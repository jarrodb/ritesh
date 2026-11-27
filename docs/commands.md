# Writing commands

```ts
import { defineCommand } from "riteshjs"

export const greet = defineCommand({
  name: "greet",
  summary: "say hello",
  usage: "greet [-l] [name...]",
  manual: "Greets each name, or the world.",
  flags: { l: { long: "loud", type: "boolean", description: "shout" } },
  run: async (p) => {
    const names = p.args.length ? p.args : ["world"]
    for (const n of names) await p.out(`hello, ${p.flags.loud ? n.toUpperCase() : n}\n`)
  },
})
```

## The process

`run(p)` gets a `Proc`:

| Field | Meaning |
|---|---|
| `argv`, `args`, `flags`, `subcommand` | the words; flags parsed from the definition |
| `out(text)`, `err(text)` | write to stdout and stderr; write `\n` for newlines |
| `lines()`, `stdin` | read stdin line by line, or as a stream |
| `env`, `cwd`, `uid` | the process's environment and directory |
| `fs` | the filesystem as this process's user sees it |
| `signal` | aborted on ^C (`"INT"`) or when a downstream reader exits (`"EPIPE"`) |
| `tty` | the terminal (`cols`, `rows`, `read`, `raw`) when stdout is the terminal, else `null` |
| `sys` | resolve names, run lines, spawn children, the session |

Return the exit code, or nothing for 0. A thrown error is exit 1 with one line on stderr.

Pipes and redirects work for every command; a command never sees them.

## Flags

- `{ type: "boolean" | "string" | "number", short?, long?, repeat?, default? }`.
- Keys in `p.flags` are the long name when there is one.
- `--help` and usage errors (exit 2) come from the definition.
- A command with no `flags` gets raw argv, including `--help`; `flags: {}` opts into parsing with no options.

## Subcommands

```ts
defineCommand({
  name: "mdm", summary: "...", usage: "mdm <devices|profiles> ...",
  subcommands: {
    devices: { summary: "devices", usage: "mdm devices <ls>", subcommands: {
      ls: { summary: "list devices", usage: "mdm devices ls", run: async (p) => { ... } },
    } },
  },
})
```

`p.subcommand` is the path taken, such as `["devices", "ls"]`.

## Completion

`complete(ctx)` returns candidates for the word under the cursor; without it, rite completes subcommand and flag names.

## Easter eggs

```ts
import { defineEgg, PASS } from "riteshjs"

defineEgg({ id: "xyzzy", trigger: { command: "xyzzy" }, run: async (p) => { await p.out("nothing happens\n") } })
defineEgg({ id: "konami", trigger: { keys: "up up down down left right left right b a" }, run: async (p) => { ... } })
```

Triggers: `command` (with an optional `when` predicate), `input` (a regex on the raw line), `keys` (a key sequence). Return `PASS` to let the line run as usual.
