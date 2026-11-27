package server

import "time"

// Limits bounds what one client can make the server do. A zero or negative
// field takes its default, the value DefaultLimits starts with.
type Limits struct {
	// MaxMessageBytes is the largest message either side may send.
	// Reported in rite.hello. The floor is 1024.
	MaxMessageBytes int
	// MaxProcs is the number of processes a session may run at once.
	// Reported in rite.hello.
	MaxProcs int
	// MaxOutputBytes is what one process may write to stdout and stderr
	// together. A process that passes it is killed, and proc.stderr says why.
	// Reported in rite.hello.
	MaxOutputBytes int64
	// IdleTimeout closes a connection, with code 1000 and reason "idle",
	// once no message has passed in either direction and no process has run
	// for this long. Pings do not count. Reported in rite.hello as
	// idleSeconds.
	IdleTimeout time.Duration

	// PingInterval is the time between WebSocket pings. Keep it below the
	// idle timeout of any proxy in front of the server.
	PingInterval time.Duration
	// MessagesPerSecond is the rate of client messages on one connection.
	// One second's worth may arrive at once. Past it the connection closes
	// with 4029.
	MessagesPerSecond int
	// SessionsPerPrincipal is the number of sessions, connected or within
	// their resume window, one principal may hold. A new session past it
	// replaces the principal's oldest disconnected one, or closes with 4029
	// when all are connected.
	SessionsPerPrincipal int
	// PreAuthPerAddress is the number of connections from one address that
	// may wait for rite.hello at once. Past it a connection closes with 4029.
	PreAuthPerAddress int
	// ProcWallTime is how long one process may run before it is killed.
	ProcWallTime time.Duration
	// MaxStdinBytes is the stdin a process may leave unread. A process whose
	// buffer passes it is killed, and proc.stderr says why.
	MaxStdinBytes int
	// MaxArgs and MaxArgBytes bound argv in proc.start and proc.complete.
	MaxArgs     int
	MaxArgBytes int
	// MaxEnvVars and MaxEnvBytes bound env in proc.start. The bytes count
	// names and values.
	MaxEnvVars  int
	MaxEnvBytes int
	// MaxPathBytes bounds a path or cwd.
	MaxPathBytes int
	// MaxReadBytes bounds the bytes one fs.read returns.
	MaxReadBytes int64
	// MaxListEntries bounds the entries one fs.list returns.
	MaxListEntries int
}

// DefaultLimits holds the default of every limit.
var DefaultLimits = defaultLimits()

func defaultLimits() Limits {
	return Limits{
		MaxMessageBytes:      64 << 10,
		MaxProcs:             4,
		MaxOutputBytes:       1 << 20,
		IdleTimeout:          5 * time.Minute,
		PingInterval:         30 * time.Second,
		MessagesPerSecond:    100,
		SessionsPerPrincipal: 8,
		PreAuthPerAddress:    16,
		ProcWallTime:         30 * time.Minute,
		MaxStdinBytes:        1 << 20,
		MaxArgs:              256,
		MaxArgBytes:          32 << 10,
		MaxEnvVars:           64,
		MaxEnvBytes:          16 << 10,
		MaxPathBytes:         4096,
		MaxReadBytes:         48 << 10,
		MaxListEntries:       1024,
	}
}

const minMessageBytes = 1024

// Fixed by the protocol.
const (
	helloTimeout  = 5 * time.Second
	preAuthBytes  = 8 << 10
	sessionTTL    = 10 * time.Minute
	sessionIDSize = 16
)

// Not part of the protocol.
const (
	authTimeout  = 10 * time.Second
	writeTimeout = 10 * time.Second
	pingTimeout  = 10 * time.Second
	// killGrace is how long a killed command has to return before the server
	// reports its exit anyway.
	killGrace = 2 * time.Second
	// maxRequests is how many fs and completion requests one connection runs
	// at once.
	maxRequests = 8
	// outQueue is the number of messages that may wait for the writer.
	outQueue = 64
	// envelopeBytes is room for the JSON-RPC envelope around a payload.
	envelopeBytes = 256
)

func (l Limits) withDefaults() Limits {
	d := defaultLimits()
	num := func(v *int, def int) {
		if *v <= 0 {
			*v = def
		}
	}
	num64 := func(v *int64, def int64) {
		if *v <= 0 {
			*v = def
		}
	}
	dur := func(v *time.Duration, def time.Duration) {
		if *v <= 0 {
			*v = def
		}
	}
	num(&l.MaxMessageBytes, d.MaxMessageBytes)
	num(&l.MaxProcs, d.MaxProcs)
	num64(&l.MaxOutputBytes, d.MaxOutputBytes)
	dur(&l.IdleTimeout, d.IdleTimeout)
	dur(&l.PingInterval, d.PingInterval)
	num(&l.MessagesPerSecond, d.MessagesPerSecond)
	num(&l.SessionsPerPrincipal, d.SessionsPerPrincipal)
	num(&l.PreAuthPerAddress, d.PreAuthPerAddress)
	dur(&l.ProcWallTime, d.ProcWallTime)
	num(&l.MaxStdinBytes, d.MaxStdinBytes)
	num(&l.MaxArgs, d.MaxArgs)
	num(&l.MaxArgBytes, d.MaxArgBytes)
	num(&l.MaxEnvVars, d.MaxEnvVars)
	num(&l.MaxEnvBytes, d.MaxEnvBytes)
	num(&l.MaxPathBytes, d.MaxPathBytes)
	num64(&l.MaxReadBytes, d.MaxReadBytes)
	num(&l.MaxListEntries, d.MaxListEntries)
	l.MaxMessageBytes = max(l.MaxMessageBytes, minMessageBytes)
	return l
}

// payloadBudget is the size a result or params object may take so that its
// message stays within MaxMessageBytes.
func (l Limits) payloadBudget() int {
	return l.MaxMessageBytes - envelopeBytes
}

type wireLimits struct {
	MaxMessageBytes int   `json:"maxMessageBytes"`
	MaxProcs        int   `json:"maxProcs"`
	MaxOutputBytes  int64 `json:"maxOutputBytes"`
	IdleSeconds     int64 `json:"idleSeconds"`
}

func (l Limits) wire() wireLimits {
	return wireLimits{
		MaxMessageBytes: l.MaxMessageBytes,
		MaxProcs:        l.MaxProcs,
		MaxOutputBytes:  l.MaxOutputBytes,
		IdleSeconds:     int64(l.IdleTimeout / time.Second),
	}
}
