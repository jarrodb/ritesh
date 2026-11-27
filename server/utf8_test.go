package server

import (
	"context"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestUTF8Stream(t *testing.T) {
	tests := []struct {
		name   string
		chunks []string // what each Write carries
		want   []string // the text each Write releases
		flush  string   // the text released when the process exits
	}{
		{"ascii", []string{"abc", "def"}, []string{"abc", "def"}, ""},
		{"empty write", []string{"", "a", ""}, []string{"", "a", ""}, ""},
		{"whole code points", []string{"h\u00e9", "\u20ac", "\U0001f600"}, []string{"h\u00e9", "\u20ac", "\U0001f600"}, ""},
		{"two bytes split", []string{"h\xc3", "\xa9llo"}, []string{"h", "\u00e9llo"}, ""},
		{"three bytes split 1+2", []string{"\xe2", "\x82\xac"}, []string{"", "\u20ac"}, ""},
		{"three bytes split 2+1", []string{"\xe2\x82", "\xac!"}, []string{"", "\u20ac!"}, ""},
		{"three bytes, one per write", []string{"\xe2", "\x82", "\xac"}, []string{"", "", "\u20ac"}, ""},
		{"four bytes split 1+3", []string{"\xf0", "\x9f\x98\x80"}, []string{"", "\U0001f600"}, ""},
		{"four bytes split 2+2", []string{"a\xf0\x9f", "\x98\x80b"}, []string{"a", "\U0001f600b"}, ""},
		{"four bytes split 3+1", []string{"\xf0\x9f\x98", "\x80"}, []string{"", "\U0001f600"}, ""},
		{"four bytes, one per write", []string{"\xf0", "\x9f", "\x98", "\x80"}, []string{"", "", "", "\U0001f600"}, ""},
		{"split with empty writes between", []string{"\xe2", "", "\x82", "", "\xac"}, []string{"", "", "", "", "\u20ac"}, ""},
		{"split twice in one write", []string{"\xc3", "\xa9\xc3", "\xa9"}, []string{"", "\u00e9", "\u00e9"}, ""},

		{"invalid byte", []string{"a\xffb"}, []string{"a\ufffdb"}, ""},
		{"each invalid byte is replaced", []string{"\xff\xfe\xfd"}, []string{"\ufffd\ufffd\ufffd"}, ""},
		{"stray continuation bytes", []string{"\x80\x80"}, []string{"\ufffd\ufffd"}, ""},
		{"overlong encoding", []string{"\xc0\xaf"}, []string{"\ufffd\ufffd"}, ""},
		{"surrogate half", []string{"\xed\xa0\x80"}, []string{"\ufffd\ufffd\ufffd"}, ""},
		{"beyond U+10FFFF", []string{"\xf4\x90\x80\x80"}, []string{"\ufffd\ufffd\ufffd\ufffd"}, ""},
		{"start byte then ascii", []string{"\xe2A"}, []string{"\ufffdA"}, ""},
		{"start byte, then ascii in the next write", []string{"\xe2\x82", "A"}, []string{"", "\ufffd\ufffdA"}, ""},
		{"start byte, then a start byte in the next write", []string{"\xf0\x9f", "\xe2\x82\xac"}, []string{"", "\ufffd\ufffd\u20ac"}, ""},
		{"held bytes turn invalid, the tail is held again", []string{"\xf0\x9f", "\xe2"}, []string{"", "\ufffd\ufffd"}, "\ufffd"},
		{"literal U+FFFD passes", []string{"\ufffd"}, []string{"\ufffd"}, ""},
		{"NUL passes", []string{"a\x00b"}, []string{"a\x00b"}, ""},

		{"cut off at exit, one byte", []string{"ok\xe2"}, []string{"ok"}, "\ufffd"},
		{"cut off at exit, two bytes", []string{"ok\xe2\x82"}, []string{"ok"}, "\ufffd\ufffd"},
		{"cut off at exit, three bytes", []string{"\xf0\x9f\x98"}, []string{""}, "\ufffd\ufffd\ufffd"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var s utf8Stream
			for i, chunk := range tt.chunks {
				got := s.feed([]byte(chunk))
				if got != tt.want[i] {
					t.Errorf("write %d (%q) released %q, want %q", i, chunk, got, tt.want[i])
				}
				if !utf8.ValidString(got) {
					t.Errorf("write %d released invalid UTF-8 %q", i, got)
				}
			}
			if got := s.flush(); got != tt.flush {
				t.Errorf("flush released %q, want %q", got, tt.flush)
			}
			if got := s.flush(); got != "" {
				t.Errorf("second flush released %q", got)
			}
		})
	}
}

// TestUTF8StreamEveryBoundary cuts a text at every pair of byte offsets and
// expects it back unchanged.
func TestUTF8StreamEveryBoundary(t *testing.T) {
	const text = "a\u00e9\u20ac\U0001f600z\u00f6\U0001f9ea"
	for i := 0; i <= len(text); i++ {
		for j := i; j <= len(text); j++ {
			var s utf8Stream
			var got strings.Builder
			for _, chunk := range []string{text[:i], text[i:j], text[j:]} {
				out := s.feed([]byte(chunk))
				if !utf8.ValidString(out) {
					t.Fatalf("cut at %d and %d: invalid output %q", i, j, out)
				}
				got.WriteString(out)
			}
			got.WriteString(s.flush())
			if got.String() != text {
				t.Fatalf("cut at %d and %d: got %q", i, j, got.String())
			}
		}
	}
}

func TestValidText(t *testing.T) {
	tests := []struct{ in, want string }{
		{"", ""},
		{"plain", "plain"},
		{"h\u00e9llo", "h\u00e9llo"},
		{"caf\xe9", "caf\ufffd"},
		{"\xe2\x82", "\ufffd\ufffd"},
		{"\xa9llo", "\ufffdllo"},
	}
	for _, tt := range tests {
		if got := validText([]byte(tt.in)); got != tt.want {
			t.Errorf("validText(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

// TestOutputIsUTF8OnTheWire runs a command whose writes split code points
// and carry invalid bytes, on both streams, and reads what the client gets.
func TestOutputIsUTF8OnTheWire(t *testing.T) {
	type write struct {
		stderr bool
		bytes  string
	}
	tests := []struct {
		name           string
		writes         []write
		stdout, stderr string
		// frames is the data of each notification, in order, when the test
		// pins it.
		frames []string
	}{
		{
			name:   "code point across two writes",
			writes: []write{{false, "h\xc3"}, {false, "\xa9llo\n"}},
			stdout: "h\u00e9llo\n",
			frames: []string{"h", "\u00e9llo\n"},
		},
		{
			name:   "a write of only part of a code point sends nothing",
			writes: []write{{false, "\xf0"}, {false, "\x9f"}, {false, "\x98"}, {false, "\x80"}},
			stdout: "\U0001f600",
			frames: []string{"\U0001f600"},
		},
		{
			name:   "the streams hold their own bytes",
			writes: []write{{false, "\xe2\x82"}, {true, "\xc3"}, {false, "\xac"}, {true, "\xa9"}},
			stdout: "\u20ac",
			stderr: "\u00e9",
			frames: []string{"\u20ac", "\u00e9"},
		},
		{
			name:   "invalid bytes are replaced",
			writes: []write{{false, "a\xffb"}, {true, "\x80"}},
			stdout: "a\ufffdb",
			stderr: "\ufffd",
			frames: []string{"a\ufffdb", "\ufffd"},
		},
		{
			name:   "a code point cut off by the exit is replaced before it",
			writes: []write{{false, "ok\xe2\x82"}, {true, "err\xc3"}},
			stdout: "ok\ufffd\ufffd",
			stderr: "err\ufffd",
			frames: []string{"ok", "err", "\ufffd\ufffd", "\ufffd"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newHarness(t, nil, func(s *Server) {
				s.Command(Command{Name: "emit", Run: func(_ context.Context, p *Proc) int {
					for _, w := range tt.writes {
						out := p.Stdout
						if w.stderr {
							out = p.Stderr
						}
						if n, err := out.Write([]byte(w.bytes)); n != len(w.bytes) || err != nil {
							t.Errorf("Write(%q) = %d, %v", w.bytes, n, err)
						}
					}
					return 0
				}})
			})
			c, _ := h.connect()
			c.start(1, "emit")
			var frames []string
			var stdout, stderr strings.Builder
			for {
				m := c.read()
				p := m["params"].(map[string]any)
				if m["method"] == methodExit {
					break
				}
				data := p["data"].(string)
				if !utf8.ValidString(data) || data == "" {
					t.Errorf("%s carried %q", m["method"], data)
				}
				frames = append(frames, data)
				if m["method"] == methodStderr {
					stderr.WriteString(data)
				} else {
					stdout.WriteString(data)
				}
			}
			if stdout.String() != tt.stdout || stderr.String() != tt.stderr {
				t.Errorf("stdout %q stderr %q, want %q and %q", stdout.String(), stderr.String(), tt.stdout, tt.stderr)
			}
			if strings.Join(frames, "|") != strings.Join(tt.frames, "|") {
				t.Errorf("notifications %q, want %q", frames, tt.frames)
			}
			c.sync()
		})
	}
}
