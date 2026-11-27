package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

const (
	testOrigin = "https://app.example"
	testToken  = "test-token"
	bobToken   = "bob-token"
	// ioTimeout bounds every wait in a test. It is a failure bound, not a
	// delay: nothing waits for it to pass.
	ioTimeout = 10 * time.Second
)

// fakeClock is a clock that moves only when a test advances it.
type fakeClock struct {
	mu      sync.Mutex
	now     time.Time
	timers  []*fakeTimer
	changed chan struct{}
}

type fakeTimer struct {
	c    *fakeClock
	d    time.Duration
	when time.Time
	f    func()
}

func newFakeClock() *fakeClock {
	return &fakeClock{now: time.Unix(1_800_000_000, 0), changed: make(chan struct{})}
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) AfterFunc(d time.Duration, f func()) timer {
	c.mu.Lock()
	defer c.mu.Unlock()
	t := &fakeTimer{c: c, d: d, when: c.now.Add(d), f: f}
	c.timers = append(c.timers, t)
	close(c.changed)
	c.changed = make(chan struct{})
	return t
}

func (t *fakeTimer) Stop() bool {
	t.c.mu.Lock()
	defer t.c.mu.Unlock()
	i := slices.Index(t.c.timers, t)
	if i < 0 {
		return false
	}
	t.c.timers = slices.Delete(t.c.timers, i, i+1)
	return true
}

// advance moves the clock and fires the timers that come due, each in its
// own goroutine, as time.AfterFunc does.
func (c *fakeClock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	target := c.now.Add(d)
	for {
		i := -1
		for j, t := range c.timers {
			if !t.when.After(target) && (i < 0 || t.when.Before(c.timers[i].when)) {
				i = j
			}
		}
		if i < 0 {
			break
		}
		t := c.timers[i]
		c.timers = slices.Delete(c.timers, i, i+1)
		c.now = t.when
		go t.f()
	}
	c.now = target
}

// awaitTimer blocks until a timer of duration d is pending, so that an
// advance cannot run ahead of the code that arms it.
func (c *fakeClock) awaitTimer(t *testing.T, d time.Duration) {
	t.Helper()
	c.awaitTimers(t, d, 1)
}

// awaitTimers blocks until n timers of duration d are pending.
func (c *fakeClock) awaitTimers(t *testing.T, d time.Duration, n int) {
	t.Helper()
	deadline := time.After(ioTimeout)
	for {
		c.mu.Lock()
		armed := 0
		for _, ft := range c.timers {
			if ft.d == d {
				armed++
			}
		}
		changed := c.changed
		c.mu.Unlock()
		if armed >= n {
			return
		}
		select {
		case <-changed:
		case <-deadline:
			t.Fatalf("%d of %d timers of %s were armed", armed, n, d)
		}
	}
}

func testAuth(_ context.Context, token string) (Principal, error) {
	switch token {
	case testToken:
		return Principal{ID: "alice", Attrs: map[string]string{"role": "admin"}}, nil
	case bobToken:
		return Principal{ID: "bob"}, nil
	case "empty-principal":
		return Principal{}, nil
	case "panic":
		panic("auth backend exploded")
	}
	return Principal{}, errors.New("unknown token")
}

// harness is a server under test behind httptest, on a fake clock.
type harness struct {
	t     *testing.T
	srv   *Server
	clock *fakeClock
	http  *httptest.Server
	// handled receives once for each connection the server has finished
	// with, session detached and all.
	handled chan struct{}

	mu      sync.Mutex
	clients []*client
}

func newHarness(t *testing.T, configure func(*Options), setup func(*Server)) *harness {
	t.Helper()
	opts := Options{
		Authenticate: testAuth,
		Origins:      []string{testOrigin},
		// Out of the way: of tests that advance the clock, and of tests
		// that send many messages while it stands still.
		Limits: Limits{PingInterval: 1000 * time.Hour, ProcWallTime: 1000 * time.Hour, MessagesPerSecond: 1 << 20},
	}
	if configure != nil {
		configure(&opts)
	}
	srv := New(opts)
	clk := newFakeClock()
	srv.clock = clk
	if setup != nil {
		setup(srv)
	}
	h := &harness{t: t, srv: srv, clock: clk, handled: make(chan struct{}, 1024)}
	h.http = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		srv.ServeHTTP(w, r)
		h.handled <- struct{}{}
	}))
	t.Cleanup(func() {
		h.mu.Lock()
		clients := h.clients
		h.mu.Unlock()
		for _, c := range clients {
			_ = c.ws.CloseNow()
		}
		_ = srv.Close()
		h.http.Close()
	})
	return h
}

// awaitHandled blocks until the server has finished with n connections.
func (h *harness) awaitHandled(n int) {
	h.t.Helper()
	for range n {
		select {
		case <-h.handled:
		case <-time.After(ioTimeout):
			h.t.Fatal("server did not finish with the connection")
		}
	}
}

type msg = map[string]any

// client is a rite.1 client for tests.
type client struct {
	t        *testing.T
	ws       *websocket.Conn
	nextID   int
	maxFrame int
}

// dial opens a WebSocket as a browser on testOrigin would. edit changes the
// handshake.
func (h *harness) dial(edit func(*websocket.DialOptions)) *client {
	h.t.Helper()
	opts := &websocket.DialOptions{
		Subprotocols: []string{Protocol},
		HTTPHeader:   http.Header{"Origin": []string{testOrigin}},
	}
	if edit != nil {
		edit(opts)
	}
	ctx, cancel := context.WithTimeout(context.Background(), ioTimeout)
	defer cancel()
	ws, resp, err := websocket.Dial(ctx, h.http.URL, opts)
	if resp != nil && resp.Body != nil {
		_ = resp.Body.Close()
	}
	if err != nil {
		h.t.Fatalf("dial: %v", err)
	}
	ws.SetReadLimit(-1)
	c := &client{t: h.t, ws: ws, nextID: 1}
	h.mu.Lock()
	h.clients = append(h.clients, c)
	h.mu.Unlock()
	return c
}

func helloParamsFor(token, session string) msg {
	p := msg{
		"protocol":     "rite.1",
		"version":      "0.0.0",
		"token":        token,
		"tty":          msg{"cols": 80, "rows": 24},
		"capabilities": []string{},
	}
	if session != "" {
		p["session"] = session
	}
	return p
}

// connect dials and completes rite.hello as alice. It returns the result.
func (h *harness) connect() (*client, msg) {
	h.t.Helper()
	return h.connectAs(testToken, "")
}

func (h *harness) connectAs(token, session string) (*client, msg) {
	h.t.Helper()
	c := h.dial(nil)
	return c, c.call("rite.hello", helloParamsFor(token, session))
}

// sendRaw sends one text frame.
func (c *client) sendRaw(data []byte) {
	c.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), ioTimeout)
	defer cancel()
	if err := c.ws.Write(ctx, websocket.MessageText, data); err != nil {
		c.t.Fatalf("write: %v", err)
	}
}

func (c *client) send(v any) {
	c.t.Helper()
	data, err := json.Marshal(v)
	if err != nil {
		c.t.Fatal(err)
	}
	c.sendRaw(data)
}

// request sends a request and returns its id.
func (c *client) request(method string, params any) int {
	c.t.Helper()
	id := c.nextID
	c.nextID++
	c.send(msg{"jsonrpc": "2.0", "id": id, "method": method, "params": params})
	return id
}

func (c *client) notify(method string, params any) {
	c.t.Helper()
	c.send(msg{"jsonrpc": "2.0", "method": method, "params": params})
}

// readErr reads the next message, or returns why there is none.
func (c *client) readErr() (msg, error) {
	ctx, cancel := context.WithTimeout(context.Background(), ioTimeout)
	defer cancel()
	typ, data, err := c.ws.Read(ctx)
	if err != nil {
		return nil, err
	}
	if typ != websocket.MessageText {
		c.t.Errorf("server sent a %v frame", typ)
	}
	c.maxFrame = max(c.maxFrame, len(data))
	var m msg
	if err := json.Unmarshal(data, &m); err != nil {
		c.t.Errorf("server sent invalid JSON: %v", err)
	}
	if m["jsonrpc"] != "2.0" {
		c.t.Errorf("server message without jsonrpc 2.0: %s", data)
	}
	return m, nil
}

func (c *client) read() msg {
	c.t.Helper()
	m, err := c.readErr()
	if err != nil {
		c.t.Fatalf("read: %v", err)
	}
	return m
}

// response reads the next message and requires it to answer id.
func (c *client) response(id int) msg {
	c.t.Helper()
	m := c.read()
	if got, ok := m["id"].(float64); !ok || int(got) != id {
		c.t.Fatalf("want the response to %d, got %v", id, m)
	}
	return m
}

// call sends a request and returns its result. It fails on an error.
func (c *client) call(method string, params any) msg {
	c.t.Helper()
	m := c.response(c.request(method, params))
	res, ok := m["result"].(map[string]any)
	if !ok {
		c.t.Fatalf("%s: want a result, got %v", method, m)
	}
	return res
}

// callErr sends a request and returns its error.
func (c *client) callErr(method string, params any) msg {
	c.t.Helper()
	m := c.response(c.request(method, params))
	e, ok := m["error"].(map[string]any)
	if !ok {
		c.t.Fatalf("%s: want an error, got %v", method, m)
	}
	return e
}

// sync proves the server has sent nothing the test has not read: the answer
// to a fresh request is the very next message.
func (c *client) sync() {
	c.t.Helper()
	c.call("fs.stat", msg{"path": ""})
}

// wantClose requires the connection to end with code, with no message first.
func (c *client) wantClose(code websocket.StatusCode) {
	c.t.Helper()
	m, err := c.readErr()
	if err == nil {
		c.t.Fatalf("want close %d, got message %v", code, m)
	}
	if got := websocket.CloseStatus(err); got != code {
		c.t.Fatalf("want close %d, got %d (%v)", code, got, err)
	}
}

// wantCloseReason is wantClose that also checks the reason.
func (c *client) wantCloseReason(code websocket.StatusCode, reason string) {
	c.t.Helper()
	m, err := c.readErr()
	if err == nil {
		c.t.Fatalf("want close %d, got message %v", code, m)
	}
	var ce websocket.CloseError
	if !errors.As(err, &ce) || ce.Code != code || ce.Reason != reason {
		c.t.Fatalf("want close %d %q, got %v", code, reason, err)
	}
}

// notification requires the next message to be the notification method and
// returns its params.
func (c *client) notification(method string) msg {
	c.t.Helper()
	m := c.read()
	if m["method"] != method {
		c.t.Fatalf("want %s, got %v", method, m)
	}
	if _, has := m["id"]; has {
		c.t.Fatalf("notification with an id: %v", m)
	}
	p, _ := m["params"].(map[string]any)
	return p
}

func startParamsFor(pid int, argv ...string) msg {
	return msg{
		"pid": pid, "argv": argv, "cwd": "", "env": msg{},
		"stdio": msg{"stdin": "pipe", "stdout": "pipe", "stderr": "pipe"},
	}
}

// start runs argv as pid and requires proc.start to succeed.
func (c *client) start(pid int, argv ...string) {
	c.t.Helper()
	c.call("proc.start", startParamsFor(pid, argv...))
}

// output is what one process sent, in order.
type output struct {
	stdout, stderr string
	code           int
}

// collect reads the notifications of pid up to its exit.
func (c *client) collect(pid int) output {
	c.t.Helper()
	var out output
	for {
		m := c.read()
		p, _ := m["params"].(map[string]any)
		if got, _ := p["pid"].(float64); int(got) != pid {
			c.t.Fatalf("want a notification for pid %d, got %v", pid, m)
		}
		switch m["method"] {
		case methodStdout:
			out.stdout += p["data"].(string)
		case methodStderr:
			out.stderr += p["data"].(string)
		case methodExit:
			out.code = int(p["code"].(float64))
			return out
		default:
			c.t.Fatalf("unexpected message %v", m)
		}
	}
}

func errnoOf(e msg) string {
	data, _ := e["data"].(map[string]any)
	s, _ := data["errno"].(string)
	return s
}

func codeOf(e msg) int {
	f, _ := e["code"].(float64)
	return int(f)
}

// recv waits for a value on ch.
func recv[T any](t *testing.T, ch <-chan T) T {
	t.Helper()
	select {
	case v := <-ch:
		return v
	case <-time.After(ioTimeout):
		t.Fatal("timed out waiting for the server")
		panic("unreachable")
	}
}
