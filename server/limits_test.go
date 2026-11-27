package server

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestLimitsDefaults(t *testing.T) {
	d := defaultLimits()
	tests := []struct {
		name  string
		in    Limits
		check func(l Limits) bool
	}{
		{"zero value is the defaults", Limits{}, func(l Limits) bool { return l == d }},
		{"DefaultLimits is the defaults", DefaultLimits, func(l Limits) bool { return l == d }},
		{"a set field is kept", Limits{MaxProcs: 9}, func(l Limits) bool {
			want := d
			want.MaxProcs = 9
			return l == want
		}},
		{"negative fields take the default", Limits{MaxProcs: -1, IdleTimeout: -time.Second, MaxOutputBytes: -5}, func(l Limits) bool { return l == d }},
		{"message size has a floor", Limits{MaxMessageBytes: 10}, func(l Limits) bool { return l.MaxMessageBytes == minMessageBytes }},
		{"every default is positive", Limits{}, func(l Limits) bool {
			return l.MaxMessageBytes > 0 && l.MaxProcs > 0 && l.MaxOutputBytes > 0 && l.IdleTimeout > 0 &&
				l.PingInterval > 0 && l.MessagesPerSecond > 0 && l.SessionsPerPrincipal > 0 &&
				l.PreAuthPerAddress > 0 && l.ProcWallTime > 0 && l.MaxStdinBytes > 0 && l.MaxArgs > 0 &&
				l.MaxArgBytes > 0 && l.MaxEnvVars > 0 && l.MaxEnvBytes > 0 && l.MaxPathBytes > 0 &&
				l.MaxReadBytes > 0 && l.MaxListEntries > 0
		}},
		{"pings come before the idle timeout", Limits{}, func(l Limits) bool { return l.PingInterval < l.IdleTimeout }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.in.withDefaults(); !tt.check(got) {
				t.Errorf("withDefaults() = %+v", got)
			}
		})
	}
}

func TestHelloReportsLimits(t *testing.T) {
	h := newHarness(t, func(o *Options) {
		o.Limits = Limits{MaxMessageBytes: 2048, MaxProcs: 2, MaxOutputBytes: 4096, IdleTimeout: 90 * time.Second}
	}, nil)
	_, hello := h.connect()
	want := msg{"maxMessageBytes": 2048.0, "maxProcs": 2.0, "maxOutputBytes": 4096.0, "idleSeconds": 90.0}
	if !matches(any(want), hello["limits"], "exact", "") {
		t.Errorf("limits %v, want %v", hello["limits"], want)
	}
}

// paddedRequest is a valid fs.stat request of exactly size bytes.
func paddedRequest(t *testing.T, id, size int) []byte {
	t.Helper()
	build := func(pad int) []byte {
		return encode(msg{"jsonrpc": "2.0", "id": id, "method": "fs.stat", "params": msg{"path": "", "pad": strings.Repeat("p", pad)}})
	}
	frame := build(size - len(build(0)))
	if len(frame) != size {
		t.Fatalf("padded request is %d bytes, want %d", len(frame), size)
	}
	return frame
}

func TestMessageSize(t *testing.T) {
	const limit = 2048
	tests := []struct {
		name  string
		size  int
		close websocket.StatusCode
	}{
		{"at the limit", limit, 0},
		{"a byte over", limit + 1, websocket.StatusMessageTooBig},
		{"far over", 64 * limit, websocket.StatusMessageTooBig},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newHarness(t, func(o *Options) { o.Limits.MaxMessageBytes = limit }, nil)
			c, _ := h.connect()
			c.sendRaw(paddedRequest(t, 50, tt.size))
			if tt.close != 0 {
				c.wantClose(tt.close)
				return
			}
			c.response(50)
		})
	}
}

func TestBinaryFramesAreRefused(t *testing.T) {
	h := newHarness(t, nil, nil)
	c, _ := h.connect()
	if err := c.ws.Write(context.Background(), websocket.MessageBinary, paddedRequest(t, 2, 200)); err != nil {
		t.Fatal(err)
	}
	c.wantClose(websocket.StatusUnsupportedData)
}

func TestMessagesPerSecond(t *testing.T) {
	const perSecond = 5
	limited := func(t *testing.T) (*harness, *client) {
		h := newHarness(t, func(o *Options) { o.Limits.MessagesPerSecond = perSecond }, nil)
		c, _ := h.connect() // rite.hello is not counted
		return h, c
	}
	t.Run("a second's worth passes, the next closes 4029", func(t *testing.T) {
		_, c := limited(t)
		for range perSecond {
			c.sync()
		}
		c.request("fs.stat", msg{"path": ""})
		c.wantClose(closeRateLimited)
	})
	t.Run("notifications count, known or not", func(t *testing.T) {
		_, c := limited(t)
		for i := range perSecond {
			if i%2 == 0 {
				c.notify("tty.resize", msg{"cols": 80, "rows": 24})
			} else {
				c.notify("future.thing", msg{})
			}
		}
		c.notify("tty.resize", msg{"cols": 80, "rows": 24})
		c.wantClose(closeRateLimited)
	})
	t.Run("malformed messages count", func(t *testing.T) {
		_, c := limited(t)
		for range perSecond {
			c.sendRaw([]byte("{"))
			c.read()
		}
		c.sendRaw([]byte("{"))
		c.wantClose(closeRateLimited)
	})
	t.Run("the allowance refills with time", func(t *testing.T) {
		h, c := limited(t)
		for range 4 {
			for range perSecond {
				c.sync()
			}
			h.clock.advance(time.Second)
		}
		// A long quiet does not bank more than one second's worth.
		h.clock.advance(time.Minute)
		for range perSecond {
			c.sync()
		}
		c.request("fs.stat", msg{"path": ""})
		c.wantClose(closeRateLimited)
	})
	t.Run("the limit is per connection", func(t *testing.T) {
		h, c := limited(t)
		other, _ := h.connect()
		for range perSecond {
			c.sync()
			other.sync()
		}
	})
}

func TestIdle(t *testing.T) {
	const idle = 5 * time.Minute
	type world struct {
		h        *harness
		c        *client
		sessions chan Session
	}
	setup := func(t *testing.T) world {
		sessions := make(chan Session, 1)
		h := newHarness(t, func(o *Options) { o.Limits.IdleTimeout = idle }, func(s *Server) {
			s.Command(waitCommand(nil))
			s.OnSession(func(sess Session) { sessions <- sess })
		})
		c, _ := h.connect()
		h.clock.awaitTimer(t, idle)
		return world{h, c, sessions}
	}

	t.Run("closes 1000 idle after idleSeconds of nothing", func(t *testing.T) {
		w := setup(t)
		w.h.clock.advance(idle - 1)
		w.c.sync()
		// The message a nanosecond before the timeout started the wait over.
		w.h.clock.advance(1)
		w.h.clock.awaitTimer(t, idle-1)
		w.h.clock.advance(idle - 2)
		w.h.clock.advance(1)
		w.c.wantCloseReason(websocket.StatusNormalClosure, "idle")
	})

	t.Run("a message from the client is traffic", func(t *testing.T) {
		w := setup(t)
		w.h.clock.advance(idle - time.Second)
		w.c.notify("future.thing", msg{}) // even one the server ignores
		w.c.notify("tty.resize", msg{"cols": 90, "rows": 30})
		w.c.sync()
		w.h.clock.advance(time.Second)
		// The check found traffic and went back to waiting for the rest.
		w.h.clock.awaitTimer(t, idle-time.Second)
		w.h.clock.advance(idle - time.Second)
		w.c.wantCloseReason(websocket.StatusNormalClosure, "idle")
	})

	t.Run("a message from the server is traffic", func(t *testing.T) {
		w := setup(t)
		sess := recv(t, w.sessions)
		w.h.clock.advance(idle - time.Second)
		if err := sess.Notify("info", "still here"); err != nil {
			t.Fatal(err)
		}
		w.c.notification("term.notify")
		w.h.clock.advance(time.Second)
		w.h.clock.awaitTimer(t, idle-time.Second)
		w.h.clock.advance(idle - time.Second)
		w.c.wantCloseReason(websocket.StatusNormalClosure, "idle")
	})

	t.Run("a running process keeps the connection, and its exit starts the wait", func(t *testing.T) {
		w := setup(t)
		w.c.start(1, "wait")
		w.c.notification(methodStdout)
		for range 3 {
			w.h.clock.advance(idle)
			w.h.clock.awaitTimer(t, idle) // checked, and armed again
		}
		w.h.clock.advance(idle / 2)
		w.c.notify("proc.signal", msg{"pid": 1, "signal": "KILL"})
		w.c.notification(methodExit)
		// The pending check comes half a timeout after the exit: too soon.
		w.h.clock.advance(idle / 2)
		w.h.clock.awaitTimer(t, idle/2)
		w.h.clock.advance(idle / 2)
		w.c.wantCloseReason(websocket.StatusNormalClosure, "idle")
	})
}

// TestPing: the server pings on its interval, and pings are not traffic.
func TestPing(t *testing.T) {
	const (
		interval = 100 * time.Second
		idle     = 250 * time.Second
	)
	pings := make(chan struct{}, 16)
	h := newHarness(t, func(o *Options) {
		o.Limits.PingInterval = interval
		o.Limits.IdleTimeout = idle
	}, nil)
	c := h.dial(func(o *websocket.DialOptions) {
		o.OnPingReceived = func(context.Context, []byte) bool {
			pings <- struct{}{}
			return true
		}
	})
	c.call("rite.hello", helloParamsFor(testToken, ""))

	// Something has to read for the client to see a ping and answer it.
	closed := make(chan error, 1)
	go func() {
		_, err := c.readErr()
		closed <- err
	}()

	h.clock.awaitTimer(t, interval)
	h.clock.awaitTimer(t, idle)
	h.clock.advance(interval)
	recv(t, pings)
	h.clock.awaitTimer(t, interval) // armed again
	// A ping and a pong have passed, and no message. At 250 s the connection
	// is idle all the same.
	h.clock.advance(idle - interval)
	var ce websocket.CloseError
	if err := recv(t, closed); !errors.As(err, &ce) || ce.Code != websocket.StatusNormalClosure || ce.Reason != "idle" {
		t.Errorf("want close 1000 idle, got %v", err)
	}
}

func TestServerClose(t *testing.T) {
	causes := make(chan error, 1)
	h := newHarness(t, nil, func(s *Server) { s.Command(waitCommand(causes)) })
	c, _ := h.connect()
	c.start(1, "wait")
	c.notification(methodStdout)
	waiting := h.dial(nil) // has not said hello

	closed := make(chan error, 1)
	go func() { closed <- h.srv.Close() }()
	// The process is cancelled as its connection goes.
	for {
		m, err := c.readErr()
		if err != nil {
			if got := websocket.CloseStatus(err); got != websocket.StatusGoingAway {
				t.Fatalf("close status %d, want 1001 (%v)", got, err)
			}
			break
		}
		if m["method"] != methodExit {
			t.Fatalf("unexpected message %v", m)
		}
	}
	waiting.wantClose(websocket.StatusGoingAway)
	if cause := recv(t, causes); !errors.Is(cause, ErrDisconnected) && !errors.Is(cause, ErrKilled) {
		t.Errorf("context cause %v", cause)
	}
	if err := recv(t, closed); err != nil {
		t.Errorf("Close: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), ioTimeout)
	defer cancel()
	ws, resp, err := websocket.Dial(ctx, h.http.URL, &websocket.DialOptions{Subprotocols: []string{Protocol}})
	if resp != nil {
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
	}
	if err == nil {
		_ = ws.CloseNow()
		t.Fatal("a closed server accepted a connection")
	}
	if resp == nil || resp.StatusCode != 503 {
		t.Errorf("a closed server answered %v", resp)
	}
}
