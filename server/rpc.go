package server

import (
	"bytes"
	"encoding/json"
	"errors"
)

// JSON-RPC 2.0 error codes.
const (
	codeParse          = -32700
	codeInvalidRequest = -32600
	codeMethodNotFound = -32601
	codeInvalidParams  = -32602
	codeApp            = -32000
)

// errno is one of the error names the client understands
// (packages/ritesh/src/contracts.ts).
type errno string

const (
	enoent  errno = "ENOENT"
	enotdir errno = "ENOTDIR"
	eisdir  errno = "EISDIR"
	eacces  errno = "EACCES"
	eloop   errno = "ELOOP"
	einval  errno = "EINVAL"
	enotsup errno = "ENOTSUP"
	enospc  errno = "ENOSPC"
	eio     errno = "EIO"
)

var errnoMessages = map[errno]string{
	enoent:  "no such file or directory",
	enotdir: "not a directory",
	eisdir:  "is a directory",
	eacces:  "permission denied",
	eloop:   "too many levels of symbolic links",
	einval:  "invalid argument",
	enotsup: "operation not supported",
	enospc:  "no space left on device",
	eio:     "input/output error",
}

// rpcError is the error member of a response.
type rpcError struct {
	Code    int      `json:"code"`
	Message string   `json:"message"`
	Data    *errData `json:"data,omitempty"`
}

type errData struct {
	Errno errno   `json:"errno"`
	Path  *string `json:"path,omitempty"`
}

var (
	errParse          = &rpcError{Code: codeParse, Message: "parse error"}
	errInvalidRequest = &rpcError{Code: codeInvalidRequest, Message: "invalid request"}
	errMethodNotFound = &rpcError{Code: codeMethodNotFound, Message: "method not found"}
	errInvalidParams  = &rpcError{Code: codeInvalidParams, Message: "invalid params"}
)

// appError is an application error without a path.
func appError(e errno) *rpcError {
	return &rpcError{Code: codeApp, Message: errnoMessages[e], Data: &errData{Errno: e}}
}

// pathError is an application error about path.
func pathError(e errno, path string) *rpcError {
	err := appError(e)
	err.Data.Path = &path
	return err
}

// request is a message from the client. ID is nil for a notification.
type request struct {
	ID     *int64
	Method string
	Params json.RawMessage
}

type envelope struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  *string         `json:"method"`
	Params  json.RawMessage `json:"params"`
	Result  json.RawMessage `json:"result"`
	Error   json.RawMessage `json:"error"`
}

// parseRequest decodes one frame. It returns nil and no error for a message
// to drop: a response, which the server never asked for.
func parseRequest(data []byte) (*request, *rpcError) {
	var env envelope
	if err := json.Unmarshal(data, &env); err != nil {
		var syntax *json.SyntaxError
		if errors.As(err, &syntax) {
			return nil, errParse
		}
		// Valid JSON of the wrong shape, a batch among them.
		return nil, errInvalidRequest
	}
	if env.JSONRPC != "2.0" {
		return nil, errInvalidRequest
	}
	if env.Method == nil {
		if env.Result != nil || env.Error != nil {
			return nil, nil
		}
		return nil, errInvalidRequest
	}
	req := &request{Method: *env.Method, Params: env.Params}
	if env.ID != nil {
		var id int64
		if err := json.Unmarshal(env.ID, &id); err != nil || bytes.Equal(env.ID, []byte("null")) {
			return nil, errInvalidRequest
		}
		req.ID = &id
	}
	return req, nil
}

func encode(v any) []byte {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		// Every value passed here is a struct of strings, numbers, and
		// booleans, or a json.RawMessage this package produced.
		panic("server: encode: " + err.Error())
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n"))
}

type response struct {
	JSONRPC string    `json:"jsonrpc"`
	ID      *int64    `json:"id"`
	Result  any       `json:"result,omitempty"`
	Error   *rpcError `json:"error,omitempty"`
}

// encodeResult builds a response. A nil id is JSON null.
func encodeResult(id *int64, result any) []byte {
	return encode(response{JSONRPC: "2.0", ID: id, Result: result})
}

func encodeError(id *int64, e *rpcError) []byte {
	return encode(response{JSONRPC: "2.0", ID: id, Error: e})
}

type notification struct {
	JSONRPC string `json:"jsonrpc"`
	Method  string `json:"method"`
	Params  any    `json:"params"`
}

func encodeNotification(method string, params any) []byte {
	return encode(notification{JSONRPC: "2.0", Method: method, Params: params})
}

// empty is the result of a request that returns nothing.
type empty struct{}
