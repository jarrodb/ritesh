# The rite language

rite is its own shell. This document defines the language for rite 0.x. The parser and kernel follow it, and `docs/language/cases.jsonl` holds the cases both are tested against. A change to this file is a change to the language.

## Lines

A line is parsed whole. It holds a list, a comment, or nothing.

```
line      = [ list ] [ comment ]
list      = pipeline { ( ";" | "&&" | "||" ) pipeline } [ ";" ]
pipeline  = command { "|" command }
command   = { assignment } word-or-redirect { word-or-redirect }
          | assignment { assignment }
```

- `;`, `&&`, and `||` have equal precedence and associate left: `a || b && c` runs `c` when `a || b` succeeded.
- `|` binds tighter than the list operators.
- A trailing `;` is allowed. A trailing `|`, `&&`, or `||` makes the line incomplete.
- Pipeline status is the status of its last command.

## Words and quoting

- Unquoted text is split into words on spaces and tabs.
- `'...'`: everything literal. No escapes.
- `"..."`: `$NAME` and `${NAME}` expand; `\"`, `\\`, and `\$` are the only escapes; any other `\` is literal.
- Unquoted `\` makes the next character literal. `\` at the end of the line makes the line incomplete; when the editor continues it, the `\` and the newline are removed (a line continuation), inside double quotes too.
- Adjacent parts form one word: `a'b'"c"` is the word `abc`.
- `#` starts a comment only at the start of a word: `echo a#b` prints `a#b`, `echo a #b` prints `a`.
- An open quote makes the line incomplete. The editor continues it on the next line, joined with `\n`.

## Assignments

`NAME=value` at the start of a command, where `NAME` matches `[A-Za-z_][A-Za-z0-9_]*`.

- With no command word, it sets a shell variable.
- Before a command word, it sets the variable for that command only.
- `export NAME` or `export NAME=value` marks it for child processes; `unset NAME` removes it.
- No globbing in assignment values.

Kernel variables:

| Name | Set by | Writable |
|---|---|---|
| `UID`, `RITE_VERSION`, `SHELL` (`/bin/rite`) | kernel | no: assignment fails, exit 1 |
| `USER`, `HOME`, `PWD`, `OLDPWD`, `HOSTNAME`, `PATH` (`/bin:/usr/bin`) | kernel | yes; changing `USER` does not change the uid, `cd` updates `PWD` |
| `?` | kernel, after every command | no |

## Expansion

In order, per word:

1. **Alias**: the first word of a command, unquoted, is replaced by its alias body, which is then parsed (it may contain operators). An alias is not expanded again inside its own body.
2. **Tilde**: unquoted `~` at the start of a word, followed by `/` or the end of the word, becomes `$HOME`. `~user` is reserved.
3. **Parameter**: `$NAME`, `${NAME}`, `$?`. An undefined variable is empty. `$` followed by anything else is literal.
4. **Glob**: see below.
5. **Quote removal.**

There is no field splitting: an expansion never produces more than one word, and its result is never globbed.

## Globs

- `*` matches any run of characters within one path segment; `[abc]`, `[a-z]`, `[!a]` match one character.
- Only characters unquoted in the source are glob characters.
- `?` is a literal in 0.x. `**` is reserved.
- `*` does not match a leading `.`.
- Matches are sorted by code point.
- No match is an error: `rite: no matches found: <pattern>`, exit 1, the command does not run.

## Redirects

| Form | Meaning |
|---|---|
| `> file` | stdout to file, truncated |
| `>> file` | stdout appended to file |
| `< file` | stdin from file |
| `2> file` | stderr to file, truncated |
| `2>> file` | stderr appended to file |
| `2>&1` | stderr to wherever stdout goes now |
| `>&2` | stdout to wherever stderr goes now |

- Redirects may appear anywhere in a command and apply left to right: `cmd > f 2>&1` sends both to `f`; `cmd 2>&1 > f` sends stderr to the previous stdout.
- Targets are opened, and truncated where the form says, before the command starts.
- A redirect with no command is a syntax error. A target that expands to more than one word is `rite: ambiguous redirect`. A directory is `EISDIR`. Errors are exit 1 and the command does not run.
- Builtins honor redirects.

## Reserved syntax

Unquoted, each of these is a syntax error, exit 2: `rite: '<token>' is not supported in rite <version>`. None of them is ever a literal. The `$` and backquote forms (`` ` ``, `$(`, `$((`, `$0` to `$9`, `$@`, `$*`, `$#`, `$$`, `$!`, `${` with anything but a name) are errors inside double quotes too (`$'` and `$"` are reserved unquoted only: inside double quotes a `$` before a quote is a literal `$`), so adding them later cannot change what an existing quoted line means.

- `` ` `` `$(` `$((` `$'` `$"` `(` `)` `{` `}` `<<` `<<<` `<(` `>(` `|&` `&>` `>|` `;;` `&` `[[` `((`
- `$0` to `$9`, `$@`, `$*`, `$#`, `$$`, `$!`
- `${` followed by anything but a name and `}`
- `~user`
- In command position: `!`, `if`, `then`, `else`, `elif`, `fi`, `for`, `in`, `do`, `done`, `while`, `until`, `case`, `esac`, `function`, `return`, `break`, `continue`, `local`

The `&` message adds: `quote the argument if it is part of a URL`. Unquoted JSON arguments are an error because of `{`; quote them.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | general failure, expansion and redirect errors |
| 2 | usage and syntax errors |
| 126 | permission denied or not executable |
| 127 | command not found: `rite: command not found: <name>` |
| 130 | interrupted (^C) |
| 255 | remote connection lost |

Codes outside 0 to 255 are clamped. `$?` holds the last pipeline's status.

## Errors

Commands print `<command>: <path>: <message>`; builtins print `rite: <builtin>: <path>: <message>`. Messages for the errno set are in `src/contracts.ts` (`ERRNO_MESSAGES`).

## Cases

`docs/language/cases.jsonl`, one JSON object per line:

| Field | Meaning |
|---|---|
| `line` | the input |
| `parse` | `"ok"`, `"incomplete"`, or `"syntax"` |
| `words` | for `ok`: each command's words after expansion, as arrays, in order of execution where it is static |
| `error` | for `syntax`: a substring of the message |
| `env` | variables set before the line |
| `files` | files present before the line, path to content |
| `stdout`, `stderr`, `exit` | the expected result of running the line in a session with only the case's env and files |

Parser tests use `line`, `parse`, `error`. Kernel tests use all fields.
