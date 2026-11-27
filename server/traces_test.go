package server

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// traceLine is one line of protocol/traces/*.jsonl.
type traceLine struct {
	Dir   string          `json:"dir"`
	Match string          `json:"match"`
	Msg   json.RawMessage `json:"msg"`
	Close int             `json:"close"`
}

func loadTraces(t *testing.T) map[string][]traceLine {
	t.Helper()
	files, err := filepath.Glob(filepath.Join("..", "protocol", "traces", "*.jsonl"))
	if err != nil || len(files) == 0 {
		t.Fatalf("no traces found: %v", err)
	}
	out := make(map[string][]traceLine, len(files))
	for _, f := range files {
		fh, err := os.Open(f) // #nosec G304 -- test reads the repository's own trace files
		if err != nil {
			t.Fatal(err)
		}
		sc := bufio.NewScanner(fh)
		sc.Buffer(make([]byte, 0, 1<<16), 1<<20)
		var lines []traceLine
		for sc.Scan() {
			var l traceLine
			if err := json.Unmarshal(sc.Bytes(), &l); err != nil {
				t.Fatalf("%s: %v", f, err)
			}
			lines = append(lines, l)
		}
		_ = fh.Close()
		out[filepath.Base(f)] = lines
	}
	return out
}

func TestTracesLoad(t *testing.T) {
	for name, lines := range loadTraces(t) {
		if len(lines) == 0 {
			t.Errorf("%s: empty trace", name)
		}
		for i, l := range lines {
			if l.Dir != "c2s" && l.Dir != "s2c" {
				t.Errorf("%s:%d: dir %q", name, i+1, l.Dir)
			}
			if l.Msg == nil && l.Close == 0 {
				t.Errorf("%s:%d: neither msg nor close", name, i+1)
			}
		}
	}
}

func TestSchemaEmbedded(t *testing.T) {
	var s map[string]any
	if err := json.Unmarshal(Schema, &s); err != nil {
		t.Fatal(err)
	}
	if s["$schema"] != "https://json-schema.org/draft/2020-12/schema" {
		t.Fatalf("unexpected $schema %v", s["$schema"])
	}
}
