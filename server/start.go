package server

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
)

type startParams struct {
	Pid   *int64            `json:"pid"`
	Argv  []string          `json:"argv"`
	Cwd   *string           `json:"cwd"`
	Env   map[string]string `json:"env"`
	Stdio *struct {
		Stdin  string `json:"stdin"`
		Stdout string `json:"stdout"`
		Stderr string `json:"stderr"`
	} `json:"stdio"`
}

func validStdio(kinds ...string) bool {
	for _, k := range kinds {
		if k != StdioTTY && k != StdioPipe {
			return false
		}
	}
	return true
}

func (p *startParams) valid() bool {
	return p.Pid != nil && *p.Pid >= 1 && len(p.Argv) > 0 && p.Cwd != nil && p.Env != nil &&
		p.Stdio != nil && validStdio(p.Stdio.Stdin, p.Stdio.Stdout, p.Stdio.Stderr)
}

// checkArgv applies the argv limits. NUL cannot be part of an argument.
func (l Limits) checkArgv(argv []string) *rpcError {
	if len(argv) > l.MaxArgs {
		return appError(einval)
	}
	total := 0
	for _, a := range argv {
		total += len(a)
		if total > l.MaxArgBytes || strings.ContainsRune(a, 0) {
			return appError(einval)
		}
	}
	return nil
}

func (l Limits) checkEnv(env map[string]string) *rpcError {
	if len(env) > l.MaxEnvVars {
		return appError(einval)
	}
	total := 0
	for name, value := range env {
		total += len(name) + len(value)
		if total > l.MaxEnvBytes || name == "" || strings.ContainsAny(name, "=\x00") || strings.ContainsRune(value, 0) {
			return appError(einval)
		}
	}
	return nil
}

func killedBy(what string) error {
	return fmt.Errorf("%w: %s", ErrKilled, what)
}

// startProc answers proc.start and, on success, starts the command. It runs
// on the reader so that the stdin and signals behind it find the process.
func (c *conn) startProc(id int64, raw json.RawMessage) {
	p, ok := decode[startParams](raw)
	if !ok || !p.valid() {
		c.reply(id, nil, errInvalidParams)
		return
	}
	pr, pub, rerr := c.newProc(&p)
	if rerr != nil {
		c.reply(id, nil, rerr)
		return
	}
	// The result goes out before anything the process writes.
	c.reply(id, empty{}, nil)
	go pr.run(pub)
}

func (c *conn) newProc(p *startParams) (*proc, *Proc, *rpcError) {
	if rerr := c.limits.checkArgv(p.Argv); rerr != nil {
		return nil, nil, rerr
	}
	if rerr := c.limits.checkEnv(p.Env); rerr != nil {
		return nil, nil, rerr
	}
	if rerr := c.limits.checkPath(*p.Cwd); rerr != nil {
		return nil, nil, rerr
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	// pids only grow, so one at or below the last is a repeat.
	if *p.Pid <= c.lastPid {
		return nil, nil, appError(einval)
	}
	cmd := c.srv.lookup(p.Argv[0])
	if cmd == nil {
		return nil, nil, pathError(enoent, p.Argv[0])
	}
	if !c.sess.acquireProc(c.limits.MaxProcs) {
		rerr := appError(enospc)
		rerr.Message = "too many processes"
		return nil, nil, rerr
	}
	c.lastPid = *p.Pid

	ctx, cancel := context.WithCancelCause(context.WithValue(context.Background(), principalKey{}, c.principal))
	pr := &proc{
		c:      c,
		pid:    *p.Pid,
		cmd:    *cmd,
		ctx:    ctx,
		cancel: cancel,
		stdin:  newStdinPipe(ctx),
		stop:   make(chan struct{}),
	}
	limit := c.limits.ProcWallTime
	pr.state.Lock()
	pr.wall = c.srv.clock.AfterFunc(limit, func() {
		pr.kill(killedBy("time limit"), fmt.Sprintf("rite: %s: time limit of %s exceeded\n", cmd.Name, limit))
	})
	pr.state.Unlock()
	c.procs[pr.pid] = pr

	cols, rows := c.sess.size()
	pub := &Proc{
		Args:      p.Argv,
		Env:       p.Env,
		Cwd:       *p.Cwd,
		Stdin:     pr.stdin,
		Stdout:    procWriter{p: pr, stream: 0},
		Stderr:    procWriter{p: pr, stream: 1},
		TTY:       TTY{Cols: cols, Rows: rows, Stdin: p.Stdio.Stdin, Stdout: p.Stdio.Stdout, Stderr: p.Stdio.Stderr},
		Principal: c.principal,
		sess:      c.sess,
	}
	return pr, pub, nil
}

type completeParams struct {
	Argv  []string `json:"argv"`
	Index *int64   `json:"index"`
}

type completeResult struct {
	Candidates []Candidate `json:"candidates"`
}

// complete answers proc.complete: command names for the first word, then
// what the command's Complete returns, or its flags when it has none.
func (c *conn) complete(raw json.RawMessage) (any, *rpcError) {
	p, ok := decode[completeParams](raw)
	if !ok || p.Argv == nil || p.Index == nil || *p.Index < 0 || *p.Index > int64(len(p.Argv)) {
		return nil, errInvalidParams
	}
	if rerr := c.limits.checkArgv(p.Argv); rerr != nil {
		return nil, rerr
	}
	// A word not typed yet is completed as the empty word.
	argv := p.Argv
	index := int(*p.Index)
	if index == len(argv) {
		argv = append(slices.Clone(argv), "")
	}
	word := argv[index]

	var found []Candidate
	if index == 0 {
		for _, info := range c.srv.commandInfos() {
			if strings.HasPrefix(info.Name, word) {
				found = append(found, Candidate{Value: info.Name, Description: info.Summary})
			}
		}
	} else if cmd := c.srv.lookup(argv[0]); cmd != nil {
		switch {
		case cmd.Complete != nil:
			ctx := context.WithValue(c.ctx, principalKey{}, c.principal)
			found = cmd.Complete(ctx, argv, index)
		case strings.HasPrefix(word, "-") && !slices.Contains(argv[1:index], "--"):
			found = cmd.completeFlags(word)
		}
	}

	res := completeResult{Candidates: []Candidate{}}
	size := 0
	for _, cand := range found {
		size += len(encode(cand)) + 1
		if size > c.limits.payloadBudget() {
			break
		}
		res.Candidates = append(res.Candidates, cand)
	}
	return res, nil
}
