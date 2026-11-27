package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"runtime/debug"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"golang.org/x/time/rate"
)

var (
	errMessageTooBig = errors.New("message too big")
	errNotText       = errors.New("not a text frame")
	errStopped       = errors.New("send stopped")
	errConnClosed    = errors.New("connection closed")
)

// conn is one WebSocket connection. Its reader goroutine (serve) owns the
// handshake and dispatch; one writer goroutine (writeLoop) owns every frame
// the server sends, the close frame included.
type conn struct {
	srv    *Server
	ws     *websocket.Conn
	log    *slog.Logger
	limits Limits
	addr   string

	// ctx ends when the connection is done for.
	ctx    context.Context
	cancel context.CancelFunc

	out        chan []byte
	writerDone chan struct{}

	// closing is closed to ask the writer for a close handshake.
	closing     chan struct{}
	closeOnce   sync.Once
	closeCode   websocket.StatusCode
	closeReason string

	preAuth sync.Once // releases the address's pre-auth slot

	// Set by the handshake, before any other goroutine reads them.
	sess      *session
	principal Principal
	limiter   *rate.Limiter

	// lastActive is when a message last passed in either direction or a
	// process last exited, in nanoseconds of the server's clock. Pings are
	// not messages.
	lastActive atomic.Int64
	pinging    atomic.Bool

	// requests bounds the fs and completion requests in flight.
	requests chan struct{}
	inFlight sync.WaitGroup

	mu      sync.Mutex
	procs   map[int64]*proc
	lastPid int64
	idle    timer
	ping    timer
	down    bool
}

func newConn(s *Server, ws *websocket.Conn, addr string) *conn {
	ctx, cancel := context.WithCancel(context.Background())
	return &conn{
		srv:        s,
		ws:         ws,
		log:        s.log.With(slog.String("remote", addr)),
		limits:     s.limits,
		addr:       addr,
		ctx:        ctx,
		cancel:     cancel,
		out:        make(chan []byte, outQueue),
		writerDone: make(chan struct{}),
		closing:    make(chan struct{}),
		requests:   make(chan struct{}, maxRequests),
		procs:      make(map[int64]*proc),
	}
}

// serve runs the connection to its end.
func (c *conn) serve() {
	// Message size is enforced in readMessage, to choose the close code.
	c.ws.SetReadLimit(-1)
	go c.writeLoop()
	defer c.teardown()
	defer func() {
		// A panic here is a bug in this package or in an OnSession hook.
		// Either way the connection's processes and session are let go.
		if r := recover(); r != nil {
			c.log.Error("rite connection panicked", slog.Any("panic", r), slog.String("stack", string(debug.Stack())))
			c.close(closeServerError, "server error")
		}
	}()
	if c.handshake() {
		c.readLoop()
	}
}

// close asks for the connection to be closed with code. The first call wins.
func (c *conn) close(code websocket.StatusCode, reason string) {
	c.closeOnce.Do(func() {
		c.closeCode, c.closeReason = code, reason
		close(c.closing)
	})
}

// send queues one message for the writer. It blocks while the queue is full,
// which is how a slow client slows its processes down, and gives up when
// stop closes or the connection ends.
func (c *conn) send(msg []byte, stop <-chan struct{}) error {
	select {
	case c.out <- msg:
		return nil
	case <-stop:
		return errStopped
	case <-c.closing:
		return errConnClosed
	case <-c.ctx.Done():
		return errConnClosed
	}
}

func (c *conn) reply(id int64, result any, rerr *rpcError) {
	if rerr != nil {
		_ = c.send(encodeError(&id, rerr), nil)
		return
	}
	_ = c.send(encodeResult(&id, result), nil)
}

func (c *conn) writeLoop() {
	defer close(c.writerDone)
	for {
		select {
		case <-c.closing:
			c.closeHandshake()
			return
		default:
		}
		select {
		case <-c.closing:
			c.closeHandshake()
			return
		case <-c.ctx.Done():
			return
		case msg := <-c.out:
			// Noted before the write, so the client cannot hold a message
			// the idle check has not counted.
			c.touch()
			ctx, cancel := context.WithTimeout(c.ctx, writeTimeout)
			err := c.ws.Write(ctx, websocket.MessageText, msg)
			cancel()
			if err != nil {
				c.log.Debug("rite write failed", slog.Any("error", err))
				c.cancel()
				return
			}
		}
	}
}

func (c *conn) closeHandshake() {
	// Close writes the close frame and waits for the peer's, a few seconds
	// at most.
	_ = c.ws.Close(c.closeCode, c.closeReason)
	c.cancel()
}

// readMessage reads one text frame of at most limit bytes.
func (c *conn) readMessage(limit int) ([]byte, error) {
	typ, r, err := c.ws.Reader(c.ctx)
	if err != nil {
		return nil, err
	}
	data, err := io.ReadAll(io.LimitReader(r, int64(limit)+1))
	if err != nil {
		return nil, err
	}
	if len(data) > limit {
		return nil, errMessageTooBig
	}
	if typ != websocket.MessageText {
		return nil, errNotText
	}
	return data, nil
}

type helloParams struct {
	Protocol *string `json:"protocol"`
	Version  *string `json:"version"`
	Token    *string `json:"token"`
	Session  string  `json:"session"`
	TTY      *struct {
		Cols *int64 `json:"cols"`
		Rows *int64 `json:"rows"`
	} `json:"tty"`
	Capabilities []string `json:"capabilities"`
}

func (p *helloParams) valid() bool {
	return p.Protocol != nil && *p.Protocol == Protocol &&
		p.Version != nil && p.Token != nil && p.Capabilities != nil &&
		p.TTY != nil && validSize(p.TTY.Cols, p.TTY.Rows)
}

const maxTTYSide = 1<<16 - 1

func validSize(cols, rows *int64) bool {
	return cols != nil && rows != nil &&
		*cols >= 0 && *cols <= maxTTYSide && *rows >= 0 && *rows <= maxTTYSide
}

type helloResult struct {
	Session      string        `json:"session"`
	Resumed      bool          `json:"resumed"`
	Commands     []commandInfo `json:"commands"`
	Limits       wireLimits    `json:"limits"`
	Capabilities []string      `json:"capabilities"`
	MOTD         string        `json:"motd,omitempty"`
}

// handshake reads rite.hello, authenticates, and binds a session. It reports
// whether the connection may go on.
func (c *conn) handshake() bool {
	deadline := c.srv.clock.AfterFunc(helloTimeout, func() {
		c.close(closeHelloTimeout, "hello timeout")
	})
	data, err := c.readMessage(preAuthBytes)
	deadline.Stop()
	if err != nil {
		if errors.Is(err, errMessageTooBig) || errors.Is(err, errNotText) {
			c.close(closeBadHello, "bad hello")
		}
		return false
	}
	req, rerr := parseRequest(data)
	if rerr != nil || req == nil || req.ID == nil || req.Method != "rite.hello" {
		c.close(closeBadHello, "bad hello")
		return false
	}
	var p helloParams
	if err := json.Unmarshal(req.Params, &p); err != nil || !p.valid() {
		c.close(closeBadHello, "bad hello")
		return false
	}

	ctx, cancel := context.WithTimeout(c.ctx, authTimeout)
	principal, err := c.srv.auth(ctx, *p.Token)
	timedOut := errors.Is(ctx.Err(), context.DeadlineExceeded)
	cancel()
	switch {
	case err == nil:
	case timedOut || errors.Is(err, errAuthPanic):
		c.log.Error("rite authentication failed to answer", slog.Any("error", err))
		c.close(closeServerError, "authentication unavailable")
		return false
	default:
		c.log.Info("rite authentication refused", slog.Any("error", err))
		c.close(closeUnauthorized, "unauthorized")
		return false
	}

	now := c.srv.clock.Now()
	sess, resumed, previous, err := c.srv.sessions.attach(c, principal, p.Session, now, c.limits.SessionsPerPrincipal)
	switch {
	case errors.Is(err, errSessionPrincipal):
		c.log.Warn("rite resume of another principal's session refused", slog.String("principal", principal.ID))
		c.close(closeUnauthorized, "unauthorized")
		return false
	case err != nil:
		c.log.Info("rite session refused", slog.String("principal", principal.ID), slog.Any("error", err))
		c.close(closeRateLimited, "too many sessions")
		return false
	}
	if previous != nil {
		previous.close(closeSessionReplaced, "session replaced")
	}
	sess.setSize(*p.TTY.Cols, *p.TTY.Rows)
	c.sess = sess
	c.principal = principal
	c.limiter = rate.NewLimiter(rate.Limit(c.limits.MessagesPerSecond), c.limits.MessagesPerSecond)
	c.releasePreAuth()
	c.lastActive.Store(now.UnixNano())

	c.reply(*req.ID, helloResult{
		Session:      sess.id,
		Resumed:      resumed,
		Commands:     c.srv.commandInfos(),
		Limits:       c.limits.wire(),
		Capabilities: []string{},
		MOTD:         c.srv.motd,
	}, nil)
	c.log.Debug("rite session attached", slog.String("principal", principal.ID), slog.String("session", sess.id),
		slog.Bool("resumed", resumed), slog.String("client", *p.Version))
	if !resumed {
		for _, fn := range c.srv.sessionHooks() {
			fn(Session{s: sess})
		}
	}
	c.armIdle(c.limits.IdleTimeout)
	c.armPing()
	return true
}

func (c *conn) releasePreAuth() {
	c.preAuth.Do(func() { c.srv.preAuth.release(c.addr) })
}

func (c *conn) readLoop() {
	for {
		data, err := c.readMessage(c.limits.MaxMessageBytes)
		switch {
		case errors.Is(err, errMessageTooBig):
			c.close(websocket.StatusMessageTooBig, "message too big")
			return
		case errors.Is(err, errNotText):
			c.close(websocket.StatusUnsupportedData, "text frames only")
			return
		case err != nil:
			return
		}
		now := c.touch()
		if !c.limiter.AllowN(now, 1) {
			c.log.Info("rite connection rate limited")
			c.close(closeRateLimited, "rate limited")
			return
		}
		c.dispatch(data)
	}
}

func (c *conn) dispatch(data []byte) {
	req, rerr := parseRequest(data)
	switch {
	case rerr != nil:
		_ = c.send(encodeError(nil, rerr), nil)
	case req == nil:
	case req.ID == nil:
		c.notified(req.Method, req.Params)
	default:
		c.requested(*req.ID, req.Method, req.Params)
	}
}

// decode reads params into T. Unknown fields are ignored.
func decode[T any](raw json.RawMessage) (T, bool) {
	var v T
	err := json.Unmarshal(raw, &v)
	return v, err == nil
}

type pathParams struct {
	Path *string `json:"path"`
}

type readParams struct {
	Path   *string `json:"path"`
	Offset *int64  `json:"offset"`
	Length *int64  `json:"length"`
}

func (c *conn) requested(id int64, method string, raw json.RawMessage) {
	switch method {
	case "rite.hello":
		// One hello per connection.
		c.reply(id, nil, errInvalidRequest)
	case "fs.stat":
		c.async(id, func() (any, *rpcError) {
			p, ok := decode[pathParams](raw)
			if !ok || p.Path == nil {
				return nil, errInvalidParams
			}
			return result(c.srv.fileSystem().stat(*p.Path))
		})
	case "fs.list":
		c.async(id, func() (any, *rpcError) {
			p, ok := decode[pathParams](raw)
			if !ok || p.Path == nil {
				return nil, errInvalidParams
			}
			return result(c.srv.fileSystem().list(*p.Path))
		})
	case "fs.read":
		c.async(id, func() (any, *rpcError) {
			p, ok := decode[readParams](raw)
			if !ok || p.Path == nil || (p.Offset != nil && *p.Offset < 0) || (p.Length != nil && *p.Length < 0) {
				return nil, errInvalidParams
			}
			var offset int64
			if p.Offset != nil {
				offset = *p.Offset
			}
			return result(c.srv.fileSystem().read(*p.Path, offset, p.Length))
		})
	case "proc.complete":
		c.async(id, func() (any, *rpcError) { return c.complete(raw) })
	case "proc.start":
		// In order with the stdin and signals that follow it.
		c.startProc(id, raw)
	default:
		c.reply(id, nil, errMethodNotFound)
	}
}

// result adapts a typed handler result to reply.
func result[T any](v T, rerr *rpcError) (any, *rpcError) {
	if rerr != nil {
		return nil, rerr
	}
	return v, nil
}

// async answers a request off the reader, so a slow file system or completer
// does not hold up signals. The reader waits when maxRequests are in flight.
func (c *conn) async(id int64, handle func() (any, *rpcError)) {
	select {
	case c.requests <- struct{}{}:
	case <-c.closing:
		return
	case <-c.ctx.Done():
		return
	}
	c.inFlight.Go(func() {
		defer func() { <-c.requests }()
		defer func() {
			if r := recover(); r != nil {
				c.log.Error("rite request panicked", slog.Any("panic", r), slog.String("stack", string(debug.Stack())))
				c.reply(id, nil, appError(eio))
			}
		}()
		res, rerr := handle()
		c.reply(id, res, rerr)
	})
}

type stdinParams struct {
	Pid  *int64  `json:"pid"`
	Data *string `json:"data"`
	EOF  bool    `json:"eof"`
}

type signalParams struct {
	Pid    *int64 `json:"pid"`
	Signal string `json:"signal"`
}

type resizeParams struct {
	Cols *int64 `json:"cols"`
	Rows *int64 `json:"rows"`
}

// notified handles a notification. There is no one to tell about a bad one,
// so it is dropped, as an unknown one is.
func (c *conn) notified(method string, raw json.RawMessage) {
	switch method {
	case "proc.stdin":
		p, ok := decode[stdinParams](raw)
		if !ok || p.Pid == nil {
			return
		}
		pr := c.proc(*p.Pid)
		if pr == nil {
			return
		}
		if p.Data != nil && !pr.stdin.push(*p.Data, c.limits.MaxStdinBytes) {
			pr.kill(killedBy("stdin limit"), "rite: "+pr.cmd.Name+": stdin buffer full\n")
			return
		}
		if p.EOF {
			pr.stdin.close()
		}
	case "proc.signal":
		p, ok := decode[signalParams](raw)
		if !ok || p.Pid == nil {
			return
		}
		pr := c.proc(*p.Pid)
		if pr == nil {
			return
		}
		switch p.Signal {
		case "INT":
			pr.interrupt()
		case "KILL":
			pr.kill(ErrKilled, "")
		}
	case "tty.resize":
		p, ok := decode[resizeParams](raw)
		if !ok || !validSize(p.Cols, p.Rows) {
			return
		}
		c.sess.setSize(*p.Cols, *p.Rows)
	}
}

func (c *conn) proc(pid int64) *proc {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.procs[pid]
}

func (c *conn) removeProc(p *proc) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.procs[p.pid] == p {
		delete(c.procs, p.pid)
	}
	c.touch()
}

// touch notes traffic on the connection, for the idle timeout.
func (c *conn) touch() time.Time {
	now := c.srv.clock.Now()
	c.lastActive.Store(now.UnixNano())
	return now
}

// armIdle schedules the idle check. The connection is idle when no message
// has passed in either direction and no process has run for IdleTimeout.
func (c *conn) armIdle(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.down {
		return
	}
	c.idle = c.srv.clock.AfterFunc(d, func() {
		c.mu.Lock()
		running := len(c.procs)
		c.mu.Unlock()
		if running > 0 {
			c.armIdle(c.limits.IdleTimeout)
			return
		}
		quiet := c.srv.clock.Now().Sub(time.Unix(0, c.lastActive.Load()))
		if left := c.limits.IdleTimeout - quiet; left > 0 {
			c.armIdle(left)
			return
		}
		c.close(websocket.StatusNormalClosure, "idle")
	})
}

// armPing schedules the next ping. Pings keep proxies from dropping a quiet
// connection and find a dead one.
func (c *conn) armPing() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.down {
		return
	}
	c.ping = c.srv.clock.AfterFunc(c.limits.PingInterval, func() {
		c.armPing()
		if !c.pinging.CompareAndSwap(false, true) {
			return
		}
		defer c.pinging.Store(false)
		ctx, cancel := context.WithTimeout(c.ctx, pingTimeout)
		defer cancel()
		if err := c.ws.Ping(ctx); err != nil && c.ctx.Err() == nil {
			c.log.Debug("rite ping failed", slog.Any("error", err))
			c.cancel()
		}
	})
}

// teardown ends everything the connection owns. No process survives it.
func (c *conn) teardown() {
	c.mu.Lock()
	c.down = true
	procs := make([]*proc, 0, len(c.procs))
	for _, p := range c.procs {
		procs = append(procs, p)
	}
	if c.idle != nil {
		c.idle.Stop()
	}
	if c.ping != nil {
		c.ping.Stop()
	}
	c.mu.Unlock()

	for _, p := range procs {
		p.kill(ErrDisconnected, "")
	}
	c.releasePreAuth()
	if c.sess != nil {
		c.srv.sessions.detach(c.sess, c, c.srv.clock.Now())
	}

	// Let the writer finish a close handshake it was asked for, so the client
	// gets the code.
	select {
	case <-c.closing:
		<-c.writerDone
	default:
	}
	c.cancel()
	_ = c.ws.CloseNow()
	<-c.writerDone
	c.inFlight.Wait()
	c.log.Debug("rite connection closed")
}
