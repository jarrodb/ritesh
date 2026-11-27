package server

import (
	"context"
	"errors"
	"io"
	"testing"

	"github.com/coder/websocket"
)

func sessionOf(t *testing.T, hello msg) (id string, resumed bool) {
	t.Helper()
	id, _ = hello["session"].(string)
	resumed, _ = hello["resumed"].(bool)
	if len(id) != 2*sessionIDSize {
		t.Fatalf("session id %q is not 128 bits in hex", id)
	}
	return id, resumed
}

func TestSessionIDsAreRandom(t *testing.T) {
	seen := make(map[string]bool)
	for range 64 {
		id := newSessionID()
		if len(id) != 2*sessionIDSize || seen[id] {
			t.Fatalf("session id %q: wrong size or repeated", id)
		}
		seen[id] = true
	}
}

func TestSessionResume(t *testing.T) {
	tests := []struct {
		name string
		// resume builds the session param from the first connection's id.
		resume      func(id string) string
		token       string
		wantClose   websocket.StatusCode
		wantResumed bool
	}{
		{"same principal", func(id string) string { return id }, testToken, 0, true},
		{"another principal", func(id string) string { return id }, bobToken, closeUnauthorized, false},
		{"unknown id", func(string) string { return "ffffffffffffffffffffffffffffffff" }, testToken, 0, false},
		{"malformed id", func(string) string { return "../../etc/passwd" }, testToken, 0, false},
		{"no id", func(string) string { return "" }, testToken, 0, false},
	}
	for _, tt := range tests {
		t.Run(tt.name+", first still connected", func(t *testing.T) {
			h := newHarness(t, nil, nil)
			first, hello := h.connect()
			id, _ := sessionOf(t, hello)

			second := h.dial(nil)
			reqID := second.request("rite.hello", helloParamsFor(tt.token, tt.resume(id)))
			if tt.wantClose != 0 {
				second.wantClose(tt.wantClose)
				// The owner's connection is untouched.
				first.sync()
				return
			}
			res := second.response(reqID)["result"].(map[string]any)
			gotID, resumed := sessionOf(t, res)
			if resumed != tt.wantResumed || (gotID == id) != tt.wantResumed {
				t.Fatalf("resumed = %v with id %q (first was %q), want resumed %v", resumed, gotID, id, tt.wantResumed)
			}
			if tt.wantResumed {
				first.wantClose(closeSessionReplaced)
			} else {
				first.sync()
			}
			second.sync()
		})
		t.Run(tt.name+", first disconnected", func(t *testing.T) {
			h := newHarness(t, nil, nil)
			first, hello := h.connect()
			id, _ := sessionOf(t, hello)
			_ = first.ws.CloseNow()
			h.awaitHandled(1)

			second := h.dial(nil)
			reqID := second.request("rite.hello", helloParamsFor(tt.token, tt.resume(id)))
			if tt.wantClose != 0 {
				second.wantClose(tt.wantClose)
				return
			}
			res := second.response(reqID)["result"].(map[string]any)
			gotID, resumed := sessionOf(t, res)
			if resumed != tt.wantResumed || (gotID == id) != tt.wantResumed {
				t.Fatalf("resumed = %v with id %q (first was %q), want resumed %v", resumed, gotID, id, tt.wantResumed)
			}
		})
	}
}

// TestSessionTTL: a session can be resumed for ten minutes after its
// connection ends, and each disconnect starts the ten minutes again.
func TestSessionTTL(t *testing.T) {
	h := newHarness(t, nil, nil)
	c, hello := h.connect()
	id, _ := sessionOf(t, hello)

	disconnect := func(c *client) {
		_ = c.ws.CloseNow()
		h.awaitHandled(1)
	}
	resume := func() (*client, string, bool) {
		c, hello := h.connectAs(testToken, id)
		got, resumed := sessionOf(t, hello)
		return c, got, resumed
	}

	// Connected sessions do not age.
	h.clock.advance(3 * sessionTTL)
	disconnect(c)

	h.clock.advance(sessionTTL - 1)
	c, got, resumed := resume()
	if !resumed || got != id {
		t.Fatalf("just inside the TTL: resumed = %v, id %q, want %q", resumed, got, id)
	}
	disconnect(c)

	h.clock.advance(sessionTTL - 1)
	c, got, resumed = resume()
	if !resumed || got != id {
		t.Fatalf("the TTL did not restart on the second disconnect: resumed = %v", resumed)
	}
	disconnect(c)

	h.clock.advance(sessionTTL)
	_, got, resumed = resume()
	if resumed || got == id {
		t.Fatalf("at the TTL: resumed = %v, id %q; want a new session", resumed, got)
	}
}

func TestSessionsPerPrincipal(t *testing.T) {
	h := newHarness(t, func(o *Options) { o.Limits.SessionsPerPrincipal = 2 }, nil)
	first, hello := h.connect()
	firstID, _ := sessionOf(t, hello)
	second, _ := h.connect()

	// All of alice's sessions are connected: no room.
	third := h.dial(nil)
	third.request("rite.hello", helloParamsFor(testToken, ""))
	third.wantClose(closeRateLimited)
	// The limit is per principal.
	bob, _ := h.connectAs(bobToken, "")
	bob.sync()
	// Resuming is not a new session.
	_ = first.ws.CloseNow()
	h.awaitHandled(2) // third and first
	first, hello = h.connectAs(testToken, firstID)
	if _, resumed := sessionOf(t, hello); !resumed {
		t.Fatal("could not resume at the session limit")
	}

	// A new session replaces the oldest disconnected one.
	_ = first.ws.CloseNow()
	h.awaitHandled(1)
	h.clock.advance(1)
	_ = second.ws.CloseNow()
	h.awaitHandled(1)
	fourth, hello := h.connect()
	if _, resumed := sessionOf(t, hello); resumed {
		t.Fatal("a hello without a session resumed one")
	}
	fourth.sync()
	gone := h.dial(nil)
	if _, resumed := sessionOf(t, gone.call("rite.hello", helloParamsFor(testToken, firstID))); resumed {
		t.Error("the oldest disconnected session survived being replaced")
	}
}

// TestNoProcessSurvivesDisconnect: the command's context ends when the
// connection does, and a resumed session starts with no processes.
func TestNoProcessSurvivesDisconnect(t *testing.T) {
	started := make(chan struct{}, 1)
	ended := make(chan error, 1)
	h := newHarness(t, func(o *Options) { o.Limits.MaxProcs = 1 }, func(s *Server) {
		s.Command(Command{Name: "hang", Run: func(ctx context.Context, p *Proc) int {
			started <- struct{}{}
			_, err := p.Stdin.Read(make([]byte, 1))
			if err == nil || errors.Is(err, io.EOF) {
				ended <- errors.New("stdin did not fail when the connection ended")
				return 1
			}
			<-ctx.Done()
			ended <- context.Cause(ctx)
			return 0
		}})
	})
	c, hello := h.connect()
	id, _ := sessionOf(t, hello)
	c.start(1, "hang")
	recv(t, started)

	_ = c.ws.CloseNow()
	if cause := recv(t, ended); !errors.Is(cause, ErrDisconnected) {
		t.Fatalf("context cause = %v, want ErrDisconnected", cause)
	}
	h.awaitHandled(1)

	c, hello = h.connectAs(testToken, id)
	if _, resumed := sessionOf(t, hello); !resumed {
		t.Fatal("session was not resumed")
	}
	// pids are scoped to the connection, and the old process's slot is free:
	// the command returned before the server finished with the connection or
	// soon after, so the start is retried until the slot shows.
	for attempt := 1; ; attempt++ {
		m := c.response(c.request("proc.start", startParamsFor(1, "hang")))
		if m["result"] != nil {
			break
		}
		if errnoOf(m["error"].(map[string]any)) != string(enospc) || attempt == 1000 {
			t.Fatalf("start after resume: %v", m)
		}
	}
	recv(t, started)
}

func TestSessionNotify(t *testing.T) {
	sessions := make(chan Session, 4)
	h := newHarness(t, nil, func(s *Server) {
		s.OnSession(func(sess Session) {
			// Sent from inside the callback: it must follow the hello result.
			if err := sess.Notify("info", "welcome"); err != nil {
				t.Errorf("Notify in OnSession: %v", err)
			}
			sessions <- sess
		})
	})

	c, hello := h.connect()
	id, _ := sessionOf(t, hello)
	sess := recv(t, sessions)
	if sess.ID() != id || sess.Principal().ID != "alice" {
		t.Fatalf("OnSession got session %q of %q", sess.ID(), sess.Principal().ID)
	}
	if p := c.notification("term.notify"); p["text"] != "welcome" || p["level"] != "info" {
		t.Fatalf("term.notify params %v", p)
	}

	tests := []struct {
		level, text string
		want        error
	}{
		{"info", "device enrolled", nil},
		{"warn", "certificate expires soon", nil},
		{"error", "push failed\x1b[31m", nil},
		{"debug", "nope", ErrLevel},
		{"", "nope", ErrLevel},
	}
	for _, tt := range tests {
		err := sess.Notify(tt.level, tt.text)
		if !errors.Is(err, tt.want) {
			t.Fatalf("Notify(%q) = %v, want %v", tt.level, err, tt.want)
		}
		if err != nil {
			continue
		}
		if p := c.notification("term.notify"); p["text"] != tt.text || p["level"] != tt.level {
			t.Errorf("term.notify params %v, want %q at %q", p, tt.text, tt.level)
		}
	}
	if err := sess.Notify("info", string(make([]byte, h.srv.limits.MaxMessageBytes))); !errors.Is(err, ErrTooLarge) {
		t.Errorf("Notify with a text over the message limit = %v, want ErrTooLarge", err)
	}
	c.sync()

	// The handle follows the session across a reconnect, and OnSession does
	// not run again for it.
	_ = c.ws.CloseNow()
	h.awaitHandled(1)
	if err := sess.Notify("info", "anyone?"); !errors.Is(err, ErrNotConnected) {
		t.Errorf("Notify while disconnected = %v, want ErrNotConnected", err)
	}
	c, hello = h.connectAs(testToken, id)
	if _, resumed := sessionOf(t, hello); !resumed {
		t.Fatal("session was not resumed")
	}
	if err := sess.Notify("info", "back"); err != nil {
		t.Fatalf("Notify after resume: %v", err)
	}
	if p := c.notification("term.notify"); p["text"] != "back" {
		t.Errorf("term.notify after resume: %v", p)
	}
	select {
	case <-sessions:
		t.Error("OnSession ran for a resumed session")
	default:
	}

	// After the TTL the handle is dead.
	_ = c.ws.CloseNow()
	h.awaitHandled(1)
	h.clock.advance(sessionTTL)
	c, _ = h.connect() // sweeps the expired session
	recv(t, sessions)
	c.notification("term.notify")
	if err := sess.Notify("info", "late"); !errors.Is(err, ErrNotConnected) {
		t.Errorf("Notify on an expired session = %v, want ErrNotConnected", err)
	}
	if err := (Session{}).Notify("info", "zero"); !errors.Is(err, ErrNotConnected) {
		t.Errorf("Notify on the zero Session = %v, want ErrNotConnected", err)
	}
}

// TestOnSessionPanic: a hook that panics costs its connection, with a code
// the client retries, and nothing else.
func TestOnSessionPanic(t *testing.T) {
	calls := 0
	h := newHarness(t, nil, func(s *Server) {
		s.Command(waitCommand(nil))
		s.OnSession(func(Session) {
			calls++
			if calls == 1 {
				panic("hook exploded")
			}
		})
	})
	c := h.dial(nil)
	c.response(c.request("rite.hello", helloParamsFor(testToken, "")))
	c.wantClose(closeServerError)
	h.awaitHandled(1)

	c, _ = h.connect()
	c.start(1, "wait")
	c.notification(methodStdout)
}
