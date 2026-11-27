// Client replay of protocol/traces: the client is driven through its public
// surface so that it sends each c2s line, every s2c line is fed to it, and
// what it sends is compared with `matches`.
//
// Three lines cannot come from the provider or the command source and go
// through the link's own request and notify: fs.read with offset and length
// (MountProvider.read has neither), the unknown methods fs.write and
// fs.nothing, and the second proc.start with a pid already in use (the client
// never reuses one).
import { describe, expect, it } from "vitest"
import { RiteError } from "../../src/contracts.js"
import { loadTraces, matches, type TraceLine } from "../support/trace.js"
import { FakeClock, type FakeProc, fakeProc, FakeNet, type FakeSocket, idOf, methodOf, paramsOf, settle } from "./support.js"
import { createRemote, type RemoteClient } from "../../src/remote/client.js"

type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown }

function outcome(promise: Promise<unknown>): Promise<Outcome> {
  return promise.then(
    (value): Outcome => ({ ok: true, value }),
    (error: unknown): Outcome => ({ ok: false, error }),
  )
}

interface Started {
  fake: FakeProc
  exit: Promise<number>
}

interface Replay {
  client: RemoteClient
  net: FakeNet
  clock: FakeClock
  socket: FakeSocket | undefined
  /** How each request sent by id ended, and whether it went through the public surface. */
  requests: Map<number, { method: string; raw: boolean; outcome: Promise<Outcome> }>
  procs: Map<number, Started>
  connecting: Promise<Outcome> | undefined
}

function str(value: unknown): string {
  if (typeof value !== "string") throw new Error(`expected a string, got ${JSON.stringify(value)}`)
  return value
}

function num(value: unknown): number {
  if (typeof value !== "number") throw new Error(`expected a number, got ${JSON.stringify(value)}`)
  return value
}

/** The variable names any proc.start in the trace sends: the host's allowlist. */
function envAllowlist(lines: TraceLine[]): string[] {
  const names = new Set<string>()
  for (const line of lines) {
    if (!("msg" in line) || line.dir !== "c2s" || line.msg.method !== "proc.start") continue
    for (const name of Object.keys(paramsOf(line.msg).env as Record<string, string>)) names.add(name)
  }
  return [...names]
}

function begin(lines: TraceLine[]): Replay {
  const first = lines[0]
  if (!first || !("msg" in first) || first.msg.method !== "rite.hello") throw new Error("trace does not start with rite.hello")
  const token = str(paramsOf(first.msg).token)
  const net = new FakeNet()
  const clock = new FakeClock()
  const client = createRemote({
    url: "wss://test.invalid/rite", at: "/remote", token: () => token, env: envAllowlist(lines),
    socket: net.factory, clock, random: () => 0.5,
  })
  return { client, net, clock, socket: undefined, requests: new Map(), procs: new Map(), connecting: undefined }
}

/** Makes the client send the c2s message `msg`. */
async function act(r: Replay, msg: Record<string, unknown>): Promise<void> {
  const method = methodOf(msg)
  if (method === "rite.hello") {
    r.connecting = outcome(r.client.connect())
    r.socket = await r.net.next()
    r.socket.open()
    return
  }
  const params = paramsOf(msg)
  const track = (promise: Promise<unknown>, raw = false): void => {
    r.requests.set(idOf(msg), { method, raw, outcome: outcome(promise) })
  }
  const pid = typeof params.pid === "number" ? params.pid : 0
  const started = r.procs.get(pid)
  if (method === "fs.stat") {
    track(r.client.provider.stat(str(params.path), {}))
  } else if (method === "fs.list") {
    track(r.client.provider.list(str(params.path), {}))
  } else if (method === "fs.read" && !("offset" in params) && !("length" in params)) {
    track(r.client.provider.read(str(params.path), {}))
  } else if (method === "proc.complete") {
    track(r.client.commands.complete?.(params.argv as string[], num(params.index), new AbortController().signal) ?? Promise.reject(new Error("no complete")))
  } else if (method === "proc.start" && !started) {
    const argv = params.argv as string[]
    const stdio = params.stdio as { stdin: "tty" | "pipe"; stdout: "tty" | "pipe"; stderr: "tty" | "pipe" }
    // The process has more in its environment than the host allows out, and a cwd outside the remote.
    const fake = fakeProc({ argv, env: { ...(params.env as Record<string, string>), HOME: "/home/guest", SECRET: "hunter2" }, cwd: "/home/guest", stdio })
    const exit = r.client.commands.run(str(argv[0]), fake.proc)
    r.procs.set(pid, { fake, exit })
    track(exit)
  } else if (method === "proc.stdin" && started) {
    if (typeof params.data === "string") started.fake.stdin.push(params.data)
    else started.fake.stdin.end()
  } else if (method === "proc.signal" && started) {
    started.fake.abort(params.signal === "INT" ? "INT" : "EPIPE")
  } else if ("id" in msg) {
    track(r.client.link.request(method, params), true)
  } else {
    expect(r.client.link.notify(method, params), `${method} was not sent`).toBe(true)
  }
}

/** What the client must have done with the s2c message `msg`. */
async function check(r: Replay, msg: Record<string, unknown>): Promise<void> {
  if (typeof msg.method === "string") {
    const params = paramsOf(msg)
    const started = r.procs.get(num(params.pid))
    if (!started) throw new Error(`no process ${String(params.pid)}`)
    if (msg.method === "proc.stdout") expect(started.fake.out.join("")).toContain(str(params.data))
    if (msg.method === "proc.stderr") expect(started.fake.err.join("")).toContain(str(params.data))
    if (msg.method === "proc.exit") expect(await started.exit).toBe(params.code)
    return
  }
  const id = idOf(msg)
  if (id === 1) {
    expect(await r.connecting).toEqual({ ok: true, value: undefined })
    const commands = (msg.result as { commands: Array<{ name: string }> }).commands
    expect(r.client.commands.names()).toEqual(commands.map((c) => c.name))
    return
  }
  const request = r.requests.get(id)
  if (!request) throw new Error(`no request ${id}`)
  if ("result" in msg) {
    // A started process is settled by its proc.exit, not by the result of proc.start.
    if (request.method === "proc.start") return
    const got = await request.outcome
    const want = msg.result as Record<string, unknown>
    if (request.raw) expect(got).toEqual({ ok: true, value: want })
    else if (request.method === "fs.stat") expect(got).toMatchObject({ ok: true, value: { type: want.type, size: want.size, mode: want.mode, mtime: want.mtime } })
    else if (request.method === "fs.list") expect(got).toEqual({ ok: true, value: want.entries })
    else if (request.method === "fs.read") expect(got).toEqual({ ok: true, value: want.data })
    else if (request.method === "proc.complete") expect(got).toEqual({ ok: true, value: want.candidates })
    return
  }
  const error = msg.error as { code: number; data?: { errno: string; path?: string } }
  const got = await request.outcome
  if (request.method === "proc.start" && !request.raw) {
    // A command the server does not have is rite's "command not found".
    expect(error.data?.errno).toBe("ENOENT")
    expect(got).toEqual({ ok: true, value: 127 })
    const started = [...r.procs.values()].at(-1)
    expect(started?.fake.err.join("")).toBe(`rite: command not found: ${str(error.data?.path)}\n`)
    return
  }
  if (got.ok) throw new Error(`request ${id} resolved, expected an error`)
  expect(got.error).toBeInstanceOf(RiteError)
  const thrown = got.error as RiteError
  if (error.code === -32000) {
    expect(thrown.errno).toBe(error.data?.errno)
    if (error.data?.path !== undefined) expect(thrown.path).toBe(error.data.path)
  } else {
    expect(error.code).toBe(-32601)
    expect(thrown.errno).toBe("ENOTSUP")
  }
}

async function replay(lines: TraceLine[]): Promise<Replay> {
  const r = begin(lines)
  let sent = 0
  for (const [i, line] of lines.entries()) {
    const where = `line ${i + 1}`
    if (!r.socket && !("msg" in line && line.dir === "c2s")) throw new Error(`${where}: the server speaks before the client`)
    if ("close" in line) {
      r.socket?.drop(line.close)
      await settle()
    } else if (line.dir === "c2s") {
      await act(r, line.msg)
      const frame = await r.socket?.take()
      sent++
      expect(matches(line.msg, frame, line.match), `${where}: sent ${JSON.stringify(frame)}\nwant ${JSON.stringify(line.msg)}`).toBe(true)
    } else {
      r.socket?.receive(line.msg)
      await settle()
      await check(r, line.msg)
    }
  }
  await settle()
  // Nothing the trace does not list: no early stdin eof, no stray signal, no retry.
  expect(r.socket?.sent.length, "frames sent").toBe(sent)
  return r
}

describe("rite.1 trace replay against the client", () => {
  const traces = loadTraces()

  for (const [name, lines] of traces) {
    const first = lines[0]
    // before-hello opens with fs.stat: a server-side trace this client cannot produce (covered below).
    if (!first || !("msg" in first) || first.msg.method !== "rite.hello") continue

    it(`trace ${name}`, async () => {
      const r = await replay(lines)
      const last = lines.at(-1)
      if (last && "close" in last) {
        // auth-rejected: the attempt fails and, 4001 being final, nothing reconnects.
        const got = await r.connecting
        expect(got?.ok).toBe(false)
        expect((got as { error: RiteError }).error.errno).toBe("ENOTCONN")
        await r.clock.tick(600_000)
        expect(r.net.sockets).toHaveLength(1)
      }
      r.client.dispose()
    })
  }

  it("replays every trace that starts with rite.hello", () => {
    const skipped = [...traces].filter(([, lines]) => {
      const first = lines[0]
      return !first || !("msg" in first) || first.msg.method !== "rite.hello"
    }).map(([name]) => name)
    expect(skipped).toEqual(["before-hello"])
    expect(traces.size).toBeGreaterThan(10)
  })

  it("trace before-hello does not apply: the first message is always rite.hello", async () => {
    const lines = traces.get("before-hello") ?? []
    const first = lines[0]
    if (!first || !("msg" in first)) throw new Error("before-hello is missing")
    const net = new FakeNet()
    const client = createRemote({ url: "wss://test.invalid/rite", at: "/remote", token: () => "test-token", socket: net.factory, clock: new FakeClock() })
    const stat = outcome(client.provider.stat(str(paramsOf(first.msg).path), {}))
    const socket = await net.next()
    socket.open()
    const frame = await socket.take()
    expect(methodOf(frame)).toBe("rite.hello")
    expect(matches(first.msg, frame, "exact")).toBe(false)
    await settle()
    // Until hello succeeds nothing else leaves, not even the stat that caused the connection.
    expect(socket.sent).toHaveLength(1)
    client.dispose()
    expect((await stat).ok).toBe(false)
  })
})
