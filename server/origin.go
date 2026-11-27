package server

import (
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// origin is a scheme, host, and port, as RFC 6454 defines an origin.
type origin struct {
	scheme, host, port string
}

var defaultPorts = map[string]string{"http": "80", "https": "443", "ws": "80", "wss": "443"}

// parseOrigin reads a serialized origin such as "https://example.dev" or
// "http://localhost:5173". The port of a scheme with a default may be left
// out; it is compared as that default.
func parseOrigin(s string) (origin, error) {
	u, err := url.Parse(s)
	if err != nil {
		return origin{}, fmt.Errorf("origin %q: %w", s, err)
	}
	switch {
	case u.Scheme == "" || u.Hostname() == "":
		return origin{}, fmt.Errorf("origin %q: want scheme://host[:port]", s)
	case strings.Contains(u.Hostname(), "*"):
		return origin{}, fmt.Errorf("origin %q: patterns are not supported", s)
	case u.User != nil, u.Path != "", u.RawQuery != "", u.ForceQuery, u.Fragment != "", u.Opaque != "", strings.HasSuffix(s, "#"):
		return origin{}, fmt.Errorf("origin %q: want only scheme, host, and port", s)
	}
	o := origin{scheme: strings.ToLower(u.Scheme), host: strings.ToLower(u.Hostname()), port: u.Port()}
	if o.port == "" {
		o.port = defaultPorts[o.scheme]
	}
	return o, nil
}

type originSet map[origin]struct{}

func newOriginSet(list []string) (originSet, error) {
	set := make(originSet, len(list))
	for _, s := range list {
		o, err := parseOrigin(s)
		if err != nil {
			return nil, err
		}
		set[o] = struct{}{}
	}
	return set, nil
}

// allows reports whether the request carries exactly one Origin header that
// names a listed origin. A missing Origin and "null" are refused.
func (set originSet) allows(h http.Header) bool {
	values := h.Values("Origin")
	if len(values) != 1 {
		return false
	}
	o, err := parseOrigin(values[0])
	if err != nil {
		return false
	}
	_, ok := set[o]
	return ok
}
