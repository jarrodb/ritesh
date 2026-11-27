import { describe, expect, it } from "vitest"
import { type MountProvider, RiteError, type Vfs } from "../../src/contracts.js"
import { errnoOf, FakeProvider, GUEST, ROOT, thrownErrno, world } from "./support.js"

const FILES = { "a.txt": "alpha", docs: null, "docs/b.txt": "beta", "docs/deep": null, "docs/deep/c.txt": "gamma" }

function mounted(options: { readonly?: boolean } = {}) {
  const w = world()
  const provider = new FakeProvider(FILES, options)
  w.vfs.mount("/mnt", provider)
  return { ...w, provider }
}

describe("mounts", () => {
  const routes: Array<[name: string, call: (v: Vfs) => Promise<unknown>, log: string]> = [
    ["stat the mount point", (v) => v.stat("/mnt", "/"), "stat "],
    ["stat a file", (v) => v.stat("/mnt/a.txt", "/"), "stat a.txt"],
    ["stat relative to a cwd in the mount", (v) => v.stat("deep/c.txt", "/mnt/docs"), "stat docs/deep/c.txt"],
    ["stat with dot-dot back into the mount", (v) => v.stat("../mnt/docs/../a.txt", "/tmp"), "stat a.txt"],
    ["list the mount point", (v) => v.list("/mnt/", "/"), "list "],
    ["list a directory", (v) => v.list("docs", "/mnt"), "list docs"],
    ["read a file", (v) => v.read("/mnt/docs/b.txt", "/"), "read docs/b.txt"],
    ["read through a link into the mount", (v) => v.read("/home/guest/into/b.txt", "/"), "read docs/b.txt"],
  ]
  it.each(routes)("%s goes to the provider as %j", async (_name, call, log) => {
    const { vfs, provider } = mounted()
    vfs.put("/home/guest/into", { type: "link", target: "/mnt/docs" })
    await call(vfs)
    expect(provider.log).toEqual([log])
  })

  it("answers from the provider, with the mount on each stat and listings sorted", async () => {
    const { vfs } = mounted()
    expect(await vfs.stat("/mnt/a.txt", "/")).toEqual({ type: "file", mode: 0o644, uid: ROOT, gid: ROOT, size: 5, mtime: 7, mount: "/mnt" })
    expect((await vfs.stat("/mnt", "/")).mount).toBe("/mnt")
    expect(await vfs.list("/mnt", "/")).toEqual([{ name: "a.txt", type: "file" }, { name: "docs", type: "dir" }])
    expect(await vfs.read("/mnt/docs/deep/c.txt", "/")).toBe("gamma")
    expect((await vfs.stat("/etc/motd", "/")).mount).toBeUndefined()
  })

  it("shows a mount point in its parent as a directory and makes missing parents", async () => {
    const { vfs } = world()
    const provider = new FakeProvider(FILES)
    vfs.put("/tenants", { type: "file", content: "shadowed while mounted" })
    vfs.mount("/tenants", provider)
    vfs.mount("/srv/remote/one", new FakeProvider())
    expect(await vfs.list("/", "/")).toContainEqual({ name: "tenants", type: "dir" })
    expect((await vfs.list("/", "/")).filter((e) => e.name === "tenants")).toHaveLength(1)
    expect(await vfs.list("/srv/remote", "/")).toEqual([{ name: "one", type: "dir" }])
    expect(await vfs.stat("/srv", "/")).toMatchObject({ type: "dir", mode: 0o755, uid: ROOT })
    expect(provider.total).toBe(0)
  })

  const refused: Array<[name: string, call: (v: Vfs) => void, errno: string]> = [
    ["mount on the root", (v) => { v.mount("/", new FakeProvider()) }, "EINVAL"],
    ["mount twice on one path", (v) => { v.mount("/mnt/", new FakeProvider()) }, "EEXIST"],
    ["mount inside a mount", (v) => { v.mount("/mnt/docs/inner", new FakeProvider()) }, "ENOTSUP"],
    ["mount above a mount", (v) => { v.mount("/outer", new FakeProvider()) }, "ENOTSUP"],
    ["mount under a file", (v) => { v.mount("/etc/motd/x", new FakeProvider()) }, "ENOTDIR"],
    ["unmount a path that is not mounted", (v) => { v.unmount("/etc") }, "EINVAL"],
    ["unmount a path in a mount", (v) => { v.unmount("/mnt/docs") }, "ENOTSUP"],
    ["put inside a mount", (v) => { v.put("/mnt/new.txt", { type: "file", content: "" }) }, "ENOTSUP"],
    ["put on a mount point", (v) => { v.put("/mnt", { type: "dir" }) }, "ENOTSUP"],
    ["put a file over a directory that holds a mount", (v) => { v.put("/outer", { type: "file", content: "" }) }, "EPERM"],
  ]
  it.each(refused)("refuses to %s: %s", (_name, call, errno) => {
    const { vfs, provider } = mounted()
    vfs.mount("/outer/inner", new FakeProvider())
    expect(thrownErrno(() => { call(vfs) })).toBe(errno)
    expect(provider.total).toBe(0)
  })

  it("keeps a mount in place when its parent is removed", async () => {
    const { vfs } = world()
    vfs.mount("/srv/one", new FakeProvider(FILES))
    expect(await errnoOf(vfs.remove("/srv", "/", { recursive: true }))).toBe("EPERM")
    expect(await errnoOf(vfs.remove("/srv", "/"))).toBe("EPERM")
    expect(await vfs.read("/srv/one/a.txt", "/")).toBe("alpha")
  })

  it("unmounts: the watcher is released and the path goes back to the local tree", async () => {
    const { vfs, provider } = mounted()
    vfs.put("/tenants", { type: "file", content: "local" })
    const other = new FakeProvider()
    vfs.mount("/tenants", other)
    await vfs.stat("/mnt/a.txt", "/")
    vfs.unmount("/mnt")
    vfs.unmount("/tenants")
    expect(provider.unsubscribed).toBe(1)
    expect(other.unsubscribed).toBe(1)
    expect(await errnoOf(vfs.stat("/mnt/a.txt", "/"))).toBe("ENOENT")
    expect(vfs.peek("/mnt/a.txt", "/")).toBeUndefined()
    expect(await vfs.read("/tenants", "/")).toBe("local")
    expect(await vfs.list("/", "/")).not.toContainEqual({ name: "mnt", type: "dir" })
    expect(provider.log).toEqual(["stat a.txt"])
  })

  it("mounts through a link under the directory's real path", async () => {
    const { vfs } = world()
    const provider = new FakeProvider(FILES)
    vfs.put("/alias", { type: "link", target: "/srv" })
    vfs.mount("/alias/data", provider)
    expect(await vfs.read("/srv/data/a.txt", "/")).toBe("alpha")
    expect(await vfs.read("/alias/data/a.txt", "/")).toBe("alpha")
    expect((await vfs.stat("/alias/data", "/")).mount).toBe("/srv/data")
    vfs.unmount("/alias/data")
    expect(provider.unsubscribed).toBe(1)
  })
})

describe("mount cache", () => {
  const ops: Array<[name: "stat" | "list", call: (v: Vfs) => Promise<unknown>]> = [
    ["stat", (v) => v.stat("/mnt/docs", "/")],
    ["list", (v) => v.list("/mnt/docs", "/")],
  ]
  it.each(ops)("serves %s from the cache for 30 s", async (op, call) => {
    const { vfs, provider, clock } = mounted()
    const first = await call(vfs)
    expect(await call(vfs)).toEqual(first)
    clock.t += 29_999
    expect(await call(vfs)).toEqual(first)
    expect(provider.calls[op]).toBe(1)
    clock.t += 1
    await call(vfs)
    expect(provider.calls[op]).toBe(2)
    clock.t += 29_999
    await call(vfs)
    expect(provider.calls[op]).toBe(2)
    expect(provider.total).toBe(2)
  })

  it("keeps stat and list apart, per path", async () => {
    const { vfs, provider } = mounted()
    await vfs.stat("/mnt/docs", "/")
    await vfs.list("/mnt/docs", "/")
    await vfs.stat("/mnt/a.txt", "/")
    await vfs.stat("a.txt", "/mnt")
    await vfs.list("/mnt", "/")
    expect(provider.log).toEqual(["stat docs", "list docs", "stat a.txt", "list "])
  })

  it("does not cache read, or a failed stat", async () => {
    const { vfs, provider } = mounted()
    await vfs.read("/mnt/a.txt", "/")
    await vfs.read("/mnt/a.txt", "/")
    expect(await errnoOf(vfs.stat("/mnt/nope", "/"))).toBe("ENOENT")
    provider.set("nope", "here now")
    expect((await vfs.stat("/mnt/nope", "/")).size).toBe(8)
    expect(provider.calls).toMatchObject({ read: 2, stat: 2 })
  })

  it("hands out copies, so a caller cannot change the cache", async () => {
    const { vfs } = mounted()
    // The first answer of each comes from the provider, the second from the cache.
    for (let i = 0; i < 2; i++) {
      const stat = await vfs.stat("/mnt/a.txt", "/")
      const entries = await vfs.list("/mnt", "/")
      stat.size = 999
      entries.pop()
      const [first] = entries
      if (first) first.name = "changed"
    }
    expect((await vfs.stat("/mnt/a.txt", "/")).size).toBe(5)
    expect(await vfs.list("/mnt", "/")).toEqual([{ name: "a.txt", type: "file" }, { name: "docs", type: "dir" }])
  })

  const watched: Array<[name: string, changed: string, refetched: string[]]> = [
    ["a file", "docs/b.txt", ["stat docs/b.txt", "list docs"]],
    ["a file, with slashes to trim", "/docs/b.txt/", ["stat docs/b.txt", "list docs"]],
    ["a directory", "docs", ["stat docs", "list docs", "list "]],
    ["the mount root", "", ["stat ", "list "]],
    ["a path that was never cached", "docs/new.txt", ["list docs"]],
  ]
  it.each(watched)("watch drops %s and its parent's listing, and nothing else", async (_name, changed, refetched) => {
    const { vfs, provider } = mounted()
    const touch = async (): Promise<void> => {
      await vfs.stat("/mnt", "/")
      await vfs.stat("/mnt/a.txt", "/")
      await vfs.stat("/mnt/docs", "/")
      await vfs.stat("/mnt/docs/b.txt", "/")
      await vfs.list("/mnt/docs", "/")
      await vfs.list("/mnt", "/")
      await vfs.list("/mnt/docs/deep", "/")
    }
    await touch()
    provider.log.length = 0
    provider.emit(changed)
    await touch()
    expect(provider.log).toEqual(refetched)
  })

  it("shows a change after watch reports it", async () => {
    const { vfs, provider } = mounted()
    expect((await vfs.list("/mnt/docs", "/")).map((e) => e.name)).toEqual(["b.txt", "deep"])
    provider.set("docs/new.txt", "new")
    expect((await vfs.list("/mnt/docs", "/")).map((e) => e.name)).toEqual(["b.txt", "deep"])
    provider.emit("docs/new.txt")
    expect((await vfs.list("/mnt/docs", "/")).map((e) => e.name)).toEqual(["b.txt", "deep", "new.txt"])
  })

  it("works with a provider that has no watch", async () => {
    const { vfs } = world()
    const inner = new FakeProvider(FILES)
    const provider: MountProvider = {
      readonly: true,
      stat: (rel, o) => inner.stat(rel, o),
      list: (rel, o) => inner.list(rel, o),
      read: (rel, o) => inner.read(rel, o),
    }
    vfs.mount("/plain", provider)
    expect(await vfs.read("/plain/a.txt", "/")).toBe("alpha")
    vfs.unmount("/plain")
  })
})

describe("peek in a mount", () => {
  it("never calls the provider", async () => {
    const { vfs, provider, clock } = mounted()
    for (const path of ["/mnt", "/mnt/a.txt", "/mnt/docs", "/mnt/docs/b.txt", "/mnt/nope", "/mnt/docs/deep/c.txt"]) vfs.peek(path, "/")
    expect(provider.total).toBe(0)
    await vfs.stat("/mnt/a.txt", "/")
    await vfs.list("/mnt/docs", "/")
    const before = provider.total
    for (const path of ["/mnt", "/mnt/a.txt", "/mnt/docs", "/mnt/docs/b.txt", "/mnt/nope", "/mnt/docs/deep/c.txt"]) vfs.peek(path, "/")
    clock.t += 60_000
    for (const path of ["/mnt", "/mnt/a.txt", "/mnt/docs/b.txt"]) vfs.peek(path, "/")
    expect(provider.total).toBe(before)
  })

  it("answers from what the cache holds", async () => {
    const { vfs, provider, clock } = mounted()
    provider.set("a.txt", "alpha", 0o600, GUEST)
    expect(vfs.peek("/mnt", "/")).toEqual({ type: "dir", mode: 0o755, uid: ROOT })
    expect(vfs.peek("/mnt/a.txt", "/")).toBeUndefined()
    expect(vfs.peek("/mnt/docs/b.txt", "/")).toBeUndefined()

    await vfs.stat("/mnt/a.txt", "/")
    expect(vfs.peek("a.txt", "/mnt")).toEqual({ type: "file", mode: 0o600, uid: GUEST })

    await vfs.list("/mnt/docs", "/")
    expect(vfs.peek("/mnt/docs/b.txt", "/")?.type).toBe("file")
    expect(vfs.peek("/mnt/docs/deep", "/")?.type).toBe("dir")
    expect(vfs.peek("/mnt/docs/nope", "/")).toBeUndefined()
    expect(vfs.peek("/mnt/docs/deep/c.txt", "/")).toBeUndefined()

    provider.emit("a.txt")
    expect(vfs.peek("/mnt/a.txt", "/")).toBeUndefined()
    clock.t += 30_000
    expect(vfs.peek("/mnt/docs/b.txt", "/")).toBeUndefined()
    expect(vfs.peek("/mnt", "/")?.type).toBe("dir")
  })
})

describe("writes in a mount", () => {
  const readonly: Array<[name: string, call: (v: Vfs) => Promise<unknown>]> = [
    ["write", (v) => v.write("/mnt/a.txt", "/", "x", { mode: "truncate" })],
    ["append", (v) => v.write("/mnt/new.txt", "/", "x", { mode: "append" })],
    ["mkdir", (v) => v.mkdir("/mnt/dir", "/")],
    ["mkdir with parents", (v) => v.mkdir("/mnt/dir/sub", "/", { parents: true })],
    ["remove", (v) => v.remove("/mnt/a.txt", "/")],
    ["remove a tree", (v) => v.remove("/mnt/docs", "/", { recursive: true })],
    ["a check for write access", (v) => v.access("/mnt/a.txt", "/", ROOT, "w")],
  ]
  it.each(readonly)("a read-only provider answers EROFS for %s", async (_name, call) => {
    const { vfs, provider } = mounted({ readonly: true })
    expect(await errnoOf(call(vfs))).toBe("EROFS")
    expect(provider.calls).toMatchObject({ write: 0, mkdir: 0, remove: 0 })
    expect(await vfs.read("/mnt/a.txt", "/")).toBe("alpha")
  })

  it("a writable provider without the method answers ENOTSUP", async () => {
    const { vfs } = world()
    const inner = new FakeProvider(FILES)
    vfs.mount("/bare", {
      readonly: false,
      stat: (rel, o) => inner.stat(rel, o),
      list: (rel, o) => inner.list(rel, o),
      read: (rel, o) => inner.read(rel, o),
    })
    expect(await errnoOf(vfs.write("/bare/a.txt", "/", "x", { mode: "truncate" }))).toBe("ENOTSUP")
    expect(await errnoOf(vfs.mkdir("/bare/dir", "/"))).toBe("ENOTSUP")
    expect(await errnoOf(vfs.remove("/bare/a.txt", "/"))).toBe("ENOTSUP")
  })

  it("writes through and drops the cached stat and parent listing", async () => {
    const { vfs, provider } = mounted()
    await vfs.stat("/mnt/docs/b.txt", "/")
    await vfs.list("/mnt/docs", "/")
    await vfs.write("/mnt/docs/b.txt", "/", "+more", { mode: "append" })
    await vfs.write("new.txt", "/mnt/docs", "new", { mode: "truncate" })
    expect(provider.log.slice(2)).toEqual(["write docs/b.txt", "write docs/new.txt"])
    expect((await vfs.stat("/mnt/docs/b.txt", "/")).size).toBe(9)
    expect((await vfs.list("/mnt/docs", "/")).map((e) => e.name)).toEqual(["b.txt", "deep", "new.txt"])
    expect(await vfs.read("/mnt/docs/b.txt", "/")).toBe("beta+more")
  })

  it("is not held to the local caps", async () => {
    const w = world({ maxFileBytes: 4, maxTotalBytes: 4 })
    w.vfs.mount("/mnt", new FakeProvider())
    await w.vfs.write("/mnt/big", "/", "0123456789", { mode: "truncate" })
    await w.vfs.write("/tmp/x", "/", "0123", { mode: "truncate" })
  })

  const mkdirs: Array<[name: string, path: string, parents: boolean, errno: string, log: string[]]> = [
    ["one level", "/mnt/new", false, "OK", ["mkdir new"]],
    ["the mount point", "/mnt", false, "EEXIST", []],
    ["the mount point with parents", "/mnt", true, "OK", []],
    ["missing levels with parents", "/mnt/docs/x/y", true, "OK", ["stat docs", "stat docs/x", "mkdir docs/x", "stat docs/x/y", "mkdir docs/x/y"]],
    ["an existing directory with parents", "/mnt/docs/deep", true, "OK", ["stat docs", "stat docs/deep"]],
    ["onto a file with parents", "/mnt/a.txt", true, "EEXIST", ["stat a.txt"]],
    ["through a file with parents", "/mnt/a.txt/x", true, "ENOTDIR", ["stat a.txt"]],
  ]
  it.each(mkdirs)("mkdir %s: %s", async (_name, path, parents, errno, log) => {
    const { vfs, provider } = mounted()
    expect(await errnoOf(vfs.mkdir(path, "/", { parents }))).toBe(errno)
    expect(provider.log).toEqual(log)
  })

  it("mkdir with parents crosses from the local tree into a mount", async () => {
    const { vfs } = world()
    const provider = new FakeProvider()
    vfs.mount("/srv/data", provider)
    await vfs.mkdir("/srv/data/a/b", "/", { parents: true })
    await vfs.mkdir("/srv/local/a", "/", { parents: true })
    expect(provider.log.filter((line) => line.startsWith("mkdir"))).toEqual(["mkdir a", "mkdir a/b"])
    expect((await vfs.list("/srv", "/")).map((e) => e.name)).toEqual(["data", "local"])
  })

  it("mkdir shows in a listing cached before it", async () => {
    const { vfs } = mounted()
    await vfs.list("/mnt", "/")
    await vfs.mkdir("/mnt/new", "/")
    expect((await vfs.list("/mnt", "/")).map((e) => e.name)).toEqual(["a.txt", "docs", "new"])
  })

  const removes: Array<[name: string, path: string, recursive: boolean, errno: string, removed: string[]]> = [
    ["a file", "/mnt/a.txt", false, "OK", ["remove a.txt"]],
    ["an empty directory", "/mnt/empty", false, "OK", ["remove empty"]],
    ["a directory with entries", "/mnt/docs", false, "ENOTEMPTY", []],
    ["a tree, deepest first", "/mnt/docs", true, "OK", ["remove docs/deep/c.txt", "remove docs/deep", "remove docs/b.txt", "remove docs"]],
    ["a missing path", "/mnt/nope", true, "ENOENT", []],
    ["the mount point", "/mnt", true, "EPERM", []],
  ]
  it.each(removes)("remove %s: %s", async (_name, path, recursive, errno, removed) => {
    const { vfs, provider } = mounted()
    provider.set("empty", null)
    expect(await errnoOf(vfs.remove(path, "/", { recursive }))).toBe(errno)
    expect(provider.log.filter((line) => line.startsWith("remove"))).toEqual(removed)
  })

  it("remove drops everything cached under the path", async () => {
    const { vfs, provider } = mounted()
    await vfs.stat("/mnt/docs/deep/c.txt", "/")
    await vfs.list("/mnt/docs/deep", "/")
    await vfs.list("/mnt", "/")
    await vfs.remove("/mnt/docs", "/", { recursive: true })
    expect(vfs.peek("/mnt/docs/deep/c.txt", "/")).toBeUndefined()
    expect(vfs.peek("/mnt/docs", "/")).toBeUndefined()
    expect(await errnoOf(vfs.stat("/mnt/docs/deep/c.txt", "/"))).toBe("ENOENT")
    expect(await vfs.list("/mnt", "/")).toEqual([{ name: "a.txt", type: "file" }])
    expect(provider.nodes.size).toBe(2)
  })
})

describe("provider errors and signals", () => {
  const failures: Array<[name: string, thrown: unknown, errno: string, message: string]> = [
    ["a RiteError", new RiteError("EACCES", "provider/path"), "EACCES", "permission denied"],
    ["a RiteError with its own message", new RiteError("ENOTCONN", undefined, "sandbox is offline"), "ENOTCONN", "sandbox is offline"],
    ["an errno from another copy of the package", Object.assign(new Error("gone"), { errno: "ETIMEDOUT" }), "ETIMEDOUT", "gone"],
    ["an Error", new Error("socket closed"), "EIO", "socket closed"],
    ["an unknown errno", Object.assign(new Error("odd"), { errno: "EWHATEVER" }), "EIO", "odd"],
    ["a thrown string", "nope", "EIO", "input/output error"],
  ]
  it.each(failures)("%s leaves as a RiteError with the caller's path", async (_name, thrown, errno, message) => {
    const { vfs } = world()
    const fail = (): Promise<never> => new Promise(() => { throw thrown })
    vfs.mount("/bad", { readonly: true, stat: fail, list: fail, read: fail })
    for (const call of [() => vfs.stat("x", "/bad"), () => vfs.list("x", "/bad"), () => vfs.read("x", "/bad")]) {
      await expect(call()).rejects.toBeInstanceOf(RiteError)
      await expect(call()).rejects.toMatchObject({ errno, path: "x", message })
    }
  })

  it("passes the signal to the provider and nothing else", async () => {
    const { vfs, provider } = mounted()
    const { signal } = new AbortController()
    await vfs.stat("/mnt/a.txt", "/", { signal })
    await vfs.list("/mnt", "/", { signal })
    await vfs.read("/mnt/a.txt", "/", { signal })
    await vfs.mkdir("/mnt/x/y", "/", { signal, parents: true })
    await vfs.read("/mnt/a.txt", "/")
    expect(provider.signals.slice(0, -1).every((s) => s === signal)).toBe(true)
    expect(provider.signals.at(-1)).toBeUndefined()
  })

  it("is ECANCELED before any provider call when the signal is already aborted", async () => {
    const { vfs, provider } = mounted()
    const signal = AbortSignal.abort()
    expect(await errnoOf(vfs.stat("/mnt/a.txt", "/", { signal }))).toBe("ECANCELED")
    expect(await errnoOf(vfs.read("/mnt/a.txt", "/", { signal }))).toBe("ECANCELED")
    expect(await errnoOf(vfs.write("/mnt/a.txt", "/", "x", { mode: "truncate", signal }))).toBe("ECANCELED")
    expect(provider.total).toBe(0)
  })

  it("is ECANCELED when the provider fails after an abort", async () => {
    const { vfs } = world()
    const controller = new AbortController()
    const read = (): Promise<string> => new Promise(() => {
      controller.abort()
      throw new DOMException("aborted", "AbortError")
    })
    const inner = new FakeProvider()
    vfs.mount("/slow", { readonly: true, stat: (rel, o) => inner.stat(rel, o), list: (rel, o) => inner.list(rel, o), read })
    expect(await errnoOf(vfs.read("/slow/x", "/", { signal: controller.signal }))).toBe("ECANCELED")
  })
})

describe("access in a mount", () => {
  const cases: Array<[name: string, path: string, uid: number, want: "r" | "w" | "x", allowed: boolean]> = [
    ["another user reads a 0644 file", "/mnt/a.txt", GUEST, "r", true],
    ["another user cannot write a 0644 file", "/mnt/a.txt", GUEST, "w", false],
    ["root writes it", "/mnt/a.txt", ROOT, "w", true],
    ["the owner writes its 0600 file", "/mnt/mine.txt", GUEST, "w", true],
    ["another user enters the mount point", "/mnt", GUEST, "x", true],
    ["a 0700 dir keeps another user out", "/mnt/closed", GUEST, "x", false],
    ["a file under a 0700 dir is out of reach", "/mnt/closed/in.txt", GUEST, "r", false],
    ["root reaches under a 0700 dir", "/mnt/closed/in.txt", ROOT, "r", true],
  ]
  it.each(cases)("%s", async (_name, path, uid, want, allowed) => {
    const { vfs, provider } = mounted()
    provider.set("mine.txt", "mine", 0o600, GUEST)
    provider.set("closed", null, 0o700)
    provider.set("closed/in.txt", "in")
    expect(await vfs.access(path, "/", uid, want)).toBe(allowed)
    expect(provider.calls).toMatchObject({ read: 0, list: 0, write: 0 })
  })

  it("is closed off by a local directory above the mount", async () => {
    const { vfs } = world()
    const provider = new FakeProvider(FILES)
    vfs.mount("/root/vault", provider)
    expect(await vfs.access("/root/vault/a.txt", "/", GUEST, "r")).toBe(false)
    expect(await vfs.access("/root/vault/a.txt", "/", ROOT, "r")).toBe(true)
    expect(provider.log).toEqual(["stat a.txt"])
  })

  it("uses the stat cache and rejects for a missing path", async () => {
    const { vfs, provider } = mounted()
    await vfs.access("/mnt/docs/b.txt", "/", GUEST, "r")
    await vfs.access("/mnt/docs/b.txt", "/", GUEST, "w")
    await vfs.stat("/mnt/docs", "/")
    expect(provider.log).toEqual(["stat ", "stat docs", "stat docs/b.txt"])
    expect(await errnoOf(vfs.access("/mnt/nope", "/", GUEST, "r"))).toBe("ENOENT")
  })
})
