package server

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"sync"
	"sync/atomic"
	"time"
)

// Principal is who a token authenticated.
type Principal struct {
	// ID names the principal. Sessions are bound to it, and the limit on
	// sessions counts by it. It must not be empty.
	ID string
	// Attrs carries what the host wants its commands to know, such as a
	// tenant or a role. The server does not read it.
	Attrs map[string]string
}

// Errors from Session.Notify.
var (
	// ErrNotConnected means the session has no connection, or has expired.
	ErrNotConnected = errors.New("server: session is not connected")
	// ErrLevel means the level is not info, warn, or error.
	ErrLevel = errors.New("server: level must be info, warn, or error")
	// ErrTooLarge means the text does not fit in one message.
	ErrTooLarge = errors.New("server: text exceeds the message limit")
)

var (
	errSessionPrincipal = errors.New("session belongs to another principal")
	errTooManySessions  = errors.New("too many sessions")
)

// Session is a handle on one client session. It stays valid across the
// client's reconnects and for ten minutes after a disconnect.
type Session struct {
	s *session
}

// ID returns the session id.
func (s Session) ID() string {
	if s.s == nil {
		return ""
	}
	return s.s.id
}

// Principal returns who the session belongs to.
func (s Session) Principal() Principal {
	if s.s == nil {
		return Principal{}
	}
	return s.s.principal
}

// Notify sends term.notify to the session's connection. The client prints
// text above the prompt. Level is "info", "warn", or "error".
func (s Session) Notify(level, text string) error {
	switch level {
	case "info", "warn", "error":
	default:
		return ErrLevel
	}
	if s.s == nil {
		return ErrNotConnected
	}
	c := s.s.store.connOf(s.s)
	if c == nil {
		return ErrNotConnected
	}
	msg := encodeNotification("term.notify", notifyParams{Text: text, Level: level})
	if len(msg) > c.limits.MaxMessageBytes {
		return ErrTooLarge
	}
	if err := c.send(msg, nil); err != nil {
		return ErrNotConnected
	}
	return nil
}

type notifyParams struct {
	Text  string `json:"text"`
	Level string `json:"level"`
}

type session struct {
	id        string
	principal Principal
	store     *sessionStore

	// running counts processes whose command has not returned.
	running atomic.Int64
	cols    atomic.Int64
	rows    atomic.Int64

	// Guarded by store.mu.
	conn    *conn
	expires time.Time // set while disconnected
}

func (s *session) setSize(cols, rows int64) {
	s.cols.Store(cols)
	s.rows.Store(rows)
}

func (s *session) size() (cols, rows int) {
	return int(s.cols.Load()), int(s.rows.Load())
}

// acquireProc takes one of the session's process slots.
func (s *session) acquireProc(limit int) bool {
	if s.running.Add(1) > int64(limit) {
		s.running.Add(-1)
		return false
	}
	return true
}

func (s *session) releaseProc() {
	s.running.Add(-1)
}

// sessionStore holds every live session. Sessions live in process memory.
type sessionStore struct {
	mu   sync.Mutex
	byID map[string]*session
}

func newSessionStore() *sessionStore {
	return &sessionStore{byID: make(map[string]*session)}
}

func newSessionID() string {
	var b [sessionIDSize]byte
	// crypto/rand.Read never returns an error.
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// attach binds c to the session named by resume, or to a new one. It returns
// the connection the session had, which the caller closes.
func (st *sessionStore) attach(c *conn, p Principal, resume string, now time.Time, limit int) (s *session, resumed bool, previous *conn, err error) {
	st.mu.Lock()
	defer st.mu.Unlock()

	var held int
	var oldest *session
	for id, s := range st.byID {
		if s.conn == nil && !now.Before(s.expires) {
			delete(st.byID, id)
			continue
		}
		if s.principal.ID != p.ID {
			continue
		}
		held++
		if s.conn == nil && (oldest == nil || s.expires.Before(oldest.expires)) {
			oldest = s
		}
	}

	if s, ok := st.byID[resume]; ok && resume != "" {
		if s.principal.ID != p.ID {
			return nil, false, nil, errSessionPrincipal
		}
		previous = s.conn
		s.conn = c
		s.expires = time.Time{}
		return s, true, previous, nil
	}

	if held >= limit {
		if oldest == nil {
			return nil, false, nil, errTooManySessions
		}
		delete(st.byID, oldest.id)
	}
	s = &session{id: newSessionID(), principal: p, store: st, conn: c}
	st.byID[s.id] = s
	return s, false, nil, nil
}

// detach starts the session's resume window, unless another connection has
// taken the session over.
func (st *sessionStore) detach(s *session, c *conn, now time.Time) {
	st.mu.Lock()
	defer st.mu.Unlock()
	if s.conn == c {
		s.conn = nil
		s.expires = now.Add(sessionTTL)
	}
}

func (st *sessionStore) connOf(s *session) *conn {
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.byID[s.id] != s {
		return nil
	}
	return s.conn
}
