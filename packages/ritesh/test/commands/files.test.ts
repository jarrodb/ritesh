import { describe, expect, it } from "vitest"
import { type ActionVia, RiteError } from "../../src/contracts.js"
import { ls, mkdir, open, pwd, rm, touch } from "../../src/commands/index.js"
import { fakeTty, HOME, run, T0, world } from "./support.js"

/** T0 in local time, by a formatter the commands do not use. */
const WHEN = new Date(T0).toLocaleString("sv-SE").slice(0, 16)

describe("pwd", () => {
  it("prints the working directory", async () => {
    expect(await run(pwd, [], { cwd: "/tmp" })).toEqual({ code: 0, stdout: "/tmp\n", stderr: "" })
  })
})

describe("ls", () => {
  it("lists the working directory one name per line when stdout is not the terminal", async () => {
    expect(await run(ls)).toEqual({ code: 0, stdout: "docs\ngo\nhello\nlatest\nnotes.txt\nsite\n", stderr: "" })
  })

  it("includes dot names with -a", async () => {
    expect((await run(ls, ["-a"])).stdout).toBe(".riterc\ndocs\ngo\nhello\nlatest\nnotes.txt\nsite\n")
    expect((await run(ls, ["--all", "docs"])).stdout).toBe("a.txt\n")
  })

  it("marks directories, commands, and links only with -F", async () => {
    const fs = world()
    fs.put(`${HOME}/tool`, { type: "cmd", command: pwd })
    expect((await run(ls, ["-F"], { fs })).stdout).toBe("docs/\ngo\nhello\nlatest@\nnotes.txt\nsite\ntool*\n")
    expect((await run(ls, ["--classify", "/home", "notes.txt"], { fs })).stdout).toBe("notes.txt\n\n/home:\nguest/\n")
  })

  it("sorts by code point", async () => {
    const fs = world()
    for (const name of ["b", "B", "a", "é", "10", "9"]) fs.put(`/tmp/${name}`, { type: "file", content: "" })
    expect((await run(ls, ["/tmp"], { fs })).stdout).toBe("10\n9\nB\na\nb\né\n")
  })

  it("lays names out down the columns on the terminal", async () => {
    expect((await run(ls, [], { tty: fakeTty({ cols: 80 }) })).stdout).toBe("docs       go         hello      latest     notes.txt  site\n")
    expect((await run(ls, [], { tty: fakeTty({ cols: 30 }) })).stdout).toBe("docs       latest\ngo         notes.txt\nhello      site\n")
    expect((await run(ls, [], { tty: fakeTty({ cols: 4 }) })).stdout).toBe("docs\ngo\nhello\nlatest\nnotes.txt\nsite\n")
  })

  it("prints one name per line on the terminal with -1", async () => {
    expect((await run(ls, ["-1", "docs", "/etc"], { tty: fakeTty() })).stdout).toBe("docs:\na.txt\n\n/etc:\nmotd\n")
  })

  it("prints nothing for an empty directory", async () => {
    expect(await run(ls, ["/bin"], { tty: fakeTty() })).toEqual({ code: 0, stdout: "", stderr: "" })
  })

  it("prints mode, owner, size, time, and name with -l", async () => {
    expect((await run(ls, ["-l"])).stdout).toBe([
      `drwxr-xr-x guest  0 ${WHEN} docs`,
      `arwxr-xr-x guest  0 ${WHEN} go`,
      `arwxr-xr-x guest  0 ${WHEN} hello`,
      `lrwxr-xr-x guest  0 ${WHEN} latest`,
      `-rw-r--r-- guest 17 ${WHEN} notes.txt`,
      `arwxr-xr-x guest  0 ${WHEN} site`,
      "",
    ].join("\n"))
  })

  it("names root, the session user, and other uids in the owner column", async () => {
    const fs = world()
    fs.put("/tmp/theirs", { type: "file", content: "x", uid: 42 })
    fs.put("/tmp/mine", { type: "file", content: "xy", mode: 0o600 })
    fs.put("/tmp/null", { type: "dev" })
    expect((await run(ls, ["-la", "/"], { fs })).stdout).toBe([
      `drwxr-xr-x root 0 ${WHEN} bin`,
      `drwxr-xr-x root 0 ${WHEN} etc`,
      `drwxr-xr-x root 0 ${WHEN} home`,
      `drwxrwxrwx root 0 ${WHEN} tmp`,
      `drwxr-xr-x root 0 ${WHEN} usr`,
      "",
    ].join("\n"))
    expect((await run(ls, ["-l", "-F", "/tmp/"], { fs })).stdout).toBe([
      `-rw------- guest 2 ${WHEN} mine`,
      `crw-rw-rw- guest 0 ${WHEN} null`,
      `-rw-r--r-- 42    1 ${WHEN} theirs`,
      "",
    ].join("\n"))
  })

  it("lists a file operand by the name given, files before directories", async () => {
    expect((await run(ls, ["docs", "notes.txt", "/etc/motd"])).stdout).toBe("notes.txt\n/etc/motd\n\ndocs:\na.txt\n")
    expect((await run(ls, ["-l", "notes.txt"])).stdout).toBe(`-rw-r--r-- guest 17 ${WHEN} notes.txt\n`)
  })

  it("follows a link to a directory given as an operand", async () => {
    expect((await run(ls, ["latest"])).stdout).toBe("a.txt\n")
  })

  it("shows a link that points nowhere as unreadable in the long format", async () => {
    const fs = world()
    fs.put("/tmp/gone", { type: "link", target: "/nowhere" })
    expect(await run(ls, ["-l", "/tmp"], { fs })).toEqual({ code: 0, stdout: "l????????? ? ? ? gone\n", stderr: "" })
    expect((await run(ls, ["/tmp"], { fs })).stdout).toBe("gone\n")
  })

  it("reports a missing path, lists the rest, and exits 1", async () => {
    expect(await run(ls, ["nope", "docs"])).toEqual({ code: 1, stdout: "docs:\na.txt\n", stderr: "ls: nope: no such file or directory\n" })
  })

  it("reports a directory it may not list", async () => {
    const fs = world()
    const denied = { ...fs, list: () => Promise.reject(new RiteError("EACCES")) }
    expect(await run(ls, ["docs"], { fs: denied })).toEqual({ code: 1, stdout: "", stderr: "ls: docs: permission denied\n" })
  })

  it("never triggers an action", async () => {
    const fs = world()
    let activated = 0
    const spy = { ...fs, activate: (...a: Parameters<typeof fs.activate>) => { activated++; return fs.activate(...a) } }
    await run(ls, ["-l", ".", "hello"], { fs: spy })
    expect(activated).toBe(0)
  })
})

describe("mkdir", () => {
  it("makes directories", async () => {
    const fs = world()
    expect(await run(mkdir, ["a", "/tmp/b"], { fs, cwd: "/tmp" })).toEqual({ code: 0, stdout: "", stderr: "" })
    expect((await fs.stat("/tmp/a", "/")).type).toBe("dir")
    expect((await fs.stat("/tmp/b", "/")).type).toBe("dir")
  })

  it("refuses a path that exists or has no parent, and makes the others", async () => {
    const fs = world()
    expect(await run(mkdir, ["/tmp", "/tmp/x/y", "/tmp/ok"], { fs })).toEqual({
      code: 1, stdout: "", stderr: "mkdir: /tmp: file exists\nmkdir: /tmp/x/y: no such file or directory\n",
    })
    expect((await fs.stat("/tmp/ok", "/")).type).toBe("dir")
  })

  it("makes parents and accepts an existing directory with -p", async () => {
    const fs = world()
    expect((await run(mkdir, ["-p", "/tmp/x/y", "/tmp"], { fs })).code).toBe(0)
    expect((await run(mkdir, ["--parents", "/tmp/x/y/z"], { fs })).code).toBe(0)
    expect((await fs.stat("/tmp/x/y/z", "/")).type).toBe("dir")
  })

  it("refuses a file in the way, with -p too", async () => {
    expect(await run(mkdir, ["-p", "notes.txt/sub"])).toEqual({ code: 1, stdout: "", stderr: "mkdir: notes.txt/sub: not a directory\n" })
  })

  it("needs an operand", async () => {
    expect(await run(mkdir)).toEqual({ code: 2, stdout: "", stderr: "mkdir: missing directory\nusage: mkdir [-p] dir...\n" })
  })
})

describe("touch", () => {
  it("creates an empty file", async () => {
    const fs = world()
    expect(await run(touch, ["/tmp/new", "also"], { fs, cwd: "/tmp" })).toEqual({ code: 0, stdout: "", stderr: "" })
    expect(await fs.read("/tmp/new", "/")).toBe("")
    expect(await fs.read("/tmp/also", "/")).toBe("")
  })

  it("keeps the content of a file that exists", async () => {
    const fs = world()
    expect((await run(touch, ["notes.txt", "docs"], { fs })).code).toBe(0)
    expect(await fs.read("notes.txt", HOME)).toBe("alpha\nbeta\ngamma\n")
  })

  it("leaves a computed file computed", async () => {
    const fs = world()
    let n = 0
    fs.put("/tmp/live", { type: "file", content: () => String(++n) })
    await run(touch, ["/tmp/live"], { fs })
    expect(n).toBe(0)
    expect(await fs.read("/tmp/live", "/")).toBe("1")
    expect(await fs.read("/tmp/live", "/")).toBe("2")
  })

  it("reports a path with no parent and touches the rest", async () => {
    const fs = world()
    expect(await run(touch, ["/nope/x", "/tmp/y"], { fs })).toEqual({ code: 1, stdout: "", stderr: "touch: /nope/x: no such file or directory\n" })
    expect(await fs.read("/tmp/y", "/")).toBe("")
  })

  it("needs an operand", async () => {
    expect((await run(touch)).code).toBe(2)
  })
})

describe("rm", () => {
  const gone = async (fs: ReturnType<typeof world>, path: string): Promise<boolean> =>
    fs.stat(path, HOME).then(() => false, (e: unknown) => e instanceof RiteError && e.errno === "ENOENT")

  it("removes files", async () => {
    const fs = world()
    expect(await run(rm, ["notes.txt", "docs/a.txt"], { fs })).toEqual({ code: 0, stdout: "", stderr: "" })
    expect(await gone(fs, "notes.txt")).toBe(true)
    expect(await gone(fs, "docs/a.txt")).toBe(true)
  })

  it("refuses a directory without -r, empty or not", async () => {
    const fs = world()
    fs.put("/tmp/empty", { type: "dir" })
    expect(await run(rm, ["docs", "/tmp/empty"], { fs })).toEqual({
      code: 1, stdout: "", stderr: "rm: docs: is a directory\nrm: /tmp/empty: is a directory\n",
    })
    expect(await gone(fs, "docs")).toBe(false)
    expect(await gone(fs, "/tmp/empty")).toBe(false)
  })

  it.each([["-r"], ["-R"], ["--recursive"]])("removes a directory and its contents with %s", async (option) => {
    const fs = world()
    expect((await run(rm, [option, "docs"], { fs })).code).toBe(0)
    expect(await gone(fs, "docs")).toBe(true)
  })

  it("reports a missing path, unless -f", async () => {
    const fs = world()
    expect(await run(rm, ["nope", "notes.txt"], { fs })).toEqual({ code: 1, stdout: "", stderr: "rm: nope: no such file or directory\n" })
    expect(await gone(fs, "notes.txt")).toBe(true)
    expect(await run(rm, ["-f", "nope"], { fs })).toEqual({ code: 0, stdout: "", stderr: "" })
    expect(await run(rm, ["--force", "-r", "nope/deeper"], { fs })).toEqual({ code: 0, stdout: "", stderr: "" })
  })

  it("still reports other failures with -f", async () => {
    expect(await run(rm, ["-f", "docs"])).toEqual({ code: 1, stdout: "", stderr: "rm: docs: is a directory\n" })
    const fs = world()
    const readonly = { ...fs, remove: () => Promise.reject(new RiteError("EROFS")) }
    expect(await run(rm, ["-rf", "docs"], { fs: readonly })).toEqual({ code: 1, stdout: "", stderr: "rm: docs: read-only file system\n" })
  })

  it.each([
    [["/"]], [["-r", "/"]], [["-rf", "/"]], [["-rf", "//"]], [["-rf", "/."]], [["-rf", "/tmp/.."]], [["-rf", "../.."]],
  ])("refuses the root: rm %j", async (words) => {
    const fs = world()
    const target = words.at(-1) ?? ""
    expect(await run(rm, words, { fs })).toEqual({ code: 1, stdout: "", stderr: `rm: ${target}: operation not permitted\n` })
    expect((await fs.list("/", "/")).map((e) => e.name)).toEqual(["bin", "etc", "home", "tmp", "usr"])
  })

  it("removes a link, not the directory it points at", async () => {
    const fs = world()
    expect(await run(rm, ["latest"], { fs })).toEqual({ code: 0, stdout: "", stderr: "" })
    expect((await fs.list(HOME, "/")).map((e) => e.name)).not.toContain("latest")
    expect(await fs.read("docs/a.txt", HOME)).toBe("one two\nthree\n")
  })

  it("removes a link that points nowhere", async () => {
    const fs = world()
    fs.put("/tmp/gone", { type: "link", target: "/nowhere" })
    expect((await run(rm, ["/tmp/gone"], { fs })).code).toBe(0)
    expect(await fs.list("/tmp", "/")).toEqual([])
  })

  it("needs an operand, unless -f", async () => {
    expect(await run(rm)).toEqual({ code: 2, stdout: "", stderr: "rm: missing path\nusage: rm [-rf] path...\n" })
    expect(await run(rm, ["-f"])).toEqual({ code: 0, stdout: "", stderr: "" })
  })
})

describe("open", () => {
  it("runs an action through the vfs with via open", async () => {
    const fs = world()
    const seen: ActionVia[] = []
    const spy = { ...fs, activate: (...a: Parameters<typeof fs.activate>) => { seen.push(a[2]); return fs.activate(...a) } }
    expect(await run(open, ["hello"], { fs: spy })).toEqual({ code: 0, stdout: "hello from an action\n", stderr: "" })
    expect(seen).toEqual(["open"])
  })

  it("prints the URL of an open action the browser blocked", async () => {
    expect(await run(open, ["site"])).toEqual({ code: 0, stdout: "https://example.com/\n", stderr: "" })
  })

  it("prints nothing for an action with no text", async () => {
    expect(await run(open, ["go"])).toEqual({ code: 0, stdout: "", stderr: "" })
  })

  it.each([["https://example.com/a?b=1&c=2"], ["http://example.com"], ["HTTPS://EXAMPLE.COM/"]])("hands %s to the page", async (url) => {
    const fs = world()
    let activated = 0
    const spy = { ...fs, activate: (...a: Parameters<typeof fs.activate>) => { activated++; return fs.activate(...a) } }
    expect(await run(open, [url], { fs: spy })).toEqual({ code: 0, stdout: `open: ${url}\n`, stderr: "" })
    expect(activated).toBe(0)
  })

  it("treats any other scheme as a path", async () => {
    expect(await run(open, ["javascript:alert(1)"])).toEqual({ code: 1, stdout: "", stderr: "open: javascript:alert(1): no such file or directory\n" })
  })

  it("cannot open a file or a directory, and goes on to the next operand", async () => {
    expect(await run(open, ["notes.txt", "docs", "nope", "hello"])).toEqual({
      code: 1,
      stdout: "hello from an action\n",
      stderr: "open: notes.txt: operation not supported\nopen: docs: operation not supported\nopen: nope: no such file or directory\n",
    })
  })

  it("needs an operand", async () => {
    expect(await run(open)).toEqual({ code: 2, stdout: "", stderr: "open: missing path or URL\nusage: open path|url...\n" })
  })
})
