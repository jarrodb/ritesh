// The TypeScript rite.1 client against the Go server over a real WebSocket:
// what the trace replays cannot show (ordering across the wire, the
// subprotocol, Origin, real framing). Skipped when Go is not installed.
import { type ChildProcess, execFileSync, spawn } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { RemoteHandle } from "../../src/contracts.js"
import { remote } from "../../src/remote.js"
import { fakeProc } from "../remote/support.js"

const serverDir = join(import.meta.dirname, "../../../../server")
const hasGo = (() => {
  try {
    execFileSync("go", ["version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
})()

describe.skipIf(!hasGo)("rite.1 client against the Go server", () => {
  let child: ChildProcess | undefined
  let url = ""
  let handle: RemoteHandle

  beforeAll(async () => {
    const bin = join(mkdtempSync(join(tmpdir(), "rite-world-")), "rite-world")
    execFileSync("go", ["build", "-o", bin, "./cmd/rite-world"], { cwd: serverDir, stdio: "inherit" })
    child = spawn(bin, ["-world", join(serverDir, "../protocol/world.json"), "-origin", "http://localhost"], { stdio: ["ignore", "pipe", "inherit"] })
    const stdout = child.stdout
    if (!stdout) throw new Error("no stdout")
    const addr = await new Promise<string>((resolve, reject) => {
      const lines = createInterface({ input: stdout })
      lines.on("line", (line) => {
        const m = /^listening (\S+)$/.exec(line)
        if (m?.[1]) resolve(m[1])
      })
      child?.on("exit", (code) => { reject(new Error(`rite-world exited ${String(code)}`)) })
    })
    url = `ws://${addr}/`
    handle = remote({
      url, at: "/w", token: () => "test-token", connect: "eager", env: ["A"],
      // Node's WebSocket sends no Origin; the server requires one.
      socket: (u, protocols) => new WebSocket(u, { protocols, headers: { Origin: "http://localhost" } } as unknown as string[]),
    })
    await handle.connect()
  }, 120_000)

  afterAll(() => {
    handle.dispose()
    child?.kill()
  })

  it("reads the remote filesystem", async () => {
    expect(await handle.provider.read("readme.txt", {})).toBe("hello from the test world\n")
    expect((await handle.provider.list("docs", {})).map((e) => e.name)).toEqual(["a.md", "b.md"])
    expect((await handle.provider.stat("docs", {})).type).toBe("dir")
    await expect(handle.provider.stat("missing", {})).rejects.toMatchObject({ errno: "ENOENT" })
  })

  it("runs commands with output, exit codes, env, and stdin", async () => {
    const count = fakeProc({ argv: ["count", "-n", "3"] })
    count.stdin.end()
    expect(await handle.commands.run("count", count.proc)).toBe(0)
    expect(count.out.join("")).toBe("1\n2\n3\n")

    const fail = fakeProc({ argv: ["fail", "7"] })
    fail.stdin.end()
    expect(await handle.commands.run("fail", fail.proc)).toBe(7)
    expect(fail.err.join("")).toBe("failing\n")

    const env = fakeProc({ argv: ["env"], env: { A: "1", SECRET: "no" } })
    env.stdin.end()
    expect(await handle.commands.run("env", env.proc)).toBe(0)
    expect(env.out.join("")).toBe("A=1\n")

    const upper = fakeProc({ argv: ["upper"] })
    const done = handle.commands.run("upper", upper.proc)
    upper.stdin.push("hello ")
    upper.stdin.push("world\n")
    upper.stdin.end()
    expect(await done).toBe(0)
    expect(upper.out.join("")).toBe("HELLO WORLD\n")
  })

  it("interrupts a running command", async () => {
    const wait = fakeProc({ argv: ["wait"] })
    const done = handle.commands.run("wait", wait.proc)
    for (let i = 0; i < 200 && wait.out.join("") !== "waiting\n"; i++) {
      await new Promise((r) => { setImmediate(r) })
      await new Promise((r) => { setTimeout(r, 5) })
    }
    expect(wait.out.join("")).toBe("waiting\n")
    wait.abort("INT")
    expect(await done).toBe(130)
  })

  it("knows the server's commands", () => {
    expect(handle.commands.names()).toEqual(expect.arrayContaining(["count", "env", "fail", "upper", "wait"]))
  })
})
