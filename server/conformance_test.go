package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/coder/websocket"
)

// world is protocol/world.json: what the conformance server registers.
type world struct {
	Token    string            `json:"token"`
	Files    map[string]string `json:"files"`
	Commands []struct {
		Name    string          `json:"name"`
		Summary string          `json:"summary"`
		Usage   string          `json:"usage"`
		Flags   map[string]Flag `json:"flags"`
	} `json:"commands"`
	Limits wireLimits `json:"limits"`
}

func loadWorld(t *testing.T) world {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "protocol", "world.json"))
	if err != nil {
		t.Fatal(err)
	}
	var w world
	if err := json.Unmarshal(data, &w); err != nil {
		t.Fatal(err)
	}
	return w
}

// worldBehaviors implements the "behavior" of each command in world.json.
// Each writes its output in one Write, so the traces see one notification.
var worldBehaviors = map[string]func(ctx context.Context, p *Proc) int{
	"upper": func(_ context.Context, p *Proc) int {
		buf := make([]byte, 4096)
		for {
			n, err := p.Stdin.Read(buf)
			if n > 0 {
				_, _ = p.Stdout.Write(bytes.ToUpper(buf[:n]))
			}
			if errors.Is(err, io.EOF) {
				return 0
			}
			if err != nil {
				return 130
			}
		}
	},
	"count": func(_ context.Context, p *Proc) int {
		flags := flag.NewFlagSet("count", flag.ContinueOnError)
		flags.SetOutput(io.Discard)
		n := 3
		flags.IntVar(&n, "n", n, "")
		flags.IntVar(&n, "number", n, "")
		if err := flags.Parse(p.Args[1:]); err != nil {
			_, _ = io.WriteString(p.Stderr, "usage: count [-n number]\n")
			return 2
		}
		var out strings.Builder
		for i := 1; i <= n; i++ {
			out.WriteString(strconv.Itoa(i) + "\n")
		}
		_, _ = io.WriteString(p.Stdout, out.String())
		return 0
	},
	"fail": func(_ context.Context, p *Proc) int {
		_, _ = io.WriteString(p.Stderr, "failing\n")
		if len(p.Args) < 2 {
			return 1
		}
		code, err := strconv.Atoi(p.Args[1])
		if err != nil {
			return 1
		}
		return code
	},
	"wait": func(ctx context.Context, p *Proc) int {
		_, _ = io.WriteString(p.Stdout, "waiting\n")
		<-ctx.Done()
		return 130
	},
	"env": func(_ context.Context, p *Proc) int {
		lines := make([]string, 0, len(p.Env))
		for name, value := range p.Env {
			lines = append(lines, name+"="+value+"\n")
		}
		slices.Sort(lines)
		_, _ = io.WriteString(p.Stdout, strings.Join(lines, ""))
		return 0
	},
}

// newWorld starts a server that is the world of protocol/world.json. limits
// may adjust the world's limits.
func newWorld(t *testing.T, limits func(*Limits)) *harness {
	t.Helper()
	w := loadWorld(t)
	files := fstest.MapFS{}
	for name, content := range w.Files {
		files[name] = &fstest.MapFile{Data: []byte(content), Mode: 0o644}
	}
	return newHarness(t, func(o *Options) {
		o.Authenticate = func(_ context.Context, token string) (Principal, error) {
			if token != w.Token {
				return Principal{}, errors.New("wrong token")
			}
			return Principal{ID: "world"}, nil
		}
		o.Limits.MaxMessageBytes = w.Limits.MaxMessageBytes
		o.Limits.MaxProcs = w.Limits.MaxProcs
		o.Limits.MaxOutputBytes = w.Limits.MaxOutputBytes
		o.Limits.IdleTimeout = time.Duration(w.Limits.IdleSeconds) * time.Second
		if limits != nil {
			limits(&o.Limits)
		}
	}, func(s *Server) {
		s.Mount("/", files)
		for _, c := range w.Commands {
			run, ok := worldBehaviors[c.Name]
			if !ok {
				t.Fatalf("world.json has command %q with no behavior in this test", c.Name)
			}
			s.Command(Command{Name: c.Name, Summary: c.Summary, Usage: c.Usage, Flags: c.Flags, Run: run})
		}
	})
}

// matches compares a message from the server with a trace line, as
// packages/ritesh/test/support/trace.ts does. exact: deep equal. shape: the
// same keys and types, where a string under "session" or "data" and a number
// other than code, id, and pid may differ.
func matches(want, got any, mode, key string) bool {
	if _, isString := want.(string); mode == "shape" && (key == "session" || key == "data") && isString {
		_, ok := got.(string)
		return ok
	}
	switch w := want.(type) {
	case []any:
		g, ok := got.([]any)
		if !ok || len(w) != len(g) {
			return false
		}
		for i := range w {
			if !matches(w[i], g[i], mode, key) {
				return false
			}
		}
		return true
	case map[string]any:
		g, ok := got.(map[string]any)
		if !ok || len(w) != len(g) {
			return false
		}
		for k, wv := range w {
			gv, has := g[k]
			if !has || !matches(wv, gv, mode, k) {
				return false
			}
		}
		return true
	case float64:
		if mode == "shape" && key != "code" && key != "id" && key != "pid" {
			_, ok := got.(float64)
			return ok
		}
	}
	return want == got
}

func TestMatches(t *testing.T) {
	parse := func(s string) any {
		var v any
		if err := json.Unmarshal([]byte(s), &v); err != nil {
			t.Fatal(err)
		}
		return v
	}
	tests := []struct {
		name      string
		mode      string
		want, got string
		ok        bool
	}{
		{"exact equal", "exact", `{"a":[1,"x",true,null]}`, `{"a":[1,"x",true,null]}`, true},
		{"exact number differs", "exact", `{"size":1}`, `{"size":2}`, false},
		{"exact extra key", "exact", `{"a":1}`, `{"a":1,"b":2}`, false},
		{"exact missing key", "exact", `{"a":1,"b":null}`, `{"a":1}`, false},
		{"shape session differs", "shape", `{"session":"s"}`, `{"session":"0123"}`, true},
		{"shape session type", "shape", `{"session":"s"}`, `{"session":1}`, false},
		{"shape data string differs", "shape", `{"data":"a"}`, `{"data":"b"}`, true},
		{"shape data object is compared", "shape", `{"data":{"errno":"ENOENT"}}`, `{"data":{"errno":"EINVAL"}}`, false},
		{"shape other string must equal", "shape", `{"message":"a"}`, `{"message":"b"}`, false},
		{"shape number may differ", "shape", `{"mtime":0}`, `{"mtime":17}`, true},
		{"shape number type", "shape", `{"mtime":0}`, `{"mtime":"0"}`, false},
		{"shape code must equal", "shape", `{"code":-32000}`, `{"code":-32601}`, false},
		{"shape id must equal", "shape", `{"id":1}`, `{"id":2}`, false},
		{"shape pid must equal", "shape", `{"pid":1}`, `{"pid":2}`, false},
		{"shape keys must match", "shape", `{"a":1}`, `{"a":1,"b":2}`, false},
		{"shape array length", "shape", `{"a":[1]}`, `{"a":[1,2]}`, false},
		{"shape strings in arrays under data", "shape", `{"data":["a"]}`, `{"data":["b"]}`, true},
		{"shape boolean must equal", "shape", `{"eof":true}`, `{"eof":false}`, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := matches(parse(tt.want), parse(tt.got), tt.mode, ""); got != tt.ok {
				t.Errorf("matches(%s, %s, %s) = %v, want %v", tt.want, tt.got, tt.mode, got, tt.ok)
			}
		})
	}
}

// TestConformance replays every trace in protocol/traces against the world:
// it sends the c2s lines in order and checks each s2c line.
func TestConformance(t *testing.T) {
	for name, lines := range loadTraces(t) {
		t.Run(strings.TrimSuffix(name, ".jsonl"), func(t *testing.T) {
			h := newWorld(t, nil)
			c := h.dial(nil)
			closed := false
			for i, line := range lines {
				at := name + ":" + strconv.Itoa(i+1)
				switch {
				case line.Dir == "c2s":
					c.sendRaw(line.Msg)
				case line.Close != 0:
					m, err := c.readErr()
					if err == nil {
						t.Fatalf("%s: want close %d, got %v", at, line.Close, m)
					}
					if got := websocket.CloseStatus(err); int(got) != line.Close {
						t.Fatalf("%s: want close %d, got %d (%v)", at, line.Close, got, err)
					}
					closed = true
				default:
					var want any
					if err := json.Unmarshal(line.Msg, &want); err != nil {
						t.Fatalf("%s: %v", at, err)
					}
					got, err := c.readErr()
					if err != nil {
						t.Fatalf("%s: want %s, got %v", at, line.Msg, err)
					}
					if !matches(want, any(got), line.Match, "") {
						raw, _ := json.Marshal(got)
						t.Fatalf("%s: %s mismatch\nwant %s\ngot  %s", at, line.Match, line.Msg, raw)
					}
				}
			}
			if !closed {
				// The trace is the whole conversation: nothing else was sent,
				// and the connection is still in service.
				c.sync()
			}
		})
	}
}
