package server

import (
	"strings"
	"unicode/utf8"
)

const replacement = "\ufffd"

// utf8Stream turns the bytes a process writes into UTF-8 text. It holds a
// code point split across writes until the rest arrives and replaces each
// invalid byte with U+FFFD.
type utf8Stream struct {
	pending [utf8.UTFMax]byte
	n       int
}

// feed returns the text that b completes.
func (s *utf8Stream) feed(b []byte) string {
	if s.n == 0 && utf8.Valid(b) {
		return string(b)
	}
	if s.n > 0 {
		b = append(s.pending[:s.n:s.n], b...)
		s.n = 0
	}
	var out strings.Builder
	out.Grow(len(b))
	for len(b) > 0 {
		if !utf8.FullRune(b) {
			// The start of a code point: at most three bytes.
			s.n = copy(s.pending[:], b)
			break
		}
		r, size := utf8.DecodeRune(b)
		if r == utf8.RuneError && size == 1 {
			out.WriteString(replacement)
		} else {
			out.Write(b[:size])
		}
		b = b[size:]
	}
	return out.String()
}

// flush returns the text for a code point that never completed.
func (s *utf8Stream) flush() string {
	n := s.n
	s.n = 0
	return strings.Repeat(replacement, n)
}

// validText returns b as UTF-8 text with each invalid byte replaced.
func validText(b []byte) string {
	if utf8.Valid(b) {
		return string(b)
	}
	var s utf8Stream
	return s.feed(b) + s.flush()
}

// cutText returns the largest n <= limit such that b[:n] does not end inside
// a code point that b completes. When the first code point alone is longer
// than limit, it returns that code point's length so a reader makes progress.
func cutText(b []byte, limit int64) int64 {
	if int64(len(b)) <= limit {
		return int64(len(b))
	}
	if limit <= 0 {
		return 0
	}
	n := limit
	// Step back over continuation bytes to the start of the last code point.
	start := n
	for start > 0 && n-start < utf8.UTFMax-1 && !utf8.RuneStart(b[start]) {
		start--
	}
	if r, size := utf8.DecodeRune(b[start:]); r != utf8.RuneError || size > 1 {
		if end := start + int64(size); end > n {
			n = start
			if n == 0 {
				n = end
			}
		}
	}
	return n
}
