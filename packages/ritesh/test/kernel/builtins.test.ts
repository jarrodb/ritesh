import { describe, expect, it } from "vitest"
import type { ActionEvent } from "../../src/contracts.js"
import { command, shell, VERSION } from "./support.js"

describe("cd", () => {
  it.each([
    ["cd /tmp; pwd; echo $PWD $OLDPWD", "/tmp\n/tmp /home/guest\n"],
    ["cd /tmp; cd; pwd", "/home/guest\n"],
    ["cd /; cd ~; pwd", "/home/guest\n"],
    ["cd /; cd ~/docs; pwd", "/home/guest/docs\n"],
    ["cd /; cd tmp; pwd", "/tmp\n"],
    ["cd ..; pwd; cd ../..; pwd", "/home\n/\n"],
    ["cd docs/../docs/.; pwd", "/home/guest/docs\n"],
    ["cd /tmp; cd -; pwd", "/home/guest\n/home/guest\n"],
    ["cd /tmp; cd /; cd -; cd -", "/tmp\n/\n"],
    ["HOME=/tmp; cd; pwd", "/tmp\n"],
    ["cd /tmp/link; pwd", "/tmp/link\n"],
    ["cd -- /tmp; pwd", "/tmp\n"],
  ])("%s", async (line, stdout) => {
    const sh = shell({ files: { "/home/guest/docs/a.txt": "" } })
    sh.vfs.put("/tmp/link", { type: "link", target: "/home/guest/docs" })
    expect(await sh.run(line)).toEqual({ code: 0, stdout, stderr: "" })
  })

  it.each([
    ["cd /none", 1, "rite: cd: /none: no such file or directory\n"],
    ["cd notes.txt", 1, "rite: cd: notes.txt: not a directory\n"],
    ["cd notes.txt/x", 1, "rite: cd: notes.txt/x: not a directory\n"],
    ["cd /root", 1, "rite: cd: /root: permission denied\n"],
    ["cd /root/secret", 1, "rite: cd: /root/secret: permission denied\n"],
    ["cd /tmp /root", 1, "rite: cd: too many arguments\n"],
    ["cd -x", 2, "rite: cd: unknown option: -x\nusage: cd [dir | -]\n"],
  ])("%s", async (line, code, stderr) => {
    const sh = shell({ files: { "/home/guest/notes.txt": "" } })
    expect(await sh.run(line)).toEqual({ code, stdout: "", stderr })
    expect(sh.kernel.session.cwd).toBe("/home/guest")
    expect((await sh.run("echo $PWD $OLDPWD")).stdout).toBe("/home/guest /home/guest\n")
  })

  it("prints its help from the definition", async () => {
    const sh = shell()
    expect(await sh.run("cd --help")).toEqual({
      code: 0,
      stdout: "usage: cd [dir | -]\n\nchange the working directory\n\noptions:\n      --help  show this help\n",
      stderr: "",
    })
  })
})

describe("actions", () => {
  /** A shell with one action of each kind, and a log of what the host was told in order. */
  function world(prevent: boolean, opens = true) {
    const log: string[] = []
    const events: ActionEvent[] = []
    const sh = shell({
      kernel: {
        onAction: (event) => {
          events.push(event)
          log.push(`action ${event.kind} ${event.path} via ${event.via}`)
          if (prevent) event.preventDefault()
        },
        openUrl: (url) => {
          log.push(`open ${url}`)
          return opens
        },
      },
    })
    sh.vfs.put("/go/docs", { type: "action", action: { navigate: "/docs" } })
    sh.vfs.put("/go/site", { type: "action", action: { open: "https://example.com/" } })
    sh.vfs.put("/go/ping", { type: "action", action: { event: "ping", detail: { n: 1 } } })
    sh.vfs.put("/go/note", { type: "action", action: { print: "a note" } })
    sh.vfs.put("/go/alias", { type: "link", target: "/go/docs" })
    return { ...sh, log, events }
  }

  it("tells the host about a navigate action and stays where it is", async () => {
    const sh = world(false)
    expect(await sh.run("cd /go/docs; pwd")).toEqual({ code: 0, stdout: "/home/guest\n", stderr: "" })
    expect(sh.log).toEqual(["action navigate /go/docs via cd"])
    expect(sh.events[0]).toMatchObject({ kind: "navigate", href: "/docs", path: "/go/docs", via: "cd" })
  })

  it("follows a link to an action", async () => {
    const sh = world(false)
    expect((await sh.run("cd /go/alias")).code).toBe(0)
    expect(sh.log).toEqual(["action navigate /go/docs via cd"])
  })

  it("opens an open action's URL after the host heard of it", async () => {
    const sh = world(false)
    expect(await sh.run("cd /go/site")).toEqual({ code: 0, stdout: "", stderr: "" })
    expect(sh.log).toEqual(["action open /go/site via cd", "open https://example.com/"])
    expect(sh.events[0]).toMatchObject({ kind: "open", url: "https://example.com/" })
  })

  it("does not open the URL when the host prevents it", async () => {
    const sh = world(true)
    expect(await sh.run("cd /go/site")).toEqual({ code: 0, stdout: "", stderr: "" })
    expect(sh.log).toEqual(["action open /go/site via cd"])
  })

  it("prints the URL when the browser refuses to open it", async () => {
    const sh = world(false, false)
    expect(await sh.run("cd /go/site")).toEqual({ code: 0, stdout: "https://example.com/\n", stderr: "" })
    expect(sh.log).toEqual(["action open /go/site via cd", "open https://example.com/"])
  })

  it("only tells the host about an event action", async () => {
    const sh = world(false)
    expect(await sh.run("cd /go/ping")).toEqual({ code: 0, stdout: "", stderr: "" })
    expect(sh.log).toEqual(["action event /go/ping via cd"])
    expect(sh.events[0]).toMatchObject({ kind: "event", name: "ping", detail: { n: 1 } })
  })

  it("prints a print action's text, unless the host prevents it", async () => {
    expect(await world(false).run("cd /go/note")).toEqual({ code: 0, stdout: "a note\n", stderr: "" })
    const sh = world(true)
    expect(await sh.run("cd /go/note")).toEqual({ code: 0, stdout: "", stderr: "" })
    expect(sh.log).toEqual(["action print /go/note via cd"])
  })

  it("is not triggered by listing, and not by a cd that fails", async () => {
    const sh = world(false)
    expect((await sh.run("ls /go")).stdout).toBe("alias\ndocs\nnote\nping\nsite\n")
    expect((await sh.run("cd /go/docs/deeper")).code).toBe(1)
    expect(sh.log).toEqual([])
  })

  it("handles an action a command activates the same way", async () => {
    const sh = world(false, false)
    sh.kernel.register(command("open", async (p) => {
      const result = await p.fs.activate(p.args[0] ?? "", p.cwd, "open")
      if (result?.output !== undefined) await p.out(result.output + "\n")
      return result === null ? 1 : 0
    }))
    expect(await sh.run("open /go/site")).toEqual({ code: 0, stdout: "https://example.com/\n", stderr: "" })
    expect(sh.log).toEqual(["action open /go/site via open", "open https://example.com/"])
    expect((await sh.run("open /tmp")).code).toBe(1)
  })
})

describe("export and unset", () => {
  it.each([
    ["X=1; env | grep '^X='", 1, ""],
    ["X=1; export X; env | grep '^X='", 0, "X=1\n"],
    ["export X; X=1; env | grep '^X='", 0, "X=1\n"],
    ["export X=1 Y='a b'; env | grep '^[XY]='", 0, "X=1\nY=a b\n"],
    ["export X=1; X=2; env | grep '^X='", 0, "X=2\n"],
    ["export X=a=b; echo $X", 0, "a=b\n"],
    ["export X=1; unset X; env | grep '^X='; echo \"[$X]\"", 0, "[]\n"],
    ["X=1; Y=2; unset X Y NOPE; echo \"[$X$Y]\"", 0, "[]\n"],
    ["export X=1 | cat; export | grep X", 1, ""],
    ["export X=\"it's\"; export | grep X", 0, "export X='it'\\''s'\n"],
  ])("%s", async (line, code, stdout) => {
    expect(await shell().run(line)).toEqual({ code, stdout, stderr: "" })
  })

  it("lists the exported variables, sorted", async () => {
    const { stdout } = await shell().run("export ZED=1; export")
    expect(stdout.split("\n").filter(Boolean)).toEqual([
      "export HOME='/home/guest'", "export HOSTNAME='enroll'", "export OLDPWD='/home/guest'",
      "export PATH='/bin:/usr/bin'", "export PWD='/home/guest'", `export RITE_VERSION='${VERSION}'`,
      "export SHELL='/bin/rite'", "export UID='1000'", "export USER='guest'", "export ZED='1'",
    ])
  })

  it.each([
    ["export 1x=2", "rite: export: 1x=2: not a valid identifier\n"],
    ["export a-b", "rite: export: a-b: not a valid identifier\n"],
    ["export UID=0", "rite: export: UID: read-only variable\n"],
    ["unset SHELL", "rite: unset: SHELL: read-only variable\n"],
    ["UID=0", "rite: UID: read-only variable\n"],
    ["RITE_VERSION=9 echo hi", "rite: RITE_VERSION: read-only variable\n"],
    ["X=1 SHELL=/bin/sh", "rite: SHELL: read-only variable\n"],
  ])("%s", async (line, stderr) => {
    const sh = shell()
    expect(await sh.run(line)).toEqual({ code: 1, stdout: "", stderr })
    expect(sh.calls).toEqual([])
    expect((await sh.run("echo $UID $SHELL $RITE_VERSION \"[$X]\"")).stdout).toBe(`1000 /bin/rite ${VERSION} []\n`)
  })

  it("carries on past a bad name", async () => {
    expect(await shell().run("export 1x A=1; echo $A")).toEqual({
      code: 0, stdout: "1\n", stderr: "rite: export: 1x: not a valid identifier\n",
    })
  })
})

describe("alias and unalias", () => {
  it.each([
    ["alias", 0, "", ""],
    ["alias b=2 a='1 1'; alias", 0, "a='1 1'\nb='2'\n", ""],
    ["alias ll='ls -l'; alias ll", 0, "ll='ls -l'\n", ""],
    ["alias q=\"it's\"; alias q", 0, "q='it'\\''s'\n", ""],
    ["alias e=; alias e", 0, "e=''\n", ""],
    ["alias nope", 1, "", "rite: alias: nope: not found\n"],
    ["alias 'a b=c'", 1, "", "rite: alias: a b: invalid alias name\n"],
    ["alias a=b; unalias a; alias", 0, "", ""],
    ["alias a=b c=d; unalias -a; alias", 0, "", ""],
    ["unalias nope", 1, "", "rite: unalias: nope: not found\n"],
    ["alias ..='cd ..'; ..; pwd", 0, "/home\n", ""],
    ["alias a=echo; unalias a; a hi", 127, "", "rite: command not found: a\n"],
    ["alias e=echo; 'e' hi", 127, "", "rite: command not found: e\n"],
    ["alias a='echo 1' b='echo 2'; a; b", 0, "1\n2\n", ""],
    ["alias a=b; alias a=echo; a hi", 0, "hi\n", ""],
    ["alias a='echo x |'; a cat", 0, "x\n", ""],
    ["alias p=pwd; cd /tmp && p || echo no", 0, "/tmp\n", ""],
  ])("%s", async (line, code, stdout, stderr) => {
    expect(await shell().run(line)).toEqual({ code, stdout, stderr })
  })

  it("expands on later lines", async () => {
    const sh = shell()
    await sh.run("alias hi='echo hello'")
    expect((await sh.run("hi there; hi | cat")).stdout).toBe("hello there\nhello\n")
  })

  it("reports a body that no longer parses when it is used on the same line", async () => {
    const sh = shell()
    expect(await sh.run("echo a; alias bad='echo ('; bad; echo unreachable")).toEqual({
      code: 2, stdout: "a\n", stderr: `rite: '(' is not supported in rite ${VERSION}\n`,
    })
    expect((await sh.run("echo $?")).stdout).toBe("2\n")
  })

  it("takes an alias defined inside an alias body from the next line on", async () => {
    const sh = shell()
    await sh.run("alias setup='alias x=echo; x'")
    // The body was parsed whole before `alias x=echo` ran.
    expect(await sh.run("setup hi; x same line")).toEqual({
      code: 0, stdout: "same line\n", stderr: "rite: command not found: x\n",
    })
    expect((await sh.run("x next")).stdout).toBe("next\n")
  })
})

describe("exit", () => {
  it.each([
    ["exit", 0, 0],
    ["exit 3", 3, 3],
    ["false; exit", 1, 1],
    ["exit 300", 255, 255],
    ["exit -1", 0, 0],
    ["exit 3; echo unreachable", 3, 3],
    ["true && exit 4 || echo unreachable", 4, 4],
  ])("%s", async (line, code, requested) => {
    const exits: number[] = []
    const sh = shell({ kernel: { onExit: (status) => { exits.push(status) } } })
    expect(await sh.run(line)).toEqual({ code, stdout: "", stderr: "" })
    expect(sh.kernel.exitRequested).toBe(requested)
    expect(exits).toEqual([requested])
    // The next line starts clean.
    expect((await sh.run("echo on")).stdout).toBe("on\n")
    expect(sh.kernel.exitRequested).toBeNull()
    expect(exits).toEqual([requested])
  })

  it("rejects a status that is not a number, and exits 2", async () => {
    const sh = shell()
    expect(await sh.run("exit abc")).toEqual({ code: 2, stdout: "", stderr: "rite: exit: abc: numeric argument required\n" })
    expect(sh.kernel.exitRequested).toBe(2)
  })

  it("ends only the child session of rite -c", async () => {
    const sh = shell()
    expect(await sh.run("rite -c 'exit 4; echo unreachable'; echo $?")).toEqual({ code: 0, stdout: "4\n", stderr: "" })
    expect(sh.kernel.exitRequested).toBeNull()
  })
})

describe("history", () => {
  it("numbers the lines given to exec, without blank ones or ones that start with a space", async () => {
    const sh = shell()
    await sh.run("echo a")
    await sh.run(" echo secret")
    await sh.run("")
    await sh.run("nosuch")
    expect((await sh.run("history")).stdout).toBe("    1  echo a\n    2  nosuch\n    3  history\n")
  })

  it("lists the editor's history when the host supplies it", async () => {
    const sh = shell({ kernel: { history: () => ["one", "two"] } })
    expect((await sh.run("history | cat")).stdout).toBe("    1  one\n    2  two\n")
  })
})

describe("source", () => {
  const RC = [
    "# a comment",
    "",
    "alias hi='echo hello'",
    "hi from rc",
    "export GREETING=\"two",
    "lines\"",
    "cd /tmp &&",
    "  X=1",
    "false",
  ].join("\n") + "\n"

  it("runs a file line by line in the session", async () => {
    const sh = shell({ files: { "/home/guest/rc": RC } })
    // The status is the last line's.
    expect(await sh.run("source rc")).toEqual({ code: 1, stdout: "hello from rc\n", stderr: "" })
    expect(await sh.run("pwd; echo $X; hi; echo \"$GREETING\"")).toEqual({
      code: 0, stdout: "/tmp\n1\nhello\ntwo\nlines\n", stderr: "",
    })
  })

  it("keeps nothing when it runs in a pipeline", async () => {
    const sh = shell({ files: { "/home/guest/rc": RC } })
    expect(await sh.run("source rc | cat; pwd; alias; echo \"[$X]\"")).toEqual({
      code: 0, stdout: "hello from rc\n/home/guest\n[]\n", stderr: "",
    })
  })

  it("reports a syntax error and goes on to the next line", async () => {
    const sh = shell({ files: { "/tmp/rc": "echo a\necho (\necho b\n" } })
    expect(await sh.run("source /tmp/rc")).toEqual({
      code: 0, stdout: "a\nb\n", stderr: `rite: '(' is not supported in rite ${VERSION}\n`,
    })
  })

  it("stops at exit, which ends the session", async () => {
    const sh = shell({ files: { "/tmp/rc": "echo a\nexit 7\necho b\n" } })
    expect(await sh.run("source /tmp/rc; echo unreachable")).toEqual({ code: 7, stdout: "a\n", stderr: "" })
    expect(sh.kernel.exitRequested).toBe(7)
  })

  it.each([
    ["source", 2, "rite: source: missing file\nusage: source file\n"],
    ["source /none", 1, "rite: source: /none: no such file or directory\n"],
    ["source /tmp", 1, "rite: source: /tmp: is a directory\n"],
    ["source /root/secret", 1, "rite: source: /root/secret: permission denied\n"],
  ])("%s", async (line, code, stderr) => {
    expect(await shell().run(line)).toEqual({ code, stdout: "", stderr })
  })

  it("stops a file that sources itself", async () => {
    const sh = shell({ files: { "/tmp/loop": "echo in\nsource /tmp/loop\n" } })
    const result = await sh.run("source /tmp/loop")
    expect(result.code).toBe(1)
    expect(result.stderr).toBe("rite: source: maximum nesting depth exceeded\n")
    expect(result.stdout.split("\n").filter(Boolean).length).toBeLessThan(40)
  })
})

describe("rite", () => {
  it.each([
    ["rite --version", 0, `rite ${VERSION}\n`, ""],
    ["rite -c 'echo hi | cat'", 0, "hi\n", ""],
    ["rite -c false; echo $?", 0, "1\n", ""],
    ["rite -c 'cd /tmp; X=1; alias a=b; pwd'; pwd; echo \"[$X]\"; alias", 0, "/tmp\n/home/guest\n[]\n", ""],
    ["X=1; alias hi='echo hello'; rite -c 'hi $X'", 0, "hello 1\n", ""],
    ["Y=2 rite -c 'env | grep ^Y='", 0, "Y=2\n", ""],
    ["rite -c 'echo out; echo err >&2' > /tmp/o 2> /tmp/e; cat /tmp/o /tmp/e", 0, "out\nerr\n", ""],
    ["rite -c 'echo ('", 2, "", `rite: '(' is not supported in rite ${VERSION}\n`],
    ["rite -c \"rite -c 'echo deep'\"", 0, "deep\n", ""],
    ["rite", 2, "", "rite: rite: interactive child shells are not supported\nusage: rite --version | rite -c line\n"],
    ["rite -c", 2, "", "rite: rite: option requires an argument: -c\nusage: rite --version | rite -c line\n"],
  ])("%s", async (line, code, stdout, stderr) => {
    expect(await shell().run(line)).toEqual({ code, stdout, stderr })
  })
})

describe(".riterc", () => {
  it("is sourced by init", async () => {
    const sh = shell({ files: { "/home/guest/.riterc": "alias ll='ls -l'\nexport EDITOR=vi\nPROMPT='%n@%m'\n" } })
    await sh.kernel.init()
    expect(await sh.run("alias; env | grep EDITOR")).toEqual({ code: 0, stdout: "ll='ls -l'\nEDITOR=vi\n", stderr: "" })
    expect(sh.kernel.getenv("PROMPT")).toBe("%n@%m")
    expect(sh.kernel.getenv("constructor")).toBeUndefined()
  })

  it("is optional", async () => {
    const sh = shell()
    await sh.kernel.init()
    expect(sh.terminal).toEqual({ stdout: "", stderr: "" })
  })

  it("runs before the lines queued behind it", async () => {
    const sh = shell({ files: { "/home/guest/.riterc": "alias hi='echo hello'\n" } })
    const ready = sh.kernel.init()
    const first = sh.run("hi")
    await ready
    expect((await first).stdout).toBe("hello\n")
  })

  it("reports what fails in it and goes on", async () => {
    const sh = shell({ files: { "/home/guest/.riterc": "nosuch\nX=1\n" } })
    await sh.kernel.init()
    expect(sh.terminal).toEqual({ stdout: "", stderr: "rite: command not found: nosuch\n" })
    expect(sh.kernel.getenv("X")).toBe("1")
  })
})
