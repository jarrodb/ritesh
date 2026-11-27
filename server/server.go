package server

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"sync"

	"github.com/coder/websocket"
)

// Close codes of rite.1.
const (
	closeBadHello        websocket.StatusCode = 4000
	closeUnauthorized    websocket.StatusCode = 4001
	closeOrigin          websocket.StatusCode = 4003
	closeHelloTimeout    websocket.StatusCode = 4008
	closeRateLimited     websocket.StatusCode = 4029
	closeSessionReplaced websocket.StatusCode = 4040
	closeServerError     websocket.StatusCode = 4500
)

// Options configures a Server.
type Options struct {
	// Authenticate turns the token of a rite.hello into a principal. An
	// error closes the connection as unauthorized (4001), which the client
	// does not retry. A context that ran out closes it as a server error
	// (4500), which the client does. The server never logs the token.
	// Without Authenticate every connection is refused.
	Authenticate func(ctx context.Context, token string) (Principal, error)
	// Origins lists the origins that may connect, each as scheme://host or
	// scheme://host:port. The Origin header must name one of them exactly;
	// there are no patterns. A request without an Origin is refused.
	Origins []string
	// Limits bounds each client. Zero fields take their defaults.
	Limits Limits
	// Logger receives the server's logs. Nil discards them.
	Logger *slog.Logger
	// MOTD, when set, is shown by the client after it connects.
	MOTD string
}

// Server serves rite.1 to browsers. It is an http.Handler: route the
// WebSocket endpoint to it. Sessions live in process memory, so run one
// replica or pin clients to one.
type Server struct {
	authenticate func(ctx context.Context, token string) (Principal, error)
	origins      originSet
	limits       Limits
	log          *slog.Logger
	motd         string
	clock        clock
	sessions     *sessionStore
	preAuth      *addrCounter

	mu        sync.RWMutex
	mounts    mounts
	commands  []*Command
	onSession []func(Session)
	conns     map[*conn]struct{}
	closed    bool
	handlers  sync.WaitGroup
}

// New returns a server with no mounts and no commands. It panics when an
// entry of Options.Origins is not an origin.
func New(opts Options) *Server {
	origins, err := newOriginSet(opts.Origins)
	if err != nil {
		panic("server: " + err.Error())
	}
	log := opts.Logger
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	if opts.Authenticate == nil {
		log.Warn("rite server has no Authenticate: every connection will be refused")
	}
	return &Server{
		authenticate: opts.Authenticate,
		origins:      origins,
		limits:       opts.Limits.withDefaults(),
		log:          log,
		motd:         opts.MOTD,
		clock:        realClock{},
		sessions:     newSessionStore(),
		preAuth:      &addrCounter{n: make(map[string]int)},
		conns:        make(map[*conn]struct{}),
	}
}

// Mount serves fsys, read-only, at path under the remote's root: "/" for the
// root itself. For files on disk pass os.OpenRoot(dir) and its FS method,
// which the operating system confines to dir. Mount panics on a path that is
// not clean or is already mounted.
func (s *Server) Mount(path string, fsys fs.FS) {
	at, ok := cleanMountPath(path)
	if !ok || fsys == nil {
		panic(fmt.Sprintf("server: Mount(%q): invalid path or nil file system", path))
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.mounts.has(at) {
		panic(fmt.Sprintf("server: Mount(%q): already mounted", path))
	}
	s.mounts = s.mounts.add(mount{at: at, fsys: fsys})
}

// Command registers a command. Commands are reported to clients in the order
// they were registered. Command panics on an empty or repeated name, a nil
// Run, or an unknown flag type.
func (s *Server) Command(c Command) {
	if c.Name == "" || c.Run == nil {
		panic("server: Command needs a Name and a Run")
	}
	if len(c.Flags) > 0 {
		flags := make(map[string]Flag, len(c.Flags))
		for name, f := range c.Flags {
			switch f.Type {
			case "":
				f.Type = FlagBoolean
			case FlagBoolean, FlagString, FlagNumber:
			default:
				panic(fmt.Sprintf("server: Command(%q): flag %q has type %q", c.Name, name, f.Type))
			}
			flags[name] = f
		}
		c.Flags = flags
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.lookupLocked(c.Name) != nil {
		panic(fmt.Sprintf("server: Command(%q): already registered", c.Name))
	}
	s.commands = append(s.commands, &c)
}

// OnSession registers fn to be called with each new session, after the
// client has its rite.hello result. A resumed session is not new. fn runs on
// the connection's reader and must not block; keep the Session to notify the
// client later.
func (s *Server) OnSession(fn func(Session)) {
	if fn == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.onSession = append(s.onSession, fn)
}

func (s *Server) lookupLocked(name string) *Command {
	for _, c := range s.commands {
		if c.Name == name {
			return c
		}
	}
	return nil
}

func (s *Server) lookup(name string) *Command {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.lookupLocked(name)
}

func (s *Server) commandInfos() []commandInfo {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]commandInfo, 0, len(s.commands))
	for _, c := range s.commands {
		out = append(out, c.info())
	}
	return out
}

func (s *Server) fileSystem() fileSystem {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return fileSystem{mounts: s.mounts, limits: s.limits, log: s.log}
}

func (s *Server) sessionHooks() []func(Session) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.onSession
}

// ServeHTTP upgrades the request to a rite.1 WebSocket and serves it until
// the connection ends.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !s.enter() {
		http.Error(w, "server closed", http.StatusServiceUnavailable)
		return
	}
	defer s.handlers.Done()

	// The origin is checked here, by exact match. Accept's own check takes
	// host patterns and always allows the request's host.
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		Subprotocols:       []string{Protocol},
		InsecureSkipVerify: true,
	})
	if err != nil {
		s.log.Debug("rite upgrade refused", slog.String("remote", r.RemoteAddr), slog.Any("error", err))
		return
	}
	// The reasons are told through close codes, which a browser can read. It
	// cannot read the status of a refused upgrade.
	addr := remoteHost(r.RemoteAddr)
	switch {
	case !s.origins.allows(r.Header):
		s.log.Info("rite origin refused", slog.String("remote", addr), slog.String("origin", r.Header.Get("Origin")))
		_ = ws.Close(closeOrigin, "origin not allowed")
		return
	case ws.Subprotocol() != Protocol:
		_ = ws.Close(websocket.StatusPolicyViolation, "subprotocol rite.1 required")
		return
	case !s.preAuth.acquire(addr, s.limits.PreAuthPerAddress):
		s.log.Info("rite connection refused: too many awaiting hello", slog.String("remote", addr))
		_ = ws.Close(closeRateLimited, "too many connections")
		return
	}

	c := newConn(s, ws, addr)
	if !s.track(c) {
		s.preAuth.release(addr)
		_ = ws.Close(websocket.StatusGoingAway, "server closing")
		return
	}
	defer s.untrack(c)
	c.serve()
}

// Close ends every connection and waits for their handlers to return. New
// connections are refused afterwards. Commands are cancelled, not waited for.
func (s *Server) Close() error {
	s.mu.Lock()
	s.closed = true
	conns := make([]*conn, 0, len(s.conns))
	for c := range s.conns {
		conns = append(conns, c)
	}
	s.mu.Unlock()
	for _, c := range conns {
		c.close(websocket.StatusGoingAway, "server closing")
	}
	s.handlers.Wait()
	return nil
}

func (s *Server) enter() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return false
	}
	s.handlers.Add(1)
	return true
}

func (s *Server) track(c *conn) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return false
	}
	s.conns[c] = struct{}{}
	return true
}

func (s *Server) untrack(c *conn) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.conns, c)
}

var errAuthPanic = errors.New("authenticate panicked")

// auth calls the host's Authenticate. It never logs the token.
func (s *Server) auth(ctx context.Context, token string) (p Principal, err error) {
	if s.authenticate == nil {
		return Principal{}, errors.New("no Authenticate configured")
	}
	defer func() {
		if r := recover(); r != nil {
			s.log.Error("rite Authenticate panicked", slog.Any("panic", r))
			err = errAuthPanic
		}
	}()
	p, err = s.authenticate(ctx, token)
	if err == nil && p.ID == "" {
		return Principal{}, errors.New("authenticate returned a principal without an ID")
	}
	return p, err
}

func remoteHost(addr string) string {
	if host, _, err := net.SplitHostPort(addr); err == nil {
		return host
	}
	return addr
}

// addrCounter counts connections per address.
type addrCounter struct {
	mu sync.Mutex
	n  map[string]int
}

func (a *addrCounter) acquire(addr string, limit int) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.n[addr] >= limit {
		return false
	}
	a.n[addr]++
	return true
}

func (a *addrCounter) release(addr string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.n[addr] <= 1 {
		delete(a.n, addr)
		return
	}
	a.n[addr]--
}
