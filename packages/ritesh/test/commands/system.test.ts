import { afterEach, describe, expect, it, vi } from "vitest"
import { type Resolution } from "../../src/contracts.js"
import {
  clear, date, env, falseCommand, head, help, hostname, id, ls, man, renderManual, sudo, trueCommand, type, uname,
  which, whoami,
} from "../../src/commands/index.js"
import { fakeSys, fakeTty, info, run, T0, world } from "./support.js"

const resolutions: Record<string, Resolution> = {
  ls: { kind: "command", name: "ls", path: "/bin/ls", info: info("ls", ls.summary, { usage: ls.usage }) },
  mdm: { kind: "command", name: "mdm", path: "/mdm/bin/mdm", info: info("mdm", "manage devices", { remote: true }) },
  cd: { kind: "builtin", name: "cd", info: info("cd", "change directory", { usage: "cd [dir]", builtin: true }) },
  ll: { kind: "alias", name: "ll", body: "ls -l" },
  memdsk: { kind: "egg", name: "memdsk", id: "memdsk" },
}

describe("env", () => {
  it("prints the environment sorted by name", async () => {
    expect(await run(env, [], { env: { USER: "guest", HOME: "/home/guest", EMPTY: "", _X: "a=b" } })).toEqual({
      code: 0, stdout: "EMPTY=\nHOME=/home/guest\nUSER=guest\n_X=a=b\n", stderr: "",
    })
  })

  it("prints nothing for an empty environment", async () => {
    expect(await run(env)).toEqual({ code: 0, stdout: "", stderr: "" })
  })
})

describe("which", () => {
  const sys = fakeSys({ resolutions })

  it("prints the path, or names a builtin or an alias", async () => {
    expect(await run(which, ["ls", "mdm", "cd", "ll"], { sys })).toEqual({
      code: 0, stdout: "/bin/ls\n/mdm/bin/mdm\ncd: shell builtin\nll: aliased to ls -l\n", stderr: "",
    })
  })

  it("exits 1 when a name is not a command, and keeps an egg hidden", async () => {
    expect(await run(which, ["nope", "ls", "memdsk"], { sys })).toEqual({
      code: 1, stdout: "/bin/ls\n", stderr: "which: nope: not found\nwhich: memdsk: not found\n",
    })
  })

  it("needs a name", async () => {
    expect(await run(which, [], { sys })).toEqual({ code: 2, stdout: "", stderr: "which: missing name\nusage: which name...\n" })
  })
})

describe("type", () => {
  const sys = fakeSys({ resolutions })

  it("describes a command, a builtin, and an alias", async () => {
    expect(await run(type, ["ls", "cd", "ll"], { sys })).toEqual({
      code: 0, stdout: "ls is /bin/ls\ncd is a shell builtin\nll is an alias for ls -l\n", stderr: "",
    })
  })

  it("exits 1 for a name that is none of them", async () => {
    expect(await run(type, ["nope", "memdsk", "cd"], { sys })).toEqual({
      code: 1, stdout: "cd is a shell builtin\n", stderr: "type: nope: not found\ntype: memdsk: not found\n",
    })
  })

  it("needs a name", async () => {
    expect((await run(type, [], { sys })).code).toBe(2)
  })
})

describe("clear", () => {
  it("homes the cursor and erases the screen and the scrollback, unfiltered", async () => {
    const tty = fakeTty()
    expect(await run(clear, [], { tty })).toEqual({ code: 0, stdout: "", stderr: "" })
    expect(tty.raws).toEqual(["\x1b[H\x1b[2J\x1b[3J"])
  })

  it("writes nothing when stdout is not the terminal", async () => {
    expect(await run(clear)).toEqual({ code: 0, stdout: "", stderr: "" })
  })
})

describe("help", () => {
  const sys = fakeSys({
    commands: [
      info("ls", "list directory contents", { usage: "ls [-la1F] [path...]" }),
      info("cd", "change directory", { builtin: true }),
      info("cat", "print files or stdin"),
      info("alias", "define an alias", { builtin: true }),
      info("mdm", "manage devices", { remote: true }),
    ],
  })

  it("lists builtins and commands with their summaries in columns", async () => {
    expect(await run(help, [], { sys })).toEqual({
      code: 0,
      stderr: "",
      stdout: [
        "builtins",
        "  alias  define an alias",
        "  cd     change directory",
        "",
        "commands",
        "  cat  print files or stdin",
        "  ls   list directory contents",
        "  mdm  manage devices",
        "",
        "man <command> shows a command's manual.",
        "",
      ].join("\n"),
    })
  })

  it("leaves out a section with nothing in it", async () => {
    const r = await run(help, [], { sys: fakeSys({ commands: [info("ls", "list")] }) })
    expect(r.stdout).toBe("commands\n  ls  list\n\nman <command> shows a command's manual.\n")
  })

  it("prints the summary and usage of the commands named", async () => {
    expect(await run(help, ["ls", "nope"], { sys })).toEqual({
      code: 1, stdout: "ls: list directory contents\nusage: ls [-la1F] [path...]\n", stderr: "help: nope: no such command\n",
    })
  })
})

describe("man", () => {
  const sys = fakeSys({ resolutions })

  it("renders a definition: name, synopsis, description, and options", () => {
    expect(renderManual(head)).toBe([
      "NAME",
      "    head - output the first lines",
      "",
      "SYNOPSIS",
      "    head [-n lines] [file...]",
      "",
      "DESCRIPTION",
      "    Prints the first lines of each file, or of stdin. With several files each",
      "    is headed by `==> name <==`. Reading stdin stops once the lines are printed.",
      "",
      "OPTIONS",
      "    -n, --lines <number>  how many lines to print (default 10)",
      "",
    ].join("\n"))
  })

  it("uses the summary when there is no manual, and lists subcommands", () => {
    const page = renderManual({
      name: "mdm",
      summary: "manage devices",
      usage: "mdm <command>",
      flags: {
        json: { long: "json", type: "boolean" },
        v: { short: "v", type: "boolean", description: "say more" },
        tag: { long: "tag", short: "t", type: "string", repeat: true, description: "filter by tag" },
        quiet: { type: "boolean", default: false },
        x: { type: "number", default: 3 },
      },
      subcommands: {
        devices: { summary: "list devices", usage: "mdm devices" },
        ls: { summary: "list tenants", usage: "mdm ls" },
      },
    })
    expect(page).toBe([
      "NAME",
      "    mdm - manage devices",
      "",
      "SYNOPSIS",
      "    mdm <command>",
      "",
      "DESCRIPTION",
      "    manage devices",
      "",
      "OPTIONS",
      "    --json",
      "    -v                     say more",
      "    -t, --tag <string>...  filter by tag",
      "    --quiet",
      "    -x <number>            (default 3)",
      "",
      "SUBCOMMANDS",
      "    devices  list devices",
      "    ls       list tenants",
      "",
    ].join("\n"))
  })

  it("renders what the kernel resolves for a command or a builtin", async () => {
    expect(await run(man, ["ls"], { sys })).toEqual({
      code: 0,
      stderr: "",
      stdout: "NAME\n    ls - list directory contents\n\nSYNOPSIS\n    ls [-la1F] [path...]\n\nDESCRIPTION\n    list directory contents\n",
    })
    expect((await run(man, ["cd"], { sys })).stdout).toContain("SYNOPSIS\n    cd [dir]\n")
  })

  it("prints a page under /usr/share/man for a name that is not a command", async () => {
    expect(await run(man, ["rite"], { sys })).toEqual({ code: 0, stdout: "rite is a shell for the browser.\n", stderr: "" })
  })

  it("prefers the definition to a page of the same name", async () => {
    const fs = world()
    fs.put("/usr/share/man/ls", { type: "file", content: "a page\n" })
    expect((await run(man, ["ls"], { sys, fs })).stdout).toContain("NAME\n    ls - ")
  })

  it.each([["nope"], ["ll"], ["memdsk"], ["../../../etc/motd"], [""], ["."]])("has no entry for %j", async (name) => {
    expect(await run(man, [name], { sys })).toEqual({ code: 1, stdout: "", stderr: `man: no manual entry for ${name}\n` })
  })

  it("shows the pages it finds and exits 1 for one it does not", async () => {
    const r = await run(man, ["rite", "nope", "rite"], { sys })
    expect(r).toEqual({
      code: 1, stdout: "rite is a shell for the browser.\n\nrite is a shell for the browser.\n", stderr: "man: no manual entry for nope\n",
    })
  })

  it("needs a name", async () => {
    expect(await run(man, [], { sys })).toEqual({ code: 2, stdout: "", stderr: "man: missing name\nusage: man name...\n" })
  })
})

describe("sudo", () => {
  it("runs nothing when the host lets nobody use sudo", async () => {
    const sys = fakeSys({ sudo: false })
    expect(await run(sudo, ["whoami"], { sys })).toEqual({ code: 1, stdout: "", stderr: "sudo: guest is not in the sudoers file.\n" })
    expect(sys.spawned).toEqual([])
  })

  it("runs the command as uid 0 when the host lets everybody, with its words untouched", async () => {
    const sys = fakeSys({ sudo: true, spawn: () => Promise.resolve(7) })
    expect(await run(sudo, ["rm", "-rf", "--", "/tmp/x"], { sys })).toEqual({ code: 7, stdout: "", stderr: "" })
    expect(sys.spawned).toEqual([{ argv: ["rm", "-rf", "--", "/tmp/x"], uid: 0 }])
  })

  it("asks for the password without echo and runs the command when it is right", async () => {
    const sys = fakeSys({ sudo: (password) => password === "hunter2", session: { user: "ada" } })
    const tty = fakeTty({ answers: ["hunter2"] })
    expect(await run(sudo, ["whoami"], { sys, tty })).toEqual({ code: 0, stdout: "", stderr: "" })
    expect(tty.reads).toEqual([{ echo: false, prompt: "[sudo] password for ada: " }])
    expect(sys.spawned).toEqual([{ argv: ["whoami"], uid: 0 }])
  })

  it("accepts a policy that answers later, on the second try", async () => {
    const sys = fakeSys({ sudo: (password) => Promise.resolve(password === "right") })
    const tty = fakeTty({ answers: ["wrong", "right"] })
    expect(await run(sudo, ["id"], { sys, tty })).toEqual({ code: 0, stdout: "", stderr: "Sorry, try again.\n" })
    expect(tty.reads).toHaveLength(2)
    expect(sys.spawned).toHaveLength(1)
  })

  it("gives up after three wrong passwords", async () => {
    const sys = fakeSys({ sudo: () => false })
    const tty = fakeTty({ answers: ["a", "b", "c", "d"] })
    expect(await run(sudo, ["id"], { sys, tty })).toEqual({
      code: 1, stdout: "", stderr: "Sorry, try again.\nSorry, try again.\nsudo: incorrect password\n",
    })
    expect(tty.reads).toHaveLength(3)
    expect(sys.spawned).toEqual([])
  })

  it("gives up when the prompt is closed", async () => {
    const sys = fakeSys({ sudo: () => true })
    expect(await run(sudo, ["id"], { sys, tty: fakeTty({ answers: [null] }) })).toEqual({ code: 1, stdout: "", stderr: "" })
    expect(sys.spawned).toEqual([])
  })

  it("needs the terminal to ask", async () => {
    const sys = fakeSys({ sudo: () => true })
    expect(await run(sudo, ["id"], { sys })).toEqual({ code: 1, stdout: "", stderr: "sudo: a terminal is required to read the password\n" })
    expect(sys.spawned).toEqual([])
  })

  it("does not ask root again", async () => {
    const sys = fakeSys({ sudo: () => false })
    expect((await run(sudo, ["id"], { sys, uid: 0 })).code).toBe(0)
    expect(sys.spawned).toEqual([{ argv: ["id"], uid: 0 }])
  })

  it("stops with 130 when interrupted at the prompt", async () => {
    const stop = new AbortController()
    const sys = fakeSys({ sudo: () => true })
    const tty = { ...fakeTty(), read: () => { stop.abort("INT"); return Promise.reject(new Error("aborted")) } }
    expect(await run(sudo, ["id"], { sys, tty, signal: stop.signal })).toEqual({ code: 130, stdout: "", stderr: "" })
    expect(sys.spawned).toEqual([])
  })

  it("needs a command", async () => {
    expect(await run(sudo, [], { sys: fakeSys({ sudo: true }) })).toEqual({
      code: 2, stdout: "", stderr: "sudo: missing command\nusage: sudo command [arg...]\n",
    })
  })
})

describe("whoami and id", () => {
  it.each([
    [1000, "guest\n", "uid=1000(guest) gid=1000(guest)\n"],
    [0, "root\n", "uid=0(root) gid=0(root)\n"],
    [42, "42\n", "uid=42(42) gid=42(42)\n"],
  ])("uid %d", async (uid, name, ids) => {
    expect(await run(whoami, [], { uid })).toEqual({ code: 0, stdout: name, stderr: "" })
    expect(await run(id, [], { uid })).toEqual({ code: 0, stdout: ids, stderr: "" })
  })

  it("names the session's user, whatever USER says", async () => {
    const sys = fakeSys({ session: { user: "ada" } })
    expect((await run(whoami, [], { sys, env: { USER: "mallory" } })).stdout).toBe("ada\n")
  })
})

describe("uname and hostname", () => {
  it("prints the system name", async () => {
    expect(await run(uname)).toEqual({ code: 0, stdout: "rite\n", stderr: "" })
  })

  it.each([["-a"], ["--all"]])("prints the hostname, version, and machine with %s", async (option) => {
    expect((await run(uname, [option], { env: { RITE_VERSION: "0.1.0" } })).stdout).toBe("rite rite.test 0.1.0 browser\n")
    expect((await run(uname, [option])).stdout).toBe("rite rite.test unknown browser\n")
  })

  it("prints the host name", async () => {
    const sys = fakeSys({ session: { hostname: "enroll.dev" } })
    expect(await run(hostname, [], { sys })).toEqual({ code: 0, stdout: "enroll.dev\n", stderr: "" })
  })
})

describe("date", () => {
  afterEach(() => { vi.useRealTimers() })

  it("prints the local date and time with the UTC offset", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(T0 + 61_000)
    const r = await run(date)
    expect(r.code).toBe(0)
    const local = new Date(T0 + 61_000).toLocaleString("sv-SE")
    expect(r.stdout.slice(0, 19)).toBe(local)
    expect(r.stdout).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:01 [+-]\d{4}\n$/)
    // The printed offset is the one that takes the local time back to the instant.
    const [day = "", time = "", offset = ""] = r.stdout.trim().split(" ")
    expect(Date.parse(`${day}T${time}${offset.slice(0, 3)}:${offset.slice(3)}`)).toBe(T0 + 61_000)
  })
})

describe("true and false", () => {
  it("exit 0 and 1 whatever the arguments", async () => {
    expect(await run(trueCommand, ["--nope", "x"])).toEqual({ code: 0, stdout: "", stderr: "" })
    expect(await run(falseCommand, ["--help"])).toEqual({ code: 1, stdout: "", stderr: "" })
  })
})
