package server

import (
	"context"
	"strings"
	"testing"
)

func TestEncodeKeepsHTML(t *testing.T) {
	// Output is terminal text, not markup: the escapes would only cost bytes.
	if got := string(encode("<a href='x'>&</a>")); got != `"<a href='x'>&</a>"` {
		t.Errorf("encode = %s", got)
	}
}

func TestSplitText(t *testing.T) {
	tests := []struct {
		name   string
		text   string
		budget int
		head   string
	}{
		{"fits", "hello", 100, "hello"},
		{"fits after measuring", strings.Repeat("a", 90), 100, strings.Repeat("a", 90)},
		{"too long", strings.Repeat("a", 200), 122, strings.Repeat("a", 20)},
		{"escapes count", strings.Repeat("\x01", 30), 122, strings.Repeat("\x01", 20)},
		{"cut on a code point", strings.Repeat("\xe2\x82\xac", 100), 122, strings.Repeat("\xe2\x82\xac", 6)},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			head, tail := splitText(tt.text, tt.budget)
			if head != tt.head || head+tail != tt.text {
				t.Errorf("splitText = %d bytes and %d bytes, want a head of %d", len(head), len(tail), len(tt.head))
			}
			if len(encode(head)) > tt.budget {
				t.Errorf("the head takes %d bytes of JSON, over %d", len(encode(head)), tt.budget)
			}
		})
	}
}

// TestMessages covers JSON-RPC faults after the handshake: what is answered,
// with which code and id, and what is dropped without an answer.
func TestMessages(t *testing.T) {
	h := newHarness(t, nil, func(s *Server) {
		s.Mount("/", textFS(map[string]string{"readme.txt": "hi"}))
		s.Command(Command{Name: "true", Run: func(context.Context, *Proc) int { return 0 }})
	})
	c, _ := h.connect()

	const none = -1 << 62 // the answer carries a null id
	answered := []struct {
		name  string
		frame string
		id    int
		code  int // 0: a result
	}{
		{"not JSON", `{"jsonrpc":"2.0",`, none, codeParse},
		{"empty", ``, none, codeParse},
		{"two values", `{"jsonrpc":"2.0","id":1,"method":"fs.stat","params":{"path":""}} {}`, none, codeParse},
		{"a batch", `[{"jsonrpc":"2.0","id":1,"method":"fs.stat","params":{"path":""}}]`, none, codeInvalidRequest},
		{"an empty batch", `[]`, none, codeInvalidRequest},
		{"a string", `"fs.stat"`, none, codeInvalidRequest},
		{"a number", `42`, none, codeInvalidRequest},
		{"null", `null`, none, codeInvalidRequest},
		{"an empty object", `{}`, none, codeInvalidRequest},
		{"no jsonrpc", `{"id":1,"method":"fs.stat","params":{"path":""}}`, none, codeInvalidRequest},
		{"jsonrpc 1.0", `{"jsonrpc":"1.0","id":1,"method":"fs.stat","params":{"path":""}}`, none, codeInvalidRequest},
		{"no method", `{"jsonrpc":"2.0","id":1}`, none, codeInvalidRequest},
		{"method a number", `{"jsonrpc":"2.0","id":1,"method":5}`, none, codeInvalidRequest},
		{"id a string", `{"jsonrpc":"2.0","id":"1","method":"fs.stat","params":{"path":""}}`, none, codeInvalidRequest},
		{"id a fraction", `{"jsonrpc":"2.0","id":1.5,"method":"fs.stat","params":{"path":""}}`, none, codeInvalidRequest},
		{"id null", `{"jsonrpc":"2.0","id":null,"method":"fs.stat","params":{"path":""}}`, none, codeInvalidRequest},

		{"unknown method", `{"jsonrpc":"2.0","id":11,"method":"fs.write","params":{"path":"x","data":"y"}}`, 11, codeMethodNotFound},
		{"unknown method without params", `{"jsonrpc":"2.0","id":12,"method":"nope"}`, 12, codeMethodNotFound},
		{"a notification's method as a request", `{"jsonrpc":"2.0","id":13,"method":"proc.signal","params":{"pid":1,"signal":"KILL"}}`, 13, codeMethodNotFound},
		{"a server notification as a request", `{"jsonrpc":"2.0","id":14,"method":"proc.exit","params":{"pid":1,"code":0}}`, 14, codeMethodNotFound},
		{"method names are exact", `{"jsonrpc":"2.0","id":15,"method":"FS.STAT","params":{"path":""}}`, 15, codeMethodNotFound},

		{"no params", `{"jsonrpc":"2.0","id":21,"method":"fs.stat"}`, 21, codeInvalidParams},
		{"params null", `{"jsonrpc":"2.0","id":22,"method":"fs.stat","params":null}`, 22, codeInvalidParams},
		{"params by position", `{"jsonrpc":"2.0","id":23,"method":"fs.stat","params":[""]}`, 23, codeInvalidParams},
		{"param of the wrong type", `{"jsonrpc":"2.0","id":24,"method":"fs.list","params":{"path":["a"]}}`, 24, codeInvalidParams},
		{"complete without index", `{"jsonrpc":"2.0","id":25,"method":"proc.complete","params":{"argv":["true"]}}`, 25, codeInvalidParams},
		{"complete without argv", `{"jsonrpc":"2.0","id":26,"method":"proc.complete","params":{"index":0}}`, 26, codeInvalidParams},
		{"complete with a negative index", `{"jsonrpc":"2.0","id":27,"method":"proc.complete","params":{"argv":["true"],"index":-1}}`, 27, codeInvalidParams},
		{"complete with an index past argv", `{"jsonrpc":"2.0","id":28,"method":"proc.complete","params":{"argv":["true"],"index":2}}`, 28, codeInvalidParams},

		{"unknown fields are ignored", `{"jsonrpc":"2.0","id":31,"method":"fs.stat","params":{"path":"","future":[1]},"meta":{"x":1}}`, 31, 0},
		{"id zero", `{"jsonrpc":"2.0","id":0,"method":"fs.stat","params":{"path":""}}`, 0, 0},
		{"a negative id", `{"jsonrpc":"2.0","id":-7,"method":"fs.stat","params":{"path":""}}`, -7, 0},
		{"the largest safe integer", `{"jsonrpc":"2.0","id":9007199254740991,"method":"fs.stat","params":{"path":""}}`, 9007199254740991, 0},
		{"key order is free", `{"params":{"path":"readme.txt"},"method":"fs.read","id":35,"jsonrpc":"2.0"}`, 35, 0},
		{"whitespace is free", " {\n\t\"jsonrpc\": \"2.0\", \"id\": 36, \"method\": \"fs.stat\", \"params\": {\"path\": \"\"} }\n", 36, 0},
	}
	for _, tt := range answered {
		t.Run(tt.name, func(t *testing.T) {
			c.sendRaw([]byte(tt.frame))
			m := c.read()
			if tt.id == none {
				if id, has := m["id"]; !has || id != nil {
					t.Errorf("want a null id, got %v", m)
				}
			} else if id, _ := m["id"].(float64); int(id) != tt.id {
				t.Errorf("want id %d, got %v", tt.id, m)
			}
			if tt.code == 0 {
				if _, ok := m["result"].(map[string]any); !ok || m["error"] != nil {
					t.Errorf("want a result, got %v", m)
				}
				return
			}
			e, _ := m["error"].(map[string]any)
			if codeOf(e) != tt.code || m["result"] != nil {
				t.Errorf("want error %d, got %v", tt.code, m)
			}
			if _, has := e["data"]; has {
				t.Errorf("a protocol fault carries data: %v", e)
			}
			want := map[int]string{codeParse: "parse error", codeInvalidRequest: "invalid request", codeMethodNotFound: "method not found", codeInvalidParams: "invalid params"}
			if e["message"] != want[tt.code] {
				t.Errorf("message %q, want %q", e["message"], want[tt.code])
			}
		})
	}

	dropped := []struct{ name, frame string }{
		{"unknown notification", `{"jsonrpc":"2.0","method":"fs.nothing","params":{}}`},
		{"unknown notification without params", `{"jsonrpc":"2.0","method":"future.thing"}`},
		{"a request's method as a notification", `{"jsonrpc":"2.0","method":"fs.stat","params":{"path":""}}`},
		{"proc.start as a notification", `{"jsonrpc":"2.0","method":"proc.start","params":{"pid":1,"argv":["true"],"cwd":"","env":{},"stdio":{"stdin":"pipe","stdout":"pipe","stderr":"pipe"}}}`},
		{"rite.hello as a notification", `{"jsonrpc":"2.0","method":"rite.hello","params":{}}`},
		{"a server notification echoed back", `{"jsonrpc":"2.0","method":"proc.stdout","params":{"pid":1,"data":"x"}}`},
		{"a known notification with bad params", `{"jsonrpc":"2.0","method":"tty.resize","params":"wide"}`},
		{"a known notification without params", `{"jsonrpc":"2.0","method":"proc.stdin"}`},
		{"a result", `{"jsonrpc":"2.0","id":1,"result":{}}`},
		{"an error", `{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"method not found"}}`},
	}
	for _, tt := range dropped {
		t.Run("dropped: "+tt.name, func(*testing.T) {
			c.sendRaw([]byte(tt.frame))
			c.sync()
		})
	}
}

func TestHelloResult(t *testing.T) {
	run := func(context.Context, *Proc) int { return 0 }
	h := newHarness(t, func(o *Options) { o.MOTD = "welcome to the sandbox" }, func(s *Server) {
		s.Command(Command{Name: "zeta", Summary: "last letter, first registered", Usage: "zeta", Run: run})
		s.Command(Command{
			Name: "mdm", Summary: "manage devices", Usage: "mdm <command>", Run: run,
			Flags: map[string]Flag{
				"verbose": {Long: "verbose", Short: "v", Description: "say more"},
				"tag":     {Long: "tag", Type: FlagString, Repeat: true},
				"n":       {Short: "n", Type: FlagNumber},
			},
			Subcommands: map[string]Subcommand{"devices": {Summary: "list devices", Usage: "mdm devices [--tag t]"}},
		})
		s.Command(Command{Name: "alpha", Run: run})
	})
	_, hello := h.connect()

	want := msg{
		"resumed": false,
		"commands": []any{
			msg{"name": "zeta", "summary": "last letter, first registered", "usage": "zeta"},
			msg{
				"name": "mdm", "summary": "manage devices", "usage": "mdm <command>",
				"flags": msg{
					"verbose": msg{"long": "verbose", "short": "v", "type": "boolean", "description": "say more"},
					"tag":     msg{"long": "tag", "type": "string", "repeat": true},
					"n":       msg{"short": "n", "type": "number"},
				},
				"subcommands": msg{"devices": msg{"summary": "list devices", "usage": "mdm devices [--tag t]"}},
			},
			msg{"name": "alpha", "summary": "", "usage": ""},
		},
		"capabilities": []any{},
		"motd":         "welcome to the sandbox",
	}
	delete(hello, "session")
	delete(hello, "limits")
	if !matches(any(want), any(hello), "exact", "") {
		t.Errorf("hello result\n got %s\nwant %s", encode(hello), encode(want))
	}

	t.Run("without commands or a motd", func(t *testing.T) {
		h := newHarness(t, nil, nil)
		_, hello := h.connect()
		if cmds, ok := hello["commands"].([]any); !ok || len(cmds) != 0 {
			t.Errorf("commands = %v, want an empty array", hello["commands"])
		}
		if _, has := hello["motd"]; has {
			t.Errorf("motd is present: %v", hello)
		}
	})
}
