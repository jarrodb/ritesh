import { describe, expect, it } from "vitest"
import { type MountProvider, RiteError, type Stat } from "../../src/contracts.js"
import { command, gate, shell } from "./support.js"

/** A shell with `stubborn`, which ignores its signal until the test lets it go. */
function world(options: Parameters<typeof shell>[0] = {}) {
  const sh = shell(options)
  const started = gate()
  const release = gate()
  const finished = gate<{ aborted: boolean; reason: unknown; late: string }>()
  sh.kernel.register(command("stubborn", async (p) => {
    started.open()
    await release.promise
    // Whatever it writes after ^C goes nowhere.
    const late = await p.out("late\n").then(() => "written", (e: unknown) => (e instanceof RiteError ? e.errno : "error"))
    finished.open({ aborted: p.signal.aborted, reason: p.signal.reason, late })
    return 5
  }))
  return { ...sh, started, release, finished }
}

describe("^C", () => {
  it("resolves exec with 130 without waiting for a command that ignores the abort", async () => {
    const sh = world()
    const running = sh.run("stubborn; echo after")
    await sh.started.promise
    expect(sh.kernel.running).toBe(true)
    sh.kernel.interrupt()
    expect(await running).toEqual({ code: 130, stdout: "", stderr: "" })
    expect(sh.kernel.running).toBe(false)
    expect(sh.kernel.session.lastStatus).toBe(130)
    expect(await sh.run("echo $?")).toEqual({ code: 0, stdout: "130\n", stderr: "" })

    // The command is still there. When it ends, nothing it does reaches the terminal or the session.
    sh.release.open()
    expect(await sh.finished.promise).toEqual({ aborted: true, reason: "INT", late: "EPIPE" })
    expect(await sh.run("echo $?")).toEqual({ code: 0, stdout: "0\n", stderr: "" })
    expect(sh.terminal).toEqual({ stdout: "130\n0\n", stderr: "" })
    expect(sh.calls).toEqual([["echo", "130"], ["echo", "0"]])
  })

  it("is 130 whatever the command returns when it honors the abort", async () => {
    const sh = world()
    const started = gate()
    sh.kernel.register(command("polite", (p) => new Promise((resolve) => {
      p.signal.addEventListener("abort", () => { resolve(p.signal.reason === "INT" ? 0 : 9) })
      started.open()
    })))
    const running = sh.run("polite && echo after")
    await started.promise
    sh.kernel.interrupt()
    expect(await running).toEqual({ code: 130, stdout: "", stderr: "" })
  })

  it("errors the pipeline's streams and aborts every stage", async () => {
    const sh = world()
    const seen: Array<{ errno: string | undefined; reason: unknown }> = []
    const reading = gate()
    const done = gate()
    sh.kernel.register(command("reader", async (p) => {
      try {
        const lines = p.lines()[Symbol.asyncIterator]()
        const first = lines.next()
        reading.open()
        await first
      } catch (e) {
        seen.push({ errno: e instanceof RiteError ? e.errno : undefined, reason: p.signal.reason })
        done.open()
        throw e
      }
    }))
    const running = sh.run("stubborn | reader | cat")
    await reading.promise
    sh.kernel.interrupt()
    expect(await running).toEqual({ code: 130, stdout: "", stderr: "" })
    await done.promise
    expect(seen).toEqual([{ errno: "ECANCELED", reason: "INT" }])
  })

  it("keeps a redirect's file as the command left it", async () => {
    const sh = world()
    const running = sh.run("stubborn > /tmp/o")
    await sh.started.promise
    sh.kernel.interrupt()
    expect((await running).code).toBe(130)
    sh.release.open()
    await sh.finished.promise
    expect(await sh.run("cat /tmp/o")).toEqual({ code: 0, stdout: "", stderr: "" })
  })

  it("does nothing when no job is running", async () => {
    const sh = world()
    await sh.run("false")
    sh.kernel.interrupt()
    expect(sh.kernel.session.lastStatus).toBe(1)
    expect(await sh.run("echo $?")).toEqual({ code: 0, stdout: "1\n", stderr: "" })
  })

  it("aborts the foreground job only, and the queue goes on", async () => {
    const sh = world()
    const first = sh.run("stubborn")
    const second = sh.run("echo next")
    await sh.started.promise
    sh.kernel.interrupt()
    expect((await first).code).toBe(130)
    expect((await second).stdout).toBe("next\n")
  })

  it("stops a sourced file at the line it interrupts, keeping what ran before", async () => {
    const sh = world({ files: { "/tmp/rc": "cd /tmp\nX=1\nstubborn\ncd /root\nX=2\n" } })
    const running = sh.run("source /tmp/rc; echo after")
    await sh.started.promise
    sh.kernel.interrupt()
    expect((await running).code).toBe(130)
    sh.release.open()
    await sh.finished.promise
    expect(await sh.run("pwd; echo $X")).toEqual({ code: 0, stdout: "/tmp\n1\n", stderr: "" })
  })

  it("discards what a builtin does after the interrupt", async () => {
    const sh = world()
    const asked = gate()
    const answer = gate<Stat>()
    const slow: MountProvider = {
      readonly: true,
      stat: () => {
        asked.open()
        return answer.promise
      },
      list: () => Promise.resolve([]),
      read: () => Promise.resolve(""),
    }
    sh.vfs.mount("/slow", slow)
    const running = sh.run("cd /slow")
    await asked.promise
    sh.kernel.interrupt()
    expect((await running).code).toBe(130)
    // cd gets its answer after the prompt is back. The directory does not change under the user.
    answer.open({ type: "dir", mode: 0o755, uid: 0, gid: 0, size: 0, mtime: 0 })
    expect(await sh.run("pwd")).toEqual({ code: 0, stdout: "/home/guest\n", stderr: "" })
    expect(await sh.run("cd /slow; pwd")).toEqual({ code: 0, stdout: "/slow\n", stderr: "" })
  })

  it("ends a read from the terminal", async () => {
    const reading = gate()
    const cancelled = gate()
    const sh = world({
      kernel: {
        stdin: () => new ReadableStream<string>({
          pull: () => {
            reading.open()
            return new Promise<void>(() => undefined)
          },
          cancel: () => { cancelled.open() },
        }),
      },
    })
    const running = sh.run("cat")
    await reading.promise
    sh.kernel.interrupt()
    expect(await running).toEqual({ code: 130, stdout: "", stderr: "" })
    await cancelled.promise
  })
})
