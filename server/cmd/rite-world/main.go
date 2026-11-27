// Command rite-world serves protocol/world.json over rite.1 on a local port,
// for the client-to-server interop test (packages/ritesh/test/interop).
// It prints "listening <addr>" once ready. Its command behaviors match the
// conformance test's (server/conformance_test.go), which cannot share them
// without an import cycle.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"slices"
	"strconv"
	"strings"
	"testing/fstest"
	"time"

	"github.com/jarrodb/ritesh/server"
)

type world struct {
	Token    string            `json:"token"`
	Files    map[string]string `json:"files"`
	Commands []struct {
		Name    string                 `json:"name"`
		Summary string                 `json:"summary"`
		Usage   string                 `json:"usage"`
		Flags   map[string]server.Flag `json:"flags"`
	} `json:"commands"`
	Limits struct {
		MaxMessageBytes int `json:"maxMessageBytes"`
		MaxProcs        int `json:"maxProcs"`
		MaxOutputBytes  int `json:"maxOutputBytes"`
		IdleSeconds     int `json:"idleSeconds"`
	} `json:"limits"`
}

var behaviors = map[string]func(ctx context.Context, p *server.Proc) int{
	"upper": func(_ context.Context, p *server.Proc) int {
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
	"count": func(_ context.Context, p *server.Proc) int {
		fs := flag.NewFlagSet("count", flag.ContinueOnError)
		fs.SetOutput(io.Discard)
		n := 3
		fs.IntVar(&n, "n", n, "")
		fs.IntVar(&n, "number", n, "")
		if err := fs.Parse(p.Args[1:]); err != nil {
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
	"fail": func(_ context.Context, p *server.Proc) int {
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
	"wait": func(ctx context.Context, p *server.Proc) int {
		_, _ = io.WriteString(p.Stdout, "waiting\n")
		<-ctx.Done()
		return 130
	},
	"env": func(_ context.Context, p *server.Proc) int {
		lines := make([]string, 0, len(p.Env))
		for name, value := range p.Env {
			lines = append(lines, name+"="+value+"\n")
		}
		slices.Sort(lines)
		_, _ = io.WriteString(p.Stdout, strings.Join(lines, ""))
		return 0
	},
}

func main() {
	worldPath := flag.String("world", "../protocol/world.json", "world.json")
	origin := flag.String("origin", "http://localhost", "allowed Origin")
	flag.Parse()
	data, err := os.ReadFile(*worldPath)
	if err != nil {
		log.Fatal(err)
	}
	var w world
	if err := json.Unmarshal(data, &w); err != nil {
		log.Fatal(err)
	}
	files := fstest.MapFS{}
	for name, content := range w.Files {
		files[name] = &fstest.MapFile{Data: []byte(content), Mode: 0o644}
	}
	limits := server.DefaultLimits
	limits.MaxMessageBytes = w.Limits.MaxMessageBytes
	limits.MaxProcs = w.Limits.MaxProcs
	limits.MaxOutputBytes = int64(w.Limits.MaxOutputBytes)
	limits.IdleTimeout = time.Duration(w.Limits.IdleSeconds) * time.Second
	srv := server.New(server.Options{
		Authenticate: func(_ context.Context, token string) (server.Principal, error) {
			if token != w.Token {
				return server.Principal{}, errors.New("wrong token")
			}
			return server.Principal{ID: "world"}, nil
		},
		Origins: []string{*origin},
		Limits:  limits,
	})
	srv.Mount("/", files)
	for _, c := range w.Commands {
		run, ok := behaviors[c.Name]
		if !ok {
			log.Fatalf("no behavior for %q", c.Name)
		}
		srv.Command(server.Command{Name: c.Name, Summary: c.Summary, Usage: c.Usage, Flags: c.Flags, Run: run})
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("listening %s\n", ln.Addr())
	hs := &http.Server{Handler: srv, ReadHeaderTimeout: 5 * time.Second}
	log.Fatal(hs.Serve(ln))
}
