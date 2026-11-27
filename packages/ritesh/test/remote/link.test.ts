// The connection: handshake, lazy and eager connect, backoff, close codes,
// in-flight requests, idle disconnect. Time is the fake clock's.
import { describe, expect, it } from "vitest"
import { RiteError } from "../../src/contracts.js"
import { backoffDelay, BACKOFF_MAX_MS, NO_RETRY_CODES } from "../../src/remote/backoff.js"
import { HELLO_TIMEOUT_MS } from "../../src/remote/link.js"
import { accept, connected, failure, helloResult, idOf, methodOf, note, paramsOf, result, rig, settle, world } from "./support.js"

async function errnoOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    if (error instanceof RiteError) return error.errno
    throw error
  }
  throw new Error("expected a rejection")
}

describe("backoffDelay", () => {
  it("doubles the ceiling from 1 s and stops at 30 s, with full jitter", () => {
    const top = (): number => 0.999999
    expect([0, 1, 2, 3, 4, 5, 6, 40].map((n) => backoffDelay(n, top))).toEqual([999, 1999, 3999, 7999, 15999, 29999, 29999, 29999])
    expect(backoffDelay(3, () => 0)).toBe(0)
    expect(backoffDelay(3, () => 0.25)).toBe(2000)
    expect(backoffDelay(99, () => 0.5)).toBe(BACKOFF_MAX_MS / 2)
  })

  it("never retries 4000, 4001, 4003, 4040", () => {
    expect([...NO_RETRY_CODES].sort()).toEqual([4000, 4001, 4003, 4040])
  })
})

describe("handshake", () => {
  it("opens with the rite.1 subprotocol and sends rite.hello first, with a fresh token", async () => {
    const { client, net, tokens } = rig()
    const up = client.connect()
    const socket = await net.next()
    expect(socket.url).toBe("wss://test.invalid/rite")
    expect(socket.protocols).toEqual(["rite.1"])
    socket.open()
    const hello = await socket.take()
    expect(hello).toEqual({
      jsonrpc: "2.0", id: 1, method: "rite.hello",
      params: { protocol: "rite.1", version: "0.0.0", token: world.token, tty: { cols: 80, rows: 24 }, capabilities: [] },
    })
    expect(tokens()).toBe(1)
    socket.receive(result(1, helloResult()))
    await up
    expect(client.link.hello?.limits).toEqual(world.limits)
    expect(client.link.hello?.session).toBe("session-1")
  })

  it("awaits an async token before opening the socket", async () => {
    let release: (token: string) => void = () => undefined
    const { client, net } = rig({ token: () => new Promise<string>((resolve) => { release = resolve }) })
    void client.connect()
    await settle()
    expect(net.sockets).toHaveLength(0)
    release("late-token")
    const socket = await net.next()
    socket.open()
    expect(paramsOf(await socket.take()).token).toBe("late-token")
  })

  it("sends nothing but rite.hello until it succeeds", async () => {
    const { client, net } = rig()
    const stat = client.provider.stat("readme.txt", {})
    const list = client.provider.list("docs", {})
    const socket = await net.next()
    await settle()
    expect(socket.sent).toHaveLength(0)
    socket.open()
    await settle()
    expect(socket.sent.map(methodOf)).toEqual(["rite.hello"])
    // Requests from the server and notifications are not answered before hello either.
    socket.receive({ jsonrpc: "2.0", id: 7, method: "client.ping" })
    await settle()
    expect(socket.sent).toHaveLength(1)
    socket.receive(result(1, helloResult()))
    await settle()
    expect(socket.sent.map(methodOf)).toEqual(["rite.hello", "fs.stat", "fs.list"])
    expect(socket.sent.map(idOf)).toEqual([1, 2, 3])
    socket.receive(result(2, { type: "file", size: 1, mode: 0o644, mtime: 0 }))
    socket.receive(result(3, { entries: [], truncated: false }))
    expect((await stat).size).toBe(1)
    expect(await list).toEqual([])
  })

  it("resumes with the session on reconnect, and ids start again at 1", async () => {
    const { client, net, clock, socket, tokens } = await connected({}, { session: "abc" })
    const lost = client.provider.stat("a", {})
    expect(idOf(await socket.take())).toBe(2)
    socket.drop(1006)
    expect(await errnoOf(lost)).toBe("ENOTCONN")
    await settle()
    const again = client.connect()
    await settle()
    // The lost connection is a first failure: the next attempt waits out its backoff.
    expect(net.sockets).toHaveLength(1)
    await clock.tick(499)
    expect(net.sockets).toHaveLength(1)
    await clock.tick(1)
    const socket2 = await net.next()
    socket2.open()
    const hello = await socket2.take()
    expect(idOf(hello)).toBe(1)
    expect(paramsOf(hello).session).toBe("abc")
    expect(tokens()).toBe(2)
    socket2.receive(result(1, helloResult({ session: "abc" })))
    await again
  })

  it("fails the attempt when the server does not select rite.1", async () => {
    const { client, net, clock } = rig({ connect: "eager" })
    const socket = await net.next()
    socket.protocol = ""
    socket.open()
    await settle()
    expect(socket.sent).toHaveLength(0)
    expect(socket.closedByClient?.code).toBe(1000)
    await clock.tick(120_000)
    expect(net.sockets).toHaveLength(1)
    expect(client.link.ready).toBe(false)
  })

  it("does not retry a hello the server answers with an error or a malformed result", async () => {
    for (const reply of [failure(1, -32602, "invalid params"), result(1, { session: 5 })]) {
      const { client, net, clock } = rig({ connect: "eager" })
      const up = client.connect()
      const socket = await net.next()
      socket.open()
      await socket.take()
      socket.receive(reply)
      expect(await errnoOf(up)).toBe("ENOTCONN")
      expect(socket.closedByClient).toBeDefined()
      await clock.tick(120_000)
      expect(net.sockets).toHaveLength(1)
    }
  })

  it("gives up on a hello that is not answered in time, and retries", async () => {
    const { client, net, clock } = rig({ connect: "eager" })
    const up = client.connect()
    const socket = await net.next()
    socket.open()
    await socket.take()
    await clock.tick(HELLO_TIMEOUT_MS - 1)
    expect(socket.closedByClient).toBeUndefined()
    await clock.tick(1)
    expect(socket.closedByClient?.code).toBe(1000)
    expect(await errnoOf(up)).toBe("ENOTCONN")
    await clock.tick(500)
    expect(net.sockets).toHaveLength(2)
  })

  it("answers a request from the server with -32601 and ignores unknown or malformed frames", async () => {
    const { socket } = await connected()
    socket.receive({ jsonrpc: "2.0", id: 9, method: "client.ping", params: {} })
    expect(await socket.take()).toEqual({ jsonrpc: "2.0", id: 9, error: { code: -32601, message: "method not found" } })
    socket.receive(note("fs.nothing", {}))
    socket.receiveRaw("not json")
    socket.receiveRaw(new Uint8Array([1, 2, 3]))
    socket.receiveRaw("[1,2]")
    socket.receive(result(99, "nobody asked"))
    await settle()
    expect(socket.untaken).toEqual([])
  })
})

describe("reconnect", () => {
  it("eager: retries with exponential backoff and full jitter, a new token each attempt", async () => {
    const { net, clock, tokens } = rig({ connect: "eager", random: () => 0.5 })
    // random is 0.5: half of 1, 2, 4, 8, 16, 30, 30 seconds.
    const waits = [500, 1000, 2000, 4000, 8000, 15_000, 15_000]
    for (const [i, wait] of waits.entries()) {
      const socket = await net.next()
      expect(tokens()).toBe(i + 1)
      socket.drop(1006)
      await settle()
      expect(clock.delays).toEqual([wait])
      await clock.tick(wait - 1)
      expect(net.sockets).toHaveLength(i + 1)
      await clock.tick(1)
      expect(net.sockets).toHaveLength(i + 2)
    }
  })

  it("eager: a successful hello resets the backoff", async () => {
    const { net, clock } = rig({ connect: "eager" })
    for (const wait of [500, 1000, 2000]) {
      (await net.next()).drop(1006)
      await settle()
      expect(clock.delays).toEqual([wait])
      await clock.tick(wait)
    }
    const socket = await accept(net)
    socket.drop(1006)
    await settle()
    expect(clock.delays).toEqual([500])
  })

  it("eager: retries 4008, 4029, 4500, and abnormal closes, during hello and after it", async () => {
    for (const code of [4008, 4029, 4500, 1006, 1001, 1011]) {
      const pre = rig({ connect: "eager" })
      const first = await pre.net.next()
      first.open()
      first.drop(code)
      await pre.clock.tick(500)
      expect(pre.net.sockets, `${code} during hello`).toHaveLength(2)

      const post = rig({ connect: "eager" })
      const socket = await accept(post.net)
      socket.drop(code)
      await post.clock.tick(500)
      expect(post.net.sockets, `${code} after hello`).toHaveLength(2)
    }
  })

  it("never retries 4000, 4001, 4003, 4040", async () => {
    for (const code of [4000, 4001, 4003, 4040]) {
      const pre = rig({ connect: "eager" })
      const up = pre.client.connect()
      const first = await pre.net.next()
      first.open()
      await first.take()
      first.drop(code)
      expect(await errnoOf(up), `${code} during hello`).toBe("ENOTCONN")
      await pre.clock.tick(3_600_000)
      expect(pre.net.sockets, `${code} during hello`).toHaveLength(1)

      const post = rig({ connect: "eager" })
      const socket = await accept(post.net)
      socket.drop(code)
      await post.clock.tick(3_600_000)
      expect(post.net.sockets, `${code} after hello`).toHaveLength(1)
    }
  })

  it("after a final close code the next use is a new attempt; 4001 drops the session", async () => {
    for (const [code, resumes] of [[4040, true], [4001, false]] as const) {
      const { client, net, clock, socket } = await connected({}, { session: "mine" })
      socket.drop(code)
      await settle()
      void client.connect()
      await clock.tick(1000)
      const second = await net.next()
      second.open()
      const params = paramsOf(await second.take())
      expect("session" in params, `${code}`).toBe(resumes)
    }
  })

  it("lazy: a failed attempt rejects its waiters at once and schedules nothing", async () => {
    const { client, net, clock } = rig()
    const stat = client.provider.stat("a", {})
    const socket = await net.next()
    socket.drop(1006)
    expect(await errnoOf(stat)).toBe("ENOTCONN")
    expect(clock.delays).toEqual([])
    await clock.tick(3_600_000)
    expect(net.sockets).toHaveLength(1)
  })

  it("lazy: a use inside the backoff window waits for the window, then connects once", async () => {
    const { client, net, clock } = rig({ random: () => 0.8 })
    void client.connect().catch(() => undefined)
    const first = await net.next()
    first.drop(1006)
    await settle()
    // The first failure owes 0.8 * 1 s.
    const a = client.provider.stat("a", {})
    const b = client.provider.stat("b", {})
    await clock.tick(799)
    expect(net.sockets).toHaveLength(1)
    await clock.tick(1)
    expect(net.sockets).toHaveLength(2)
    const socket = await accept(net)
    expect(methodOf(await socket.take())).toBe("fs.stat")
    expect(methodOf(await socket.take())).toBe("fs.stat")
    socket.receive(result(2, { type: "dir", size: 0, mode: 0o755, mtime: 0 }))
    socket.receive(result(3, { type: "dir", size: 0, mode: 0o755, mtime: 0 }))
    expect((await a).type).toBe("dir")
    expect((await b).type).toBe("dir")
  })

  it("a token callback that throws fails the attempt; the next one asks again after the backoff", async () => {
    for (const mode of ["lazy", "eager"] as const) {
      let calls = 0
      const { client, net, clock } = rig({
        connect: mode,
        token: () => {
          calls++
          if (calls === 1) throw new Error("not signed in")
          return "ok"
        },
      })
      const first = client.connect()
      expect(await errnoOf(first), mode).toBe("ENOTCONN")
      expect(net.sockets).toHaveLength(0)
      // Eager has its retry scheduled; lazy schedules it when it is next used.
      expect(clock.delays, mode).toEqual(mode === "eager" ? [500] : [])
      if (mode === "lazy") void client.connect().catch(() => undefined)
      await clock.tick(500)
      expect(calls, mode).toBe(2)
      expect(net.sockets, mode).toHaveLength(1)
    }
  })
})

describe("in-flight requests", () => {
  it("fail ENOTCONN when the connection drops and are not replayed", async () => {
    const { client, net, clock, socket } = await connected()
    const stat = client.provider.stat("readme.txt", {})
    const read = client.provider.read("docs/a.md", {})
    await socket.take()
    await socket.take()
    socket.drop(1006)
    expect(await errnoOf(stat)).toBe("ENOTCONN")
    expect(await errnoOf(read)).toBe("ENOTCONN")
    const up = client.connect()
    await clock.tick(1000)
    const second = await accept(net)
    await up
    await settle()
    expect(second.sent.map(methodOf)).toEqual(["rite.hello"])
  })

  it("a late response to a dropped connection's request is ignored", async () => {
    const { client, socket } = await connected()
    const stat = client.provider.stat("a", {})
    await socket.take()
    socket.drop(1006)
    expect(await errnoOf(stat)).toBe("ENOTCONN")
    socket.receive(result(2, { type: "file", size: 1, mode: 0o644, mtime: 0 }))
    await settle()
    expect(client.link.ready).toBe(false)
  })

  it("an aborted request fails ECANCELED and its response is dropped", async () => {
    const { client, socket } = await connected()
    const control = new AbortController()
    const stat = client.provider.stat("a", { signal: control.signal })
    await socket.take()
    control.abort()
    expect(await errnoOf(stat)).toBe("ECANCELED")
    socket.receive(result(2, { type: "file", size: 1, mode: 0o644, mtime: 0 }))
    await settle()
    // Not cached either: the next stat asks again.
    void client.provider.stat("a", {})
    expect(methodOf(await socket.take())).toBe("fs.stat")
  })

  it("a use whose signal aborts while connecting fails ECANCELED", async () => {
    const { client, net } = rig()
    const control = new AbortController()
    const stat = client.provider.stat("a", { signal: control.signal })
    await net.next()
    control.abort()
    expect(await errnoOf(stat)).toBe("ECANCELED")
    expect(await errnoOf(client.provider.stat("a", { signal: control.signal }))).toBe("ECANCELED")
  })
})

describe("lazy connect and idle disconnect", () => {
  it("opens nothing until the first use, and knows the declared commands before that", async () => {
    const { client, net, clock, tokens } = rig({ commands: ["mdm", "count"] })
    expect(client.commands.names()).toEqual(["mdm", "count"])
    expect(client.commands.info("mdm")).toEqual({ name: "mdm", summary: "", usage: "mdm", builtin: false, remote: true })
    expect(client.commands.info("nope")).toBeUndefined()
    const off = client.provider.watch?.(() => undefined)
    client.onNotify(() => undefined)
    off?.()
    await clock.tick(3_600_000)
    expect(net.sockets).toHaveLength(0)
    expect(tokens()).toBe(0)

    void client.provider.stat("readme.txt", {})
    const socket = await accept(net)
    expect(methodOf(await socket.take())).toBe("fs.stat")
    // After hello the server's descriptors replace the declared names.
    expect(client.commands.names()).toEqual(world.commands.map((c) => c.name))
    expect(client.commands.info("count")).toEqual({
      name: "count", summary: "print numbers", usage: "count [-n number]",
      flags: { n: { long: "number", short: "n", type: "number" } }, builtin: false, remote: true,
    })
    expect(client.commands.info("mdm")).toBeUndefined()
  })

  it("eager connects when the remote is created, without a use", async () => {
    const { net, tokens } = rig({ connect: "eager" })
    await accept(net)
    expect(tokens()).toBe(1)
  })

  it("disconnects after idleSeconds without traffic and reconnects, resuming, on the next use", async () => {
    const { client, net, clock, socket } = await connected({}, { limits: { idleSeconds: 300 }, session: "kept" })
    await clock.tick(299_999)
    expect(socket.closedByClient).toBeUndefined()
    await clock.tick(1)
    expect(socket.closedByClient).toEqual({ code: 1000, reason: "idle" })
    expect(client.link.ready).toBe(false)
    // An idle disconnect is not a failure: nothing reconnects, and the next use does not wait.
    await clock.tick(3_600_000)
    expect(net.sockets).toHaveLength(1)
    expect(client.commands.names()).toContain("count")

    const stat = client.provider.stat("readme.txt", {})
    const second = await net.next()
    second.open()
    const hello = await second.take()
    expect(paramsOf(hello).session).toBe("kept")
    second.receive(result(1, helloResult({ session: "kept" })))
    const frame = await second.take()
    second.receive(result(idOf(frame), { type: "file", size: 26, mode: 0o644, mtime: 0 }))
    expect((await stat).size).toBe(26)
  })

  it("traffic in either direction restarts the idle count", async () => {
    const { client, clock, socket } = await connected({}, { limits: { idleSeconds: 10 } })
    await clock.tick(6000)
    const stat = client.provider.stat("a", {})
    const frame = await socket.take()
    await clock.tick(6000)
    // A request is in flight: not idle.
    expect(socket.closedByClient).toBeUndefined()
    socket.receive(result(idOf(frame), { type: "file", size: 1, mode: 0o644, mtime: 0 }))
    await stat
    await clock.tick(9999)
    expect(socket.closedByClient).toBeUndefined()
    socket.receive(note("term.notify", { text: "hi", level: "info" }))
    await clock.tick(9999)
    expect(socket.closedByClient).toBeUndefined()
    await clock.tick(1)
    expect(socket.closedByClient?.code).toBe(1000)
  })

  it("eager never disconnects when idle", async () => {
    const r = rig({ connect: "eager" })
    const socket = await accept(r.net, { limits: { idleSeconds: 5 } })
    await r.clock.tick(3_600_000)
    expect(socket.closedByClient).toBeUndefined()
  })
})
