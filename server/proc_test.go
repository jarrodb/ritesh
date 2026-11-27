package server

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"
)

// startEventually retries proc.start while the session is out of process
// slots. A slot frees when a command returns, which the client cannot see.
func (c *client) startEventually(pid int, argv ...string) {
	c.t.Helper()
	deadline := time.Now().Add(ioTimeout)
	for {
		m := c.response(c.request("proc.start", startParamsFor(pid, argv...)))
		if m["result"] != nil {
			return
		}
		if e := m["error"].(map[string]any); errnoOf(e) != string(enospc) || time.Now().After(deadline) {
			c.t.Fatalf("proc.start %v: %v", argv, e)
		}
	}
}

// waitCommand prints "waiting\n" and returns 130 when its context ends. It
// reports the cause on causes.
func waitCommand(causes chan<- error) Command {
	return Command{Name: "wait", Run: func(ctx context.Context, p *Proc) int {
		_, _ = io.WriteString(p.Stdout, "waiting\n")
		<-ctx.Done()
		if causes != nil {
			causes <- context.Cause(ctx)
		}
		return 130
	}}
}

// TestOutputPrecedesExit: everything a process writes arrives before its
// exit, in the order each writer wrote it, and nothing arrives after.
func TestOutputPrecedesExit(t *testing.T) {
	const writers, lines = 4, 50
	release := make(chan struct{})
	late := make(chan error, 2)
	h := newHarness(t, nil, func(s *Server) {
		s.Command(Command{Name: "noisy", Run: func(_ context.Context, p *Proc) int {
			var wg sync.WaitGroup
			for w := range writers {
				wg.Go(func() {
					out := p.Stdout
					if w%2 == 1 {
						out = p.Stderr
					}
					for i := range lines {
						_, _ = fmt.Fprintf(out, "w%d-%d\n", w, i)
					}
				})
			}
			wg.Wait()
			// Two writers outlive Run: one races the exit, one writes after
			// the client has seen it.
			go func() {
				for {
					if _, err := io.WriteString(p.Stdout, "racing\n"); err != nil {
						late <- err
						return
					}
				}
			}()
			go func() {
				<-release
				_, err := io.WriteString(p.Stderr, "after exit\n")
				late <- err
			}()
			return 7
		}})
	})
	c, _ := h.connect()
	c.start(1, "noisy")
	out := c.collect(1) // fails on anything that is not pid 1's, up to the exit
	if out.code != 7 {
		t.Errorf("exit code %d, want 7", out.code)
	}
	next := make([]int, writers)
	for _, line := range strings.Split(out.stdout+out.stderr, "\n") {
		var w, i int
		if _, err := fmt.Sscanf(line, "w%d-%d", &w, &i); err != nil {
			continue
		}
		if i != next[w] {
			t.Fatalf("writer %d: line %d arrived when %d was due", w, i, next[w])
		}
		next[w]++
	}
	for w, n := range next {
		if n != lines {
			t.Errorf("writer %d: %d of %d lines arrived before the exit", w, n, lines)
		}
	}

	close(release)
	for range 2 {
		if err := recv(t, late); err == nil {
			t.Error("a Write after the exit succeeded")
		}
	}
	c.sync()
}

func TestOutputCap(t *testing.T) {
	type result struct {
		n   int
		err error
	}
	results := make(chan result, 8)
	causes := make(chan error, 1)
	h := newHarness(t, func(o *Options) { o.Limits.MaxOutputBytes = 100 }, func(s *Server) {
		s.Command(Command{Name: "flood", Run: func(ctx context.Context, p *Proc) int {
			write := func(w io.Writer, s string) {
				n, err := io.WriteString(w, s)
				results <- result{n, err}
			}
			write(p.Stdout, strings.Repeat("a", 60))
			write(p.Stderr, strings.Repeat("e", 40)) // exactly at the cap
			write(p.Stdout, strings.Repeat("b", 60)) // over it
			write(p.Stdout, "more")
			write(p.Stderr, "more")
			<-ctx.Done()
			causes <- context.Cause(ctx)
			return 0
		}})
		s.Command(Command{Name: "exact", Run: func(_ context.Context, p *Proc) int {
			_, _ = io.WriteString(p.Stdout, strings.Repeat("x", 99))
			_, _ = io.WriteString(p.Stderr, "y")
			return 0
		}})
		s.Command(Command{Name: "split", Run: func(_ context.Context, p *Proc) int {
			// The cap falls inside the euro sign.
			_, _ = io.WriteString(p.Stdout, strings.Repeat("x", 98)+"\u20ac")
			return 0
		}})
	})
	c, _ := h.connect()

	t.Run("over the cap", func(t *testing.T) {
		c.start(1, "flood")
		out := c.collect(1)
		const notice = "rite: flood: output limit of 100 bytes exceeded\n"
		if out.stdout != strings.Repeat("a", 60) || out.stderr != strings.Repeat("e", 40)+notice || out.code != exitKilled {
			t.Errorf("stdout %q\nstderr %q\ncode %d", out.stdout, out.stderr, out.code)
		}
		want := []result{{60, nil}, {40, nil}, {0, io.ErrClosedPipe}, {0, io.ErrClosedPipe}, {0, io.ErrClosedPipe}}
		for i, w := range want {
			if got := recv(t, results); got.n != w.n || !errors.Is(got.err, w.err) {
				t.Errorf("write %d = %d, %v; want %d, %v", i, got.n, got.err, w.n, w.err)
			}
		}
		if cause := recv(t, causes); !errors.Is(cause, ErrKilled) {
			t.Errorf("context cause %v, want ErrKilled", cause)
		}
		c.sync()
	})
	t.Run("exactly the cap", func(t *testing.T) {
		c.start(2, "exact")
		if out := c.collect(2); len(out.stdout) != 99 || out.stderr != "y" || out.code != 0 {
			t.Errorf("%+v", out)
		}
	})
	t.Run("the cap inside a code point", func(t *testing.T) {
		c.start(3, "split")
		out := c.collect(3)
		// 98 bytes and two of the euro's three: those two are replaced.
		if out.stdout != strings.Repeat("x", 98)+"\ufffd\ufffd" || out.code != exitKilled || !strings.Contains(out.stderr, "output limit") {
			t.Errorf("%+v", out)
		}
	})
}

func TestKill(t *testing.T) {
	t.Run("a command that heeds its context exits 137 at once", func(t *testing.T) {
		causes := make(chan error, 1)
		h := newHarness(t, nil, func(s *Server) { s.Command(waitCommand(causes)) })
		c, _ := h.connect()
		c.start(1, "wait")
		c.notification(methodStdout)
		c.notify("proc.signal", msg{"pid": 1, "signal": "KILL"})
		// The command returned 130. Killed is 137 whatever it returns.
		if p := c.notification(methodExit); p["code"] != float64(exitKilled) {
			t.Errorf("exit %v", p)
		}
		if cause := recv(t, causes); !errors.Is(cause, ErrKilled) {
			t.Errorf("context cause %v, want ErrKilled", cause)
		}
		// A signal for a process that is gone, or never was, is dropped.
		c.notify("proc.signal", msg{"pid": 1, "signal": "KILL"})
		c.notify("proc.signal", msg{"pid": 99, "signal": "INT"})
		c.sync()
	})

	t.Run("a command that ignores its context is reported dead after the grace", func(t *testing.T) {
		release := make(chan struct{})
		killed := make(chan struct{})
		writes := make(chan error, 1)
		h := newHarness(t, func(o *Options) { o.Limits.MaxProcs = 1 }, func(s *Server) {
			s.Command(Command{Name: "stubborn", Run: func(ctx context.Context, p *Proc) int {
				_, _ = io.WriteString(p.Stdout, "started\n")
				<-ctx.Done()
				close(killed)
				_, err := io.WriteString(p.Stdout, "you cannot kill me\n")
				writes <- err
				<-release
				return 0
			}})
			s.Command(waitCommand(nil))
		})
		c, _ := h.connect()
		c.start(1, "stubborn")
		c.notification(methodStdout)
		c.notify("proc.signal", msg{"pid": 1, "signal": "KILL"})
		recv(t, killed)
		if err := recv(t, writes); err == nil {
			t.Error("a Write after KILL succeeded")
		}
		h.clock.awaitTimer(t, killGrace)
		c.sync() // no exit yet, and no output from after the kill

		h.clock.advance(killGrace)
		if p := c.notification(methodExit); p["code"] != float64(exitKilled) {
			t.Errorf("exit %v", p)
		}
		// The command still runs, so it still holds its slot.
		if e := c.callErr("proc.start", startParamsFor(2, "wait")); errnoOf(e) != "ENOSPC" {
			t.Errorf("start while the killed command runs on: %v", e)
		}
		close(release)
		c.startEventually(2, "wait")
		c.notification(methodStdout)
	})

	t.Run("signals other than INT and KILL are dropped", func(t *testing.T) {
		h := newHarness(t, nil, func(s *Server) { s.Command(waitCommand(nil)) })
		c, _ := h.connect()
		c.start(1, "wait")
		c.notification(methodStdout)
		for _, p := range []msg{
			{"pid": 1, "signal": "TERM"},
			{"pid": 1, "signal": "kill"},
			{"pid": 1},
			{"signal": "KILL"},
			{"pid": "1", "signal": "KILL"},
		} {
			c.notify("proc.signal", p)
		}
		c.sync()
		c.notify("proc.signal", msg{"pid": 1, "signal": "KILL"})
		c.notification(methodExit)
	})
}

func TestInterrupt(t *testing.T) {
	causes := make(chan error, 2)
	h := newHarness(t, nil, func(s *Server) {
		s.Command(Command{Name: "polite", Run: func(ctx context.Context, p *Proc) int {
			_, _ = io.WriteString(p.Stdout, "working\n")
			<-ctx.Done()
			causes <- context.Cause(ctx)
			// An interrupted command may still speak, and picks its code.
			_, _ = io.WriteString(p.Stderr, "interrupted\n")
			return 130
		}})
		s.Command(Command{Name: "reader", Run: func(ctx context.Context, p *Proc) int {
			_, _ = io.WriteString(p.Stdout, "reading\n")
			_, err := p.Stdin.Read(make([]byte, 16))
			causes <- err
			if ctx.Err() == nil {
				return 1
			}
			return 42
		}})
	})
	c, _ := h.connect()

	c.start(1, "polite")
	c.notification(methodStdout)
	c.notify("proc.signal", msg{"pid": 1, "signal": "INT"})
	if out := c.collect(1); out.stderr != "interrupted\n" || out.code != 130 {
		t.Errorf("%+v", out)
	}
	if cause := recv(t, causes); !errors.Is(cause, ErrInterrupted) {
		t.Errorf("context cause %v, want ErrInterrupted", cause)
	}

	// INT frees a command blocked on stdin.
	c.start(2, "reader")
	c.notification(methodStdout)
	c.notify("proc.signal", msg{"pid": 2, "signal": "INT"})
	if out := c.collect(2); out.code != 42 {
		t.Errorf("%+v", out)
	}
	if err := recv(t, causes); !errors.Is(err, ErrInterrupted) {
		t.Errorf("stdin Read returned %v, want ErrInterrupted", err)
	}
}

func TestWallTime(t *testing.T) {
	const limit = 90 * time.Second
	causes := make(chan error, 1)
	h := newHarness(t, func(o *Options) { o.Limits.ProcWallTime = limit }, func(s *Server) {
		s.Command(waitCommand(causes))
		s.Command(Command{Name: "quick", Run: func(context.Context, *Proc) int { return 0 }})
	})
	c, _ := h.connect()

	// A process that ends in time takes its timer with it.
	c.start(1, "quick")
	c.collect(1)

	c.start(2, "wait")
	c.notification(methodStdout)
	h.clock.awaitTimer(t, limit)
	h.clock.advance(limit - 1)
	c.sync()
	h.clock.advance(1)
	out := c.collect(2)
	if out.stderr != "rite: wait: time limit of 1m30s exceeded\n" || out.code != exitKilled {
		t.Errorf("%+v", out)
	}
	if cause := recv(t, causes); !errors.Is(cause, ErrKilled) {
		t.Errorf("context cause %v, want ErrKilled", cause)
	}
	c.sync()
}

// catCommand copies stdin to stdout, one Write per Read.
var catCommand = Command{Name: "cat", Run: func(_ context.Context, p *Proc) int {
	buf := make([]byte, 64)
	for {
		n, err := p.Stdin.Read(buf)
		if n > 0 {
			_, _ = p.Stdout.Write(buf[:n])
		}
		if errors.Is(err, io.EOF) {
			return 0
		}
		if err != nil {
			return 1
		}
	}
}}

func TestStdin(t *testing.T) {
	h := newHarness(t, func(o *Options) { o.Limits.MaxStdinBytes = 256 }, func(s *Server) {
		s.Command(catCommand)
		s.Command(waitCommand(nil))
	})
	c, _ := h.connect()

	tests := []struct {
		name   string
		frames []msg // proc.stdin params; pid is filled in
		want   string
	}{
		{"data then eof", []msg{{"data": "abc\n"}, {"eof": true}}, "abc\n"},
		{"eof alone", []msg{{"eof": true}}, ""},
		{"data and eof in one message", []msg{{"data": "one", "eof": true}}, "one"},
		{"several chunks", []msg{{"data": "a"}, {"data": "b"}, {"data": "c"}, {"eof": true}}, "abc"},
		{"empty data", []msg{{"data": ""}, {"data": "x"}, {"eof": true}}, "x"},
		{"multibyte", []msg{{"data": "h\u00e9llo \U0001f600"}, {"eof": true}}, "h\u00e9llo \U0001f600"},
		{"data after eof is dropped", []msg{{"data": "kept"}, {"eof": true}, {"data": "dropped"}}, "kept"},
		{"eof false is not eof", []msg{{"data": "a", "eof": false}, {"eof": true}}, "a"},
		{"malformed frames are dropped", []msg{{"data": 7}, {"eof": "yes"}, {}, {"data": "ok"}, {"eof": true}}, "ok"},
	}
	for i, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			pid := i + 1
			c.start(pid, "cat")
			for _, f := range tt.frames {
				f["pid"] = pid
				c.notify("proc.stdin", f)
			}
			if out := c.collect(pid); out.stdout != tt.want || out.code != 0 {
				t.Errorf("got %+v, want stdout %q", out, tt.want)
			}
			c.sync()
		})
	}

	t.Run("stdin for no process is dropped", func(*testing.T) {
		c.notify("proc.stdin", msg{"pid": 1, "data": "to a process that exited"})
		c.notify("proc.stdin", msg{"pid": 4242, "data": "to a process that never was"})
		c.notify("proc.stdin", msg{"data": "to no one"})
		c.sync()
	})

	t.Run("a reader that keeps up is never over the buffer", func(t *testing.T) {
		c.start(100, "cat")
		chunk := strings.Repeat("z", 64)
		for range 16 { // four times the buffer, a quarter of it at a time
			c.notify("proc.stdin", msg{"pid": 100, "data": chunk})
			if p := c.notification(methodStdout); p["data"] != chunk {
				t.Fatalf("echo %v", p)
			}
		}
		c.notify("proc.stdin", msg{"pid": 100, "eof": true})
		c.notification(methodExit)
	})

	t.Run("an unread buffer over the limit kills the process", func(t *testing.T) {
		c.start(101, "wait")
		c.notification(methodStdout)
		c.notify("proc.stdin", msg{"pid": 101, "data": strings.Repeat("x", 256)}) // exactly the limit
		c.sync()
		c.notify("proc.stdin", msg{"pid": 101, "data": "y"})
		out := c.collect(101)
		if out.stderr != "rite: wait: stdin buffer full\n" || out.code != exitKilled {
			t.Errorf("%+v", out)
		}
	})
}

func TestExitCodes(t *testing.T) {
	tests := []struct {
		name   string
		run    func(ctx context.Context, p *Proc) int
		code   int
		stderr string
	}{
		{"zero", func(context.Context, *Proc) int { return 0 }, 0, ""},
		{"one", func(context.Context, *Proc) int { return 1 }, 1, ""},
		{"255", func(context.Context, *Proc) int { return 255 }, 255, ""},
		{"256 does not wrap to success", func(context.Context, *Proc) int { return 256 }, 255, ""},
		{"negative", func(context.Context, *Proc) int { return -1 }, 255, ""},
		{"137 by the command's own choice", func(context.Context, *Proc) int { return 137 }, 137, ""},
		{"panic", func(context.Context, *Proc) int { panic("boom") }, exitPanic, "rite: cmd: internal error\n"},
		{"panic after output", func(_ context.Context, p *Proc) int {
			_, _ = io.WriteString(p.Stderr, "about to fail\n")
			panic(errors.New("boom, as an error"))
		}, exitPanic, "about to fail\nrite: cmd: internal error\n"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newHarness(t, nil, func(s *Server) { s.Command(Command{Name: "cmd", Run: tt.run}) })
			c, _ := h.connect()
			c.start(1, "cmd")
			if out := c.collect(1); out.code != tt.code || out.stderr != tt.stderr || out.stdout != "" {
				t.Errorf("got %+v, want code %d stderr %q", out, tt.code, tt.stderr)
			}
			// The server survives its commands.
			c.sync()
		})
	}
}

func TestMaxProcs(t *testing.T) {
	h := newHarness(t, func(o *Options) { o.Limits.MaxProcs = 3 }, func(s *Server) { s.Command(waitCommand(nil)) })
	c, hello := h.connect()
	if got := hello["limits"].(map[string]any)["maxProcs"]; got != 3.0 {
		t.Fatalf("hello reports maxProcs %v", got)
	}
	for pid := 1; pid <= 3; pid++ {
		c.start(pid, "wait")
		c.notification(methodStdout)
	}
	e := c.callErr("proc.start", startParamsFor(4, "wait"))
	if codeOf(e) != codeApp || errnoOf(e) != "ENOSPC" || e["message"] != "too many processes" {
		t.Fatalf("fourth process: %v", e)
	}
	// Another session of the same principal has its own slots.
	other, _ := h.connect()
	other.start(1, "wait")
	other.notification(methodStdout)

	// A slot is free by the time the client hears of the exit, and the
	// refused pid was not used up.
	for round := range 5 {
		victim := 1 + round
		if round > 0 {
			victim = 3 + round
		}
		c.notify("proc.signal", msg{"pid": victim, "signal": "KILL"})
		c.notification(methodExit)
		c.start(4+round, "wait")
		c.notification(methodStdout)
	}
}

func TestPids(t *testing.T) {
	h := newHarness(t, func(o *Options) { o.Limits.MaxProcs = 64 }, func(s *Server) {
		s.Command(Command{Name: "true", Run: func(context.Context, *Proc) int { return 0 }})
	})
	c, _ := h.connect()
	steps := []struct {
		pid   any
		argv  string
		errno string // "" for success
		code  int
	}{
		{1, "true", "", 0},
		{1, "true", "EINVAL", codeApp},                // repeated after its exit: never reused
		{5, "true", "", 0},                            // gaps are fine
		{3, "true", "EINVAL", codeApp},                // not increasing
		{5, "true", "EINVAL", codeApp},                //
		{6, "missing", "ENOENT", codeApp},             //
		{6, "true", "", 0},                            // a refused start did not use the pid
		{6, "missing", "EINVAL", codeApp},             // a used pid is checked before the command
		{1 << 40, "true", "", 0},                      // beyond 32 bits
		{0, "true", "", codeInvalidParams},            // pids start at 1
		{-4, "true", "", codeInvalidParams},           //
		{1.5, "true", "", codeInvalidParams},          //
		{"7", "true", "", codeInvalidParams},          //
		{float64(1<<40 + 1), "true", "", 0},           //
		{float64(1 << 40), "true", "EINVAL", codeApp}, //
	}
	for i, st := range steps {
		p := startParamsFor(0, st.argv)
		p["pid"] = st.pid
		m := c.response(c.request("proc.start", p))
		if st.errno == "" && st.code == 0 {
			if m["result"] == nil {
				t.Fatalf("step %d (pid %v): %v", i, st.pid, m)
			}
			if p := c.notification(methodExit); p["pid"] != toFloat(st.pid) {
				t.Fatalf("step %d: exit for %v", i, p)
			}
			continue
		}
		e, _ := m["error"].(map[string]any)
		if codeOf(e) != st.code || errnoOf(e) != st.errno {
			t.Fatalf("step %d (pid %v, %s): %v, want code %d errno %q", i, st.pid, st.argv, m, st.code, st.errno)
		}
		if st.errno == "EINVAL" {
			if _, has := e["data"].(map[string]any)["path"]; has {
				t.Errorf("step %d: a repeated pid is not about a path: %v", i, e)
			}
		}
		if st.errno == "ENOENT" && e["data"].(map[string]any)["path"] != st.argv {
			t.Errorf("step %d: ENOENT without the command as its path: %v", i, e)
		}
	}
	c.sync()

	// pids belong to the connection.
	other, _ := h.connect()
	other.start(1, "true")
	other.notification(methodExit)
}

func toFloat(v any) float64 {
	switch n := v.(type) {
	case int:
		return float64(n)
	case float64:
		return n
	}
	return -1
}

func TestStartParams(t *testing.T) {
	ran := make(chan struct{}, 16)
	h := newHarness(t, func(o *Options) {
		o.Limits.MaxArgs = 4
		o.Limits.MaxArgBytes = 32
		o.Limits.MaxEnvVars = 2
		o.Limits.MaxEnvBytes = 32
		o.Limits.MaxPathBytes = 64
	}, func(s *Server) {
		s.Command(Command{Name: "true", Run: func(context.Context, *Proc) int { ran <- struct{}{}; return 0 }})
	})
	c, _ := h.connect()

	stdio := msg{"stdin": "pipe", "stdout": "pipe", "stderr": "pipe"}
	base := func() msg { return msg{"pid": 1, "argv": []string{"true"}, "cwd": "", "env": msg{}, "stdio": stdio} }
	tests := []struct {
		name  string
		edit  func(p msg)
		code  int
		errno string
	}{
		{"no pid", func(p msg) { delete(p, "pid") }, codeInvalidParams, ""},
		{"no argv", func(p msg) { delete(p, "argv") }, codeInvalidParams, ""},
		{"empty argv", func(p msg) { p["argv"] = []string{} }, codeInvalidParams, ""},
		{"argv of numbers", func(p msg) { p["argv"] = []int{1} }, codeInvalidParams, ""},
		{"argv a string", func(p msg) { p["argv"] = "true" }, codeInvalidParams, ""},
		{"no cwd", func(p msg) { delete(p, "cwd") }, codeInvalidParams, ""},
		{"no env", func(p msg) { delete(p, "env") }, codeInvalidParams, ""},
		{"env with a number", func(p msg) { p["env"] = msg{"A": 1} }, codeInvalidParams, ""},
		{"no stdio", func(p msg) { delete(p, "stdio") }, codeInvalidParams, ""},
		{"stdio without stderr", func(p msg) { p["stdio"] = msg{"stdin": "pipe", "stdout": "pipe"} }, codeInvalidParams, ""},
		{"stdio of an unknown kind", func(p msg) { p["stdio"] = msg{"stdin": "file", "stdout": "pipe", "stderr": "pipe"} }, codeInvalidParams, ""},
		{"params an array", nil, codeInvalidParams, ""},

		{"too many args", func(p msg) { p["argv"] = []string{"true", "a", "b", "c", "d"} }, codeApp, "EINVAL"},
		{"args too long", func(p msg) { p["argv"] = []string{"true", strings.Repeat("a", 29)} }, codeApp, "EINVAL"},
		{"NUL in an arg", func(p msg) { p["argv"] = []string{"true", "a\x00b"} }, codeApp, "EINVAL"},
		{"too many variables", func(p msg) { p["env"] = msg{"A": "1", "B": "2", "C": "3"} }, codeApp, "EINVAL"},
		{"env too long", func(p msg) { p["env"] = msg{"A": strings.Repeat("v", 32)} }, codeApp, "EINVAL"},
		{"empty variable name", func(p msg) { p["env"] = msg{"": "1"} }, codeApp, "EINVAL"},
		{"= in a variable name", func(p msg) { p["env"] = msg{"A=B": "1"} }, codeApp, "EINVAL"},
		{"NUL in a variable name", func(p msg) { p["env"] = msg{"A\x00": "1"} }, codeApp, "EINVAL"},
		{"NUL in a value", func(p msg) { p["env"] = msg{"A": "1\x00"} }, codeApp, "EINVAL"},
		{"cwd climbs", func(p msg) { p["cwd"] = "../.." }, codeApp, "EINVAL"},
		{"cwd too long", func(p msg) { p["cwd"] = strings.Repeat("d", 65) }, codeApp, "EINVAL"},
		{"unknown command", func(p msg) { p["argv"] = []string{"false"} }, codeApp, "ENOENT"},
		{"command by path", func(p msg) { p["argv"] = []string{"/bin/true"} }, codeApp, "ENOENT"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var params any = []any{1, "true"}
			if tt.edit != nil {
				p := base()
				tt.edit(p)
				params = p
			}
			e := c.callErr("proc.start", params)
			if codeOf(e) != tt.code || errnoOf(e) != tt.errno {
				t.Errorf("got %v, want code %d errno %q", e, tt.code, tt.errno)
			}
		})
	}
	select {
	case <-ran:
		t.Fatal("a refused proc.start ran the command")
	default:
	}

	t.Run("at the limits", func(t *testing.T) {
		p := base()
		p["argv"] = []string{"true", strings.Repeat("a", 28), "", ""} // 4 args, 32 bytes
		p["env"] = msg{"A": strings.Repeat("v", 15), "B": strings.Repeat("v", 15)}
		p["cwd"] = strings.Repeat("d", 64)
		p["future"] = "ignored"
		c.call("proc.start", p)
		c.notification(methodExit)
		recv(t, ran)
	})
}

// TestLargeOutputIsSplit: no notification is larger than maxMessageBytes,
// whatever the size of a Write and however its bytes escape in JSON.
func TestLargeOutputIsSplit(t *testing.T) {
	const maxMessage = 4096
	payloads := map[string]string{
		"plain":    strings.Repeat("0123456789abcdef", 2048),
		"controls": strings.Repeat("\x01\x02\x1b", 8000),
		"quotes":   strings.Repeat(`"\`, 12000),
		"wide":     strings.Repeat("\u20ac\U0001f600\u00e9x", 3000),
		"html":     strings.Repeat("<b>&amp;</b>", 3000),
		"small":    "just a line\n",
	}
	h := newHarness(t, func(o *Options) {
		o.Limits.MaxMessageBytes = maxMessage
		o.Limits.MaxOutputBytes = 1 << 20
	}, func(s *Server) {
		s.Command(Command{Name: "emit", Run: func(_ context.Context, p *Proc) int {
			if n, err := io.WriteString(p.Stdout, payloads[p.Args[1]]); err != nil || n != len(payloads[p.Args[1]]) {
				return 1
			}
			return 0
		}})
	})
	c, _ := h.connect()
	pid := 0
	for name, payload := range payloads {
		t.Run(name, func(t *testing.T) {
			pid++
			c.maxFrame = 0
			c.start(pid, "emit", name)
			frames := 0
			var got strings.Builder
			for {
				m := c.read()
				if m["method"] == methodExit {
					if code := m["params"].(map[string]any)["code"]; code != 0.0 {
						t.Fatalf("exit %v", code)
					}
					break
				}
				data := m["params"].(map[string]any)["data"].(string)
				if !utf8.ValidString(data) {
					t.Fatal("a notification split a code point")
				}
				got.WriteString(data)
				frames++
			}
			if got.String() != payload {
				t.Errorf("%d bytes arrived of %d, or not the same ones", got.Len(), len(payload))
			}
			if c.maxFrame > maxMessage {
				t.Errorf("a frame of %d bytes exceeds maxMessageBytes %d", c.maxFrame, maxMessage)
			}
			if name == "small" && frames != 1 {
				t.Errorf("a small write took %d notifications", frames)
			}
		})
	}
}

// TestProcSeesItsWorld covers what the server hands a command: argv, env,
// cwd, the stdio kinds, the terminal size and its changes, and the principal.
func TestProcSeesItsWorld(t *testing.T) {
	h := newHarness(t, nil, func(s *Server) {
		s.Command(Command{Name: "show", Run: func(ctx context.Context, p *Proc) int {
			who, _ := PrincipalFromContext(ctx)
			_, _ = fmt.Fprintf(p.Stdout, "args=%q cwd=%q env=%v tty=%+v principal=%s/%s ctx=%s\n",
				p.Args, p.Cwd, p.Env, p.TTY, p.Principal.ID, p.Principal.Attrs["role"], who.ID)
			lines := bufio.NewScanner(p.Stdin)
			for lines.Scan() {
				cols, rows := p.Size()
				_, _ = fmt.Fprintf(p.Stdout, "size=%dx%d\n", cols, rows)
			}
			return 0
		}})
	})
	c := h.dial(nil)
	hello := helloParamsFor(testToken, "")
	hello["tty"] = msg{"cols": 132, "rows": 43}
	c.call("rite.hello", hello)

	c.call("proc.start", msg{
		"pid": 1, "argv": []string{"show", "-v", "", "a b", "é"}, "cwd": "docs/sub",
		"env":   msg{"LANG": "C", "EMPTY": ""},
		"stdio": msg{"stdin": "tty", "stdout": "pipe", "stderr": "tty"},
	})
	const want = `args=["show" "-v" "" "a b" "é"] cwd="docs/sub" env=map[EMPTY: LANG:C] ` +
		`tty={Cols:132 Rows:43 Stdin:tty Stdout:pipe Stderr:tty} principal=alice/admin ctx=alice` + "\n"
	if p := c.notification(methodStdout); p["data"] != want {
		t.Errorf("got  %q\nwant %q", p["data"], want)
	}

	sizes := []struct {
		resize msg
		want   string
	}{
		{nil, "size=132x43\n"},
		{msg{"cols": 80, "rows": 24}, "size=80x24\n"},
		{msg{"cols": 0, "rows": 0}, "size=0x0\n"},
		{msg{"cols": 200, "rows": 60, "extra": true}, "size=200x60\n"},
		{msg{"cols": -1, "rows": 24}, "size=200x60\n"},      // dropped
		{msg{"cols": 80}, "size=200x60\n"},                  //
		{msg{"cols": "80", "rows": "24"}, "size=200x60\n"},  //
		{msg{"cols": 1 << 20, "rows": 24}, "size=200x60\n"}, //
		{msg{"cols": 100, "rows": 30}, "size=100x30\n"},
	}
	for _, tt := range sizes {
		if tt.resize != nil {
			c.notify("tty.resize", tt.resize)
		}
		c.notify("proc.stdin", msg{"pid": 1, "data": "\n"})
		if p := c.notification(methodStdout); p["data"] != tt.want {
			t.Errorf("after tty.resize %v: %q, want %q", tt.resize, p["data"], tt.want)
		}
	}
	c.notify("proc.stdin", msg{"pid": 1, "eof": true})
	c.notification(methodExit)

	// The size belongs to the session: a later process starts with it.
	c.call("proc.start", msg{"pid": 2, "argv": []string{"show"}, "cwd": "", "env": msg{}, "stdio": msg{"stdin": "pipe", "stdout": "pipe", "stderr": "pipe"}})
	if p := c.notification(methodStdout); !strings.Contains(p["data"].(string), "tty={Cols:100 Rows:30 Stdin:pipe") {
		t.Errorf("second process: %q", p["data"])
	}
}

func TestCommandPanics(t *testing.T) {
	run := func(context.Context, *Proc) int { return 0 }
	tests := []struct {
		name string
		cmds []Command
	}{
		{"no name", []Command{{Run: run}}},
		{"no Run", []Command{{Name: "x"}}},
		{"twice", []Command{{Name: "x", Run: run}, {Name: "x", Run: run}}},
		{"unknown flag type", []Command{{Name: "x", Run: run, Flags: map[string]Flag{"n": {Type: "integer"}}}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			defer func() {
				if recover() == nil {
					t.Error("Command did not panic")
				}
			}()
			s := New(Options{})
			for _, c := range tt.cmds {
				s.Command(c)
			}
		})
	}
}
