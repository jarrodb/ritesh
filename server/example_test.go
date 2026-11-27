package server_test

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"testing/fstest"

	"github.com/jarrodb/ritesh/server"
)

func Example() {
	srv := server.New(server.Options{
		Authenticate: func(_ context.Context, token string) (server.Principal, error) {
			if token != "let-me-in" {
				return server.Principal{}, errors.New("unknown token")
			}
			return server.Principal{ID: "user-1"}, nil
		},
		Origins: []string{"https://example.dev"},
		Limits:  server.DefaultLimits,
	})
	srv.Mount("/", fstest.MapFS{"readme.txt": {Data: []byte("hello\n")}})
	srv.Command(server.Command{
		Name:    "whoami",
		Summary: "print who you are",
		Usage:   "whoami",
		Run: func(_ context.Context, p *server.Proc) int {
			_, _ = fmt.Fprintln(p.Stdout, p.Principal.ID)
			return 0
		},
	})
	srv.OnSession(func(s server.Session) {
		_ = s.Notify("info", "connected as "+s.Principal().ID)
	})

	mux := http.NewServeMux()
	mux.Handle("/rite", srv)
	// http.ListenAndServe(":8080", mux)
}
