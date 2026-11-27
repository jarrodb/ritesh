// Remote commands: proc.start parameters, stdin, output, signals, exit, loss.
import { describe, expect, it } from "vitest"
import { pickEnv, remoteCwd, STDIN_HIGH_WATER_BYTES, STDIN_POLL_MS } from "../../src/remote/procs.js"
import {
  accept, connected, failure, fakeProc, type FakeProcOptions, type FakeSocket, idOf, methodOf, note, paramsOf, result, rig, settle, wellFormed,
} from "./support.js"
import type { RemoteClient } from "../../src/remote/client.js"

const byteLength = (text: string): number => new TextEncoder().encode(text).length

/** Runs a command and answers its proc.start. Returns the fake process, its exit, and the start frame. */
async function start(client: RemoteClient, socket: FakeSocket, o: FakeProcOptions) {
  const fake = fakeProc(o)
  const exit = client.commands.run(o.argv[0] ?? "", fake.proc)
  const frame = await socket.take()
  expect(methodOf(frame)).toBe("proc.start")
  socket.receive(result(idOf(frame), {}))
  await settle()
  return { fake, exit, frame, pid: paramsOf(frame).pid as number }
}

describe("remoteCwd", () => {
  it.each([
    ["/remote", "/remote", ""],
    ["/remote", "/remote/", ""],
    ["/remote", "/remote/docs", "docs"],
    ["/remote", "/remote/docs/deep", "docs/deep"],
    ["/remote", "/remotely/docs", ""],
    ["/remote", "/home/guest", ""],
    ["/remote", "/", ""],
    // A remote mounted at "/" has the empty root.
    ["", "/", ""],
    ["", "/docs/a", "docs/a"],
  ])("root %j, cwd %j is %j", (root, cwd, want) => {
    expect(remoteCwd(root, cwd)).toBe(want)
  })
})

describe("pickEnv", () => {
  it("keeps only allowed names that are set", () => {
    const env = { A: "1", B: "two", SECRET: "x", EMPTY: "" }
    expect(pickEnv(env, [])).toEqual({})
    expect(pickEnv(env, ["A", "EMPTY", "MISSING"])).toEqual({ A: "1", EMPTY: "" })
    // Inherited names are not variables.
    expect(pickEnv(env, ["toString", "constructor", "__proto__"])).toEqual({})
  })
})

describe("proc.start", () => {
  it("sends nothing from the environment by default", async () => {
    const { client, socket } = await connected()
    const { frame } = await start(client, socket, { argv: ["env"], env: { HOME: "/home/guest", TOKEN: "secret" } })
    expect(paramsOf(frame).env).toEqual({})
  })

  it("sends only the variables on the allowlist", async () => {
    const { client, socket } = await connected({ env: ["LANG", "TENANT", "UNSET"] })
    const { frame } = await start(client, socket, { argv: ["env"], env: { LANG: "en", TENANT: "acme", TOKEN: "secret" } })
    expect(paramsOf(frame).env).toEqual({ LANG: "en", TENANT: "acme" })
  })

  it("sends cwd relative to the remote root, and empty outside it", async () => {
    const { client, socket } = await connected({ at: "/sandbox/" })
    expect(client.at).toBe("/sandbox")
    expect(client.bin).toBe("/sandbox/bin")
    const cases = [["/sandbox", ""], ["/sandbox/docs/deep", "docs/deep"], ["/home/guest", ""], ["/sandboxes", ""]]
    for (const [cwd, want] of cases) {
      const { frame } = await start(client, socket, { argv: ["count"], ...(cwd !== undefined ? { cwd } : {}) })
      expect(paramsOf(frame).cwd, cwd).toBe(want)
    }
  })

  it("maps stdio to tty or pipe and sends the name with the rest of argv", async () => {
    const { client, socket } = await connected()
    const fake = fakeProc({ argv: ["/remote/bin/count", "-n", "2"], stdio: { stdin: "null", stdout: "tty", stderr: "file" }, tty: { cols: 80, rows: 24 } })
    void client.commands.run("count", fake.proc)
    expect(await socket.take()).toEqual({
      jsonrpc: "2.0", id: 2, method: "proc.start",
      params: { pid: 1, argv: ["count", "-n", "2"], cwd: "", env: {}, stdio: { stdin: "pipe", stdout: "tty", stderr: "pipe" } },
    })
  })

  it("allocates pids from 1, increasing, never reused, and again from 1 on a new connection", async () => {
    const { client, net, clock, socket } = await connected()
    const a = await start(client, socket, { argv: ["wait"] })
    const b = await start(client, socket, { argv: ["wait"] })
    socket.receive(note("proc.exit", { pid: a.pid, code: 0 }))
    await a.exit
    const c = await start(client, socket, { argv: ["wait"] })
    expect([a.pid, b.pid, c.pid]).toEqual([1, 2, 3])
    socket.drop(1006)
    expect(await b.exit).toBe(255)
    expect(await c.exit).toBe(255)
    const again = fakeProc({ argv: ["wait"] })
    void client.commands.run("wait", again.proc)
    await clock.tick(1000)
    const second = await accept(net)
    expect(paramsOf(await second.take()).pid).toBe(1)
  })

  it("tells the server the terminal size when a process has a terminal of another size", async () => {
    const { client, socket } = await connected()
    const tty = fakeProc({ argv: ["count"], stdio: { stdout: "tty" }, tty: { cols: 132, rows: 43 } })
    void client.commands.run("count", tty.proc)
    expect(await socket.take()).toEqual({ jsonrpc: "2.0", method: "tty.resize", params: { cols: 132, rows: 43 } })
    expect(methodOf(await socket.take())).toBe("proc.start")
    // The same size again is not repeated.
    const same = fakeProc({ argv: ["count"], stdio: { stdout: "tty" }, tty: { cols: 132, rows: 43 } })
    void client.commands.run("count", same.proc)
    expect(methodOf(await socket.take())).toBe("proc.start")
  })

  it("a command the server does not have is 127; other start errors are 1 or 126", async () => {
    const { client, socket } = await connected()
    const cases: Array<[string, number, string]> = [
      ["ENOENT", 127, "rite: command not found: nope\n"],
      ["EACCES", 126, "nope: permission denied\n"],
      ["EINVAL", 1, "nope: invalid argument\n"],
    ]
    for (const [errno, code, line] of cases) {
      const fake = fakeProc({ argv: ["nope"] })
      const exit = client.commands.run("nope", fake.proc)
      socket.receive(failure(idOf(await socket.take()), -32000, "x", { errno, path: "nope" }))
      expect(await exit).toBe(code)
      expect(fake.err.join("")).toBe(line)
      // A process that did not start reads no stdin and sends none.
      fake.stdin.push("ignored")
      await settle()
      expect(socket.untaken).toEqual([])
    }
  })

  it("cannot start without a connection: 255 and one line on stderr", async () => {
    const { client, net } = rig()
    const fake = fakeProc({ argv: ["count"] })
    const exit = client.commands.run("count", fake.proc)
    const socket = await net.next()
    socket.open()
    await socket.take()
    socket.drop(4001)
    expect(await exit).toBe(255)
    expect(fake.err.join("")).toBe("rite: count: connection closed (4001)\n")
  })

  it("does not start a process that is already aborted", async () => {
    const { client, socket } = await connected()
    const fake = fakeProc({ argv: ["count"] })
    fake.abort("INT")
    expect(await client.commands.run("count", fake.proc)).toBe(130)
    await settle()
    expect(socket.untaken).toEqual([])
  })
})

describe("output and exit", () => {
  it("writes stdout and stderr in order and resolves with the exit code", async () => {
    const { client, socket } = await connected()
    const { fake, exit, pid } = await start(client, socket, { argv: ["fail", "3"] })
    socket.receive(note("proc.stdout", { pid, data: "1\n" }))
    socket.receive(note("proc.stderr", { pid, data: "failing\n" }))
    socket.receive(note("proc.stdout", { pid, data: "2\n" }))
    socket.receive(note("proc.exit", { pid, code: 3 }))
    expect(await exit).toBe(3)
    expect(fake.out).toEqual(["1\n", "2\n"])
    expect(fake.err).toEqual(["failing\n"])
    // Nothing follows proc.exit; a server that sends more is ignored.
    socket.receive(note("proc.stdout", { pid, data: "late" }))
    await settle()
    expect(fake.out).toEqual(["1\n", "2\n"])
  })

  it("routes output by pid", async () => {
    const { client, socket } = await connected()
    const a = await start(client, socket, { argv: ["count"] })
    const b = await start(client, socket, { argv: ["count"] })
    socket.receive(note("proc.stdout", { pid: b.pid, data: "b" }))
    socket.receive(note("proc.stdout", { pid: a.pid, data: "a" }))
    socket.receive(note("proc.stdout", { pid: 99, data: "nobody" }))
    socket.receive(note("proc.exit", { pid: b.pid, code: 0 }))
    socket.receive(note("proc.exit", { pid: a.pid, code: 7 }))
    expect([await a.exit, await b.exit]).toEqual([7, 0])
    expect([a.fake.out, b.fake.out]).toEqual([["a"], ["b"]])
  })

  it("stops reading stdin when the process exits", async () => {
    const { client, socket } = await connected()
    const { fake, exit, pid } = await start(client, socket, { argv: ["count"] })
    socket.receive(note("proc.exit", { pid, code: 0 }))
    expect(await exit).toBe(0)
    await settle()
    // The client cancelled its reader: the stream is released to nobody and takes no more.
    expect(() => { fake.stdin.push("late") }).toThrow()
    expect(socket.untaken).toEqual([])
  })
})

describe("stdin", () => {
  it("streams chunks as they arrive and ends with eof", async () => {
    const { client, socket } = await connected()
    const { fake, pid } = await start(client, socket, { argv: ["upper"] })
    fake.stdin.push("abc\n")
    expect(await socket.take()).toEqual({ jsonrpc: "2.0", method: "proc.stdin", params: { pid, data: "abc\n" } })
    fake.stdin.push("")
    fake.stdin.push("def\n")
    expect(paramsOf(await socket.take())).toEqual({ pid, data: "def\n" })
    fake.stdin.end()
    expect(await socket.take()).toEqual({ jsonrpc: "2.0", method: "proc.stdin", params: { pid, eof: true } })
  })

  it("splits stdin so every message is at most maxMessageBytes", async () => {
    const max = 160
    const { client, socket } = await connected({}, { limits: { maxMessageBytes: max } })
    const { fake, pid } = await start(client, socket, { argv: ["upper"] })
    // ASCII, escapes, control characters, two- and three-byte characters, astral pairs.
    const text = ("plain text " + "\"quoted\\\" \n\t\u0001\u001f " + "héllo wörld " + "日本語のテキスト " + "😀🎉🚀 ").repeat(40)
    fake.stdin.push(text)
    fake.stdin.end()
    await settle(20)
    const frames = socket.untaken
    const last = frames.at(-1)
    expect(last).toEqual({ jsonrpc: "2.0", method: "proc.stdin", params: { pid, eof: true } })
    const data = frames.slice(0, -1).map((f) => paramsOf(f).data as string)
    expect(data.join("")).toBe(text)
    expect(data.length).toBeGreaterThan(text.length / max)
    const sizes = socket.raw.slice(-frames.length).map(byteLength)
    expect(Math.max(...sizes)).toBeLessThanOrEqual(max)
    // Close to the limit, not one character per message.
    expect(Math.max(...sizes)).toBeGreaterThan(max - 8)
    // No piece ends inside a surrogate pair.
    for (const piece of data) expect(wellFormed(piece)).toBe(true)
  })

  it("waits while the socket's bufferedAmount is high", async () => {
    const { client, clock, socket } = await connected()
    const { fake, pid } = await start(client, socket, { argv: ["upper"] })
    socket.bufferedAmount = STDIN_HIGH_WATER_BYTES + 1
    fake.stdin.push("held")
    await clock.tick(STDIN_POLL_MS * 10)
    expect(socket.untaken).toEqual([])
    socket.bufferedAmount = STDIN_HIGH_WATER_BYTES
    await clock.tick(STDIN_POLL_MS)
    expect(paramsOf(await socket.take())).toEqual({ pid, data: "held" })
  })

  it("stops waiting on the socket when the process exits", async () => {
    const { client, clock, socket } = await connected()
    const { fake, exit, pid } = await start(client, socket, { argv: ["upper"] })
    socket.bufferedAmount = STDIN_HIGH_WATER_BYTES + 1
    fake.stdin.push("never sent")
    await clock.tick(STDIN_POLL_MS)
    socket.receive(note("proc.exit", { pid, code: 0 }))
    expect(await exit).toBe(0)
    socket.bufferedAmount = 0
    await clock.tick(STDIN_POLL_MS * 2)
    expect(socket.untaken).toEqual([])
    expect(clock.delays.filter((d) => d <= STDIN_POLL_MS)).toEqual([])
  })

  it("sends eof when stdin fails for a reason other than an abort", async () => {
    const { client, socket } = await connected()
    const { fake, pid } = await start(client, socket, { argv: ["upper"] })
    fake.stdin.fail()
    expect(paramsOf(await socket.take())).toEqual({ pid, eof: true })
  })
})

describe("signals", () => {
  it("^C sends INT and the process decides its exit code", async () => {
    const { client, socket } = await connected()
    const { fake, exit, pid } = await start(client, socket, { argv: ["wait"] })
    fake.abort("INT")
    expect(await socket.take()).toEqual({ jsonrpc: "2.0", method: "proc.signal", params: { pid, signal: "INT" } })
    socket.receive(note("proc.stdout", { pid, data: "bye\n" }))
    socket.receive(note("proc.exit", { pid, code: 130 }))
    expect(await exit).toBe(130)
    expect(fake.out).toEqual(["bye\n"])
    expect(socket.untaken).toEqual([])
  })

  it("an EPIPE abort sends KILL", async () => {
    const { client, socket } = await connected()
    const { fake, exit, pid } = await start(client, socket, { argv: ["wait"] })
    fake.abort("EPIPE")
    expect(await socket.take()).toEqual({ jsonrpc: "2.0", method: "proc.signal", params: { pid, signal: "KILL" } })
    socket.receive(note("proc.exit", { pid, code: 137 }))
    expect(await exit).toBe(137)
  })

  it("a stdout nobody reads any more sends KILL once and drops the rest", async () => {
    const { client, socket } = await connected()
    const { fake, exit, pid } = await start(client, socket, { argv: ["count"] })
    socket.receive(note("proc.stdout", { pid, data: "1\n" }))
    await settle()
    fake.breakStdout()
    socket.receive(note("proc.stdout", { pid, data: "2\n" }))
    socket.receive(note("proc.stdout", { pid, data: "3\n" }))
    expect(await socket.take()).toEqual({ jsonrpc: "2.0", method: "proc.signal", params: { pid, signal: "KILL" } })
    // The kernel's own EPIPE abort arrives too: still one KILL.
    fake.abort("EPIPE")
    socket.receive(note("proc.stdout", { pid, data: "4\n" }))
    await settle()
    expect(socket.untaken).toEqual([])
    expect(fake.out).toEqual(["1\n"])
    socket.receive(note("proc.exit", { pid, code: 137 }))
    expect(await exit).toBe(137)
  })

  it("an abort while proc.start is unanswered still signals the process", async () => {
    const { client, socket } = await connected()
    const fake = fakeProc({ argv: ["wait"] })
    const exit = client.commands.run("wait", fake.proc)
    const frame = await socket.take()
    fake.abort("INT")
    expect(paramsOf(await socket.take())).toEqual({ pid: 1, signal: "INT" })
    socket.receive(result(idOf(frame), {}))
    socket.receive(note("proc.exit", { pid: 1, code: 130 }))
    expect(await exit).toBe(130)
  })

  it("an abort during the connection attempt starts nothing", async () => {
    const { client, net } = rig()
    const fake = fakeProc({ argv: ["wait"] })
    const exit = client.commands.run("wait", fake.proc)
    const socket = await net.next()
    fake.abort("INT")
    expect(await exit).toBe(130)
    socket.open()
    await settle()
    expect(socket.sent.map(methodOf)).toEqual(["rite.hello"])
    expect(fake.err).toEqual([])
  })
})

describe("connection loss", () => {
  it("ends running processes with 255 and `rite: connection lost`, after their output", async () => {
    const { client, socket } = await connected()
    const a = await start(client, socket, { argv: ["wait"] })
    const b = await start(client, socket, { argv: ["wait"] })
    socket.receive(note("proc.stdout", { pid: a.pid, data: "waiting\n" }))
    socket.drop(1006)
    expect([await a.exit, await b.exit]).toEqual([255, 255])
    expect(a.fake.out).toEqual(["waiting\n"])
    expect(a.fake.err).toEqual(["rite: connection lost\n"])
    expect(b.fake.err).toEqual(["rite: connection lost\n"])
    // Their stdin is released and nothing is sent for them after a reconnect.
    expect(() => { a.fake.stdin.push("late") }).toThrow()
  })

  it("ends a process whose proc.start was in flight the same way, once", async () => {
    const { client, socket } = await connected()
    const fake = fakeProc({ argv: ["wait"] })
    const exit = client.commands.run("wait", fake.proc)
    await socket.take()
    socket.drop(4500)
    expect(await exit).toBe(255)
    await settle()
    expect(fake.err).toEqual(["rite: connection lost\n"])
  })

  it("a final close code ends them too", async () => {
    const { client, socket } = await connected()
    const { fake, exit } = await start(client, socket, { argv: ["wait"] })
    socket.drop(4040)
    expect(await exit).toBe(255)
    expect(fake.err).toEqual(["rite: connection lost\n"])
  })

  it("a running process keeps a lazy connection from idling out", async () => {
    const { client, clock, socket } = await connected({}, { limits: { idleSeconds: 10 } })
    const { exit, pid } = await start(client, socket, { argv: ["wait"] })
    await clock.tick(60_000)
    expect(socket.closedByClient).toBeUndefined()
    socket.receive(note("proc.exit", { pid, code: 0 }))
    await exit
    await clock.tick(9999)
    expect(socket.closedByClient).toBeUndefined()
    await clock.tick(1)
    expect(socket.closedByClient?.code).toBe(1000)
  })
})

describe("completion", () => {
  it("asks proc.complete and returns the candidates", async () => {
    const { client, socket } = await connected()
    const done = client.commands.complete?.(["count", "-"], 1, new AbortController().signal)
    const frame = await socket.take()
    expect(frame).toEqual({ jsonrpc: "2.0", id: 2, method: "proc.complete", params: { argv: ["count", "-"], index: 1 } })
    socket.receive(result(2, { candidates: [{ value: "-n", description: "number", extra: true }, { value: "docs", display: "docs/", suffix: "/" }] }))
    expect(await done).toEqual([{ value: "-n", description: "number" }, { value: "docs", display: "docs/", suffix: "/" }])
  })

  it("connects on first use, and fails ECANCELED when the editor moves on", async () => {
    const { client, net } = rig()
    const control = new AbortController()
    const done = client.commands.complete?.(["count", ""], 1, control.signal)
    const socket = await accept(net)
    expect(methodOf(await socket.take())).toBe("proc.complete")
    control.abort()
    await expect(done).rejects.toMatchObject({ errno: "ECANCELED" })
  })
})
