// A Proc for one command over the real vfs, with the flag parsing the kernel
// does from a definition. Command and egg tests share it.
import { parseArgv } from "../../src/kernel/flags.js"
import {
  type CommandDef, type CommandInfo, type Env, EXIT, type Flags, type Proc, type Resolution,
  type SessionView, type SudoPolicy, type Sys, type Tty, type Vfs,
} from "../../src/contracts.js"
import { createVfs } from "../../src/vfs/index.js"

/** The time every inode in `world()` was made. */
export const T0 = Date.UTC(2026, 10, 26, 12, 0, 0)

export const HOME = "/home/guest"

/** A small tree: root-owned system directories, a home for uid 1000, a link, and actions. */
export function world(): Vfs {
  const fs = createVfs({ now: () => T0, open: () => false })
  fs.put("/bin", { type: "dir" })
  fs.put("/etc/motd", { type: "file", content: "welcome\n" })
  fs.put("/usr/share/man/rite", { type: "file", content: "rite is a shell for the browser." })
  fs.put("/tmp", { type: "dir", mode: 0o777 })
  fs.put(HOME, { type: "dir", uid: 1000 })
  fs.put(`${HOME}/.riterc`, { type: "file", content: "alias ll='ls -l'\n", uid: 1000 })
  fs.put(`${HOME}/notes.txt`, { type: "file", content: "alpha\nbeta\ngamma\n", uid: 1000 })
  fs.put(`${HOME}/docs`, { type: "dir", uid: 1000 })
  fs.put(`${HOME}/docs/a.txt`, { type: "file", content: "one two\nthree\n", uid: 1000 })
  fs.put(`${HOME}/latest`, { type: "link", target: "docs" })
  fs.put(`${HOME}/hello`, { type: "action", action: { print: "hello from an action" } })
  fs.put(`${HOME}/site`, { type: "action", action: { open: "https://example.com/" } })
  fs.put(`${HOME}/go`, { type: "action", action: { navigate: "/docs" } })
  return fs
}

// ---------------------------------------------------------------- flags

// ---------------------------------------------------------------- sys and tty

export interface SysOptions {
  resolutions?: Record<string, Resolution>
  commands?: CommandInfo[]
  sudo?: SudoPolicy
  session?: Partial<SessionView>
  spawn?: Sys["spawn"]
}

export interface FakeSys extends Sys {
  readonly spawned: Array<{ argv: readonly string[]; uid: number | undefined }>
}

export function fakeSys(o: SysOptions = {}): FakeSys {
  const spawned: FakeSys["spawned"] = []
  return {
    spawned,
    resolve: (name) => o.resolutions?.[name] ?? { kind: "not-found", name },
    commands: () => o.commands ?? [],
    spawn: (argv, options) => {
      spawned.push({ argv, uid: options?.uid })
      return o.spawn ? o.spawn(argv, options) : Promise.resolve(EXIT.OK)
    },
    run: () => Promise.resolve(EXIT.OK),
    session: { user: "guest", uid: 1000, cwd: HOME, hostname: "rite.test", home: HOME, lastStatus: 0, ...o.session },
    sudo: o.sudo ?? false,
    history: () => [],
  }
}

export interface FakeTty extends Tty {
  readonly raws: string[]
  readonly reads: Array<{ echo: boolean | undefined; prompt: string | undefined }>
}

/** `answers` are the lines `read` returns in order; after them it returns null (^D). */
export function fakeTty(o: { cols?: number; rows?: number; answers?: Array<string | null> } = {}): FakeTty {
  const raws: string[] = []
  const reads: FakeTty["reads"] = []
  const answers = [...(o.answers ?? [])]
  return {
    raws,
    reads,
    cols: o.cols ?? 80,
    rows: o.rows ?? 24,
    read: (options) => {
      reads.push({ echo: options?.echo, prompt: options?.prompt })
      return Promise.resolve(answers.shift() ?? null)
    },
    raw: (data) => {
      raws.push(data)
      return Promise.resolve()
    },
  }
}

export function info(name: string, summary: string, more: Partial<CommandInfo> = {}): CommandInfo {
  return { name, summary, usage: name, builtin: false, remote: false, ...more }
}

// ---------------------------------------------------------------- running

export interface RunOptions {
  /** One chunk, several chunks, or a stream. Absent means stdin is closed. */
  stdin?: string | readonly string[] | ReadableStream<string>
  /** Makes stdout the terminal. */
  tty?: Tty
  fs?: Vfs
  env?: Env
  cwd?: string
  uid?: number
  sys?: Sys
  signal?: AbortSignal
}

export interface Result {
  code: number
  stdout: string
  stderr: string
}

function toStream(input: RunOptions["stdin"]): ReadableStream<string> {
  if (input instanceof ReadableStream) return input
  const pieces = input === undefined ? [] : typeof input === "string" ? [input] : input
  return new ReadableStream<string>({
    start: (controller) => {
      for (const piece of pieces) controller.enqueue(piece)
      controller.close()
    },
  })
}

async function* linesOf(stream: ReadableStream<string>): AsyncGenerator<string> {
  let buffer = ""
  for await (const chunk of stream) {
    buffer += chunk
    for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
      yield buffer.slice(0, at)
      buffer = buffer.slice(at + 1)
    }
  }
  if (buffer !== "") yield buffer
}

function sink(): { stream: WritableStream<string>; text: () => string } {
  let text = ""
  return { stream: new WritableStream<string>({ write: (chunk) => { text += chunk } }), text: () => text }
}

/** Builds the Proc for `argv` and calls `body`. `flags` and `args` are passed in already parsed. */
export async function exec(
  body: (p: Proc) => Promise<unknown>, argv: readonly string[], parsed: { flags: Flags; args: readonly string[] },
  o: RunOptions = {},
): Promise<{ value: unknown; stdout: string; stderr: string }> {
  const stdout = sink()
  const stderr = sink()
  const out = stdout.stream.getWriter()
  const err = stderr.stream.getWriter()
  const stdin = toStream(o.stdin)
  const proc: Proc = {
    argv, flags: parsed.flags, args: parsed.args, subcommand: [],
    stdin, stdout: stdout.stream, stderr: stderr.stream,
    out: (text) => out.write(text), err: (text) => err.write(text), lines: () => linesOf(stdin),
    env: o.env ?? {}, cwd: o.cwd ?? HOME, uid: o.uid ?? 1000, fs: o.fs ?? world(),
    signal: o.signal ?? new AbortController().signal,
    tty: o.tty ?? null,
    stdio: { stdin: o.stdin === undefined ? "null" : "pipe", stdout: o.tty ? "tty" : "pipe", stderr: o.tty ? "tty" : "pipe" },
    sys: o.sys ?? fakeSys(),
  }
  const value = await body(proc)
  await out.close()
  await err.close()
  return { value, stdout: stdout.text(), stderr: stderr.text() }
}

/**
 * Runs a command as the kernel would: flags parsed from the definition,
 * `--help` and usage errors answered without calling `run`, void as exit 0.
 */
export async function run(def: CommandDef, words: readonly string[] = [], o: RunOptions = {}): Promise<Result> {
  // The kernel's own parser, so a command test reads its words as the shell does.
  const parsed = parseArgv(def, [def.name, ...words])
  if (parsed.kind === "help") return { code: EXIT.OK, stdout: `usage: ${def.usage}\n`, stderr: "" }
  if (parsed.kind === "usage") return { code: EXIT.USAGE, stdout: "", stderr: `${def.name}: ${parsed.message}\nusage: ${def.usage}\n` }
  if (!def.run) throw new Error(`${def.name} has no run`)
  const { value, stdout, stderr } = await exec(def.run, [def.name, ...words], parsed, o)
  return { code: typeof value === "number" ? value : EXIT.OK, stdout, stderr }
}

/** An endless stdin of numbered lines, and a count of how many were pulled. */
export function endless(onPull: (n: number) => void): ReadableStream<string> {
  let n = 0
  return new ReadableStream<string>({
    pull: (controller) => {
      n++
      onPull(n)
      controller.enqueue(`line ${n}\n`)
    },
  }, { highWaterMark: 0 })
}
