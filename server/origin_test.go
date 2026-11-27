package server

import (
	"net/http"
	"testing"

	"github.com/coder/websocket"
)

func TestParseOrigin(t *testing.T) {
	tests := []struct {
		in   string
		want origin
		ok   bool
	}{
		{"https://example.dev", origin{"https", "example.dev", "443"}, true},
		{"https://example.dev:443", origin{"https", "example.dev", "443"}, true},
		{"https://example.dev:8443", origin{"https", "example.dev", "8443"}, true},
		{"http://localhost:5173", origin{"http", "localhost", "5173"}, true},
		{"http://localhost", origin{"http", "localhost", "80"}, true},
		{"HTTPS://Example.DEV", origin{"https", "example.dev", "443"}, true},
		{"http://[::1]:8080", origin{"http", "::1", "8080"}, true},
		{"tauri://localhost", origin{"tauri", "localhost", ""}, true},
		{"", origin{}, false},
		{"null", origin{}, false},
		{"example.dev", origin{}, false},
		{"//example.dev", origin{}, false},
		{"https://", origin{}, false},
		{"https://example.dev/", origin{}, false},
		{"https://example.dev/path", origin{}, false},
		{"https://example.dev?q=1", origin{}, false},
		{"https://example.dev?", origin{}, false},
		{"https://example.dev#frag", origin{}, false},
		{"https://example.dev#", origin{}, false},
		{"https://user@example.dev", origin{}, false},
		{"https://*.example.dev", origin{}, false},
		{"https://*", origin{}, false},
		{"https://example.dev:port", origin{}, false},
		{"mailto:someone@example.dev", origin{}, false},
	}
	for _, tt := range tests {
		t.Run(tt.in, func(t *testing.T) {
			got, err := parseOrigin(tt.in)
			if (err == nil) != tt.ok {
				t.Fatalf("parseOrigin(%q) error = %v, want ok %v", tt.in, err, tt.ok)
			}
			if got != tt.want {
				t.Errorf("parseOrigin(%q) = %+v, want %+v", tt.in, got, tt.want)
			}
		})
	}
}

func TestOriginSetAllows(t *testing.T) {
	set, err := newOriginSet([]string{"https://app.example", "http://localhost:5173"})
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name    string
		origins []string
		want    bool
	}{
		{"listed", []string{"https://app.example"}, true},
		{"listed with default port", []string{"https://app.example:443"}, true},
		{"listed, host in another case", []string{"https://APP.example"}, true},
		{"listed with port", []string{"http://localhost:5173"}, true},
		{"missing", nil, false},
		{"empty", []string{""}, false},
		{"null", []string{"null"}, false},
		{"other scheme", []string{"http://app.example"}, false},
		{"other port", []string{"https://app.example:8443"}, false},
		{"other port on localhost", []string{"http://localhost:5174"}, false},
		{"localhost without port", []string{"http://localhost"}, false},
		{"subdomain", []string{"https://evil.app.example"}, false},
		{"parent domain", []string{"https://example"}, false},
		{"listed host as a prefix", []string{"https://app.example.evil.test"}, false},
		{"listed host as a suffix", []string{"https://notapp.example"}, false},
		{"listed host in userinfo", []string{"https://app.example@evil.test"}, false},
		{"with a path", []string{"https://app.example/"}, false},
		{"two headers", []string{"https://app.example", "https://evil.test"}, false},
		{"listed twice", []string{"https://app.example", "https://app.example"}, false},
		{"two in one header", []string{"https://app.example https://evil.test"}, false},
		{"comma list", []string{"https://app.example, https://evil.test"}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := http.Header{}
			for _, o := range tt.origins {
				h.Add("Origin", o)
			}
			if got := set.allows(h); got != tt.want {
				t.Errorf("allows(%q) = %v, want %v", tt.origins, got, tt.want)
			}
		})
	}
	t.Run("empty allowlist", func(t *testing.T) {
		if (originSet{}).allows(http.Header{"Origin": []string{"https://app.example"}}) {
			t.Error("an empty allowlist allowed an origin")
		}
	})
}

func TestNewRejectsBadOrigin(t *testing.T) {
	for _, o := range []string{"example.dev", "https://example.dev/", "*", "https://*.example.dev"} {
		t.Run(o, func(t *testing.T) {
			defer func() {
				if recover() == nil {
					t.Errorf("New accepted origin %q", o)
				}
			}()
			New(Options{Origins: []string{o}})
		})
	}
}

// TestOriginOverTheWire checks that the handler refuses with close 4003, so
// a browser can tell why, and serves a listed origin.
func TestOriginOverTheWire(t *testing.T) {
	tests := []struct {
		name   string
		origin []string // nil sends no Origin header
		close  websocket.StatusCode
	}{
		{"listed", []string{testOrigin}, 0},
		{"listed with default port", []string{testOrigin + ":443"}, 0},
		{"missing", nil, closeOrigin},
		{"null", []string{"null"}, closeOrigin},
		{"other scheme", []string{"http://app.example"}, closeOrigin},
		{"other port", []string{testOrigin + ":8443"}, closeOrigin},
		{"other host", []string{"https://evil.test"}, closeOrigin},
		{"the server's own host", []string{"self"}, closeOrigin},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newHarness(t, nil, nil)
			c := h.dial(func(o *websocket.DialOptions) {
				o.HTTPHeader = http.Header{}
				for _, v := range tt.origin {
					if v == "self" {
						// Same-origin with the endpoint is not enough: the
						// list decides.
						v = h.http.URL
					}
					o.HTTPHeader.Add("Origin", v)
				}
			})
			if tt.close != 0 {
				c.wantClose(tt.close)
				return
			}
			if res := c.call("rite.hello", helloParamsFor(testToken, "")); res["session"] == "" {
				t.Errorf("hello result without a session: %v", res)
			}
		})
	}
}

func TestSubprotocolRequired(t *testing.T) {
	tests := []struct {
		name         string
		subprotocols []string
		close        websocket.StatusCode
	}{
		{"rite.1", []string{"rite.1"}, 0},
		{"rite.1 among others", []string{"other", "rite.1"}, 0},
		{"none", nil, websocket.StatusPolicyViolation},
		{"another", []string{"rite.2"}, websocket.StatusPolicyViolation},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newHarness(t, nil, nil)
			c := h.dial(func(o *websocket.DialOptions) { o.Subprotocols = tt.subprotocols })
			if tt.close != 0 {
				c.wantClose(tt.close)
				return
			}
			if got := c.ws.Subprotocol(); got != Protocol {
				t.Errorf("negotiated subprotocol %q", got)
			}
			c.call("rite.hello", helloParamsFor(testToken, ""))
		})
	}
}

func TestPlainHTTPRequestIsRefused(t *testing.T) {
	h := newHarness(t, nil, nil)
	resp, err := http.Get(h.http.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 400 {
		t.Errorf("a request that is not a WebSocket upgrade got status %d", resp.StatusCode)
	}
}
