import { describe, expect, it } from "vitest"
import { RiteError } from "../../src/contracts.js"
import { command, shell } from "./support.js"

/** What a writer saw when its pipe broke. */
interface Broken {
  aborted: boolean
  reason: unknown
  errno: string | undefined
}

/** A shell with `spew` (writes until it cannot), `first` (prints one line of stdin and leaves), and `wait` (leaves when aborted). */
function world(): ReturnType<typeof shell> & { broken: Broken[]; reasons: unknown[] } {
  const sh = shell()
  const broken: Broken[] = []
  const reasons: unknown[] = []
  sh.kernel.register(command("spew", async (p) => {
    try {
      for (;;) await p.out("y\n")
    } catch (e) {
      broken.push({ aborted: p.signal.aborted, reason: p.signal.reason, errno: e instanceof RiteError ? e.errno : undefined })
      throw e
    }
  }))
  sh.kernel.register(command("first", async (p) => {
    for await (const line of p.lines()) {
      await p.out(line + "\n")
      break
    }
  }))
  sh.kernel.register(command("wait", (p) => new Promise((resolve) => {
    p.signal.addEventListener("abort", () => {
      reasons.push(p.signal.reason)
      resolve(7)
    })
  })))
  return { ...sh, broken, reasons }
}

describe("pipelines", () => {
  it("connects each stage to the next", async () => {
    const sh = world()
    expect(await sh.run("echo a | cat | cat | grep a")).toEqual({ code: 0, stdout: "a\n", stderr: "" })
    expect(sh.calls).toEqual([["echo", "a"], ["cat"], ["cat"], ["grep", "a"]])
  })

  it("has the status of its last stage", async () => {
    const sh = world()
    expect((await sh.run("false | true")).code).toBe(0)
    expect((await sh.run("true | false")).code).toBe(1)
    expect((await sh.run("echo a | grep b")).code).toBe(1)
    expect(await sh.run("echo a | nosuch")).toEqual({ code: 127, stdout: "", stderr: "rite: command not found: nosuch\n" })
    expect(await sh.run("nosuch | cat")).toEqual({ code: 0, stdout: "", stderr: "rite: command not found: nosuch\n" })
    expect((await sh.run("echo a | grep b; echo $?")).stdout).toBe("1\n")
  })

  it("aborts upstream with EPIPE when a reader finishes", async () => {
    const sh = world()
    // Nothing is printed for the writer: a broken pipe is the signal's doing.
    expect(await sh.run("spew | first")).toEqual({ code: 0, stdout: "y\n", stderr: "" })
    expect(sh.broken).toEqual([{ aborted: true, reason: "EPIPE", errno: "EPIPE" }])
  })

  it("aborts every stage above the reader that finished", async () => {
    const sh = world()
    expect(await sh.run("wait | wait | true")).toEqual({ code: 0, stdout: "", stderr: "" })
    expect(sh.reasons).toEqual(["EPIPE", "EPIPE"])
  })

  it("breaks the pipe of a reader that never read", async () => {
    const sh = world()
    expect(await sh.run("spew | true")).toEqual({ code: 0, stdout: "", stderr: "" })
    expect(sh.broken).toEqual([{ aborted: true, reason: "EPIPE", errno: "EPIPE" }])
    expect(await sh.run("spew | echo done")).toEqual({ code: 0, stdout: "done\n", stderr: "" })
  })

  it("does not leave a writer waiting when a later stage never starts", async () => {
    const sh = world()
    expect(await sh.run("spew | cat *.none")).toEqual({ code: 1, stdout: "", stderr: "rite: no matches found: *.none\n" })
    expect(await sh.run("spew | cat > /tmp")).toEqual({ code: 1, stdout: "", stderr: "rite: /tmp: is a directory\n" })
    expect(sh.broken).toHaveLength(2)
  })

  it("does not abort the stages below a writer that finished", async () => {
    const sh = world()
    const seen: boolean[] = []
    sh.kernel.register(command("drain", async (p) => {
      for await (const line of p.lines()) await p.out(line + "\n")
      seen.push(p.signal.aborted)
    }))
    expect(await sh.run("echo a | drain | drain")).toEqual({ code: 0, stdout: "a\n", stderr: "" })
    expect(seen).toEqual([false, false])
  })

  it("lets the shell's own messages into a pipe", async () => {
    const sh = world()
    expect(await sh.run("nosuch 2>&1 | cat")).toEqual({ code: 0, stdout: "rite: command not found: nosuch\n", stderr: "" })
    expect(await sh.run("/tmp 2>&1 | cat")).toEqual({ code: 0, stdout: "rite: /tmp: is a directory\n", stderr: "" })
    expect(await sh.run("cd -x 2>&1 | grep usage")).toEqual({ code: 0, stdout: "usage: cd [dir | -]\n", stderr: "" })
    expect(await sh.run("cd --help | grep usage")).toEqual({ code: 0, stdout: "usage: cd [dir | -]\n", stderr: "" })
  })

  it("starts the stages left to right", async () => {
    const sh = world()
    await sh.run("echo a b c d e f | cat | true")
    expect(sh.calls.map(([name]) => name)).toEqual(["echo", "cat", "true"])
  })

  it("tells each stage what its streams are", async () => {
    const sh = world()
    sh.kernel.register(command("kinds", async (p) => {
      await p.err(`${p.stdio.stdin} ${p.stdio.stdout} ${p.stdio.stderr} ${p.tty === null ? "notty" : "tty"}\n`)
    }))
    const kinds = async (line: string): Promise<string> => (await sh.run(line)).stderr
    expect(await kinds("kinds")).toBe("null tty tty notty\n")
    expect(await kinds("kinds | cat")).toBe("null pipe tty notty\n")
    expect(await kinds("echo | kinds")).toBe("pipe tty tty notty\n")
    expect(await kinds("kinds < /dev/null > /tmp/k")).toBe("file file tty notty\n")
    expect(await kinds("kinds 2>&1 | cat > /dev/null; cat /tmp/k")).toBe("")
  })
})

describe("builtins in a pipeline", () => {
  it.each([
    ["cd /tmp | cat; pwd", "/home/guest\n"],
    ["echo hi | cd /tmp; pwd", "/home/guest\n"],
    ["X=1 | cat; echo \"[$X]\"", "[]\n"],
    ["true | X=1; echo \"[$X]\"", "[]\n"],
    ["export Y=1 | cat; echo \"[$Y]\"", "[]\n"],
    ["alias a=b | cat; alias", ""],
    ["X=1; unset X | cat; echo $X", "1\n"],
    ["alias a='echo kept'; unalias a | cat; a", "kept\n"],
  ])("%s", async (line, stdout) => {
    const sh = world()
    expect(await sh.run(line)).toEqual({ code: 0, stdout, stderr: "" })
  })

  it("does not end the session", async () => {
    const sh = world()
    expect(await sh.run("exit 3 | cat; echo still here")).toEqual({ code: 0, stdout: "still here\n", stderr: "" })
    expect(sh.kernel.exitRequested).toBeNull()
  })

  it("writes into the pipe", async () => {
    const sh = world()
    expect(await sh.run("alias a=b; alias | cat | grep a")).toEqual({ code: 0, stdout: "a='b'\n", stderr: "" })
    expect(await sh.run("cd - | cat")).toEqual({ code: 0, stdout: "/home/guest\n", stderr: "" })
  })
})
