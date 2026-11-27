package server

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"runtime/debug"
	"sync"
	"unicode/utf8"
)

// Causes of a process's context ending, read with context.Cause.
var (
	// ErrInterrupted means the client sent INT.
	ErrInterrupted = errors.New("server: process interrupted")
	// ErrKilled means the client sent KILL or the process passed a limit.
	ErrKilled = errors.New("server: process killed")
	// ErrDisconnected means the connection ended.
	ErrDisconnected = errors.New("server: client disconnected")
)

var errExited = errors.New("server: process exited")

// Exit codes the server assigns.
const (
	exitPanic  = 1
	exitKilled = 137
	exitMax    = 255
)

const (
	methodStdout = "proc.stdout"
	methodStderr = "proc.stderr"
	methodExit   = "proc.exit"
)

type outputParams struct {
	Pid  int64  `json:"pid"`
	Data string `json:"data"`
}

type exitParams struct {
	Pid  int64 `json:"pid"`
	Code int   `json:"code"`
}

// proc is the server's side of one running command.
type proc struct {
	c      *conn
	pid    int64
	cmd    Command
	ctx    context.Context
	cancel context.CancelCauseFunc
	stdin  *stdinPipe
	// stop is closed when the process is killed, to free a blocked Write.
	stop chan struct{}

	// state guards killed, notice, and wall. It is never held across a send.
	state  sync.Mutex
	killed bool
	notice string
	wall   timer

	// out orders everything sent for this pid: output, then exit, then
	// nothing. Writers hold it across the send to the connection.
	out      sync.Mutex
	exited   bool
	written  int64
	streams  [2]utf8Stream
	finished sync.Once
}

// procWriter is a process's stdout or stderr.
type procWriter struct {
	p      *proc
	stream int // index into proc.streams
}

var streamMethods = [2]string{methodStdout, methodStderr}

func (w procWriter) Write(b []byte) (int, error) {
	p := w.p
	p.out.Lock()
	defer p.out.Unlock()
	if p.exited || p.isKilled() {
		return 0, io.ErrClosedPipe
	}
	n := len(b)
	over := false
	if room := p.c.limits.MaxOutputBytes - p.written; int64(n) > room {
		b, over = b[:room], true
	}
	p.written += int64(len(b))
	if err := p.emit(streamMethods[w.stream], p.streams[w.stream].feed(b), p.stop); err != nil {
		return 0, err
	}
	if over {
		p.kill(fmt.Errorf("%w: output limit", ErrKilled),
			fmt.Sprintf("rite: %s: output limit of %d bytes exceeded\n", p.cmd.Name, p.c.limits.MaxOutputBytes))
		return len(b), io.ErrClosedPipe
	}
	return n, nil
}

// emit sends text as one notification, or as several when it would not fit
// in a message. The caller holds p.out.
func (p *proc) emit(method, text string, stop <-chan struct{}) error {
	for text != "" {
		var piece string
		piece, text = splitText(text, p.c.limits.payloadBudget())
		msg := encodeNotification(method, outputParams{Pid: p.pid, Data: piece})
		if err := p.c.send(msg, stop); err != nil {
			return err
		}
	}
	return nil
}

// worstEscape is the most bytes one byte of text can take in a JSON string.
// The string's quotes take two more.
const (
	worstEscape = 6
	quotes      = 2
)

// splitText cuts text so that head, as a JSON string, fits in budget bytes.
func splitText(text string, budget int) (head, tail string) {
	if len(text)*worstEscape+quotes <= budget || len(encode(text)) <= budget {
		return text, ""
	}
	n := max((budget-quotes)/worstEscape, utf8.UTFMax)
	for n > 0 && !utf8.RuneStart(text[n]) {
		n--
	}
	return text[:n], text[n:]
}

func (p *proc) isKilled() bool {
	p.state.Lock()
	defer p.state.Unlock()
	return p.killed
}

// interrupt asks the command to stop. The command decides what happens next.
func (p *proc) interrupt() {
	p.cancel(ErrInterrupted)
}

// kill ends the process: its output is dropped from here on and its exit is
// reported as 137, once the command returns or after killGrace. notice, when
// not empty, is sent on stderr before the exit.
func (p *proc) kill(cause error, notice string) {
	p.state.Lock()
	if p.killed {
		p.state.Unlock()
		return
	}
	p.killed = true
	p.notice = notice
	p.state.Unlock()

	close(p.stop)
	p.cancel(cause)
	if !errors.Is(cause, ErrDisconnected) {
		p.c.srv.clock.AfterFunc(killGrace, func() { p.finish(exitKilled) })
	}
}

// run calls the command and reports its exit.
func (p *proc) run(pub *Proc) {
	code := p.call(pub)
	// Free the slot before the client can learn of the exit and start another.
	p.c.sess.releaseProc()
	if p.isKilled() {
		code = exitKilled
	}
	p.finish(code)
}

func (p *proc) call(pub *Proc) (code int) {
	defer func() {
		if r := recover(); r != nil {
			p.c.log.Error("command panicked", slog.String("command", p.cmd.Name),
				slog.Any("panic", r), slog.String("stack", string(debug.Stack())))
			_, _ = fmt.Fprintf(pub.Stderr, "rite: %s: internal error\n", p.cmd.Name)
			code = exitPanic
		}
	}()
	code = p.cmd.Run(p.ctx, pub)
	if code < 0 || code > exitMax {
		code = exitMax
	}
	return code
}

// finish sends what is left of the process's output and its exit. Only the
// first call does anything.
func (p *proc) finish(code int) {
	p.finished.Do(func() {
		p.state.Lock()
		notice := p.notice
		p.wall.Stop()
		p.state.Unlock()
		p.cancel(errExited)

		p.out.Lock()
		defer p.out.Unlock()
		p.exited = true
		p.c.removeProc(p)

		// A send fails only when the connection is gone.
		for i := range p.streams {
			_ = p.emit(streamMethods[i], p.streams[i].flush(), nil)
		}
		_ = p.emit(methodStderr, notice, nil)
		_ = p.c.send(encodeNotification(methodExit, exitParams{Pid: p.pid, Code: code}), nil)
	})
}
