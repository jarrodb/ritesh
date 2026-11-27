// Package server serves the rite.1 protocol: a read-only filesystem and
// commands that a ritesh client in the browser mounts over a WebSocket.
//
// The wire contract is docs/protocol.md and the embedded JSON Schema
// (Schema). Conformance is checked against the shared traces in protocol/.
package server
