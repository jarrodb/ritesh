// A fake socket, a manual clock, and a fake process for the rite.1 client
// tests. Nothing here waits on time: timers fire when a test advances the
// clock, and async work is awaited by turning the event loop.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { Env, Proc, Stdio, Sys } from "../../src/contracts.js"
import { createRemote, type RemoteClient } from "../../src/remote/client.js"
import type { RemoteOptions } from "../../src/remote/options.js"
import type { Clock, SocketFactory, SocketLike } from "../../src/remote/wire.js"
import { FakeVfs } from "../support/fakes.js"
import { PROTOCOL_DIR } from "../support/trace.js"

// ---------------------------------------------------------------- event loop

/** One turn of the event loop: every microtask queued so far has run. */
export function turn(): Promise<void> {
  return new Promise((resolve) => { setImmediate(resolve) })
}

export async function settle(turns = 4): Promise<void> {
  for (let i = 0; i < turns; i++) await turn()
}

/** Turns the event loop until `ready` returns a value. Fails instead of hanging. */
export async function until<T>(ready: () => T | undefined, what: string): Promise<T> {
  for (let i = 0; i < 50; i++) {
    const value = ready()
    if (value !== undefined) return value
    await turn()
  }
  throw new Error(`never happened: ${what}`)
}

/** No half of a surrogate pair on its own (String.prototype.isWellFormed is ES2024). */
export function wellFormed(text: string): boolean {
  return !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text)
}

// ---------------------------------------------------------------- clock

export class FakeClock implements Clock {
  private time = 0
  private seq = 0
  private readonly timers = new Map<number, { at: number; fn: () => void }>()

  now(): number {
    return this.time
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq
    this.timers.set(id, { at: this.time + Math.max(0, ms), fn })
    return id
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === "number") this.timers.delete(handle)
  }

  /** How long until each pending timer fires, soonest first. */
  get delays(): number[] {
    return [...this.timers.values()].map((t) => t.at - this.time).sort((a, b) => a - b)
  }

  /** Moves time forward, firing due timers in order, including ones they set. */
  advance(ms: number): void {
    const end = this.time + ms
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | undefined
      for (const entry of this.timers) {
        if (entry[1].at <= end && (!next || entry[1].at < next[1].at)) next = entry
      }
      if (!next) break
      this.timers.delete(next[0])
      this.time = next[1].at
      next[1].fn()
    }
    this.time = end
  }

  /** advance, then let the async work the timers started run. */
  async tick(ms: number): Promise<void> {
    this.advance(ms)
    await settle()
  }
}

// ---------------------------------------------------------------- socket

interface FakeEvent {
  data: unknown
  code: number
}

export class FakeSocket implements SocketLike {
  protocol = "rite.1"
  bufferedAmount = 0
  /** Every frame the client sent, as text and parsed. */
  readonly raw: string[] = []
  readonly sent: unknown[] = []
  /** Set when the client closed the socket. */
  closedByClient: { code: number | undefined; reason: string | undefined } | undefined
  private isOpen = false
  private taken = 0
  private readonly listeners = new Map<string, Array<(event: FakeEvent) => void>>()

  constructor(readonly url: string, readonly protocols: string[]) {}

  addEventListener(type: "open", listener: () => void): void
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void
  addEventListener(type: "close", listener: (event: { code: number }) => void): void
  addEventListener(type: string, listener: (event: FakeEvent) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  send(data: string): void {
    if (!this.isOpen) throw new Error("fake socket: send on a socket that is not open")
    this.raw.push(data)
    this.sent.push(JSON.parse(data))
  }

  close(code?: number, reason?: string): void {
    if (this.closedByClient) return
    this.closedByClient = { code, reason }
    this.isOpen = false
    // A real socket reports its own close later.
    queueMicrotask(() => { this.emit("close", { data: undefined, code: code ?? 1005 }) })
  }

  // ------------------------------------------------------------ the server's side

  /** The upgrade succeeded. */
  open(): void {
    this.isOpen = true
    this.emit("open", { data: undefined, code: 0 })
  }

  /** A message from the server. */
  receive(msg: unknown): void {
    this.receiveRaw(JSON.stringify(msg))
  }

  receiveRaw(data: unknown): void {
    this.emit("message", { data, code: 0 })
  }

  /** The server or the network closed the connection. */
  drop(code: number): void {
    this.isOpen = false
    this.emit("close", { data: undefined, code })
  }

  /** The next frame the client sent that no earlier take returned. */
  async take(): Promise<unknown> {
    const index = this.taken
    await until(() => (this.sent.length > index ? true : undefined), `client frame ${index + 1}`)
    this.taken = index + 1
    return this.sent[index]
  }

  /** Frames sent since the last take, without consuming them. */
  get untaken(): unknown[] {
    return this.sent.slice(this.taken)
  }

  private emit(type: string, event: FakeEvent): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

export class FakeNet {
  readonly sockets: FakeSocket[] = []
  private handed = 0

  readonly factory: SocketFactory = (url, protocols) => {
    const socket = new FakeSocket(url, protocols)
    this.sockets.push(socket)
    return socket
  }

  /** The next socket the client opened that no earlier call returned. */
  async next(): Promise<FakeSocket> {
    const index = this.handed
    const socket = await until(() => this.sockets[index], `socket ${index + 1}`)
    this.handed = index + 1
    return socket
  }
}

// ---------------------------------------------------------------- world

interface World {
  token: string
  commands: Array<{ name: string; summary: string; usage: string; flags?: Record<string, unknown>; behavior: string }>
  limits: { maxMessageBytes: number; maxProcs: number; maxOutputBytes: number; idleSeconds: number }
}

export const world = JSON.parse(readFileSync(join(PROTOCOL_DIR, "world.json"), "utf8")) as World

export interface HelloOverrides {
  session?: string
  limits?: Partial<World["limits"]>
}

/** The rite.hello result the conformance server gives for protocol/world.json. */
export function helloResult(overrides: HelloOverrides = {}): Record<string, unknown> {
  return {
    session: overrides.session ?? "session-1",
    resumed: false,
    commands: world.commands.map(({ name, summary, usage, flags }) => ({ name, summary, usage, ...(flags ? { flags } : {}) })),
    limits: { ...world.limits, ...overrides.limits },
    capabilities: [],
  }
}

export function result(id: number, value: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result: value }
}

export function failure(id: number, code: number, message: string, data?: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } }
}

export function note(method: string, params: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: "2.0", method, params }
}

// ---------------------------------------------------------------- client

export interface Rig {
  client: RemoteClient
  net: FakeNet
  clock: FakeClock
  /** How many times the client asked the host for a token. */
  tokens: () => number
}

/** A client over the fake socket and clock. Jitter is fixed at half the ceiling unless overridden. */
export function rig(options: Partial<RemoteOptions> = {}): Rig {
  const net = new FakeNet()
  const clock = new FakeClock()
  let tokens = 0
  const client = createRemote({
    url: "wss://test.invalid/rite",
    at: "/remote",
    token: () => {
      tokens++
      return world.token
    },
    socket: net.factory,
    clock,
    random: () => 0.5,
    ...options,
  })
  return { client, net, clock, tokens: () => tokens }
}

/** Plays the server's half of the handshake on the next socket the client opens. */
export async function accept(net: FakeNet, overrides: HelloOverrides = {}): Promise<FakeSocket> {
  const socket = await net.next()
  socket.open()
  const hello = await socket.take()
  socket.receive(result(idOf(hello), helloResult(overrides)))
  await settle()
  return socket
}

/** A rig whose client has connected. */
export async function connected(options: Partial<RemoteOptions> = {}, overrides: HelloOverrides = {}): Promise<Rig & { socket: FakeSocket }> {
  const r = rig(options)
  const up = r.client.connect()
  const socket = await accept(r.net, overrides)
  await up
  return { ...r, socket }
}

export function idOf(frame: unknown): number {
  const id = (frame as { id?: unknown }).id
  if (typeof id !== "number") throw new Error(`frame has no id: ${JSON.stringify(frame)}`)
  return id
}

export function methodOf(frame: unknown): string {
  const method = (frame as { method?: unknown }).method
  return typeof method === "string" ? method : ""
}

export function paramsOf(frame: unknown): Record<string, unknown> {
  const params = (frame as { params?: unknown }).params
  if (params === null || typeof params !== "object") throw new Error(`frame has no params: ${JSON.stringify(frame)}`)
  return params as Record<string, unknown>
}

// ---------------------------------------------------------------- process

export interface FakeProc {
  proc: Proc
  /** What the command wrote, chunk by chunk. */
  out: string[]
  err: string[]
  stdin: { push(text: string): void; end(): void; fail(): void }
  /** ^C is "INT"; a downstream reader that exited is "EPIPE". */
  abort(reason: "INT" | "EPIPE"): void
  /** stdout's reader exits: every later write to it fails. */
  breakStdout(): void
}

export interface FakeProcOptions {
  argv: string[]
  env?: Env
  cwd?: string
  stdio?: Partial<Stdio>
  tty?: { cols: number; rows: number }
}

/**
 * A Proc the way the kernel fake builds one: out and err hold the writers of
 * stdout and stderr, so both streams are locked for anyone else.
 */
export function fakeProc(o: FakeProcOptions): FakeProc {
  const out: string[] = []
  const err: string[] = []
  let feed: ReadableStreamDefaultController<string> | undefined
  const stdin = new ReadableStream<string>({ start: (c) => { feed = c } })
  const stdout = new WritableStream<string>({ write: (c) => { out.push(c) } })
  const stderr = new WritableStream<string>({ write: (c) => { err.push(c) } })
  const outWriter = stdout.getWriter()
  const errWriter = stderr.getWriter()
  const control = new AbortController()
  const proc: Proc = {
    argv: o.argv, flags: {}, args: o.argv.slice(1), subcommand: [],
    stdin, stdout, stderr,
    out: (text) => outWriter.write(text),
    err: (text) => errWriter.write(text),
    lines: () => { throw new Error("fake proc: lines is not used by the remote client") },
    env: o.env ?? {},
    cwd: o.cwd ?? "/home/guest",
    uid: 1000,
    fs: new FakeVfs(),
    signal: control.signal,
    tty: o.tty ? { ...o.tty, read: () => Promise.resolve(null), raw: () => Promise.resolve() } : null,
    stdio: { stdin: "pipe", stdout: "pipe", stderr: "pipe", ...o.stdio },
    sys: undefined as unknown as Sys,
  }
  return {
    proc, out, err,
    stdin: {
      push: (text) => { feed?.enqueue(text) },
      end: () => { feed?.close() },
      fail: () => { feed?.error(new Error("stdin failed")) },
    },
    abort: (reason) => { control.abort(reason) },
    breakStdout: () => { void outWriter.abort(new Error("reader exited")).catch(() => undefined) },
  }
}
