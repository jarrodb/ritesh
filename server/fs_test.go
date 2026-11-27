package server

import (
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"
)

// recordingFS notes every name the server asks the file system for.
type recordingFS struct {
	fs.FS
	mu    sync.Mutex
	names []string
}

func (r *recordingFS) Open(name string) (fs.File, error) {
	r.mu.Lock()
	r.names = append(r.names, name)
	r.mu.Unlock()
	return r.FS.Open(name)
}

func (r *recordingFS) seen() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Clone(r.names)
}

func textFS(files map[string]string) fstest.MapFS {
	out := fstest.MapFS{}
	for name, content := range files {
		out[name] = &fstest.MapFile{Data: []byte(content), Mode: 0o644, ModTime: time.UnixMilli(1_700_000_000_123)}
	}
	return out
}

// TestPathsAreRefused: a path that is not a clean relative path never
// reaches the file system, whatever the method.
func TestPathsAreRefused(t *testing.T) {
	rec := &recordingFS{FS: textFS(map[string]string{"readme.txt": "hi", "docs/a.md": "# a\n"})}
	h := newHarness(t, nil, func(s *Server) { s.Mount("/", rec) })
	c, _ := h.connect()

	tests := []struct {
		name, path string
		echoed     bool // the error carries the path
	}{
		{"parent", "..", true},
		{"parent of root file", "../readme.txt", true},
		{"climb out", "../../../../etc/passwd", true},
		{"parent in the middle", "docs/../readme.txt", true},
		{"parent at the end", "docs/..", true},
		{"climb and return", "docs/../../docs/a.md", true},
		{"NUL", "readme.txt\x00", true},
		{"NUL in the middle", "docs/\x00/a.md", true},
		{"NUL then parent", "docs\x00/../x", true},
		{"absolute", "/readme.txt", true},
		{"absolute system path", "/etc/passwd", true},
		{"trailing slash", "docs/", true},
		{"empty segment", "docs//a.md", true},
		{"dot", ".", true},
		{"dot segment", "./readme.txt", true},
		{"dot in the middle", "docs/./a.md", true},
		{"only slashes", "//", true},
		{"too long", strings.Repeat("a/", 3000) + "a", false},
	}
	for _, method := range []string{"fs.stat", "fs.list", "fs.read"} {
		for _, tt := range tests {
			t.Run(method+" "+tt.name, func(t *testing.T) {
				e := c.callErr(method, msg{"path": tt.path})
				if codeOf(e) != codeApp || errnoOf(e) != "EINVAL" || e["message"] != "invalid argument" {
					t.Fatalf("%s %q: %v, want EINVAL", method, tt.path, e)
				}
				got, has := e["data"].(map[string]any)["path"]
				if has != tt.echoed || (has && got != tt.path) {
					t.Errorf("%s %q: error path %v (present %v)", method, tt.path, got, has)
				}
			})
		}
	}
	t.Run("proc.start cwd", func(t *testing.T) {
		for _, tt := range tests {
			p := startParamsFor(1, "anything")
			p["cwd"] = tt.path
			if e := c.callErr("proc.start", p); errnoOf(e) != "EINVAL" {
				t.Errorf("cwd %q: %v, want EINVAL", tt.path, e)
			}
		}
	})
	if names := rec.seen(); len(names) != 0 {
		t.Errorf("refused paths reached the file system: %q", names)
	}

	// Every name that does reach it is one fs.FS allows.
	for _, p := range []string{"", "readme.txt", "docs", "docs/a.md", "missing", "docs/missing/deeper", "..."} {
		c.response(c.request("fs.stat", msg{"path": p}))
		c.response(c.request("fs.list", msg{"path": p}))
		c.response(c.request("fs.read", msg{"path": p}))
	}
	names := rec.seen()
	if len(names) == 0 {
		t.Fatal("the file system was never asked")
	}
	for _, name := range names {
		if !fs.ValidPath(name) {
			t.Errorf("the file system was asked for %q", name)
		}
	}
}

// linkTree lays out, in a temp dir:
//
//	secret.txt            outside the mount
//	root/readme.txt
//	root/docs/a.md
//	root/links/...        symbolic links, see the test table
func linkTree(t *testing.T) (root string) {
	t.Helper()
	base := t.TempDir()
	root = filepath.Join(base, "root")
	write := func(name, content string) {
		t.Helper()
		full := filepath.Join(base, name)
		if err := os.MkdirAll(filepath.Dir(full), 0o750); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write("secret.txt", "TOP SECRET")
	write("outside/also-secret.txt", "TOP SECRET")
	write("root/readme.txt", "hello")
	write("root/docs/a.md", "# a\n")
	links := map[string]string{
		"links/inside-file":   filepath.Join("..", "readme.txt"),
		"links/inside-dir":    filepath.Join("..", "docs"),
		"links/chain":         "inside-dir",
		"links/up":            filepath.Join("..", ".."),
		"links/out-file":      filepath.Join("..", "..", "secret.txt"),
		"links/out-dir":       filepath.Join("..", "..", "outside"),
		"links/absolute-file": filepath.Join(base, "secret.txt"),
		"links/absolute-dir":  base,
		"links/back-in":       filepath.Join("..", "..", "root", "readme.txt"),
		"links/loop":          "loop",
		"links/ping":          "pong",
		"links/pong":          "ping",
		"links/dangling":      "nothing-here",
		"docs/escape":         filepath.Join("..", "..", "secret.txt"),
	}
	for name, target := range links {
		full := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Dir(full), 0o750); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(target, full); err != nil {
			t.Skipf("symbolic links are not available here: %v", err)
		}
	}
	return root
}

// TestLinksStayInsideTheMount: no request follows a link out of the mount's
// root, for the file systems a host is likely to mount a directory with.
func TestLinksStayInsideTheMount(t *testing.T) {
	root := linkTree(t)
	osRoot, err := os.OpenRoot(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = osRoot.Close() })

	mapLinks := textFS(map[string]string{"readme.txt": "hello", "docs/a.md": "# a\n"})
	for name, target := range map[string]string{
		"links/inside-file":   "../readme.txt",
		"links/inside-dir":    "../docs",
		"links/chain":         "inside-dir",
		"links/up":            "../..",
		"links/out-file":      "../../secret.txt",
		"links/out-dir":       "../../outside",
		"links/absolute-file": "/secret.txt",
		"links/absolute-dir":  "/",
		"links/back-in":       "../../root/readme.txt",
		"links/loop":          "loop",
		"links/ping":          "pong",
		"links/pong":          "ping",
		"links/dangling":      "nothing-here",
		"docs/escape":         "../../secret.txt",
	} {
		mapLinks[name] = &fstest.MapFile{Data: []byte(target), Mode: fs.ModeSymlink | 0o777}
	}

	systems := []struct {
		name string
		fsys fs.FS
	}{
		{"os.DirFS", os.DirFS(root)},
		{"os.Root", osRoot.FS()},
		{"fstest.MapFS", mapLinks},
	}
	// want is an errno, or "" when the request must succeed. Requests that
	// may fail in more than one way list them.
	tests := []struct {
		method, path string
		want         []string
		data         string // for a successful fs.read
	}{
		{"fs.read", "links/inside-file", nil, "hello"},
		{"fs.stat", "links/inside-file", nil, ""},
		{"fs.read", "links/inside-dir/a.md", nil, "# a\n"},
		{"fs.list", "links/inside-dir", nil, ""},
		{"fs.read", "links/chain/a.md", nil, "# a\n"},

		{"fs.read", "links/out-file", []string{"EACCES"}, ""},
		{"fs.stat", "links/out-file", []string{"EACCES"}, ""},
		{"fs.list", "links/out-dir", []string{"EACCES"}, ""},
		{"fs.read", "links/out-dir/also-secret.txt", []string{"EACCES"}, ""},
		{"fs.stat", "links/out-dir/also-secret.txt", []string{"EACCES"}, ""},
		{"fs.read", "links/up/secret.txt", []string{"EACCES"}, ""},
		{"fs.list", "links/up", []string{"EACCES"}, ""},
		{"fs.stat", "links/up", []string{"EACCES"}, ""},
		{"fs.read", "links/absolute-file", []string{"EACCES"}, ""},
		{"fs.list", "links/absolute-dir", []string{"EACCES"}, ""},
		{"fs.read", "links/absolute-dir/secret.txt", []string{"EACCES"}, ""},
		{"fs.read", "docs/escape", []string{"EACCES"}, ""},
		// Leaving and coming back is still leaving.
		{"fs.read", "links/back-in", []string{"EACCES"}, ""},
		{"fs.read", "links/inside-dir/escape", []string{"EACCES"}, ""},

		{"fs.read", "links/loop", []string{"ELOOP"}, ""},
		{"fs.stat", "links/ping", []string{"ELOOP"}, ""},
		{"fs.read", "links/dangling", []string{"ENOENT"}, ""},
	}
	for _, sys := range systems {
		t.Run(sys.name, func(t *testing.T) {
			h := newHarness(t, nil, func(s *Server) { s.Mount("/", sys.fsys) })
			c, _ := h.connect()
			for _, tt := range tests {
				t.Run(tt.method+" "+tt.path, func(t *testing.T) {
					m := c.response(c.request(tt.method, msg{"path": tt.path}))
					if raw := encode(m); strings.Contains(string(raw), "SECRET") {
						t.Fatalf("the response carries a file from outside the mount: %s", raw)
					}
					if len(tt.want) == 0 {
						res, ok := m["result"].(map[string]any)
						if !ok {
							t.Fatalf("want a result, got %v", m)
						}
						if tt.method == "fs.read" && res["data"] != tt.data {
							t.Errorf("data = %q, want %q", res["data"], tt.data)
						}
						return
					}
					e, ok := m["error"].(map[string]any)
					if !ok || !slices.Contains(tt.want, errnoOf(e)) {
						t.Fatalf("got %v, want one of %v", m, tt.want)
					}
				})
			}

			t.Run("fs.list shows only links that stay inside", func(t *testing.T) {
				res := c.call("fs.list", msg{"path": "links"})
				got := map[string]string{}
				for _, e := range res["entries"].([]any) {
					entry := e.(map[string]any)
					got[entry["name"].(string)] = entry["type"].(string)
				}
				want := map[string]string{"inside-file": "file", "inside-dir": "dir", "chain": "dir"}
				if len(got) != len(want) {
					t.Errorf("entries %v, want %v", got, want)
				}
				for name, typ := range want {
					if got[name] != typ {
						t.Errorf("entry %q is %q, want %q", name, got[name], typ)
					}
				}
			})
		})
	}
}

func TestConfine(t *testing.T) {
	link := func(target string) *fstest.MapFile {
		return &fstest.MapFile{Data: []byte(target), Mode: fs.ModeSymlink | 0o777}
	}
	fsys := fstest.MapFS{
		"a/b/file":   {Data: []byte("x")},
		"a/sibling":  link("b/file"),
		"a/up-one":   link("../a/b"),
		"a/b/root":   link("../.."),
		"a/b/out":    link("../../.."),
		"a/abs":      link("/a/b/file"),
		"a/dot":      link("./b/./file"),
		"a/self":     link("self"),
		"a/b/deeper": link("root/a/up-one/file"),
	}
	tests := []struct {
		name string
		want string
		err  error
	}{
		{".", ".", nil},
		{"a/b/file", "a/b/file", nil},
		{"a/sibling", "a/b/file", nil},
		{"a/up-one/file", "a/b/file", nil},
		{"a/b/root", ".", nil},
		{"a/b/root/a/b/file", "a/b/file", nil},
		{"a/dot", "a/b/file", nil},
		{"a/b/deeper", "a/b/file", nil},
		{"a/b/out", "", errEscape},
		{"a/b/out/a/b/file", "", errEscape},
		{"a/abs", "", errEscape},
		{"a/self", "", errLoop},
		{"a/missing", "", fs.ErrNotExist},
		{"a/b/file/under-a-file", "", fs.ErrNotExist},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := confine(fsys, tt.name)
			if tt.err != nil {
				if !errors.Is(err, tt.err) {
					t.Fatalf("confine(%q) = %q, %v; want %v", tt.name, got, err, tt.err)
				}
				return
			}
			if err != nil || got != tt.want {
				t.Fatalf("confine(%q) = %q, %v; want %q", tt.name, got, err, tt.want)
			}
		})
	}
	t.Run("a file system that reports no links is left alone", func(t *testing.T) {
		plain := struct{ fs.FS }{fsys}
		if got, err := confine(plain, "a/b/out/x"); err != nil || got != "a/b/out/x" {
			t.Errorf("confine = %q, %v", got, err)
		}
	})
}

func TestRead(t *testing.T) {
	const (
		text    = "hello from the test world\n"
		accents = "h\u00e9llo w\u00f6rld" // two-byte code points at 1 and 8
		mixed   = "a\u20acb\U0001f600c"   // 1, 3, 1, 4, 1 bytes
	)
	files := textFS(map[string]string{
		"text":     text,
		"empty":    "",
		"accents":  accents,
		"mixed":    mixed,
		"latin1":   "caf\xe9 au lait",
		"cut":      "ok\xe2\x82",
		"controls": strings.Repeat("\x01", 4000),
		"big":      strings.Repeat("0123456789abcdef", 1024),
	})
	h := newHarness(t, func(o *Options) {
		o.Limits.MaxMessageBytes = 8192
		o.Limits.MaxReadBytes = 4096
	}, func(s *Server) { s.Mount("/", files) })
	c, _ := h.connect()

	type params = map[string]any
	tests := []struct {
		name string
		p    params
		data string
		eof  bool
	}{
		{"whole file", params{"path": "text"}, text, true},
		{"range", params{"path": "text", "offset": 6, "length": 4}, "from", false},
		{"range to the end", params{"path": "text", "offset": 6, "length": 20}, "from the test world\n", true},
		{"range past the end", params{"path": "text", "offset": 21, "length": 100}, "orld\n", true},
		{"offset at the end", params{"path": "text", "offset": len(text)}, "", true},
		{"offset past the end", params{"path": "text", "offset": 1000, "length": 5}, "", true},
		{"length zero", params{"path": "text", "length": 0}, "", false},
		{"length zero at the end", params{"path": "text", "offset": len(text), "length": 0}, "", true},
		{"offset only", params{"path": "text", "offset": 20}, "world\n", true},
		{"empty file", params{"path": "empty"}, "", true},
		{"empty file with a range", params{"path": "empty", "offset": 0, "length": 10}, "", true},

		// Offsets count bytes, and a read ends on a code point boundary.
		{"cut before a code point", params{"path": "accents", "length": 1}, "h", false},
		{"cut inside a code point backs up", params{"path": "accents", "length": 2}, "h", false},
		{"cut after a code point", params{"path": "accents", "length": 3}, "h\u00e9", false},
		{"from a code point", params{"path": "accents", "offset": 1, "length": 2}, "\u00e9", false},
		{"a length below one code point still moves", params{"path": "accents", "offset": 1, "length": 1}, "\u00e9", false},
		{"three bytes of four", params{"path": "mixed", "offset": 5, "length": 3}, "\U0001f600", false},
		{"cut in a three-byte code point", params{"path": "mixed", "length": 3}, "a", false},
		{"cut in a four-byte code point", params{"path": "mixed", "length": 7}, "a\u20acb", false},
		{"whole four-byte code point", params{"path": "mixed", "offset": 5, "length": 4}, "\U0001f600", false},
		{"last byte", params{"path": "mixed", "offset": 9, "length": 5}, "c", true},

		// What is not UTF-8 is replaced, byte for byte.
		{"offset inside a code point", params{"path": "accents", "offset": 2, "length": 3}, "\ufffdll", false},
		{"invalid byte", params{"path": "latin1"}, "caf\ufffd au lait", true},
		{"code point cut off by the end of the file", params{"path": "cut"}, "ok\ufffd\ufffd", true},

		// Limits: at most MaxReadBytes, and never a message over the limit.
		{"clamped to MaxReadBytes", params{"path": "big", "length": 1 << 30}, strings.Repeat("0123456789abcdef", 256), false},
		{"default length is MaxReadBytes", params{"path": "big", "offset": 16384 - 4096}, strings.Repeat("0123456789abcdef", 256), true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res := c.call("fs.read", tt.p)
			if res["data"] != tt.data || res["eof"] != tt.eof {
				t.Errorf("fs.read %v = %q eof %v, want %q eof %v", tt.p, res["data"], res["eof"], tt.data, tt.eof)
			}
		})
	}

	t.Run("a read that escapes to more than a message is shortened", func(t *testing.T) {
		// Each control byte is six bytes of JSON.
		var got strings.Builder
		offset, reads := 0, 0
		for {
			res := c.call("fs.read", params{"path": "controls", "offset": offset})
			data := res["data"].(string)
			got.WriteString(data)
			offset += len(data)
			reads++
			if res["eof"] == true {
				break
			}
			if data == "" || reads > 100 {
				t.Fatalf("no progress at offset %d", offset)
			}
		}
		if got.String() != strings.Repeat("\x01", 4000) || reads < 2 {
			t.Errorf("read %d bytes in %d reads", got.Len(), reads)
		}
		if c.maxFrame > 8192 {
			t.Errorf("a frame of %d bytes exceeds maxMessageBytes", c.maxFrame)
		}
	})

	t.Run("reading by the client's rule returns the file", func(t *testing.T) {
		// next offset = offset + UTF-8 length of data, for every chunk size.
		for _, name := range []string{"accents", "mixed", "text"} {
			want := string(files[name].Data)
			for length := 1; length <= 9; length++ {
				var got strings.Builder
				for offset := 0; ; {
					res := c.call("fs.read", params{"path": name, "offset": offset, "length": length})
					data := res["data"].(string)
					got.WriteString(data)
					offset += len(data)
					if res["eof"] == true {
						break
					}
					if data == "" {
						t.Fatalf("%s: no progress at offset %d with length %d", name, offset, length)
					}
				}
				if got.String() != want {
					t.Errorf("%s in chunks of %d = %q, want %q", name, length, got.String(), want)
				}
			}
		}
	})

	errs := []struct {
		name  string
		p     params
		errno string
		code  int
	}{
		{"missing", params{"path": "nope"}, "ENOENT", codeApp},
		{"under a file", params{"path": "text/x"}, "ENOENT", codeApp},
		{"directory", params{"path": ""}, "EISDIR", codeApp},
		{"negative offset", params{"path": "text", "offset": -1}, "", codeInvalidParams},
		{"negative length", params{"path": "text", "length": -1}, "", codeInvalidParams},
		{"fractional offset", params{"path": "text", "offset": 1.5}, "", codeInvalidParams},
		{"offset of the wrong type", params{"path": "text", "offset": "6"}, "", codeInvalidParams},
		{"no path", params{"offset": 1}, "", codeInvalidParams},
		{"path of the wrong type", params{"path": 7}, "", codeInvalidParams},
		{"null path", params{"path": nil}, "", codeInvalidParams},
	}
	for _, tt := range errs {
		t.Run(tt.name, func(t *testing.T) {
			e := c.callErr("fs.read", tt.p)
			if codeOf(e) != tt.code || errnoOf(e) != tt.errno {
				t.Errorf("fs.read %v = %v, want code %d errno %q", tt.p, e, tt.code, tt.errno)
			}
		})
	}
}

// noSeekFS hides Seek, as a file system over a stream would.
type noSeekFS struct{ fs.FS }

type noSeekFile struct{ fs.File }

func (f noSeekFS) Open(name string) (fs.File, error) {
	file, err := f.FS.Open(name)
	if err != nil {
		return nil, err
	}
	if _, isDir := file.(fs.ReadDirFile); isDir {
		return file, nil
	}
	return noSeekFile{file}, nil
}

func TestReadWithoutSeek(t *testing.T) {
	h := newHarness(t, nil, func(s *Server) {
		s.Mount("/", noSeekFS{textFS(map[string]string{"text": "hello from the test world\n"})})
	})
	c, _ := h.connect()
	if _, canSeek := any(noSeekFile{}).(io.Seeker); canSeek {
		t.Fatal("the test file can seek")
	}
	tests := []struct {
		offset, length int
		data           string
		eof            bool
	}{
		{0, 5, "hello", false},
		{6, 4, "from", false},
		{21, 100, "orld\n", true},
		{500, 4, "", true},
	}
	for _, tt := range tests {
		res := c.call("fs.read", msg{"path": "text", "offset": tt.offset, "length": tt.length})
		if res["data"] != tt.data || res["eof"] != tt.eof {
			t.Errorf("read at %d = %q eof %v, want %q eof %v", tt.offset, res["data"], res["eof"], tt.data, tt.eof)
		}
	}
}

func TestCutText(t *testing.T) {
	tests := []struct {
		in    string
		limit int64
		want  int64
	}{
		{"", 0, 0},
		{"", 5, 0},
		{"abc", 0, 0},
		{"abc", 2, 2},
		{"abc", 3, 3},
		{"abc", 10, 3},
		{"a\u00e9b", 1, 1},
		{"a\u00e9b", 2, 1},
		{"a\u00e9b", 3, 3},
		{"\u00e9", 1, 2},           // shorter than the first code point: take it whole
		{"\U0001f600x", 1, 4},      // likewise
		{"\U0001f600x", 3, 4},      // likewise
		{"x\U0001f600", 2, 1},      // not the first: back up
		{"x\U0001f600", 4, 1},      //
		{"x\U0001f600", 5, 5},      //
		{"a\xe9b", 2, 2},           // an invalid byte is its own unit
		{"\x80\x80\x80\x80", 2, 2}, // stray continuation bytes too
		{"\xe2\x82", 1, 1},         // a code point the data never completes
		{"ab\xe2\x82", 3, 3},       //
	}
	for _, tt := range tests {
		if got := cutText([]byte(tt.in), tt.limit); got != tt.want {
			t.Errorf("cutText(%q, %d) = %d, want %d", tt.in, tt.limit, got, tt.want)
		}
	}
}

func TestStat(t *testing.T) {
	files := textFS(map[string]string{"readme.txt": "hello from the test world\n", "docs/a.md": "# a\n", "empty": ""})
	files["bin/tool"] = &fstest.MapFile{Data: []byte("#!"), Mode: 0o755}
	files["dev/pipe"] = &fstest.MapFile{Mode: fs.ModeNamedPipe | 0o600}
	h := newHarness(t, nil, func(s *Server) { s.Mount("/", files) })
	c, _ := h.connect()

	tests := []struct {
		path  string
		want  msg
		errno string
	}{
		{"readme.txt", msg{"type": "file", "size": 26.0, "mode": 420.0, "mtime": 1_700_000_000_123.0}, ""},
		{"empty", msg{"type": "file", "size": 0.0, "mode": 420.0, "mtime": 1_700_000_000_123.0}, ""},
		{"bin/tool", msg{"type": "file", "size": 2.0, "mode": 493.0, "mtime": 0.0}, ""},
		{"docs/a.md", msg{"type": "file", "size": 4.0, "mode": 420.0, "mtime": 1_700_000_000_123.0}, ""},
		{"missing", nil, "ENOENT"},
		{"readme.txt/x", nil, "ENOENT"},
		{"dev/pipe", nil, "ENOTSUP"},
	}
	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			m := c.response(c.request("fs.stat", msg{"path": tt.path}))
			if tt.errno != "" {
				e, _ := m["error"].(map[string]any)
				if errnoOf(e) != tt.errno || e["data"].(map[string]any)["path"] != tt.path {
					t.Fatalf("fs.stat %q = %v, want %s", tt.path, m, tt.errno)
				}
				return
			}
			if !matches(any(tt.want), m["result"], "exact", "") {
				t.Errorf("fs.stat %q = %v, want %v", tt.path, m["result"], tt.want)
			}
		})
	}
	for _, dir := range []string{"", "docs"} {
		res := c.call("fs.stat", msg{"path": dir})
		if res["type"] != "dir" || res["size"] != 0.0 {
			t.Errorf("fs.stat %q = %v, want a directory of size 0", dir, res)
		}
	}
	// Nothing is opened to answer for what rite.1 does not serve.
	if e := c.callErr("fs.read", msg{"path": "dev/pipe"}); errnoOf(e) != "ENOTSUP" {
		t.Errorf("fs.read of a pipe: %v", e)
	}
}

func entriesOf(t *testing.T, res msg) (names []string, types map[string]string) {
	t.Helper()
	types = map[string]string{}
	for _, e := range res["entries"].([]any) {
		entry := e.(map[string]any)
		if len(entry) != 2 {
			t.Errorf("entry %v has keys beyond name and type", entry)
		}
		names = append(names, entry["name"].(string))
		types[entry["name"].(string)] = entry["type"].(string)
	}
	return names, types
}

func TestList(t *testing.T) {
	many := map[string]string{"readme.txt": "x", "docs/a.md": "x", "docs/b.md": "x", "docs/sub/c.md": "x"}
	for i := range 30 {
		many["many/"+string(rune('a'+i%26))+strings.Repeat("x", i)] = ""
	}
	files := textFS(many)
	files["docs/pipe"] = &fstest.MapFile{Mode: fs.ModeNamedPipe}
	files["hollow"] = &fstest.MapFile{Mode: fs.ModeDir | 0o755}
	h := newHarness(t, func(o *Options) { o.Limits.MaxListEntries = 20 }, func(s *Server) { s.Mount("/", files) })
	c, _ := h.connect()

	tests := []struct {
		path      string
		names     []string
		truncated bool
	}{
		{"", []string{"docs", "hollow", "many", "readme.txt"}, false},
		{"docs", []string{"a.md", "b.md", "sub"}, false}, // sorted, and without the pipe
		{"docs/sub", []string{"c.md"}, false},
		{"hollow", []string{}, false},
	}
	for _, tt := range tests {
		t.Run("list "+tt.path, func(t *testing.T) {
			res := c.call("fs.list", msg{"path": tt.path})
			names, _ := entriesOf(t, res)
			if !slices.Equal(names, tt.names) && (len(names) != 0 || len(tt.names) != 0) {
				t.Errorf("entries %q, want %q", names, tt.names)
			}
			if res["truncated"] != tt.truncated {
				t.Errorf("truncated = %v", res["truncated"])
			}
		})
	}
	t.Run("types", func(t *testing.T) {
		_, types := entriesOf(t, c.call("fs.list", msg{"path": ""}))
		want := map[string]string{"docs": "dir", "hollow": "dir", "many": "dir", "readme.txt": "file"}
		for name, typ := range want {
			if types[name] != typ {
				t.Errorf("%q is %q, want %q", name, types[name], typ)
			}
		}
	})
	t.Run("truncated at MaxListEntries", func(t *testing.T) {
		res := c.call("fs.list", msg{"path": "many"})
		names, _ := entriesOf(t, res)
		if len(names) != 20 || res["truncated"] != true || !slices.IsSorted(names) {
			t.Errorf("%d entries, truncated %v, sorted %v", len(names), res["truncated"], slices.IsSorted(names))
		}
	})
	errs := []struct{ path, errno string }{
		{"readme.txt", "ENOTDIR"},
		{"missing", "ENOENT"},
		{"docs/pipe", "ENOTSUP"},
	}
	for _, tt := range errs {
		if e := c.callErr("fs.list", msg{"path": tt.path}); errnoOf(e) != tt.errno {
			t.Errorf("fs.list %q = %v, want %s", tt.path, e, tt.errno)
		}
	}
}

func TestListFitsInAMessage(t *testing.T) {
	files := fstest.MapFS{}
	for i := range 200 {
		files["d/"+strings.Repeat(string(rune('a'+i%26)), 100)+string(rune('0'+i/26))] = &fstest.MapFile{}
	}
	h := newHarness(t, func(o *Options) { o.Limits.MaxMessageBytes = 4096 }, func(s *Server) { s.Mount("/", files) })
	c, _ := h.connect()
	res := c.call("fs.list", msg{"path": "d"})
	names, _ := entriesOf(t, res)
	if res["truncated"] != true || len(names) == 0 || len(names) >= 200 {
		t.Errorf("%d entries, truncated %v", len(names), res["truncated"])
	}
	if c.maxFrame > 4096 {
		t.Errorf("a frame of %d bytes exceeds maxMessageBytes", c.maxFrame)
	}
}

func TestMounts(t *testing.T) {
	h := newHarness(t, nil, func(s *Server) {
		s.Mount("/docs", textFS(map[string]string{"a.md": "# a\n", "guides/intro.md": "intro"}))
		s.Mount("srv/data/", textFS(map[string]string{"x.csv": "1,2\n"}))
		s.Mount("/docs/guides/extra", textFS(map[string]string{"deep.md": "deep"}))
	})
	c, _ := h.connect()

	lists := []struct {
		path  string
		names []string
	}{
		{"", []string{"docs", "srv"}},                  // no root mount: the parents of mounts
		{"srv", []string{"data"}},                      // a directory that only leads to a mount
		{"srv/data", []string{"x.csv"}},                //
		{"docs", []string{"a.md", "guides"}},           //
		{"docs/guides", []string{"extra", "intro.md"}}, // a mount inside a mount shows in its parent
		{"docs/guides/extra", []string{"deep.md"}},     //
	}
	for _, tt := range lists {
		names, types := entriesOf(t, c.call("fs.list", msg{"path": tt.path}))
		if !slices.Equal(names, tt.names) {
			t.Errorf("fs.list %q = %q, want %q", tt.path, names, tt.names)
		}
		for _, n := range names {
			if strings.Contains(n, ".") != (types[n] == "file") {
				t.Errorf("fs.list %q: %q is a %s", tt.path, n, types[n])
			}
		}
	}
	reads := []struct{ path, data, errno string }{
		{"docs/a.md", "# a\n", ""},
		{"docs/guides/intro.md", "intro", ""},
		{"docs/guides/extra/deep.md", "deep", ""},
		{"srv/data/x.csv", "1,2\n", ""},
		{"srv", "", "EISDIR"},
		{"srv/other", "", "ENOENT"},
		{"a.md", "", "ENOENT"},
		{"docsx", "", "ENOENT"},
	}
	for _, tt := range reads {
		m := c.response(c.request("fs.read", msg{"path": tt.path}))
		if tt.errno != "" {
			if e, _ := m["error"].(map[string]any); errnoOf(e) != tt.errno {
				t.Errorf("fs.read %q = %v, want %s", tt.path, m, tt.errno)
			}
			continue
		}
		if res, _ := m["result"].(map[string]any); res["data"] != tt.data {
			t.Errorf("fs.read %q = %v, want %q", tt.path, m, tt.data)
		}
	}
	for _, dir := range []string{"", "srv", "docs", "srv/data"} {
		if res := c.call("fs.stat", msg{"path": dir}); res["type"] != "dir" {
			t.Errorf("fs.stat %q = %v", dir, res)
		}
	}
	if e := c.callErr("fs.list", msg{"path": "nowhere"}); errnoOf(e) != "ENOENT" {
		t.Errorf("fs.list of nothing: %v", e)
	}
}

func TestNoMounts(t *testing.T) {
	h := newHarness(t, nil, nil)
	c, _ := h.connect()
	if res := c.call("fs.stat", msg{"path": ""}); res["type"] != "dir" {
		t.Errorf("root without mounts: %v", res)
	}
	if names, _ := entriesOf(t, c.call("fs.list", msg{"path": ""})); len(names) != 0 {
		t.Errorf("root without mounts lists %q", names)
	}
	if e := c.callErr("fs.read", msg{"path": "x"}); errnoOf(e) != "ENOENT" {
		t.Errorf("read without mounts: %v", e)
	}
}

func TestMountPanics(t *testing.T) {
	ok := fstest.MapFS{}
	tests := []struct {
		name  string
		mount func(s *Server)
	}{
		{"parent", func(s *Server) { s.Mount("/a/../b", ok) }},
		{"dot", func(s *Server) { s.Mount("/a/./b", ok) }},
		{"empty segment", func(s *Server) { s.Mount("/a//b", ok) }},
		{"NUL", func(s *Server) { s.Mount("/a\x00", ok) }},
		{"nil file system", func(s *Server) { s.Mount("/a", nil) }},
		{"twice", func(s *Server) { s.Mount("/a", ok); s.Mount("a/", ok) }},
		{"root twice", func(s *Server) { s.Mount("/", ok); s.Mount("", ok) }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			defer func() {
				if recover() == nil {
					t.Error("Mount did not panic")
				}
			}()
			tt.mount(New(Options{}))
		})
	}
}
