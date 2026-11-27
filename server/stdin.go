package server

import (
	"bytes"
	"context"
	"io"
	"sync"
)

// stdinPipe buffers what the client sends to a process until the command
// reads it.
type stdinPipe struct {
	ctx  context.Context
	wake chan struct{}

	mu  sync.Mutex
	buf bytes.Buffer
	eof bool
}

func newStdinPipe(ctx context.Context) *stdinPipe {
	return &stdinPipe{ctx: ctx, wake: make(chan struct{}, 1)}
}

// Read blocks until there is data, the client closes stdin, or the process's
// context ends.
func (s *stdinPipe) Read(b []byte) (int, error) {
	if len(b) == 0 {
		return 0, nil
	}
	for {
		if s.ctx.Err() != nil {
			return 0, context.Cause(s.ctx)
		}
		s.mu.Lock()
		if s.buf.Len() > 0 {
			n, _ := s.buf.Read(b)
			if s.buf.Len() > 0 || s.eof {
				s.signal()
			}
			s.mu.Unlock()
			return n, nil
		}
		eof := s.eof
		s.mu.Unlock()
		if eof {
			s.signal()
			return 0, io.EOF
		}
		select {
		case <-s.wake:
		case <-s.ctx.Done():
		}
	}
}

// signal wakes one blocked Read.
func (s *stdinPipe) signal() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

// push appends data. It reports false, and takes nothing, when the unread
// bytes would pass limit.
func (s *stdinPipe) push(data string, limit int) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.eof {
		return true
	}
	if s.buf.Len()+len(data) > limit {
		return false
	}
	s.buf.WriteString(data)
	s.signal()
	return true
}

func (s *stdinPipe) close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.eof = true
	s.signal()
}
