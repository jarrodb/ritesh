import { describe, expect, it } from "vitest"
import { errnoOf, GUEST, ROOT, world } from "./support.js"

type Want = "r" | "w" | "x"

function tree() {
  const w = world()
  const { vfs } = w
  vfs.put("/home/guest/private", { type: "file", content: "", mode: 0o000 })
  vfs.put("/home/guest/group", { type: "file", content: "", mode: 0o070 })
  vfs.put("/home/guest/script", { type: "file", content: "", mode: 0o755 })
  vfs.put("/home/guest/locked", { type: "dir", mode: 0o600 })
  vfs.put("/home/guest/locked/inside", { type: "file", content: "" })
  vfs.put("/home/guest/to-secret", { type: "link", target: "/root/secret" })
  vfs.put("/home/guest/to-root", { type: "link", target: "/root" })
  vfs.put("/etc/group-only", { type: "file", content: "", mode: 0o670 })
  vfs.put("/etc/shadow", { type: "file", content: "", mode: 0o600 })
  return w
}

describe("access", () => {
  const cases: Array<[name: string, path: string, uid: number, want: Want, allowed: boolean]> = [
    ["owner reads a 0644 file", "/home/guest/notes.txt", GUEST, "r", true],
    ["owner writes a 0644 file", "/home/guest/notes.txt", GUEST, "w", true],
    ["owner cannot execute a 0644 file", "/home/guest/notes.txt", GUEST, "x", false],
    ["owner executes a 0755 file", "/home/guest/script", GUEST, "x", true],
    ["owner is held to a 0000 mode", "/home/guest/private", GUEST, "r", false],
    ["owner gets nothing from group bits", "/home/guest/group", GUEST, "r", false],
    ["root reads a 0000 file", "/home/guest/private", ROOT, "r", true],
    ["root writes a 0000 file", "/home/guest/private", ROOT, "w", true],
    ["root executes a 0644 file", "/home/guest/notes.txt", ROOT, "x", true],
    ["another user reads root's 0644 file", "/etc/motd", GUEST, "r", true],
    ["another user cannot write root's 0644 file", "/etc/motd", GUEST, "w", false],
    ["another user gets nothing from group bits", "/etc/group-only", GUEST, "r", false],
    ["another user cannot read a 0600 file", "/etc/shadow", GUEST, "r", false],
    ["root writes its own file", "/etc/motd", ROOT, "w", true],
    ["another user runs a 0755 cmd", "/bin/echo", GUEST, "x", true],
    ["another user cannot write a cmd", "/bin/echo", GUEST, "w", false],
    ["another user writes a 0666 dev", "/dev/null", GUEST, "w", true],
    ["another user enters a 0755 dir", "/etc", GUEST, "x", true],
    ["another user cannot write a 0755 dir", "/etc", GUEST, "w", false],
    ["another user writes a 0777 dir", "/tmp", GUEST, "w", true],
    ["owner writes its home", "/home/guest", GUEST, "w", true],
    ["a 0700 dir keeps another user out", "/root", GUEST, "x", false],
    ["a 0700 dir cannot be listed by another user", "/root", GUEST, "r", false],
    ["a file in a 0700 dir is out of reach", "/root/secret", GUEST, "r", false],
    ["root enters a 0700 dir", "/root", ROOT, "x", true],
    ["root reads a file in a 0700 dir", "/root/secret", ROOT, "r", true],
    ["owner reads its dir without x", "/home/guest/locked", GUEST, "r", true],
    ["owner cannot enter its dir without x", "/home/guest/locked", GUEST, "x", false],
    ["owner cannot reach through its dir without x", "/home/guest/locked/inside", GUEST, "r", false],
    ["root reaches through a dir without x", "/home/guest/locked/inside", ROOT, "r", true],
    ["a link does not get around a 0700 dir", "/home/guest/to-secret", GUEST, "r", false],
    ["a link to a dir is checked as the dir", "/home/guest/to-root", GUEST, "x", false],
    ["root follows the link", "/home/guest/to-secret", ROOT, "r", true],
    ["dot-dot is lexical, so it never enters the dir", "/root/../etc/motd", GUEST, "r", true],
  ]
  it.each(cases)("%s", async (_name, path, uid, want, allowed) => {
    const { vfs } = tree()
    expect(await vfs.access(path, "/", uid, want)).toBe(allowed)
  })

  it("checks relative to cwd", async () => {
    const { vfs } = tree()
    expect(await vfs.access("notes.txt", "/home/guest", GUEST, "w")).toBe(true)
    expect(await vfs.access("../../root", "/home/guest", GUEST, "x")).toBe(false)
  })

  const failures: Array<[name: string, path: string, uid: number, errno: string]> = [
    ["a missing path", "/nope", GUEST, "ENOENT"],
    ["a missing path as root", "/nope", ROOT, "ENOENT"],
    ["a path through a file", "/etc/motd/x", GUEST, "ENOTDIR"],
    ["an empty path", "", GUEST, "ENOENT"],
  ]
  it.each(failures)("rejects for %s", async (_name, path, uid, errno) => {
    const { vfs } = tree()
    expect(await errnoOf(vfs.access(path, "/", uid, "r"))).toBe(errno)
  })

  it("answers false, not ENOENT, for a missing path behind a closed dir", async () => {
    const { vfs } = tree()
    expect(await vfs.access("/root/nope", "/", GUEST, "r")).toBe(false)
    expect(await errnoOf(vfs.access("/root/nope", "/", ROOT, "r"))).toBe("ENOENT")
  })

  it("follows a mode changed by put", async () => {
    const { vfs } = tree()
    vfs.put("/root", { type: "dir", mode: 0o755 })
    expect(await vfs.access("/root/secret", "/", GUEST, "r")).toBe(true)
  })
})
