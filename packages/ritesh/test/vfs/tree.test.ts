import { describe, expect, it } from "vitest"
import type { InodeSpec, Vfs } from "../../src/contracts.js"
import { createVfs } from "../../src/vfs/index.js"
import { echo, errnoOf, GUEST, ROOT, thrownErrno, world } from "./support.js"

type Call = (vfs: Vfs) => Promise<unknown>

describe("inode types", () => {
  const specs: Array<[name: string, spec: InodeSpec, type: string, mode: number, size: number]> = [
    ["dir", { type: "dir" }, "dir", 0o755, 0],
    ["file", { type: "file", content: "héllo" }, "file", 0o644, 6],
    ["file from a function", { type: "file", content: () => "later" }, "file", 0o644, 0],
    ["cmd", { type: "cmd", command: echo }, "cmd", 0o755, 0],
    ["action", { type: "action", action: { print: "hi" } }, "action", 0o755, 0],
    ["dev", { type: "dev" }, "dev", 0o666, 0],
    ["dir with a mode", { type: "dir", mode: 0o700 }, "dir", 0o700, 0],
    ["file with a mode and owner", { type: "file", content: "", mode: 0o600, uid: GUEST }, "file", 0o600, 0],
  ]
  it.each(specs)("put then stat: %s", async (_name, spec, type, mode, size) => {
    const { vfs, clock } = world()
    clock.t = 5_000
    vfs.put("/x", spec)
    const uid = "uid" in spec ? spec.uid : ROOT
    expect(await vfs.stat("/x", "/")).toEqual({ type, mode, uid, gid: uid, size, mtime: 5_000 })
    expect(vfs.peek("/x", "/")).toMatchObject({ type, mode, uid })
    expect(await vfs.list("/", "/")).toContainEqual({ name: "x", type })
  })

  it("stats and peeks relative to cwd", async () => {
    const { vfs } = world()
    expect((await vfs.stat("notes.txt", "/home/guest")).type).toBe("file")
    expect((await vfs.stat("../../etc/motd", "/home/guest")).size).toBe(8)
    expect(vfs.peek("guest", "/home")?.type).toBe("dir")
    expect(vfs.peek("nope", "/home")).toBeUndefined()
  })

  it("peeks a cmd with its command info", () => {
    const { vfs } = world()
    expect(vfs.peek("/bin/echo", "/")).toEqual({
      type: "cmd", mode: 0o755, uid: ROOT,
      command: {
        name: "echo", summary: "print arguments", usage: "echo [arg...]", builtin: false, remote: false,
        flags: { n: { short: "n", type: "boolean" } },
        subcommands: { loud: { summary: "print in capitals", usage: "echo loud [arg...]" } },
      },
    })
  })

  it("lists by code point", async () => {
    const vfs = createVfs()
    for (const name of ["b", "\u{1F600}", "a", "～", "B", "ab"]) vfs.put(`/d/${name}`, { type: "file", content: "" })
    expect((await vfs.list("/d", "/")).map((e) => e.name)).toEqual(["B", "a", "ab", "b", "～", "\u{1F600}"])
  })
})

describe("read", () => {
  const cases: Array<[name: string, path: string, want: string]> = [
    ["a string file", "/etc/motd", "welcome\n"],
    ["a file from a function", "/fn", "computed"],
    ["a file from an async function", "/async", "awaited"],
    ["a dev with a read handler", "/dev/seven", "7"],
    ["a dev without handlers", "/dev/null", ""],
  ]
  it.each(cases)("%s", async (_name, path, want) => {
    const { vfs } = world()
    vfs.put("/fn", { type: "file", content: () => "computed" })
    vfs.put("/async", { type: "file", content: () => Promise.resolve("awaited") })
    vfs.put("/dev/seven", { type: "dev", read: () => "7" })
    expect(await vfs.read(path, "/")).toBe(want)
  })

  it("calls a content function on every read and never on stat, list, or peek", async () => {
    const { vfs } = world()
    let calls = 0
    vfs.put("/fn", { type: "file", content: () => `call ${++calls}` })
    await vfs.stat("/fn", "/")
    await vfs.list("/", "/")
    vfs.peek("/fn", "/")
    expect(calls).toBe(0)
    expect(await vfs.read("/fn", "/")).toBe("call 1")
    expect(await vfs.read("/fn", "/")).toBe("call 2")
  })
})

describe("write", () => {
  it("truncates and appends", async () => {
    const { vfs, clock } = world()
    await vfs.write("/tmp/x", "/", "one\n", { mode: "truncate" })
    clock.t = 2_000
    await vfs.write("x", "/tmp", "two\n", { mode: "append" })
    expect(await vfs.read("/tmp/x", "/")).toBe("one\ntwo\n")
    expect(await vfs.stat("/tmp/x", "/")).toMatchObject({ size: 8, mtime: 2_000 })
    await vfs.write("/tmp/x", "/", "three\n", { mode: "truncate" })
    expect(await vfs.read("/tmp/x", "/")).toBe("three\n")
  })

  it("creates a file on append", async () => {
    const { vfs } = world()
    await vfs.write("/tmp/new", "/", "a", { mode: "append" })
    expect(await vfs.read("/tmp/new", "/")).toBe("a")
  })

  it("appends to a file whose content is a function", async () => {
    const { vfs } = world()
    vfs.put("/tmp/fn", { type: "file", content: () => Promise.resolve("base ") })
    await vfs.write("/tmp/fn", "/", "more", { mode: "append" })
    expect(await vfs.read("/tmp/fn", "/")).toBe("base more")
  })

  it("hands data to a dev and discards it without a handler", async () => {
    const { vfs } = world()
    const got: string[] = []
    vfs.put("/dev/log", { type: "dev", write: (data) => got.push(data) })
    await vfs.write("/dev/log", "/", "line", { mode: "append" })
    await vfs.write("/dev/null", "/", "gone", { mode: "truncate" })
    expect(got).toEqual(["line"])
    expect(await vfs.read("/dev/null", "/")).toBe("")
    expect((await vfs.stat("/dev/null", "/")).type).toBe("dev")
  })

  const owners: Array<[name: string, dir: string, uid: number]> = [
    ["the directory's owner", "/home/guest", GUEST],
    ["root in a root directory", "/etc", ROOT],
    ["the host user where anyone may write", "/tmp", GUEST],
  ]
  it.each(owners)("new files are 0644 and dirs 0755, owned by %s", async (_name, dir, uid) => {
    const { vfs } = world()
    await vfs.write("f", dir, "", { mode: "truncate" })
    await vfs.mkdir("d", dir)
    expect(await vfs.stat("f", dir)).toMatchObject({ type: "file", mode: 0o644, uid, gid: uid })
    expect(await vfs.stat("d", dir)).toMatchObject({ type: "dir", mode: 0o755, uid, gid: uid })
  })
})

describe("mkdir and remove", () => {
  it("makes parents", async () => {
    const { vfs } = world()
    await vfs.mkdir("a/b/c", "/tmp", { parents: true })
    expect((await vfs.stat("/tmp/a/b/c", "/")).type).toBe("dir")
    await vfs.mkdir("/tmp/a/b", "/", { parents: true })
    await vfs.mkdir("/", "/", { parents: true })
    expect(await vfs.list("/tmp/a", "/")).toEqual([{ name: "b", type: "dir" }])
  })

  it("removes a file, an empty directory, and a tree", async () => {
    const { vfs } = world()
    await vfs.mkdir("/tmp/a/b", "/", { parents: true })
    await vfs.write("/tmp/a/b/f", "/", "x", { mode: "truncate" })
    await vfs.remove("/tmp/a/b/f", "/")
    await vfs.remove("/tmp/a/b", "/")
    await vfs.mkdir("/tmp/a/c/d", "/", { parents: true })
    await vfs.remove("a", "/tmp", { recursive: true })
    expect(await vfs.list("/tmp", "/")).toEqual([])
  })
})

describe("errors", () => {
  const cases: Array<[name: string, call: Call, errno: string]> = [
    ["stat a missing path", (v) => v.stat("/nope", "/"), "ENOENT"],
    ["stat under a missing directory", (v) => v.stat("/nope/x", "/"), "ENOENT"],
    ["stat through a file", (v) => v.stat("/etc/motd/x", "/"), "ENOTDIR"],
    ["stat an empty path", (v) => v.stat("", "/"), "ENOENT"],
    ["list a missing path", (v) => v.list("/nope", "/"), "ENOENT"],
    ["list a file", (v) => v.list("/etc/motd", "/"), "ENOTDIR"],
    ["list a cmd", (v) => v.list("/bin/echo", "/"), "ENOTDIR"],
    ["read a missing path", (v) => v.read("/nope", "/"), "ENOENT"],
    ["read a directory", (v) => v.read("/etc", "/"), "EISDIR"],
    ["read the root", (v) => v.read("/", "/"), "EISDIR"],
    ["read a cmd", (v) => v.read("/bin/echo", "/"), "EINVAL"],
    ["read through a file", (v) => v.read("/etc/motd/x", "/"), "ENOTDIR"],
    ["write a directory", (v) => v.write("/etc", "/", "x", { mode: "truncate" }), "EISDIR"],
    ["write a cmd", (v) => v.write("/bin/echo", "/", "x", { mode: "truncate" }), "EINVAL"],
    ["write under a missing directory", (v) => v.write("/nope/x", "/", "x", { mode: "truncate" }), "ENOENT"],
    ["write through a file", (v) => v.write("/etc/motd/x", "/", "x", { mode: "append" }), "ENOTDIR"],
    ["mkdir an existing directory", (v) => v.mkdir("/etc", "/"), "EEXIST"],
    ["mkdir an existing file", (v) => v.mkdir("/etc/motd", "/"), "EEXIST"],
    ["mkdir the root", (v) => v.mkdir("/", "/"), "EEXIST"],
    ["mkdir without parents", (v) => v.mkdir("/tmp/a/b", "/"), "ENOENT"],
    ["mkdir through a file", (v) => v.mkdir("/etc/motd/x", "/"), "ENOTDIR"],
    ["mkdir with parents onto a file", (v) => v.mkdir("/etc/motd", "/", { parents: true }), "EEXIST"],
    ["mkdir with parents through a file", (v) => v.mkdir("/etc/motd/x/y", "/", { parents: true }), "ENOTDIR"],
    ["remove a missing path", (v) => v.remove("/nope", "/"), "ENOENT"],
    ["remove a directory with entries", (v) => v.remove("/home", "/"), "ENOTEMPTY"],
    ["remove the root", (v) => v.remove("/", "/", { recursive: true }), "EPERM"],
    ["remove through a file", (v) => v.remove("/etc/motd/x", "/"), "ENOTDIR"],
    ["a file function that throws", (v) => v.read("/broken", "/"), "EIO"],
  ]
  it.each(cases)("%s: %s", async (_name, call, errno) => {
    const { vfs } = world()
    vfs.put("/broken", { type: "file", content: () => { throw new Error("boom") } })
    expect(await errnoOf(call(vfs))).toBe(errno)
  })

  it("reports the path as the caller gave it", async () => {
    const { vfs } = world()
    await expect(vfs.read("nope.txt", "/home/guest")).rejects.toMatchObject({
      name: "RiteError", errno: "ENOENT", path: "nope.txt", message: "no such file or directory",
    })
  })

  const aborted: Array<[name: string, call: (v: Vfs, signal: AbortSignal) => Promise<unknown>]> = [
    ["stat", (v, signal) => v.stat("/etc/motd", "/", { signal })],
    ["list", (v, signal) => v.list("/etc", "/", { signal })],
    ["read", (v, signal) => v.read("/etc/motd", "/", { signal })],
    ["write", (v, signal) => v.write("/tmp/x", "/", "x", { mode: "truncate", signal })],
    ["mkdir", (v, signal) => v.mkdir("/tmp/d", "/", { signal })],
    ["remove", (v, signal) => v.remove("/etc/motd", "/", { signal })],
  ]
  it.each(aborted)("%s with an aborted signal is ECANCELED and does nothing", async (_name, call) => {
    const { vfs } = world()
    expect(await errnoOf(call(vfs, AbortSignal.abort()))).toBe("ECANCELED")
    expect(await vfs.list("/tmp", "/")).toEqual([])
    expect(await vfs.read("/etc/motd", "/")).toBe("welcome\n")
  })
})

describe("caps", () => {
  const options = { maxFileBytes: 10, maxTotalBytes: 25 }

  it("defaults to 1 MiB per file and 8 MiB in total", async () => {
    const { vfs } = world()
    const mib = "x".repeat(1024 * 1024)
    await vfs.write("/tmp/0", "/", mib, { mode: "truncate" })
    expect(await errnoOf(vfs.write("/tmp/0", "/", "x", { mode: "append" }))).toBe("ENOSPC")
    expect(await errnoOf(vfs.write("/tmp/big", "/", mib + "x", { mode: "truncate" }))).toBe("ENOSPC")
    for (let i = 1; i < 8; i++) await vfs.write(`/tmp/${i}`, "/", mib, { mode: "truncate" })
    expect(await errnoOf(vfs.write("/tmp/8", "/", "x", { mode: "truncate" }))).toBe("ENOSPC")
    expect(await vfs.list("/tmp", "/")).toHaveLength(8)
  })

  const perFile: Array<[name: string, data: string, mode: "truncate" | "append", errno: string]> = [
    ["at the cap", "0123456789", "truncate", "OK"],
    ["one over", "0123456789a", "truncate", "ENOSPC"],
    ["counted in UTF-8 bytes", "éééééé", "truncate", "ENOSPC"],
    ["five two-byte characters fit", "ééééé", "truncate", "OK"],
    ["append to the cap", "56789", "append", "OK"],
    ["append over the cap", "567890", "append", "ENOSPC"],
  ]
  it.each(perFile)("per file: %s", async (_name, data, mode, errno) => {
    const { vfs } = world(options)
    await vfs.write("/tmp/f", "/", "01234", { mode: "truncate" })
    expect(await errnoOf(vfs.write("/tmp/f", "/", data, { mode }))).toBe(errno)
    if (errno === "ENOSPC") expect(await vfs.read("/tmp/f", "/")).toBe("01234")
  })

  it("refuses a new file over the cap without creating it", async () => {
    const { vfs } = world(options)
    expect(await errnoOf(vfs.write("/tmp/f", "/", "0123456789a", { mode: "truncate" }))).toBe("ENOSPC")
    expect(await errnoOf(vfs.stat("/tmp/f", "/"))).toBe("ENOENT")
  })

  it("counts the total, and gives space back on truncate and remove", async () => {
    const { vfs } = world(options)
    const ten = "0123456789"
    await vfs.write("/tmp/a", "/", ten, { mode: "truncate" })
    await vfs.write("/tmp/b", "/", ten, { mode: "truncate" })
    expect(await errnoOf(vfs.write("/tmp/c", "/", "012345", { mode: "truncate" }))).toBe("ENOSPC")
    await vfs.write("/tmp/c", "/", "01234", { mode: "truncate" })
    expect(await errnoOf(vfs.write("/tmp/d", "/", "x", { mode: "truncate" }))).toBe("ENOSPC")
    await vfs.write("/tmp/a", "/", "", { mode: "truncate" })
    await vfs.write("/tmp/d", "/", ten, { mode: "truncate" })
    expect(await errnoOf(vfs.write("/tmp/e", "/", "x", { mode: "truncate" }))).toBe("ENOSPC")
    await vfs.remove("/tmp/b", "/")
    await vfs.write("/tmp/e", "/", ten, { mode: "truncate" })
    await vfs.mkdir("/tmp/sub", "/")
    await vfs.remove("/tmp", "/", { recursive: true })
    await vfs.mkdir("/tmp", "/")
    await vfs.write("/tmp/f", "/", ten, { mode: "truncate" })
    await vfs.write("/tmp/g", "/", ten, { mode: "truncate" })
    await vfs.write("/tmp/h", "/", "01234", { mode: "truncate" })
  })

  it("rewrites a file in place when the total is nearly full", async () => {
    const { vfs } = world(options)
    await vfs.write("/tmp/a", "/", "0123456789", { mode: "truncate" })
    await vfs.write("/tmp/b", "/", "0123456789", { mode: "truncate" })
    await vfs.write("/tmp/a", "/", "9876543210", { mode: "truncate" })
    await vfs.write("/tmp/b", "/", "", { mode: "truncate" })
    await vfs.write("/tmp/a", "/", "", { mode: "truncate" })
    await vfs.write("/tmp/a", "/", "01234", { mode: "append" })
    await vfs.write("/tmp/a", "/", "56789", { mode: "append" })
    expect(await vfs.read("/tmp/a", "/")).toBe("0123456789")
  })

  it("does not cap or count what put stores, until a write replaces it", async () => {
    const { vfs } = world(options)
    vfs.put("/big", { type: "file", content: "x".repeat(100) })
    expect((await vfs.stat("/big", "/")).size).toBe(100)
    await vfs.write("/tmp/a", "/", "0123456789", { mode: "truncate" })
    await vfs.write("/tmp/b", "/", "0123456789", { mode: "truncate" })
    expect(await errnoOf(vfs.write("/big", "/", "x", { mode: "append" }))).toBe("ENOSPC")
    await vfs.write("/big", "/", "01234", { mode: "truncate" })
    expect(await errnoOf(vfs.write("/tmp/c", "/", "x", { mode: "truncate" }))).toBe("ENOSPC")
    vfs.put("/big", { type: "file", content: "replaced" })
    await vfs.write("/tmp/c", "/", "01234", { mode: "truncate" })
  })

  it("does not cap a dev", async () => {
    const { vfs } = world(options)
    await vfs.write("/dev/null", "/", "x".repeat(1000), { mode: "truncate" })
  })
})

describe("put", () => {
  it("creates missing parents and replaces what is there", async () => {
    const vfs = createVfs()
    vfs.put("/a/b/c.txt", { type: "file", content: "one" })
    vfs.put("/a/b/c.txt", { type: "file", content: "two" })
    expect(await vfs.read("/a/b/c.txt", "/")).toBe("two")
    expect(await vfs.stat("/a/b", "/")).toMatchObject({ type: "dir", mode: 0o755, uid: ROOT })
    vfs.put("/a/b", { type: "file", content: "flat" })
    expect(await errnoOf(vfs.stat("/a/b/c.txt", "/"))).toBe("ENOTDIR")
  })

  it("keeps a directory's entries when a dir spec lands on it", async () => {
    const vfs = createVfs()
    vfs.put("/home/guest/a.txt", { type: "file", content: "a" })
    vfs.put("/home/guest", { type: "dir", mode: 0o700, uid: GUEST })
    vfs.put("/", { type: "dir", mode: 0o711 })
    expect(await vfs.read("/home/guest/a.txt", "/")).toBe("a")
    expect(await vfs.stat("/home/guest", "/")).toMatchObject({ mode: 0o700, uid: GUEST })
    expect((await vfs.stat("/", "/")).mode).toBe(0o711)
  })

  const errors: Array<[name: string, path: string, spec: InodeSpec, errno: string]> = [
    ["a file on the root", "/", { type: "file", content: "" }, "EINVAL"],
    ["under a file", "/etc/motd/x", { type: "file", content: "" }, "ENOTDIR"],
  ]
  it.each(errors)("refuses %s", (_name, path, spec, errno) => {
    const { vfs } = world()
    expect(thrownErrno(() => { vfs.put(path, spec) })).toBe(errno)
  })
})
