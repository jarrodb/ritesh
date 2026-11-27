import { describe, expect, it } from "vitest"
import { type EggDef, PASS, type Proc } from "../../src/contracts.js"
import { shell } from "./support.js"

function egg(id: string, trigger: EggDef["trigger"], run: EggDef["run"]): EggDef {
  return { id, trigger, run }
}

describe("input eggs", () => {
  it("handle a line before it is parsed", async () => {
    const sh = shell()
    const seen: Proc[] = []
    sh.kernel.registerEgg(egg("sandwich", { input: /^make me a \(sandwich$/ }, async (p) => {
      seen.push(p)
      await p.out("what? make it yourself.\n")
    }))
    // The line is not one the parser accepts.
    expect(await sh.run("make me a (sandwich")).toEqual({ code: 0, stdout: "what? make it yourself.\n", stderr: "" })
    expect(seen[0]?.argv).toEqual(["make me a (sandwich"])
    expect(seen[0]?.args).toEqual([])
    expect((await sh.run("make me a (salad")).code).toBe(2)
  })

  it("set $?, and are tried again on every line whatever the pattern's flags", async () => {
    const sh = shell()
    sh.kernel.registerEgg(egg("xyzzy", { input: /xyzzy/g }, () => Promise.resolve(42)))
    expect((await sh.run("xyzzy")).code).toBe(42)
    expect((await sh.run("xyzzy")).code).toBe(42)
    expect((await sh.run("echo $?")).stdout).toBe("42\n")
  })

  it("pass a line on by returning PASS", async () => {
    const sh = shell()
    const order: string[] = []
    sh.kernel.registerEgg(egg("a", { input: /hi/ }, () => {
      order.push("a")
      return Promise.resolve(PASS)
    }))
    sh.kernel.registerEgg(egg("b", { input: /hi/ }, () => {
      order.push("b")
      return Promise.resolve(PASS)
    }))
    expect(await sh.run("echo hi")).toEqual({ code: 0, stdout: "hi\n", stderr: "" })
    expect(order).toEqual(["a", "b"])
  })

  it("stop at the first that does not pass", async () => {
    const sh = shell()
    const order: string[] = []
    sh.kernel.registerEgg(egg("a", { input: /hi/ }, () => {
      order.push("a")
      return Promise.resolve(3)
    }))
    sh.kernel.registerEgg(egg("b", { input: /hi/ }, () => {
      order.push("b")
      return Promise.resolve(0)
    }))
    expect(await sh.run("echo hi")).toEqual({ code: 3, stdout: "", stderr: "" })
    expect(order).toEqual(["a"])
    expect(sh.calls).toEqual([])
  })

  it("report a throw under the egg's id", async () => {
    const sh = shell()
    sh.kernel.registerEgg(egg("broken", { input: /^boom$/ }, () => Promise.reject(new Error("no luck"))))
    expect(await sh.run("boom")).toEqual({ code: 1, stdout: "", stderr: "broken: no luck\n" })
  })

  it("see typed lines only, not the lines of a sourced file", async () => {
    const sh = shell({ files: { "/tmp/rc": "xyzzy\n" } })
    sh.kernel.registerEgg(egg("xyzzy", { input: /^xyzzy$/ }, () => Promise.resolve(0)))
    expect((await sh.run("source /tmp/rc")).stderr).toBe("rite: command not found: xyzzy\n")
  })
})

describe("command eggs", () => {
  it("come after input eggs, aliases, and expansion, and before builtins and PATH", async () => {
    const sh = shell()
    const order: string[] = []
    sh.kernel.registerEgg(egg("input", { input: /./ }, () => {
      order.push("input")
      return Promise.resolve(PASS)
    }))
    sh.kernel.registerEgg(egg("command", { command: "echo" }, (p) => {
      order.push(`command ${p.argv.join(" ")}`)
      return Promise.resolve(PASS)
    }))
    await sh.run("alias e=echo; X=1")
    order.length = 0
    expect((await sh.run("e $X ~")).stdout).toBe("1 /home/guest\n")
    expect(order).toEqual(["input", "command echo 1 /home/guest"])
    expect(sh.calls).toEqual([["echo", "1", "/home/guest"]])
  })

  it("take a builtin's place", async () => {
    const sh = shell()
    sh.kernel.registerEgg(egg("nocd", { command: "cd" }, async (p) => {
      await p.out("you are fine where you are\n")
      return 9
    }))
    expect(await sh.run("cd /tmp; pwd")).toEqual({ code: 0, stdout: "you are fine where you are\n/home/guest\n", stderr: "" })
    expect((await sh.run("cd /tmp")).code).toBe(9)
  })

  it("take a command's place, or the place of one that does not exist", async () => {
    const sh = shell()
    sh.kernel.registerEgg(egg("quiet", { command: "echo" }, () => Promise.resolve()))
    sh.kernel.registerEgg(egg("sudoers", { command: "sudo" }, async (p) => {
      await p.err(`${p.sys.session.user} is not in the sudoers file. This incident will be reported.\n`)
      return 1
    }))
    expect(await sh.run("echo hi")).toEqual({ code: 0, stdout: "", stderr: "" })
    expect(sh.calls).toEqual([])
    expect(await sh.run("sudo ls /root")).toEqual({
      code: 1, stdout: "", stderr: "guest is not in the sudoers file. This incident will be reported.\n",
    })
  })

  it("fall through to the lookup when every egg passes", async () => {
    const sh = shell()
    sh.kernel.registerEgg(egg("pass", { command: "sudo" }, () => Promise.resolve(PASS)))
    expect(await sh.run("sudo ls")).toEqual({ code: 127, stdout: "", stderr: "rite: command not found: sudo\n" })
  })

  it("run in registration order until one does not pass", async () => {
    const sh = shell()
    const order: string[] = []
    for (const [id, result] of [["a", PASS], ["b", 4], ["c", 0]] as const) {
      sh.kernel.registerEgg(egg(id, { command: "true" }, () => {
        order.push(id)
        return Promise.resolve(result)
      }))
    }
    expect((await sh.run("true")).code).toBe(4)
    expect(order).toEqual(["a", "b"])
    expect(sh.calls).toEqual([])
  })

  it("are chosen by the argv predicate, which sees the session", async () => {
    const sh = shell()
    const views: string[] = []
    sh.kernel.registerEgg(egg("rmrf", {
      command: "echo",
      when: (argv, session) => {
        views.push(`${session.user}@${session.cwd}`)
        return argv.includes("-rf")
      },
    }, async (p) => { await p.out("just kidding.\n") }))
    expect((await sh.run("cd /tmp; echo -rf /")).stdout).toBe("just kidding.\n")
    expect((await sh.run("echo -r /")).stdout).toBe("-r /\n")
    expect(views).toEqual(["guest@/tmp", "guest@/tmp"])
  })

  it("apply to each stage of a pipeline, on that stage's streams", async () => {
    const sh = shell()
    sh.kernel.registerEgg(egg("shout", { command: "cat" }, async (p) => {
      for await (const line of p.lines()) await p.out(line.toUpperCase() + "\n")
    }))
    expect(await sh.run("echo hi | cat | grep HI > /tmp/o; grep H < /tmp/o")).toEqual({ code: 0, stdout: "HI\n", stderr: "" })
    expect(sh.calls.map(([name]) => name)).toEqual(["echo", "grep", "grep"])
  })

  it("leave the streams open for the command when they pass", async () => {
    const sh = shell()
    sh.kernel.registerEgg(egg("peek", { command: "cat" }, async (p) => {
      await p.err("egg saw it\n")
      return PASS
    }))
    expect(await sh.run("echo hi | cat")).toEqual({ code: 0, stdout: "hi\n", stderr: "egg saw it\n" })
  })

  it("report a throw under the command's name", async () => {
    const sh = shell()
    sh.kernel.registerEgg(egg("broken", { command: "echo" }, () => Promise.reject(new Error("no luck"))))
    expect(await sh.run("echo hi")).toEqual({ code: 1, stdout: "", stderr: "echo: no luck\n" })
  })
})

describe("key eggs", () => {
  it("are listed for the editor, which is what runs them", async () => {
    const sh = shell()
    const konami = egg("konami", { keys: "\u001b[A\u001b[A\u001b[B\u001b[B" }, () => Promise.reject(new Error("not by a line")))
    sh.kernel.registerEgg(egg("a", { command: "x" }, () => Promise.resolve()))
    sh.kernel.registerEgg(konami)
    sh.kernel.registerEgg(egg("b", { input: /x/ }, () => Promise.resolve(PASS)))
    expect(sh.kernel.keyEggs()).toEqual([konami])
    expect((await sh.run("true")).code).toBe(0)
  })
})
