import { describe, expect, it } from "vitest"
import { RiteError, type SessionView } from "../../src/contracts.js"
import { eggs, rmrf } from "../../src/eggs.js"
import { wipesRoot } from "../../src/eggs/rmrf.js"
import { exec, fakeSys, fakeTty, HOME, type RunOptions, world } from "../commands/support.js"

const session = (cwd: string): SessionView => ({ ...fakeSys().session, cwd })

/** Whether the kernel would hand this command line to the egg. */
function triggers(argv: readonly string[], cwd = HOME): boolean {
  const { trigger } = rmrf
  if (!("command" in trigger)) throw new Error("rmrf is a command egg")
  return trigger.command === argv[0] && (trigger.when?.(argv, session(cwd)) ?? true)
}

const fire = (o: RunOptions = {}) => exec(rmrf.run, ["rm", "-rf", "/"], { flags: {}, args: ["-rf", "/"] }, o)

describe("rmrf trigger", () => {
  it("is shipped as a command egg on rm", () => {
    expect(eggs).toContain(rmrf)
    expect(rmrf.id).toBe("rmrf")
    expect(rmrf.trigger).toMatchObject({ command: "rm" })
  })

  it.each([
    [["rm", "-rf", "/"]],
    [["rm", "-fr", "/"]],
    [["rm", "-r", "-f", "/"]],
    [["rm", "-f", "-r", "/"]],
    [["rm", "-Rf", "/"]],
    [["rm", "-fR", "/"]],
    [["rm", "-R", "-f", "/"]],
    [["rm", "--recursive", "--force", "/"]],
    [["rm", "--force", "--recursive", "/"]],
    [["rm", "-r", "--force", "/"]],
    [["rm", "--recursive", "-f", "/"]],
    [["rm", "-rfv", "/"]],
    [["rm", "-vrf", "/"]],
    [["rm", "-rf", "--no-preserve-root", "/"]],
    [["rm", "/", "-rf"]],
    [["rm", "-r", "/", "-f"]],
    [["rm", "-rf", "--", "/"]],
    [["rm", "-rf", "//"]],
    [["rm", "-rf", "/."]],
    [["rm", "-rf", "/.."]],
    [["rm", "-rf", "/./"]],
    [["rm", "-rf", "/../.."]],
    [["rm", "-rf", "/tmp/.."]],
    [["rm", "-rf", "/tmp", "/"]],
    [["rm", "-rf", "../.."]],
  ])("matches %j", (argv) => {
    expect(triggers(argv)).toBe(true)
  })

  it("resolves a relative target against the session's directory", () => {
    expect(triggers(["rm", "-rf", "."], "/")).toBe(true)
    expect(triggers(["rm", "-rf", ".."], "/tmp")).toBe(true)
    expect(triggers(["rm", "-rf", "."], "/tmp")).toBe(false)
  })

  it.each([
    [["rm", "/"]],
    [["rm", "-r", "/"]],
    [["rm", "-R", "/"]],
    [["rm", "-f", "/"]],
    [["rm", "--recursive", "/"]],
    [["rm", "--force", "/"]],
    [["rm", "-i", "/"]],
    [["rm", "-rf"]],
    [["rm", "-rf", "/tmp"]],
    [["rm", "-rf", "/home/guest"]],
    [["rm", "-rf", "."]],
    [["rm", "-rf", ".."]],
    [["rm", "-rf", ""]],
    [["rm", "-rf", "/*"]],
    [["rm", "-rf", "~"]],
    [["rm", "-rf", "/tmp/../etc"]],
    [["rm", "--", "-rf", "/"]],
    [["rm", "-r", "--", "-f", "/"]],
    [["rm", "--recursive=yes", "--forceful", "/"]],
    [["rm"]],
    [["rmdir", "-rf", "/"]],
    [["ls", "-rf", "/"]],
  ])("does not match %j", (argv) => {
    expect(triggers(argv)).toBe(false)
  })

  it("reads flags the way the predicate helper does", () => {
    expect(wipesRoot(["rm", "-rf", "/"], "/anywhere")).toBe(true)
    expect(wipesRoot(["rm", "-r", "/"], "/anywhere")).toBe(false)
  })
})

describe("rmrf", () => {
  it("prints a deletion of what the root holds, then owns up, and deletes nothing", async () => {
    const fs = world()
    fs.put("/README", { type: "file", content: "hi" })
    const tty = fakeTty()
    expect(await fire({ fs, tty })).toEqual({
      value: 0,
      stderr: "",
      stdout: [
        "removed /README",
        "removed directory /bin",
        "removed /etc/motd",
        "removed directory /etc",
        "removed /home/guest",
        "removed directory /home",
        "removed directory /tmp",
        "removed /usr/share",
        "removed directory /usr",
        "just kidding. nothing here is yours to delete.",
        "",
      ].join("\n"),
    })
    expect(tty.raws).toEqual([])
    expect((await fs.list("/", "/")).map((e) => e.name)).toEqual(["README", "bin", "etc", "home", "tmp", "usr"])
    expect(await fs.read("/etc/motd", "/")).toBe("welcome\n")
  })

  it("shows a few entries of a large directory", async () => {
    const fs = world()
    for (let i = 0; i < 20; i++) fs.put(`/bin/c${String(i).padStart(2, "0")}`, { type: "file", content: "" })
    const { stdout } = await fire({ fs })
    expect(stdout.split("\n").filter((line) => line.startsWith("removed /bin/"))).toEqual([
      "removed /bin/c00", "removed /bin/c01", "removed /bin/c02", "removed /bin/c03", "removed /bin/c04", "removed /bin/c05",
    ])
  })

  it("only lists the root and its directories, and never acts on an inode", async () => {
    const fs = world()
    const listed: string[] = []
    const refuse = (): never => { throw new Error("the egg must only list") }
    const spy = {
      ...fs,
      list: (...a: Parameters<typeof fs.list>) => { listed.push(a[0]); return fs.list(...a) },
      remove: refuse, write: refuse, read: refuse, stat: refuse, activate: refuse, mkdir: refuse,
    }
    expect((await fire({ fs: spy })).value).toBe(0)
    expect(listed).toEqual(["/", "/bin", "/etc", "/home", "/tmp", "/usr"])
  })

  it("carries on past a directory it cannot list", async () => {
    const fs = world()
    const partial = { ...fs, list: (...a: Parameters<typeof fs.list>) => (a[0] === "/etc" ? Promise.reject(new RiteError("ETIMEDOUT")) : fs.list(...a)) }
    const r = await fire({ fs: partial })
    expect(r.value).toBe(0)
    expect(r.stdout).toContain("removed directory /bin\nremoved directory /etc\nremoved /home/guest\n")
    expect(r.stdout.endsWith("just kidding. nothing here is yours to delete.\n")).toBe(true)
  })

  it("still owns up when the root cannot be listed", async () => {
    const fs = world()
    const none = { ...fs, list: () => Promise.reject(new RiteError("EIO")) }
    expect(await fire({ fs: none })).toEqual({ value: 0, stdout: "just kidding. nothing here is yours to delete.\n", stderr: "" })
  })

  it("stops with 130 when interrupted", async () => {
    const stop = new AbortController()
    const fs = world()
    const slow = { ...fs, list: (...a: Parameters<typeof fs.list>) => { if (a[0] === "/etc") stop.abort("INT"); return fs.list(...a) } }
    const r = await fire({ fs: slow, signal: stop.signal })
    expect(r.value).toBe(130)
    expect(r.stdout).not.toContain("just kidding")
    expect(r.stdout).not.toContain("/home")
  })
})
