package server

import _ "embed"

// Schema is the rite.1 JSON Schema (2020-12), copied from protocol/ by the
// repository's sync script and checked for drift in CI.
//
//go:embed rite.1.schema.json
var Schema []byte

// Protocol is the WebSocket subprotocol this package speaks.
const Protocol = "rite.1"
