import { describe, expect, it } from "vitest"
import {
  type CommandInfo, type CommandSource, PASS, type Proc, type Resolution, RiteError, type Tty,
} from "../../src/contracts.js"
import { collector, command, gate, shell, VERSION } from "./support.js"

describe("exec", () => {
  it("queues a line behind the running job and resolves each exit code", async () => {
    const sh = shell()
    const started = gate()
    const release = gate()
    const order: string[] = []
    sh.kernel.register(command("slow", async () => {
      order.push("slow starts")
      started.open()
      await release.promise
      order.push("slow ends")
      return 3
    }))
    sh.kernel.register(command("mark", (p) => {
      order.push(`mark ${p.args.join(" ")}`)
      return Promise.resolve(Number(p.args[0]))
    }))
    expect(sh.kernel.running).toBe(false)
    const first = sh.kernel.exec("slow")
    const second = sh.kernel.exec("mark 4")
    const third = sh.kernel.exec("mark 5; echo $?")
    expect(sh.kernel.running).toBe(true)
    await started.promise
    // Nothing behind the running job has started.
    expect(order).toEqual(["slow starts"])
    release.open()
    expect(await Promise.all([first, second, third])).toEqual([3, 4, 0])
    expect(order).toEqual(["slow starts", "slow ends", "mark 4", "mark 5"])
    expect(sh.terminal.stdout).toBe("5\n")
    expect(sh.kernel.running).toBe(false)
  })

  it("writes to the caller's streams when given, and leaves them open", async () => {
    const sh = shell()
    const out = collector()
    const err = collector()
    expect(await sh.kernel.exec("echo hi; cat /none; nosuch", { stdout: out.stream, stderr: err.stream })).toBe(127)
    expect(out.text()).toBe("hi\n")
    expect(err.text()).toBe("cat: /none: no such file or directory\nrite: command not found: nosuch\n")
    expect(sh.terminal).toEqual({ stdout: "", stderr: "" })
    // Unlocked and not closed: the caller can go on writing.
    const writer = out.stream.getWriter()
    await writer.write("more\n")
    expect(out.text()).toBe("hi\nmore\n")
  })

  it("accepts one stream for both outputs, and the terminal for the one not given", async () => {
    const sh = shell()
    const both = collector()
    await sh.kernel.exec("echo a; echo b >&2", { stdout: both.stream, stderr: both.stream })
    expect(both.text()).toBe("a\nb\n")
    const out = collector()
    await sh.kernel.exec("echo a; echo b >&2", { stdout: out.stream })
    expect(out.text()).toBe("a\n")
    expect(sh.terminal).toEqual({ stdout: "", stderr: "b\n" })
  })

  it("reads stdin from the caller's stream, split into lines whatever the chunks", async () => {
    const sh = shell()
    const stdin = new ReadableStream<string>({
      start: (controller) => {
        for (const chunk of ["a\nb", "c\n", "\n", "d"]) controller.enqueue(chunk)
        controller.close()
      },
    })
    const seen: string[] = []
    sh.kernel.register(command("collect", async (p) => {
      for await (const line of p.lines()) seen.push(line)
      seen.push(p.stdio.stdin)
    }))
    expect(await sh.kernel.exec("collect", { stdin })).toBe(0)
    expect(seen).toEqual(["a", "bc", "", "d", "pipe"])
  })

  it("answers a syntax error with exit 2 and runs nothing", async () => {
    const sh = shell()
    expect(await sh.run("echo a; echo (")).toEqual({ code: 2, stdout: "", stderr: `rite: '(' is not supported in rite ${VERSION}\n` })
    expect(await sh.run("echo a &")).toEqual({
      code: 2, stdout: "",
      stderr: `rite: '&' is not supported in rite ${VERSION}; quote the argument if it is part of a URL\n`,
    })
    expect(sh.calls).toEqual([])
  })
})

describe("a process", () => {
  it.each([
    [() => Promise.resolve(), 0],
    [() => Promise.resolve(0), 0],
    [() => Promise.resolve(7), 7],
    [() => Promise.resolve(255), 255],
    [() => Promise.resolve(256), 255],
    [() => Promise.resolve(-1), 0],
    [() => Promise.resolve(3.7), 3],
    [() => Promise.resolve(Number.NaN), 1],
    [() => Promise.resolve(Number.POSITIVE_INFINITY), 255],
  ])("exits with what run returns, clamped: %s is %i", async (run, code) => {
    const sh = shell()
    sh.kernel.register(command("x", run))
    expect(await sh.run("x; echo $?")).toEqual({ code: 0, stdout: `${code}\n`, stderr: "" })
  })

  it.each([
    [new RiteError("ENOENT", "/some/path"), "x: /some/path: no such file or directory\n"],
    [new RiteError("EACCES"), "x: permission denied\n"],
    [new RiteError("EINVAL", "f", "bad thing"), "x: f: bad thing\n"],
    [new Error("boom"), "x: boom\n"],
    ["a string", "x: a string\n"],
  ])("exits 1 with one stderr line when run throws %s", async (thrown, stderr) => {
    const sh = shell()
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a command may throw anything
    sh.kernel.register(command("x", () => Promise.reject(thrown)))
    expect(await sh.run("x")).toEqual({ code: 1, stdout: "", stderr })
    // Named by how it was invoked, without the directory.
    expect((await sh.run("/bin/x")).stderr).toBe(stderr)
    expect((await sh.run("x 2>&1 | cat")).stdout).toBe(stderr)
  })

  it("reports a throw that is not a rejection", async () => {
    const sh = shell()
    sh.kernel.register(command("x", () => { throw new Error("sync") }))
    expect(await sh.run("x")).toEqual({ code: 1, stdout: "", stderr: "x: sync\n" })
  })

  it("has its argv, environment, directory, and identity", async () => {
    const sh = shell()
    const procs: Proc[] = []
    sh.kernel.register(command("x", (p) => {
      procs.push(p)
      return Promise.resolve()
    }))
    await sh.run("cd /tmp; export A=1; B=2; C=3 /bin/x  'a b' $A \"\" $NOPE")
    const [p] = procs
    expect(p?.argv).toEqual(["/bin/x", "a b", "1", ""])
    expect(p?.args).toEqual(["a b", "1", ""])
    expect(p?.flags).toEqual({})
    expect(p?.subcommand).toEqual([])
    expect(p?.cwd).toBe("/tmp")
    expect(p?.uid).toBe(1000)
    expect(p?.env).toMatchObject({ A: "1", C: "3", PWD: "/tmp", OLDPWD: "/home/guest", USER: "guest" })
    expect(p?.env).not.toHaveProperty("B")
    expect(Object.isFrozen(p?.env)).toBe(true)
    expect(p?.signal.aborted).toBe(false)
  })

  it("has stdout and stderr closed by the kernel when run settles", async () => {
    const sh = shell()
    const procs: Proc[] = []
    sh.kernel.register(command("x", async (p) => {
      procs.push(p)
      await p.out("during\n")
    }))
    await sh.run("x")
    const [p] = procs
    await expect(p?.out("after\n")).rejects.toMatchObject({ errno: "EPIPE" })
    await expect(p?.err("after\n")).rejects.toMatchObject({ errno: "EPIPE" })
    await expect(p?.stdout.getWriter().write("after\n")).rejects.toMatchObject({ errno: "EPIPE" })
    expect(sh.terminal).toEqual({ stdout: "during\n", stderr: "" })
  })

  it("can use its streams directly", async () => {
    const sh = shell()
    sh.kernel.register(command("x", async (p) => {
      const reader = p.stdin.getReader()
      const out = p.stdout.getWriter()
      const err = p.stderr.getWriter()
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        await out.write(next.value.toUpperCase())
        await err.write(String(next.value.length))
      }
      await p.out("")
    }))
    expect(await sh.run("echo hello | x")).toEqual({ code: 0, stdout: "HELLO\n", stderr: "6" })
  })

  it("has the terminal only when its stdout is the terminal", async () => {
    const tty: Tty = { cols: 80, rows: 24, read: () => Promise.resolve(null), raw: () => Promise.resolve() }
    const sh = shell({ tty })
    const seen: Array<Tty | null> = []
    sh.kernel.register(command("x", (p) => {
      seen.push(p.tty)
      return Promise.resolve()
    }))
    await sh.run("x; x | cat; x > /dev/null; x 2> /dev/null; echo | x; x >&2")
    await sh.kernel.exec("x", { stdout: collector().stream })
    expect(seen).toEqual([tty, null, null, tty, tty, tty, null])
  })

  it("sees the vfs with its own permissions", async () => {
    const sh = shell({ files: { "/home/guest/mine": "ok\n" } })
    expect(await sh.run("cat /root/secret")).toEqual({ code: 1, stdout: "", stderr: "cat: /root/secret: permission denied\n" })
    expect(await sh.run("ls /root")).toEqual({ code: 1, stdout: "", stderr: "ls: /root: permission denied\n" })
    expect((await sh.run("cat mine /home/guest/../guest/mine")).stdout).toBe("ok\nok\n")
    const tried: string[] = []
    sh.kernel.register(command("x", async (p) => {
      const attempt = (name: string, work: Promise<unknown>): Promise<void> => work.then(
        () => { tried.push(`${name} ok`) },
        (e: unknown) => { tried.push(`${name} ${e instanceof RiteError ? e.errno : "?"}`) },
      )
      await attempt("stat secret", p.fs.stat("/root/secret", "/"))
      await attempt("stat /root", p.fs.stat("/root", "/"))
      await attempt("write /root/x", p.fs.write("/root/x", "/", "", { mode: "truncate" }))
      await attempt("write /home/x", p.fs.write("/home/x", "/", "", { mode: "truncate" }))
      await attempt("mkdir /root/d", p.fs.mkdir("/root/d", "/"))
      await attempt("mkdir -p /opt/a/b", p.fs.mkdir("/opt/a/b", "/", { parents: true }))
      await attempt("remove /root/secret", p.fs.remove("/root/secret", "/"))
      await attempt("write /tmp/x", p.fs.write("/tmp/x", "/", "x", { mode: "truncate" }))
      await attempt("mkdir -p /tmp/a/b", p.fs.mkdir("/tmp/a/b", "/", { parents: true }))
      await attempt("remove /tmp/x", p.fs.remove("/tmp/x", "/"))
      await attempt("stat /none/x", p.fs.stat("/none/x", "/"))
      await attempt("read /tmp/a", p.fs.read("/tmp/a", "/"))
    }))
    await sh.run("x")
    expect(tried).toEqual([
      "stat secret EACCES", "stat /root ok", "write /root/x EACCES", "write /home/x EACCES", "mkdir /root/d EACCES",
      "mkdir -p /opt/a/b EACCES", "remove /root/secret EACCES", "write /tmp/x ok", "mkdir -p /tmp/a/b ok",
      "remove /tmp/x ok", "stat /none/x ENOENT", "read /tmp/a EISDIR",
    ])
  })
})

describe("the terminal's input", () => {
  function world() {
    const log: string[] = []
    let opened = 0
    const sh = shell({
      kernel: {
        stdin: () => {
          const id = ++opened
          log.push(`open ${id}`)
          const chunks = ["one\n", "two\n"]
          return new ReadableStream<string>({
            pull: (controller) => {
              const chunk = chunks.shift()
              if (chunk === undefined) controller.close()
              else controller.enqueue(chunk)
            },
            cancel: () => { log.push(`cancel ${id}`) },
          }, { highWaterMark: 0 })
        },
      },
    })
    return { ...sh, log }
  }

  it("is not asked for until a process reads", async () => {
    const sh = world()
    sh.kernel.register(command("kind", async (p) => { await p.out(p.stdio.stdin + "\n") }))
    expect((await sh.run("kind; echo hi; true | cat")).stdout).toBe("tty\nhi\n")
    expect(sh.log).toEqual([])
  })

  it("is a new stream for each process that reads, to its end", async () => {
    const sh = world()
    expect((await sh.run("cat; cat | grep two")).stdout).toBe("one\ntwo\ntwo\n")
    expect(sh.log).toEqual(["open 1", "open 2"])
  })

  it("is cancelled when the process leaves before the end", async () => {
    const sh = world()
    sh.kernel.register(command("first", async (p) => {
      for await (const line of p.lines()) {
        await p.out(line + "\n")
        break
      }
    }))
    expect((await sh.run("first")).stdout).toBe("one\n")
    expect(sh.log).toEqual(["open 1", "cancel 1"])
  })
})

describe("command resolution", () => {
  it.each([
    ["nosuch", 127, "rite: command not found: nosuch\n"],
    ["/bin/nosuch", 127, "rite: command not found: /bin/nosuch\n"],
    ["./nosuch", 127, "rite: command not found: ./nosuch\n"],
    ["''", 127, "rite: command not found: \n"],
    ["/tmp", 126, "rite: /tmp: is a directory\n"],
    ["./notes", 126, "rite: ./notes: permission denied\n"],
    ["locked", 126, "rite: locked: permission denied\n"],
    ["/bin/locked", 126, "rite: /bin/locked: permission denied\n"],
    ["orphan", 126, "rite: orphan: operation not supported\n"],
  ])("%s", async (line, code, stderr) => {
    const sh = shell({ files: { "/home/guest/notes": "" } })
    const def = command("locked", () => Promise.resolve())
    sh.kernel.register(def)
    sh.vfs.put("/bin/locked", { type: "cmd", command: def, mode: 0o700 })
    // A cmd inode the kernel was never given the definition of.
    sh.vfs.put("/bin/orphan", { type: "cmd", command: command("orphan", () => Promise.resolve()) })
    expect(await sh.run(line)).toEqual({ code, stdout: "", stderr })
  })

  it("finds commands on PATH, in its order, and by path", async () => {
    const sh = shell()
    const say = (name: string, text: string, at?: string): void => {
      sh.kernel.register(command(name, async (p) => { await p.out(`${text} as ${p.argv[0] ?? ""}\n`) }), at)
    }
    say("x", "bin")
    say("x", "usr", "/usr/bin")
    say("y", "usr", "/usr/bin")
    say("z", "opt", "/opt/bin")
    expect((await sh.run("x; y; /usr/bin/x; cd /usr; bin/x; ./bin/y; cd bin; ./x")).stdout)
      .toBe("bin as x\nusr as y\nusr as /usr/bin/x\nusr as bin/x\nusr as ./bin/y\nusr as ./x\n")
    expect((await sh.run("z")).code).toBe(127)
    expect((await sh.run("/opt/bin/z; PATH=$PATH:/opt/bin; z; PATH=/usr/bin:/bin; x")).stdout)
      .toBe("opt as /opt/bin/z\nopt as z\nusr as x\n")
    // A relative PATH entry is relative to the working directory.
    expect((await sh.run("cd /opt; PATH=bin; z")).stdout).toBe("opt as z\n")
  })

  it("runs a link to a command under the link's name", async () => {
    const sh = shell()
    sh.vfs.put("/usr/bin/say", { type: "link", target: "/bin/echo" })
    expect((await sh.run("say hi")).stdout).toBe("hi\n")
    expect(sh.calls).toEqual([["say", "hi"]])
  })

  it("forgets a command whose inode is gone", async () => {
    const sh = shell()
    await sh.vfs.remove("/bin/echo", "/")
    expect((await sh.run("echo hi")).code).toBe(127)
  })

  it("prefers a builtin to a command of the same name, except by path", async () => {
    const sh = shell()
    sh.kernel.register(command("cd", async (p) => { await p.out("the command\n") }))
    expect((await sh.run("cd /tmp; pwd; /bin/cd")).stdout).toBe("/tmp\nthe command\n")
  })
})

describe("command sources", () => {
  function world() {
    const sh = shell()
    const runs: Array<{ name: string; argv: readonly string[]; flags: unknown; stdin: string }> = []
    const infos: Record<string, CommandInfo> = {
      mdm: {
        name: "mdm", summary: "manage devices", usage: "mdm <command>", builtin: false, remote: true,
        flags: { json: { type: "boolean", description: "print JSON" } },
        subcommands: { devices: { summary: "device commands", usage: "mdm devices ls" } },
      },
    }
    const source: CommandSource = {
      names: () => ["mdm", "late", "echo"],
      info: (name) => infos[name],
      run: async (name, p) => {
        runs.push({ name, argv: p.argv, flags: p.flags, stdin: p.stdio.stdin })
        if (name === "late") return 255
        await p.out(`remote ${name}\n`)
        return 0
      },
    }
    sh.vfs.put("/sandbox", { type: "dir" })
    sh.kernel.addCommandSource("/sandbox/bin", source)
    return { ...sh, runs }
  }

  it("supply commands after PATH, with argv left for the server to parse", async () => {
    const sh = world()
    expect(await sh.run("echo a | mdm devices ls --json -x; echo hi")).toEqual({ code: 0, stdout: "remote mdm\nhi\n", stderr: "" })
    expect(sh.runs).toEqual([{ name: "mdm", argv: ["mdm", "devices", "ls", "--json", "-x"], flags: {}, stdin: "pipe" }])
    // The local echo ran: a source never replaces a name on PATH.
    expect(sh.calls).toEqual([["echo", "a"], ["echo", "hi"]])
  })

  it("run by path at the directory the host chose", async () => {
    const sh = world()
    expect((await sh.run("/sandbox/bin/mdm; /sandbox/bin/echo; cd /sandbox; bin/mdm")).stdout)
      .toBe("remote mdm\nremote echo\nremote mdm\n")
    expect((await sh.run("/sandbox/bin/nope")).code).toBe(127)
    expect((await sh.run("/elsewhere/mdm")).code).toBe(127)
    expect(sh.runs.map((run) => run.name)).toEqual(["mdm", "echo", "mdm"])
  })

  it("pass their exit code through", async () => {
    const sh = world()
    expect((await sh.run("late; echo $?")).stdout).toBe("255\n")
  })

  it("answer --help from the descriptor, when there is one", async () => {
    const sh = world()
    expect((await sh.run("mdm --help")).stdout).toBe([
      "usage: mdm <command>", "", "manage devices", "",
      "options:", "      --json  print JSON", "      --help  show this help", "",
      "commands:", "  devices  device commands", "",
    ].join("\n"))
    expect((await sh.run("mdm devices --help | cat")).stdout).toBe([
      "usage: mdm devices ls", "", "device commands", "", "options:", "      --help  show this help", "",
    ].join("\n"))
    expect(sh.runs).toEqual([])
    // No descriptor yet, or --help after `--`: the server's to answer.
    await sh.run("late --help; mdm -- --help")
    expect(sh.runs.map((run) => run.argv)).toEqual([["late", "--help"], ["mdm", "--", "--help"]])
  })
})

describe("sys", () => {
  function world(options: Parameters<typeof shell>[0] = {}) {
    const sh = shell(options)
    const procs: Proc[] = []
    sh.kernel.register(command("grab", (p) => {
      procs.push(p)
      return Promise.resolve()
    }))
    sh.kernel.register(command("as", async (p) => {
      const [uid, ...argv] = p.args
      return p.sys.spawn(argv, { uid: Number(uid) })
    }))
    sh.kernel.register(command("sh", (p) => p.sys.run(p.args[0] ?? "", { env: { VIA: "run" } })))
    const sys = async (): Promise<Proc["sys"]> => {
      await sh.run("grab")
      const p = procs.at(-1)
      if (p === undefined) throw new Error("grab did not run")
      return p.sys
    }
    return { ...sh, sys }
  }

  it("resolves a name the way the shell would", async () => {
    const sh = world()
    sh.kernel.registerEgg({ id: "sudoers", trigger: { command: "sudo" }, run: () => Promise.resolve(PASS) })
    sh.kernel.registerEgg({ id: "quiet", trigger: { command: "echo" }, run: () => Promise.resolve(PASS) })
    sh.kernel.addCommandSource("/sandbox/bin", { names: () => ["mdm"], info: () => undefined, run: () => Promise.resolve(0) })
    await sh.run("alias ll='ls -l'")
    const sys = await sh.sys()
    const kinds = (names: string[]): Array<Resolution["kind"]> => names.map((name) => sys.resolve(name).kind)
    expect(kinds(["ll", "cd", "echo", "/bin/echo", "mdm", "sudo", "nosuch", "/tmp", "constructor"]))
      .toEqual(["alias", "builtin", "command", "command", "command", "egg", "not-found", "not-found", "not-found"])
    expect(sys.resolve("ll")).toEqual({ kind: "alias", name: "ll", body: "ls -l" })
    expect(sys.resolve("cd")).toMatchObject({ info: { name: "cd", builtin: true, remote: false, usage: "cd [dir | -]" } })
    expect(sys.resolve("echo")).toMatchObject({ path: "/bin/echo", info: { name: "echo", builtin: false, remote: false } })
    expect(sys.resolve("mdm")).toMatchObject({ path: "/sandbox/bin/mdm", info: { name: "mdm", remote: true } })
    expect(sys.resolve("sudo")).toEqual({ kind: "egg", name: "sudo", id: "sudoers" })
  })

  it("lists every command once, by name", async () => {
    const sh = world()
    sh.kernel.addCommandSource("/sandbox/bin", { names: () => ["mdm", "echo"], info: () => undefined, run: () => Promise.resolve(0) })
    const names = (await sh.sys()).commands().map((info) => `${info.name}${info.builtin ? "*" : ""}${info.remote ? "@" : ""}`)
    expect(names).toEqual([
      "alias*", "as", "cat", "cd*", "echo", "env", "exit*", "export*", "false", "grab", "grep", "history*", "ls",
      "mdm@", "pwd", "rite*", "sh", "source*", "true", "unalias*", "unset*", "whoami",
    ])
  })

  it("shows the session, the sudo policy, and the history", async () => {
    const policy = (password: string): boolean => password === "hunter2"
    const sh = world({ kernel: { sudo: policy } })
    sh.kernel.register(command("status", async (p) => { await p.out(`${p.sys.session.lastStatus}\n`) }))
    expect((await sh.run("cd /tmp; false; status")).stdout).toBe("1\n")
    const sys = await sh.sys()
    // The view is live: it shows the session as it is now.
    expect(sys.session).toMatchObject({ user: "guest", uid: 1000, cwd: "/tmp", hostname: "enroll", home: "/home/guest", lastStatus: 0 })
    expect(sys.sudo).toBe(policy)
    expect(sys.history()).toEqual(["cd /tmp; false; status", "grab"])
    expect((await world().sys()).sudo).toBe(false)
  })

  it("spawns argv as a child, on the caller's streams, as the uid asked", async () => {
    const sh = world()
    expect(await sh.run("as 0 whoami; as 0 cat /root/secret; as 1000 cat /root/secret")).toEqual({
      code: 1, stdout: "root\ns3cret\n", stderr: "cat: /root/secret: permission denied\n",
    })
    expect(await sh.run("as 0 env | grep '^UID='; echo $UID; whoami")).toEqual({ code: 0, stdout: "UID=0\n1000\nguest\n", stderr: "" })
    expect(await sh.run("echo piped | as 0 cat > /tmp/o; cat /tmp/o")).toEqual({ code: 0, stdout: "piped\n", stderr: "" })
    expect(await sh.run("as 0 nosuch; as 0 false; echo $?")).toEqual({
      code: 0, stdout: "1\n", stderr: "rite: command not found: nosuch\n",
    })
  })

  it("spawns with the exported environment, without aliases, and through command eggs", async () => {
    const sh = world()
    sh.kernel.registerEgg({ id: "rmrf", trigger: { command: "rm" }, run: async (p) => { await p.out("just kidding.\n") } })
    await sh.run("alias whoami='echo aliased'; export A=1; B=2")
    expect((await sh.run("C=3 as 1000 env | grep '^[ABC]='; as 0 whoami; as 0 rm -rf /; as 0 cd /tmp; pwd")).stdout)
      .toBe("A=1\nC=3\nroot\njust kidding.\n/home/guest\n")
  })

  it("spawns onto streams of the caller's choosing", async () => {
    const sh = world()
    const captured = collector()
    sh.kernel.register(command("capture", async (p) => {
      const code = await p.sys.spawn(["cat", "-"], {
        env: { EXTRA: "1" },
        stdio: {
          stdin: new ReadableStream<string>({
            start: (controller) => {
              controller.enqueue("fed\n")
              controller.close()
            },
          }),
          stdout: captured.stream,
        },
      })
      await p.out(`child exited ${code}\n`)
    }))
    sh.kernel.registerEgg({ id: "stdin", trigger: { command: "cat", when: (argv) => argv[1] === "-" }, run: async (p) => {
      for await (const line of p.lines()) await p.out(`${line} ${p.env.EXTRA ?? ""} ${p.stdio.stdin}>${p.stdio.stdout}\n`)
    } })
    expect((await sh.run("capture")).stdout).toBe("child exited 0\n")
    expect(captured.text()).toBe("fed 1 pipe>pipe\n")
  })

  it("runs a line in a child session", async () => {
    const sh = world()
    expect(await sh.run("X=1; sh 'echo $X $VIA; cd /tmp; X=2; alias a=b; pwd; false'; echo $? $X \"[$VIA]\"; pwd; alias")).toEqual({
      code: 0, stdout: "1 run\n/tmp\n1 1 []\n/home/guest\n", stderr: "",
    })
    expect((await sh.run("sh 'echo out; echo err >&2' 2>&1 | cat")).stdout).toBe("out\nerr\n")
  })
})
