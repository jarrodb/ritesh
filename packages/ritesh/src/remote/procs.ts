// Remote commands as a CommandSource: proc.start, stdin, output, signals, exit.
import {
  type Candidate, type CommandInfo, type CommandSource, type Env, EXIT, type Proc, RiteError, type StdioKind, type Tty,
} from "../contracts.js"
import { byteLength, splitByJsonBytes } from "./chunk.js"
import type { Link } from "./link.js"
import { parseCandidates } from "./parse.js"
import type { CompleteParams, ResizeParams, SignalParams, StartParams, StdinParams } from "./protocol.gen.js"
import { type Clock, isRecord, messageOf } from "./wire.js"

/** What the server reports for a killed process; used when the client ends one itself. */
const EXIT_KILLED = 137
const CONNECTION_LOST = "rite: connection lost\n"
/** stdin waits while the socket holds more than this many unsent bytes. */
export const STDIN_HIGH_WATER_BYTES = 256 * 1024
export const STDIN_POLL_MS = 20
/** Used only if a process starts before any hello reported limits. */
const DEFAULT_MAX_MESSAGE_BYTES = 65_536

export interface ProcsConfig {
  link: Link
  clock: Clock
  /** The mount root, absolute, without a trailing slash ("" for "/"). */
  root: string
  /** Names of the variables sent with proc.start. */
  env: readonly string[]
  /** Command names known before the first hello. */
  declared: readonly string[]
}

interface Running {
  readonly pid: number
  readonly proc: Proc
  readonly done: Promise<number>
  resolve: (code: number) => void
  /** Output writes, in arrival order. Never rejects. */
  tail: Promise<void>
  /** Nothing more is sent or accepted for this pid. */
  ended: boolean
  /** stdout's reader is gone; further stdout is dropped. */
  broken: boolean
  killed: boolean
  reader: ReadableStreamDefaultReader<string> | undefined
  onAbort: () => void
}

/** The client's cwd relative to the remote root, or "" when it is outside the remote. */
export function remoteCwd(root: string, cwd: string): string {
  if (cwd === root || cwd === root + "/") return ""
  return cwd.startsWith(root + "/") ? cwd.slice(root.length + 1) : ""
}

/** Only the variables the host allows leave the page. */
export function pickEnv(env: Readonly<Env>, allow: readonly string[]): Env {
  const out: Env = {}
  for (const name of allow) {
    const value = Object.hasOwn(env, name) ? env[name] : undefined
    if (value !== undefined) out[name] = value
  }
  return out
}

function wireStdio(kind: StdioKind): "tty" | "pipe" {
  return kind === "tty" ? "tty" : "pipe"
}

/** Read through a call: an abort or an exit can land during any await. */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

function hasEnded(entry: Running): boolean {
  return entry.ended
}

function abortedCode(signal: AbortSignal): number {
  return signal.reason === "INT" ? EXIT.INTERRUPTED : EXIT_KILLED
}

function exitCode(params: unknown): number {
  const code = isRecord(params) ? params.code : undefined
  if (typeof code !== "number" || !Number.isInteger(code)) return EXIT.FAILURE
  return Math.min(255, Math.max(0, code))
}

export class RemoteProcs implements CommandSource {
  private readonly cfg: ProcsConfig
  private readonly running = new Map<number, Running>()
  /** Pids increase from 1 on each connection and are never reused on it. */
  private lastPid = 0

  constructor(cfg: ProcsConfig) {
    this.cfg = cfg
  }

  get busy(): boolean {
    return this.running.size > 0
  }

  names(): string[] {
    const hello = this.cfg.link.hello
    return hello ? hello.commands.map((command) => command.name) : [...this.cfg.declared]
  }

  info(name: string): CommandInfo | undefined {
    const hello = this.cfg.link.hello
    if (hello) return hello.commands.find((command) => command.name === name)
    if (!this.cfg.declared.includes(name)) return undefined
    return { name, summary: "", usage: name, builtin: false, remote: true }
  }

  async run(name: string, proc: Proc): Promise<number> {
    const { link } = this.cfg
    if (proc.signal.aborted) return abortedCode(proc.signal)
    try {
      await link.ensure(proc.signal)
    } catch (error) {
      if (isAborted(proc.signal)) return abortedCode(proc.signal)
      await proc.err(`rite: ${name}: ${messageOf(error)}\n`).catch(() => undefined)
      return EXIT.CONNECTION_LOST
    }
    // An abort that landed as the connection came up would never reach the listener below.
    if (isAborted(proc.signal)) return abortedCode(proc.signal)
    const pid = ++this.lastPid
    let resolve: (code: number) => void = () => undefined
    const done = new Promise<number>((res) => { resolve = res })
    const entry: Running = {
      pid, proc, done, resolve,
      tail: Promise.resolve(),
      ended: false,
      broken: false,
      killed: false,
      reader: undefined,
      onAbort: () => {
        if (proc.signal.reason === "INT") this.signal(entry, "INT")
        else this.kill(entry)
      },
    }
    // Registered before the request leaves: output may follow the result in the same turn.
    this.running.set(pid, entry)
    if (proc.tty) this.syncTty(proc.tty)
    const params: StartParams = {
      pid,
      argv: [name, ...proc.argv.slice(1)],
      cwd: remoteCwd(this.cfg.root, proc.cwd),
      env: pickEnv(proc.env, this.cfg.env),
      stdio: { stdin: wireStdio(proc.stdio.stdin), stdout: wireStdio(proc.stdio.stdout), stderr: wireStdio(proc.stdio.stderr) },
    }
    proc.signal.addEventListener("abort", entry.onAbort, { once: true })
    link.request("proc.start", params).then(
      () => { void this.pump(entry) },
      (error: unknown) => { this.startFailed(entry, name, error) },
    )
    return done
  }

  async complete(argv: readonly string[], index: number, signal: AbortSignal): Promise<Candidate[]> {
    const params: CompleteParams = { argv: [...argv], index }
    const candidates = parseCandidates(await this.cfg.link.request("proc.complete", params, signal))
    if (!candidates) throw new RiteError("EIO", undefined, "malformed proc.complete result")
    return candidates
  }

  /** proc.stdout, proc.stderr, and proc.exit from the server. */
  notification(method: string, params: unknown): void {
    if (!isRecord(params) || typeof params.pid !== "number") return
    const entry = this.running.get(params.pid)
    if (!entry) return
    if (method === "proc.exit") {
      this.end(entry, exitCode(params))
    } else if (typeof params.data === "string") {
      this.output(entry, method === "proc.stdout" ? "stdout" : "stderr", params.data)
    }
  }

  /** A new connection: its pids start again from 1. */
  connected(): void {
    this.lastPid = 0
  }

  /** The connection is gone: no process survives it. */
  lost(): void {
    for (const entry of [...this.running.values()]) this.end(entry, EXIT.CONNECTION_LOST, CONNECTION_LOST)
  }

  /** The host is done: KILL what runs. Call before the link is disposed. */
  dispose(): void {
    for (const entry of [...this.running.values()]) {
      this.kill(entry)
      // The terminal is going away with the host: do not wait on writes it may never take.
      this.end(entry, EXIT_KILLED, undefined, false)
    }
  }

  // ------------------------------------------------------------ one process

  private startFailed(entry: Running, name: string, error: unknown): void {
    // When the connection dropped first, lost() has already ended it.
    if (entry.ended) return
    const errno = error instanceof RiteError ? error.errno : "EIO"
    if (errno === "ENOTCONN") this.end(entry, EXIT.CONNECTION_LOST, CONNECTION_LOST)
    else if (errno === "ENOENT") this.end(entry, EXIT.NOT_FOUND, `rite: command not found: ${name}\n`)
    else if (errno === "EACCES" || errno === "EPERM") this.end(entry, EXIT.NOT_EXECUTABLE, `${name}: ${messageOf(error)}\n`)
    else this.end(entry, EXIT.FAILURE, `${name}: ${messageOf(error)}\n`)
  }

  private output(entry: Running, to: "stdout" | "stderr", data: string): void {
    if (to === "stderr") {
      entry.tail = entry.tail.then(() => entry.proc.err(data)).catch(() => undefined)
      return
    }
    entry.tail = entry.tail
      .then(() => (entry.broken ? undefined : entry.proc.out(data)))
      .catch(() => {
        // The local reader of stdout has exited.
        entry.broken = true
        this.kill(entry)
      })
  }

  private signal(entry: Running, signal: SignalParams["signal"]): void {
    if (entry.ended) return
    const params: SignalParams = { pid: entry.pid, signal }
    this.cfg.link.notify("proc.signal", params)
  }

  private kill(entry: Running): void {
    if (entry.killed) return
    entry.killed = true
    this.signal(entry, "KILL")
  }

  /** Resolves run once the output already received is written (unless `flush` is false), then `last` on stderr. */
  private end(entry: Running, code: number, last?: string, flush = true): void {
    if (entry.ended) return
    entry.ended = true
    this.running.delete(entry.pid)
    entry.proc.signal.removeEventListener("abort", entry.onAbort)
    void entry.reader?.cancel().catch(() => undefined)
    if (last !== undefined) entry.tail = entry.tail.then(() => entry.proc.err(last)).catch(() => undefined)
    if (flush) void entry.tail.then(() => { entry.resolve(code) })
    else entry.resolve(code)
  }

  private async pump(entry: Running): Promise<void> {
    if (entry.ended) return
    const { pid, proc } = entry
    try {
      const reader = proc.stdin.getReader()
      entry.reader = reader
      const budget = this.stdinBudget(pid)
      for (;;) {
        const chunk = await reader.read()
        if (hasEnded(entry)) return
        if (chunk.done) break
        for (const piece of splitByJsonBytes(chunk.value, budget)) {
          await this.drained(entry)
          if (hasEnded(entry)) return
          this.stdin({ pid, data: piece })
        }
      }
    } catch {
      // ^C errors the pipeline's streams; the abort listener has already signaled the process.
      if (proc.signal.aborted) return
    }
    if (!hasEnded(entry)) this.stdin({ pid, eof: true })
  }

  private stdin(params: StdinParams): void {
    this.cfg.link.notify("proc.stdin", params)
  }

  /** The bytes left for `data` in a proc.stdin message for this pid. */
  private stdinBudget(pid: number): number {
    const max = this.cfg.link.hello?.limits.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES
    const params: StdinParams = { pid, data: "" }
    const envelope = byteLength(JSON.stringify({ jsonrpc: "2.0", method: "proc.stdin", params }))
    return Math.max(1, max - envelope)
  }

  /** WebSocket has no drain event: poll bufferedAmount until the socket has caught up. */
  private async drained(entry: Running): Promise<void> {
    const { link, clock } = this.cfg
    while (!entry.ended && link.bufferedAmount > STDIN_HIGH_WATER_BYTES) {
      await new Promise<void>((resolve) => { clock.setTimeout(resolve, STDIN_POLL_MS) })
    }
  }

  /** A process with a terminal: tell the server when its size is not the one last sent. */
  private syncTty(tty: Tty): void {
    const { link } = this.cfg
    const { cols, rows } = tty
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) return
    if (cols === link.tty.cols && rows === link.tty.rows) return
    link.tty = { cols, rows }
    const params: ResizeParams = { cols, rows }
    link.notify("tty.resize", params)
  }
}
