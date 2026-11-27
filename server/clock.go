package server

import "time"

// clock is the server's source of time, so tests can drive timeouts.
type clock interface {
	Now() time.Time
	// AfterFunc calls f in its own goroutine after d.
	AfterFunc(d time.Duration, f func()) timer
}

type timer interface {
	Stop() bool
}

type realClock struct{}

func (realClock) Now() time.Time { return time.Now() }

func (realClock) AfterFunc(d time.Duration, f func()) timer { return time.AfterFunc(d, f) }
