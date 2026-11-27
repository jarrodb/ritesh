package server

import (
	"context"
	"io"
	"slices"
	"strings"
)

// Command is something a client can run. Name, Summary, Usage, Flags, and
// Subcommands are sent to the client in rite.hello, which renders --help and
// man from them.
type Command struct {
	// Name is what the client types. It is matched against argv[0].
	Name    string
	Summary string
	Usage   string
	// Flags describes the command's flags, keyed by their canonical name.
	// The server does not parse them: Run receives argv as the client sent it.
	Flags       map[string]Flag
	Subcommands map[string]Subcommand

	// Run executes the command and returns its exit code, 0 to 255. It must
	// return soon after ctx ends: the context is cancelled when the client
	// interrupts or kills the process, when a limit is passed, and when the
	// connection ends. context.Cause tells which. After an interrupt the
	// command chooses its code, 130 by convention.
	Run func(ctx context.Context, p *Proc) int

	// Complete returns candidates for argv[index], the word the client is
	// completing. When it is nil the server completes the command's flags.
	Complete func(ctx context.Context, argv []string, index int) []Candidate
}

// FlagType is the kind of value a flag takes.
type FlagType string

// The flag types.
const (
	FlagBoolean FlagType = "boolean"
	FlagString  FlagType = "string"
	FlagNumber  FlagType = "number"
)

// Flag describes one flag of a command. Long and Short are spelled without
// their dashes.
type Flag struct {
	Long  string `json:"long,omitempty"`
	Short string `json:"short,omitempty"`
	// Type defaults to FlagBoolean.
	Type        FlagType `json:"type"`
	Repeat      bool     `json:"repeat,omitempty"`
	Description string   `json:"description,omitempty"`
}

// Subcommand describes one subcommand of a command.
type Subcommand struct {
	Summary string `json:"summary"`
	Usage   string `json:"usage"`
}

// Candidate is one completion.
type Candidate struct {
	// Value replaces the word being completed.
	Value string `json:"value"`
	// Display is shown in place of Value in the menu.
	Display     string `json:"display,omitempty"`
	Description string `json:"description,omitempty"`
	// Suffix is appended after Value: nil for the client's default, a space.
	Suffix *string `json:"suffix,omitempty"`
}

// The kinds of stdio in TTY.
const (
	StdioTTY  = "tty"
	StdioPipe = "pipe"
)

// TTY describes the client's terminal as a process sees it.
type TTY struct {
	// Cols and Rows are the terminal's size when the process started.
	Cols, Rows int
	// Stdin, Stdout, and Stderr are StdioTTY or StdioPipe.
	Stdin, Stdout, Stderr string
}

// Proc is one run of a command.
type Proc struct {
	// Args is argv. Args[0] is the name the command was called by.
	Args []string
	// Env holds the variables the client's host allows it to send.
	Env map[string]string
	// Cwd is the client's working directory relative to the remote's root,
	// "" for the root or for a directory outside the remote.
	Cwd string
	// Stdin returns io.EOF when the client closes it and an error when the
	// process's context ends.
	Stdin io.Reader
	// Stdout and Stderr send each Write to the client as one notification, so
	// wrap them in a bufio.Writer for many small writes. Bytes that are not
	// UTF-8 are replaced with U+FFFD. Writes block while the client is slow
	// and fail once the process is killed.
	Stdout, Stderr io.Writer
	TTY            TTY
	Principal      Principal

	sess *session
}

// Size returns the terminal's size now. It follows the client's resizes.
func (p *Proc) Size() (cols, rows int) {
	if p.sess == nil {
		return p.TTY.Cols, p.TTY.Rows
	}
	return p.sess.size()
}

type principalKey struct{}

// PrincipalFromContext returns the principal a Run or Complete call is made
// for.
func PrincipalFromContext(ctx context.Context) (Principal, bool) {
	p, ok := ctx.Value(principalKey{}).(Principal)
	return p, ok
}

// commandInfo is a command as rite.hello reports it.
type commandInfo struct {
	Name        string                `json:"name"`
	Summary     string                `json:"summary"`
	Usage       string                `json:"usage"`
	Flags       map[string]Flag       `json:"flags,omitempty"`
	Subcommands map[string]Subcommand `json:"subcommands,omitempty"`
}

func (c *Command) info() commandInfo {
	return commandInfo{Name: c.Name, Summary: c.Summary, Usage: c.Usage, Flags: c.Flags, Subcommands: c.Subcommands}
}

// completeFlags offers the flags of c that word could become: each flag once,
// by its short spelling unless word starts with "--" or the flag has none.
// A short flag without a description is described by its long name.
func (c *Command) completeFlags(word string) []Candidate {
	out := []Candidate{}
	keys := make([]string, 0, len(c.Flags))
	for k := range c.Flags {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	wantLong := strings.HasPrefix(word, "--")
	for _, k := range keys {
		f := c.Flags[k]
		if f.Short != "" && !wantLong {
			if short := "-" + f.Short; strings.HasPrefix(short, word) {
				desc := f.Description
				if desc == "" {
					desc = f.Long
				}
				out = append(out, Candidate{Value: short, Description: desc})
			}
			continue
		}
		if f.Long == "" {
			continue
		}
		if long := "--" + f.Long; strings.HasPrefix(long, word) {
			out = append(out, Candidate{Value: long, Description: f.Description})
		}
	}
	return out
}
