// The handle createRite receives: term.notify with its rate cap, dispose, the options.
import { describe, expect, it } from "vitest"
import { RiteError } from "../../src/contracts.js"
import { remote } from "../../src/remote.js"
import { NOTIFY_MAX, NOTIFY_WINDOW_MS } from "../../src/remote/client.js"
import { connected, fakeProc, FakeClock, FakeNet, idOf, methodOf, note, result, rig, settle } from "./support.js"

describe("term.notify", () => {
  it("delivers text and level to every listener until it unsubscribes", async () => {
    const { client, socket } = await connected()
    const a: string[] = []
    const b: string[] = []
    const off = client.onNotify((text, level) => { a.push(`${level}: ${text}`) })
    client.onNotify(() => { throw new Error("a bad listener") })
    client.onNotify((text, level) => { b.push(`${level}: ${text}`) })
    socket.receive(note("term.notify", { text: "device enrolled", level: "info" }))
    socket.receive(note("term.notify", { text: "disk low", level: "warn" }))
    off()
    socket.receive(note("term.notify", { text: "down", level: "error" }))
    await settle()
    expect(a).toEqual(["info: device enrolled", "warn: disk low"])
    expect(b).toEqual(["info: device enrolled", "warn: disk low", "error: down"])
  })

  it("drops a notification that is not text with a known level", async () => {
    const { client, socket } = await connected()
    const seen: string[] = []
    client.onNotify((text) => { seen.push(text) })
    socket.receive(note("term.notify", { text: "x", level: "debug" }))
    socket.receive(note("term.notify", { text: 5, level: "info" }))
    socket.receive(note("term.notify", { level: "info" }))
    socket.receive({ jsonrpc: "2.0", method: "term.notify" })
    await settle()
    expect(seen).toEqual([])
  })

  it("delivers at most 5 in any 10 s and drops the extras", async () => {
    const { client, clock, socket } = await connected({ connect: "eager" })
    const seen: string[] = []
    client.onNotify((text) => { seen.push(text) })
    const send = (text: string): void => { socket.receive(note("term.notify", { text, level: "info" })) }

    for (let i = 1; i <= NOTIFY_MAX + 3; i++) send(`a${i}`)
    expect(seen).toEqual(["a1", "a2", "a3", "a4", "a5"])

    // Still inside the window of the first five.
    await clock.tick(NOTIFY_WINDOW_MS - 1)
    send("dropped")
    expect(seen).toHaveLength(5)

    // The window slides: the five at t=0 have aged out, the dropped ones never counted.
    await clock.tick(1)
    for (let i = 1; i <= 4; i++) send(`b${i}`)
    await clock.tick(4000)
    send("b5")
    send("b6")
    expect(seen.slice(5)).toEqual(["b1", "b2", "b3", "b4", "b5"])

    // 10 s after b1..b4 only b5 is still counted: four more fit.
    await clock.tick(6000)
    for (let i = 1; i <= 6; i++) send(`c${i}`)
    expect(seen.slice(10)).toEqual(["c1", "c2", "c3", "c4"])
  })
})

describe("dispose", () => {
  it("KILLs running processes, closes the socket, and never reconnects", async () => {
    const { client, net, clock, socket } = await connected({ connect: "eager" })
    const a = fakeProc({ argv: ["wait"] })
    const b = fakeProc({ argv: ["wait"] })
    const exits = [client.commands.run("wait", a.proc), client.commands.run("wait", b.proc)]
    socket.receive(result(idOf(await socket.take()), {}))
    socket.receive(result(idOf(await socket.take()), {}))
    const stat = client.provider.stat("readme.txt", {})
    expect(methodOf(await socket.take())).toBe("fs.stat")

    client.dispose()
    expect(socket.untaken).toEqual([
      { jsonrpc: "2.0", method: "proc.signal", params: { pid: 1, signal: "KILL" } },
      { jsonrpc: "2.0", method: "proc.signal", params: { pid: 2, signal: "KILL" } },
    ])
    expect(socket.closedByClient).toEqual({ code: 1000, reason: "disposed" })
    expect(await Promise.all(exits)).toEqual([137, 137])
    expect(a.err).toEqual([])
    await expect(stat).rejects.toMatchObject({ errno: "ENOTCONN" })

    await clock.tick(3_600_000)
    expect(net.sockets).toHaveLength(1)
    expect(clock.delays).toEqual([])
    // Safe to call twice.
    client.dispose()
  })

  it("refuses every later use with ENOTCONN and opens nothing", async () => {
    const { client, net, clock, tokens } = rig()
    client.dispose()
    await expect(client.connect()).rejects.toMatchObject({ errno: "ENOTCONN" })
    await expect(client.provider.stat("a", {})).rejects.toMatchObject({ errno: "ENOTCONN" })
    await expect(client.provider.read("a", {})).rejects.toMatchObject({ errno: "ENOTCONN" })
    await expect(client.commands.complete?.(["count"], 0, new AbortController().signal)).rejects.toMatchObject({ errno: "ENOTCONN" })
    const fake = fakeProc({ argv: ["count"] })
    expect(await client.commands.run("count", fake.proc)).toBe(255)
    expect(fake.err).toEqual(["rite: count: remote disposed\n"])
    await clock.tick(60_000)
    expect(net.sockets).toHaveLength(0)
    expect(tokens()).toBe(0)
  })

  it("during a connection attempt: the attempt ends and its waiters fail", async () => {
    const { client, net, clock } = rig({ connect: "eager" })
    const up = client.connect()
    const socket = await net.next()
    client.dispose()
    await expect(up).rejects.toMatchObject({ errno: "ENOTCONN" })
    expect(socket.closedByClient?.code).toBe(1000)
    socket.open()
    await clock.tick(60_000)
    expect(socket.sent).toEqual([])
    expect(net.sockets).toHaveLength(1)
  })

  it("while a token is being fetched: no socket is ever opened", async () => {
    let release: (token: string) => void = () => undefined
    const { client, net } = rig({ token: () => new Promise<string>((resolve) => { release = resolve }) })
    const up = client.connect()
    await settle()
    client.dispose()
    release("late")
    await expect(up).rejects.toMatchObject({ errno: "ENOTCONN" })
    await settle()
    expect(net.sockets).toHaveLength(0)
  })

  it("stops notifications", async () => {
    const { client, socket } = await connected()
    const seen: string[] = []
    client.onNotify((text) => { seen.push(text) })
    client.dispose()
    socket.receive(note("term.notify", { text: "late", level: "info" }))
    await settle()
    expect(seen).toEqual([])
  })
})

describe("remote()", () => {
  it("returns the handle createRite takes, with bin under the mount by default", () => {
    const net = new FakeNet()
    const base = { url: "wss://test.invalid/rite", token: () => "t", socket: net.factory, clock: new FakeClock() }
    const handle = remote({ ...base, at: "/sandbox" })
    expect([handle.at, handle.bin]).toEqual(["/sandbox", "/sandbox/bin"])
    expect(handle.provider.readonly).toBe(true)
    expect(handle.commands.names()).toEqual([])
    expect(remote({ ...base, at: "/sandbox", bin: "/usr/local/bin/" }).bin).toBe("/usr/local/bin")
    expect(remote({ ...base, at: "/" }).bin).toBe("/bin")
    expect(net.sockets).toHaveLength(0)
  })

  it("rejects a mount point or bin that is not absolute", () => {
    const base = { url: "wss://test.invalid/rite", token: () => "t" }
    expect(() => remote({ ...base, at: "sandbox" })).toThrow(RiteError)
    expect(() => remote({ ...base, at: "/sandbox", bin: "bin" })).toThrow(RiteError)
  })

  it("defaults to the global WebSocket, looked up when connecting", async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "WebSocket")
    const opened: Array<[string, string[]]> = []
    class Recorder {
      protocol = "rite.1"
      bufferedAmount = 0
      constructor(url: string, protocols: string[]) {
        opened.push([url, protocols])
      }
      addEventListener(): void { /* never opens */ }
      send(): void { /* unused */ }
      close(): void { /* unused */ }
    }
    try {
      Object.defineProperty(globalThis, "WebSocket", { value: Recorder, configurable: true, writable: true })
      const handle = remote({ url: "wss://test.invalid/rite", at: "/sandbox", token: () => "t", clock: new FakeClock() })
      void handle.connect().catch(() => undefined)
      await settle()
      expect(opened).toEqual([["wss://test.invalid/rite", ["rite.1"]]])
      handle.dispose()

      Object.defineProperty(globalThis, "WebSocket", { value: undefined, configurable: true, writable: true })
      const without = remote({ url: "wss://test.invalid/rite", at: "/sandbox", token: () => "t", clock: new FakeClock() })
      await expect(without.connect()).rejects.toMatchObject({ errno: "ENOTCONN", message: "WebSocket is not available" })
    } finally {
      if (original) Object.defineProperty(globalThis, "WebSocket", original)
    }
  })
})
