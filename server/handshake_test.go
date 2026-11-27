package server

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"sync"
	"testing"

	"github.com/coder/websocket"
)

func helloFrame(t *testing.T, edit func(params msg, envelope msg)) []byte {
	t.Helper()
	params := helloParamsFor(testToken, "")
	envelope := msg{"jsonrpc": "2.0", "id": 1, "method": "rite.hello", "params": params}
	if edit != nil {
		edit(params, envelope)
	}
	data, err := json.Marshal(envelope)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// TestFirstMessage covers what the server accepts before authentication:
// one rite.hello request, and nothing else.
func TestFirstMessage(t *testing.T) {
	tests := []struct {
		name  string
		frame func(t *testing.T) []byte
		close websocket.StatusCode // 0: hello succeeds
	}{
		{"hello", func(t *testing.T) []byte { return helloFrame(t, nil) }, 0},
		{"hello with unknown fields", func(t *testing.T) []byte {
			return helloFrame(t, func(p, e msg) { p["future"] = msg{"x": 1}; e["extra"] = true })
		}, 0},
		{"hello with a session that does not exist", func(t *testing.T) []byte {
			return helloFrame(t, func(p, _ msg) { p["session"] = "00000000000000000000000000000000" })
		}, 0},
		{"another request", func(*testing.T) []byte {
			return []byte(`{"jsonrpc":"2.0","id":1,"method":"fs.stat","params":{"path":""}}`)
		}, closeBadHello},
		{"a notification", func(*testing.T) []byte {
			return []byte(`{"jsonrpc":"2.0","method":"tty.resize","params":{"cols":80,"rows":24}}`)
		}, closeBadHello},
		{"hello as a notification", func(t *testing.T) []byte {
			return helloFrame(t, func(_, e msg) { delete(e, "id") })
		}, closeBadHello},
		{"hello with a string id", func(t *testing.T) []byte {
			return helloFrame(t, func(_, e msg) { e["id"] = "1" })
		}, closeBadHello},
		{"hello without jsonrpc", func(t *testing.T) []byte {
			return helloFrame(t, func(_, e msg) { delete(e, "jsonrpc") })
		}, closeBadHello},
		{"hello without params", func(t *testing.T) []byte {
			return helloFrame(t, func(_, e msg) { delete(e, "params") })
		}, closeBadHello},
		{"another protocol", func(t *testing.T) []byte {
			return helloFrame(t, func(p, _ msg) { p["protocol"] = "rite.2" })
		}, closeBadHello},
		{"no protocol", func(t *testing.T) []byte {
			return helloFrame(t, func(p, _ msg) { delete(p, "protocol") })
		}, closeBadHello},
		{"no version", func(t *testing.T) []byte {
			return helloFrame(t, func(p, _ msg) { delete(p, "version") })
		}, closeBadHello},
		{"no token", func(t *testing.T) []byte {
			return helloFrame(t, func(p, _ msg) { delete(p, "token") })
		}, closeBadHello},
		{"token of the wrong type", func(t *testing.T) []byte {
			return helloFrame(t, func(p, _ msg) { p["token"] = 7 })
		}, closeBadHello},
		{"no tty", func(t *testing.T) []byte {
			return helloFrame(t, func(p, _ msg) { delete(p, "tty") })
		}, closeBadHello},
		{"tty without rows", func(t *testing.T) []byte {
			return helloFrame(t, func(p, _ msg) { p["tty"] = msg{"cols": 80} })
		}, closeBadHello},
		{"tty with a negative size", func(t *testing.T) []byte {
			return helloFrame(t, func(p, _ msg) { p["tty"] = msg{"cols": -1, "rows": 24} })
		}, closeBadHello},
		{"tty with a huge size", func(t *testing.T) []byte {
			return helloFrame(t, func(p, _ msg) { p["tty"] = msg{"cols": 80, "rows": 1 << 40} })
		}, closeBadHello},
		{"no capabilities", func(t *testing.T) []byte {
			return helloFrame(t, func(p, _ msg) { delete(p, "capabilities") })
		}, closeBadHello},
		{"not JSON", func(*testing.T) []byte { return []byte(`{"jsonrpc":`) }, closeBadHello},
		{"a batch", func(t *testing.T) []byte {
			return append(append([]byte("["), helloFrame(t, nil)...), ']')
		}, closeBadHello},
		{"a response", func(*testing.T) []byte { return []byte(`{"jsonrpc":"2.0","id":1,"result":{}}`) }, closeBadHello},
		{"the wrong token", func(t *testing.T) []byte {
			return helloFrame(t, func(p, _ msg) { p["token"] = "wrong" })
		}, closeUnauthorized},
		{"an empty token", func(t *testing.T) []byte {
			return helloFrame(t, func(p, _ msg) { p["token"] = "" })
		}, closeUnauthorized},
		{"a principal without an ID", func(t *testing.T) []byte {
			return helloFrame(t, func(p, _ msg) { p["token"] = "empty-principal" })
		}, closeUnauthorized},
		{"Authenticate panics", func(t *testing.T) []byte {
			return helloFrame(t, func(p, _ msg) { p["token"] = "panic" })
		}, closeServerError},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newHarness(t, nil, nil)
			c := h.dial(nil)
			c.sendRaw(tt.frame(t))
			if tt.close != 0 {
				c.wantClose(tt.close)
				return
			}
			res, ok := c.response(1)["result"].(map[string]any)
			if !ok || len(res["session"].(string)) != 2*sessionIDSize || res["resumed"] != false {
				t.Errorf("hello result %v", res)
			}
			c.sync()
		})
	}
}

// paddedHello returns a valid hello frame of exactly size bytes.
func paddedHello(t *testing.T, size int) []byte {
	t.Helper()
	base := helloFrame(t, func(p, _ msg) { p["version"] = "" })
	pad := size - len(base)
	if pad < 0 {
		t.Fatalf("hello is already %d bytes", len(base))
	}
	frame := helloFrame(t, func(p, _ msg) { p["version"] = strings.Repeat("v", pad) })
	if len(frame) != size {
		t.Fatalf("padded hello is %d bytes, want %d", len(frame), size)
	}
	return frame
}

func TestPreAuthMessageSize(t *testing.T) {
	tests := []struct {
		name  string
		size  int
		close websocket.StatusCode
	}{
		{"8 KiB", preAuthBytes, 0},
		{"8 KiB and a byte", preAuthBytes + 1, closeBadHello},
		{"far too big", 4 * preAuthBytes, closeBadHello},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newHarness(t, nil, nil)
			c := h.dial(nil)
			c.sendRaw(paddedHello(t, tt.size))
			if tt.close != 0 {
				c.wantClose(tt.close)
				return
			}
			c.response(1)
		})
	}
}

func TestBinaryHelloIsRefused(t *testing.T) {
	h := newHarness(t, nil, nil)
	c := h.dial(nil)
	if err := c.ws.Write(context.Background(), websocket.MessageBinary, helloFrame(t, nil)); err != nil {
		t.Fatal(err)
	}
	c.wantClose(closeBadHello)
}

func TestHelloTimeout(t *testing.T) {
	t.Run("closes 4008 after 5 s without hello", func(t *testing.T) {
		h := newHarness(t, nil, nil)
		c := h.dial(nil)
		h.clock.awaitTimer(t, helloTimeout)
		h.clock.advance(helloTimeout)
		c.wantClose(closeHelloTimeout)
	})
	t.Run("hello just inside the deadline is served", func(t *testing.T) {
		h := newHarness(t, nil, nil)
		c := h.dial(nil)
		h.clock.awaitTimer(t, helloTimeout)
		h.clock.advance(helloTimeout - 1)
		c.call("rite.hello", helloParamsFor(testToken, ""))
		// The deadline is behind an authenticated connection.
		h.clock.advance(helloTimeout)
		c.sync()
	})
}

func TestSecondHelloIsAnError(t *testing.T) {
	h := newHarness(t, nil, nil)
	c, _ := h.connect()
	if e := c.callErr("rite.hello", helloParamsFor(testToken, "")); codeOf(e) != codeInvalidRequest {
		t.Errorf("second hello: %v", e)
	}
	c.sync()
}

func TestPreAuthPerAddress(t *testing.T) {
	h := newHarness(t, func(o *Options) { o.Limits.PreAuthPerAddress = 2 }, nil)
	first := h.dial(nil)
	second := h.dial(nil)
	// Both hold a slot once the server waits for their hello.
	h.clock.awaitTimers(t, helloTimeout, 2)
	h.dial(nil).wantClose(closeRateLimited)

	// Authenticating frees a slot. So does leaving.
	first.call("rite.hello", helloParamsFor(testToken, ""))
	third := h.dial(nil)
	third.call("rite.hello", helloParamsFor(testToken, ""))
	_ = second.ws.CloseNow()
	h.awaitHandled(2) // the refused connection and second
	h.dial(nil).call("rite.hello", helloParamsFor(testToken, ""))
	h.dial(nil).call("rite.hello", helloParamsFor(testToken, ""))
}

// lockedBuffer is a bytes.Buffer safe for the server's goroutines.
type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func TestTokenIsNeverLogged(t *testing.T) {
	const secret = "s3cr3t-t0ken-value"
	var logs lockedBuffer
	h := newHarness(t, func(o *Options) {
		o.Logger = slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
		o.Authenticate = func(_ context.Context, token string) (Principal, error) {
			if token == secret {
				return Principal{ID: "alice"}, nil
			}
			return Principal{}, context.DeadlineExceeded
		}
	}, nil)

	good := h.dial(nil)
	good.call("rite.hello", helloParamsFor(secret, ""))
	good.callErr("fs.nope", msg{"token": secret})
	bad := h.dial(nil)
	bad.sendRaw(helloFrame(t, func(p, _ msg) { p["token"] = secret + "-wrong" }))
	bad.wantClose(closeUnauthorized)
	malformed := h.dial(nil)
	malformed.sendRaw([]byte(`{"jsonrpc":"2.0","id":1,"method":"rite.hello","params":{"token":"` + secret + `"`))
	malformed.wantClose(closeBadHello)
	_ = good.ws.CloseNow()
	h.awaitHandled(3)

	out := logs.String()
	if !strings.Contains(out, "rite session attached") || !strings.Contains(out, "rite authentication refused") {
		t.Fatalf("the logger saw too little to prove anything:\n%s", out)
	}
	if strings.Contains(out, secret) {
		t.Errorf("the token is in the logs:\n%s", out)
	}
}
