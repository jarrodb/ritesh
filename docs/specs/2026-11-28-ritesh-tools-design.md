# ritesh tools

Status: designed, not built.

## Goal

A tool is defined once and served to people and to agents. The definition names the tool, its input, its result, and how the result reads as text. Adapters expose it as a command in a shell, as a rite command over rite.1, and as an MCP tool. The tool never picks its output format; the host picks it from the protocol it speaks.

First users: a network tools project, then mdm's `mdm` commands.

## Constraints

- Go first, in the `ritesh/server` module, as package `github.com/jarrodb/ritesh/server/tool`. A TypeScript mirror for browser commands waits for a consumer that needs it.
- MCP through the official Go SDK (`github.com/modelcontextprotocol/go-sdk`, v1.7.0 at the time of writing, which implements the 2026-07-28 revision; verify the pin when building).
- rite.1 changes are additive, and a 0.2 client keeps its help and completion against a server with tools.
- The adapters add no network access of their own.

## Definition

```go
type Tool[In, Out, Event any] struct {
    Name        string
    Summary     string // one line: rite help, MCP title
    Description string // for agents and `man`: what it does, what it contacts, its limits
    Annotations Annotations // read-only, open-world, idempotent (MCP tool hints)
    Timeout     time.Duration
    Schema      func(in *jsonschema.Schema) // optional: defaults, enums, ranges

    Run  func(ctx context.Context, c Call, in In, emit func(Event)) (Out, error)
    Text Text[Out, Event]
}

type Text[Out, Event any] struct {
    Event  func(w io.Writer, ev Event, o Render) error // one line per event
    Result func(w io.Writer, out Out, o Render) error
}

type Render struct{ Color bool } // the adapter sets Color for a TTY only
```

- `In`, `Out`, and `Event` are flat Go structs. Their schemas are generated from the types (`github.com/google/jsonschema-go`, as the SDK does). The `jsonschema` tag carries only a description, so defaults, enums, and ranges are set in `Schema`. A tool without events uses `tool.None`.
- `emit` reports progress (one ping reply, one hop). The final `Out` is the whole answer; nothing exists only in events.
- `tool.Fail(format, args...)` returns an error the tool means: the person or agent can act on it. Any other error is unexpected and reported as an internal failure.

## Registry

```go
reg := tool.NewRegistry()
tool.Register(reg, ping.Tool)      // generic: keeps In, Out, Event typed
```

`Register` builds the schemas once and stores the tool behind an interface (`entry[In, Out, Event]`) whose methods add it to each adapter with its types intact, so the MCP adapter calls the SDK's typed `AddTool[In, Out]` with exactly the schemas the CLI validates against. Registration fails on: unsupported field types, duplicate names, short flags, or JSON names, misordered `arg` tags, and a field named `help`, `json`, or `jsonl`. A compile test registers two tools of different types.

## Input from argv

v1 takes fields of `bool`, string, integer, float, and slices of those. Nested structs, maps, and pointers fail registration.

- Each field is a flag `--name` (its JSON name), with `short:"c"` for `-c`. `--name=v` and `--name v` both work; `-c5` and `-c 5` both work; booleans combine (`-46`).
- Booleans take no value; `--no-name` sets false. Slices repeat (`--resolver a --resolver b`). A scalar given twice is a usage error.
- Fields tagged `arg:"1"`, `arg:"2"` are positional in order; `arg:"rest"` (a slice) takes the remainder. Flags may come between arguments; `--` ends flags. A word starting with `-` followed by a digit is a value, not a flag.
- An absent flag is absent: the schema's default applies, and a boolean with no default is false. Required means a JSON-required field without a default.
- Order, as the SDK does it: argv becomes a JSON object, defaults are applied, the object is validated against the input schema, then decoded into `In`.
- Usage and `--help` are generated from the definition; `man` prints `Description`.

## Formats

The host chooses; the tool does not.

| Host | Default | On request |
|---|---|---|
| shell (CLI adapter) | text: events as they arrive, then the result | `--json` prints `Out` as one document; `--jsonl` prints `{"event": ...}` lines, then `{"result": ...}` |
| rite terminal (rite.1) | text | `--json`, `--jsonl`, as in a shell |
| MCP | `structuredContent` is `Out`; `content` is the text rendering of `Out` | when the client sends a progress token, each event goes as a progress notification: a counter for `progress` and the event's text as `message` |

- `--json` and `--jsonl` belong to the adapter; giving both is a usage error.
- The schemas of `In`, `Out`, and `Event` are published (MCP `inputSchema` and `outputSchema`; rite.1 descriptor). A field is never removed or retyped within a major version of a tool.

## Errors and exit codes

| Case | CLI and rite | MCP |
|---|---|---|
| success | output, exit 0 | result |
| argv fails parsing, the schema, or a format flag conflict | usage on stderr, exit 2 | input failing the schema: result with `isError: true` and the validation message (the SDK's typed handler does this before the tool runs) |
| `tool.Fail` | message on stderr, exit 1 | `isError: true`, the message as text |
| unexpected error or panic | `internal error` on stderr, exit 70 | `isError: true`, `internal error`; details in the host log only |
| `Tool.Timeout` passed | exit 124 | `isError: true`, "stopped after N s" |
| interrupted (^C) | exit 130 | cancelled by the client; no result |
| killed by the rite server (wall time, output limit, KILL) | exit 137, as rite.1 does today | none |
| `Out` fails its own output schema, or rendering fails | exit 70 | protocol error (internal) |

The base rite spec gains 124 and 70 in its exit code list.

## Calls, admission, and records

Every run gets a `Call`: the principal (rite.1's `Authenticate` result; `local` for stdio MCP and the CLI), the adapter, and the tool name. A host may set two hooks; both do nothing by default:

- `Admit(ctx, Call) error` runs before the tool. An error refuses the run: exit 1 and the error's message, or `isError: true` in MCP. Quotas and payment checks go here.
- `Record(ctx, Call, Outcome)` runs after, with the duration and outcome.

Input that fails parsing or the schema never reaches `Admit` or `Record`.

<<<<<<< ours
||| codex reject: Cost, Call, and Meter are speculative for the first consumer, and an after-run meter cannot do the quota or payment admission it claims. Remove them from v1, or define a pre-run Admit and a post-run Record.
||| claude accept-partial: the owner intends a paid service, so the seam stays; the after-run-only meter was wrong. Two no-op hooks, Admit before and Record after, and no cost classes or call ids until billing is designed.
=======
Two hooks, `Admit` before a run and `Record` after, no-op by default. No cost classes, prices, or call ids in v1.
>>>>>>> claude+codex

## rite.1 additions

- A client that wants schemas sends the capability `tool.schema` in `rite.hello`; only then does the server add `inputSchema`, `outputSchema`, and `eventSchema` to each command descriptor. Every client still gets `usage` and `flags`, projected from the schema, so 0.2 clients keep help and completion.
- The server checks the `rite.hello` response against `maxMessageBytes` and drops schemas (keeping `usage` and `flags`) when they do not fit.
- Formats are capabilities too: `tool.json`, `tool.jsonl`.
- The protocol's source of truth changes first: `protocol/rite.1.schema.json`, `docs/protocol.md`, the traces, the generated TypeScript, then the server's copy.

## Testing

- Conformance over two sample tools of different types: argv and schema validation agree on every lexical rule above; every format; every row of the error table; `Admit` and `Record` called once per admitted run and never for rejected input.
- MCP over the SDK's in-memory transport, including progress notifications.
- rite.1: the existing conformance suite, plus hello with and without `tool.schema`, and a hello that overflows.

## Decisions

- One definition, three adapters; formats belong to the host.
- Typed registration through a type-keeping registry, so the SDK's typed `AddTool` and the CLI validate against the same schema.
- Go first; the TypeScript mirror waits.
- `Admit` and `Record` as no-op hooks from the start; billing designs itself onto them later.

## Phase plan

1. `tool` package: definition, registry, schemas, argv parsing, text and JSON formats, errors, the CLI adapter, `Admit` and `Record`.
2. MCP adapter over the Go SDK.
3. rite.1 additions and the rite adapter; the client side in riteshjs.
4. A release of `ritesh/server` with the package.
