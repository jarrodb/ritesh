// Package server serves the rite.1 protocol: a read-only filesystem and
// commands that a ritesh client in the browser mounts over a WebSocket.
//
// The wire contract is docs/protocol.md and the embedded JSON Schema
// (Schema). Conformance is checked against the shared traces in protocol/.
//
// A Server is an http.Handler. Give it the origins that may connect and a way
// to turn a token into a principal, mount what clients may read, register
// what they may run, and route the WebSocket endpoint to it:
//
//	srv := server.New(server.Options{
//		Authenticate: authenticate,
//		Origins:      []string{"https://example.dev"},
//	})
//	srv.Mount("/", fsys)
//	srv.Command(server.Command{Name: "hello", Run: hello})
//	http.Handle("/rite", srv)
//
// # Security
//
// The server decides what runs: a client names a registered command and
// sends argv, stdin, and signals. Clients never write to a mount.
//
// A connection is refused unless its Origin header names a listed origin by
// exact scheme, host, and port. Behind a proxy, set the request's RemoteAddr
// to the client's address before the server sees it: the limit on
// connections that have not authenticated counts by it.
//
// Paths from clients are checked before they reach a file system: a path
// with "..", an empty segment, or NUL is refused. Symbolic links are
// resolved by the server for file systems that report them (fs.ReadLinkFS,
// which os.DirFS, os.Root, and fstest.MapFS implement), and a link that
// leaves its mount is refused. Between that check and the open, the
// directory can change; for files on disk, os.Root closes that gap in the
// operating system and is the file system to mount.
//
// Commands are Go functions, and Go cannot stop one. KILL, the output limit,
// and the time limit cancel the command's context and drop its output; a
// command that ignores its context keeps its goroutine and its process slot
// until it returns.
package server
