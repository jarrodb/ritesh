package server

import (
	"context"
	"strings"
	"testing"
)

func TestComplete(t *testing.T) {
	run := func(context.Context, *Proc) int { return 0 }
	keep := ""
	slash := "/"
	h := newHarness(t, func(o *Options) { o.Limits.MaxArgs = 8 }, func(s *Server) {
		s.Command(Command{Name: "count", Summary: "print numbers", Run: run,
			Flags: map[string]Flag{"n": {Long: "number", Short: "n", Type: FlagNumber}}})
		s.Command(Command{Name: "copy", Summary: "copy things", Run: run, Flags: map[string]Flag{
			"verbose": {Long: "verbose", Short: "v", Description: "say more"},
			"output":  {Long: "output", Type: FlagString, Description: "where to write"},
			"x":       {Short: "x"},
			"version": {Long: "version"},
		}})
		s.Command(Command{Name: "plain", Run: run})
		s.Command(Command{Name: "devices", Summary: "list devices", Run: run,
			Flags: map[string]Flag{"all": {Long: "all", Short: "a"}},
			Complete: func(ctx context.Context, argv []string, index int) []Candidate {
				who, _ := PrincipalFromContext(ctx)
				if argv[index] == "panic" {
					panic("completer exploded")
				}
				return []Candidate{
					{Value: "iphone-" + who.ID, Display: "iPhone", Description: strings.Join(argv, ",")},
					{Value: "ipad/", Suffix: &slash},
					{Value: "--serial=", Suffix: &keep},
				}
			}})
		s.Command(Command{Name: "many", Run: run, Complete: func(context.Context, []string, int) []Candidate {
			out := make([]Candidate, 5000)
			for i := range out {
				out[i] = Candidate{Value: strings.Repeat("v", 40), Description: strings.Repeat("d", 40)}
			}
			return out
		}})
		s.Command(Command{Name: "none", Run: run, Complete: func(context.Context, []string, int) []Candidate { return nil }})
	})
	c, _ := h.connect()

	type cand = map[string]any
	tests := []struct {
		name  string
		argv  []string
		index int
		want  []any
	}{
		// The trace's case: each flag once, by its short spelling.
		{"flags of a bare dash", []string{"count", "-"}, 1, []any{cand{"value": "-n", "description": "number"}}},
		{"the short flag itself", []string{"count", "-n"}, 1, []any{cand{"value": "-n", "description": "number"}}},
		{"long flags of a double dash", []string{"count", "--"}, 1, []any{cand{"value": "--number"}}},
		{"long flags by prefix", []string{"count", "--num"}, 1, []any{cand{"value": "--number"}}},
		{"no such long flag", []string{"count", "--x"}, 1, []any{}},
		{"no such short flag", []string{"count", "-z"}, 1, []any{}},
		{"a later word", []string{"count", "-n", "3", "-"}, 3, []any{cand{"value": "-n", "description": "number"}}},
		{"a word in the middle", []string{"count", "-", "5"}, 1, []any{cand{"value": "-n", "description": "number"}}},
		{"several flags, sorted by name", []string{"copy", "-"}, 1, []any{
			cand{"value": "--output", "description": "where to write"},
			cand{"value": "-v", "description": "say more"},
			cand{"value": "--version"},
			cand{"value": "-x"},
		}},
		{"several long flags", []string{"copy", "--ver"}, 1, []any{
			cand{"value": "--verbose", "description": "say more"},
			cand{"value": "--version"},
		}},
		{"after -- nothing is a flag", []string{"copy", "--", "-"}, 2, []any{}},
		{"-- itself can be completed", []string{"copy", "--"}, 1, []any{
			cand{"value": "--output", "description": "where to write"},
			cand{"value": "--verbose", "description": "say more"},
			cand{"value": "--version"},
		}},
		{"an operand of a command without Complete", []string{"copy", "fi"}, 1, []any{}},
		{"a command without flags", []string{"plain", "-"}, 1, []any{}},
		{"an unknown command", []string{"nope", "-"}, 1, []any{}},

		{"command names", []string{"co"}, 0, []any{
			cand{"value": "count", "description": "print numbers"},
			cand{"value": "copy", "description": "copy things"},
		}},
		{"every command", []string{""}, 0, []any{
			cand{"value": "count", "description": "print numbers"},
			cand{"value": "copy", "description": "copy things"},
			cand{"value": "plain"},
			cand{"value": "devices", "description": "list devices"},
			cand{"value": "many"},
			cand{"value": "none"},
		}},
		{"nothing typed yet", []string{}, 0, []any{
			cand{"value": "count", "description": "print numbers"},
			cand{"value": "copy", "description": "copy things"},
			cand{"value": "plain"},
			cand{"value": "devices", "description": "list devices"},
			cand{"value": "many"},
			cand{"value": "none"},
		}},
		{"no command by that prefix", []string{"zz"}, 0, []any{}},
		{"the first word of several", []string{"dev", "x"}, 0, []any{cand{"value": "devices", "description": "list devices"}}},

		// A command's own Complete answers for every word, flags included.
		{"Complete", []string{"devices", "ip"}, 1, []any{
			cand{"value": "iphone-alice", "display": "iPhone", "description": "devices,ip"},
			cand{"value": "ipad/", "suffix": "/"},
			cand{"value": "--serial=", "suffix": ""},
		}},
		{"Complete for a word not typed yet", []string{"devices"}, 1, []any{
			cand{"value": "iphone-alice", "display": "iPhone", "description": "devices,"},
			cand{"value": "ipad/", "suffix": "/"},
			cand{"value": "--serial=", "suffix": ""},
		}},
		{"Complete replaces the flags", []string{"devices", "-"}, 1, []any{
			cand{"value": "iphone-alice", "display": "iPhone", "description": "devices,-"},
			cand{"value": "ipad/", "suffix": "/"},
			cand{"value": "--serial=", "suffix": ""},
		}},
		{"Complete returning nil", []string{"none", "x"}, 1, []any{}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res := c.call("proc.complete", msg{"argv": tt.argv, "index": tt.index})
			if !matches(any(msg{"candidates": tt.want}), any(res), "exact", "") {
				t.Errorf("proc.complete %q at %d\n got %s\nwant %s", tt.argv, tt.index, encode(res), encode(tt.want))
			}
		})
	}

	t.Run("candidates are cut to fit a message", func(t *testing.T) {
		c.maxFrame = 0
		res := c.call("proc.complete", msg{"argv": []string{"many", ""}, "index": 1})
		n := len(res["candidates"].([]any))
		if n == 0 || n >= 5000 {
			t.Errorf("%d candidates", n)
		}
		if c.maxFrame > h.srv.limits.MaxMessageBytes {
			t.Errorf("a frame of %d bytes exceeds maxMessageBytes", c.maxFrame)
		}
	})
	t.Run("a Complete that panics is an error, and the server lives", func(t *testing.T) {
		e := c.callErr("proc.complete", msg{"argv": []string{"devices", "panic"}, "index": 1})
		if codeOf(e) != codeApp || errnoOf(e) != "EIO" {
			t.Errorf("got %v", e)
		}
		c.sync()
	})
	t.Run("argv over the limit", func(t *testing.T) {
		e := c.callErr("proc.complete", msg{"argv": strings.Split("a b c d e f g h i", " "), "index": 1})
		if errnoOf(e) != "EINVAL" {
			t.Errorf("got %v", e)
		}
	})
}
