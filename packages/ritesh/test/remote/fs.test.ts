// The read-only mount: fs.* mapping, errors, EROFS, the cache, fs.changed.
import { describe, expect, it } from "vitest"
import { RiteError } from "../../src/contracts.js"
import { CACHE_TTL_MS } from "../../src/remote/fs.js"
import { accept, connected, failure, type FakeSocket, idOf, methodOf, note, paramsOf, result, rig, settle } from "./support.js"

const FILE = { type: "file", size: 26, mode: 0o644, mtime: 1_700_000_000_000 }
const DIR = { type: "dir", size: 0, mode: 0o755, mtime: 0 }

/** Answers the next request, which must be `method` for `path`. */
async function answer(socket: FakeSocket, method: string, path: string, value: unknown): Promise<void> {
  const frame = await socket.take()
  expect([methodOf(frame), paramsOf(frame).path]).toEqual([method, path])
  socket.receive(result(idOf(frame), value))
}

async function rejection(promise: Promise<unknown>): Promise<RiteError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof RiteError) return error
    throw error
  }
  throw new Error("expected a rejection")
}

describe("remote provider", () => {
  it("is read-only: write, mkdir, and remove fail EROFS without a request or a connection", async () => {
    const { client, net, clock, tokens } = rig()
    const { provider } = client
    expect(provider.readonly).toBe(true)
    const errors = [
      await rejection(provider.write?.("docs/a.md", "x", { mode: "truncate" }) ?? Promise.resolve()),
      await rejection(provider.write?.("new.txt", "x", { mode: "append" }) ?? Promise.resolve()),
      await rejection(provider.mkdir?.("dir", {}) ?? Promise.resolve()),
      await rejection(provider.remove?.("docs", {}) ?? Promise.resolve()),
    ]
    expect(errors.map((e) => [e.errno, e.path])).toEqual([["EROFS", "docs/a.md"], ["EROFS", "new.txt"], ["EROFS", "dir"], ["EROFS", "docs"]])
    await clock.tick(1000)
    expect(net.sockets).toHaveLength(0)
    expect(tokens()).toBe(0)
  })

  it("does not send a write over an open connection either", async () => {
    const { client, socket } = await connected()
    await rejection(client.provider.write?.("x", "y", { mode: "truncate" }) ?? Promise.resolve())
    await settle()
    expect(socket.untaken).toEqual([])
  })

  it("maps stat, list, and read; paths are relative to the mount root", async () => {
    const { client, socket } = await connected()
    const stat = client.provider.stat("readme.txt", {})
    await answer(socket, "fs.stat", "readme.txt", FILE)
    expect(await stat).toEqual({ type: "file", size: 26, mode: 0o644, mtime: 1_700_000_000_000, uid: 1000, gid: 1000 })

    const root = client.provider.list("", {})
    await answer(socket, "fs.list", "", { entries: [{ name: "docs", type: "dir" }, { name: "readme.txt", type: "file" }], truncated: false })
    expect(await root).toEqual([{ name: "docs", type: "dir" }, { name: "readme.txt", type: "file" }])

    const read = client.provider.read("docs/a.md", {})
    const frame = await socket.take()
    expect(frame).toEqual({ jsonrpc: "2.0", id: idOf(frame), method: "fs.read", params: { path: "docs/a.md" } })
    socket.receive(result(idOf(frame), { data: "# a\n", eof: true }))
    expect(await read).toBe("# a\n")
  })

  it("reads on by byte offset until eof", async () => {
    const { client, socket } = await connected()
    const read = client.provider.read("big.txt", {})
    const first = await socket.take()
    expect(paramsOf(first)).toEqual({ path: "big.txt" })
    socket.receive(result(idOf(first), { data: "héllo ", eof: false }))
    const second = await socket.take()
    // "héllo " is 7 bytes of UTF-8.
    expect(paramsOf(second)).toEqual({ path: "big.txt", offset: 7 })
    socket.receive(result(idOf(second), { data: "wörld", eof: false }))
    const third = await socket.take()
    expect(paramsOf(third)).toEqual({ path: "big.txt", offset: 13 })
    socket.receive(result(idOf(third), { data: "", eof: true }))
    expect(await read).toBe("héllo wörld")
  })

  it("stops a read that makes no progress", async () => {
    const { client, socket } = await connected()
    const read = client.provider.read("stuck", {})
    const frame = await socket.take()
    socket.receive(result(idOf(frame), { data: "", eof: false }))
    expect((await rejection(read)).errno).toBe("EIO")
    await settle()
    expect(socket.untaken).toEqual([])
  })

  it("turns application errors into RiteError with the server's errno and path", async () => {
    const { client, socket } = await connected()
    const cases: Array<[Record<string, unknown> | undefined, string, string | undefined]> = [
      [{ errno: "ENOENT", path: "missing" }, "ENOENT", "missing"],
      [{ errno: "EACCES", path: "elsewhere" }, "EACCES", "elsewhere"],
      // Without data.path the path asked for stands in.
      [{ errno: "EISDIR" }, "EISDIR", "asked"],
      // An errno outside the shared set is not passed on.
      [{ errno: "EWHATEVER", path: "x" }, "EIO", "asked"],
      [undefined, "EIO", "asked"],
    ]
    for (const [data, errno, path] of cases) {
      const stat = client.provider.stat("asked", {})
      const frame = await socket.take()
      socket.receive(failure(idOf(frame), -32000, "server text", data))
      const error = await rejection(stat)
      expect([error.errno, error.path]).toEqual([errno, path])
    }
    const stat = client.provider.stat("asked", {})
    socket.receive(failure(idOf(await socket.take()), -32602, "invalid params"))
    expect((await rejection(stat)).errno).toBe("EINVAL")
  })

  it("rejects a malformed result as EIO", async () => {
    const { client, socket } = await connected()
    const stat = client.provider.stat("a", {})
    socket.receive(result(idOf(await socket.take()), { type: "socket", size: 1, mode: 1, mtime: 1 }))
    expect((await rejection(stat)).errno).toBe("EIO")
    const list = client.provider.list("a", {})
    socket.receive(result(idOf(await socket.take()), { entries: [{ name: 5, type: "file" }], truncated: false }))
    expect((await rejection(list)).errno).toBe("EIO")
    const read = client.provider.read("a", {})
    socket.receive(result(idOf(await socket.take()), { data: 5, eof: true }))
    expect((await rejection(read)).errno).toBe("EIO")
  })
})

describe("stat and list cache", () => {
  it("answers from the cache for 30 s, then asks again", async () => {
    const { client, clock, socket } = await connected({ connect: "eager" })
    const first = client.provider.stat("readme.txt", {})
    await answer(socket, "fs.stat", "readme.txt", FILE)
    const listed = client.provider.list("docs", {})
    await answer(socket, "fs.list", "docs", { entries: [{ name: "a.md", type: "file" }], truncated: false })
    await first
    await listed

    await clock.tick(CACHE_TTL_MS - 1)
    expect((await client.provider.stat("readme.txt", {})).size).toBe(26)
    expect(await client.provider.list("docs", {})).toEqual([{ name: "a.md", type: "file" }])
    await settle()
    expect(socket.untaken).toEqual([])

    await clock.tick(1)
    const again = client.provider.stat("readme.txt", {})
    await answer(socket, "fs.stat", "readme.txt", { ...FILE, size: 30 })
    expect((await again).size).toBe(30)
    const relisted = client.provider.list("docs", {})
    await answer(socket, "fs.list", "docs", { entries: [], truncated: false })
    expect(await relisted).toEqual([])
  })

  it("hands out copies: a caller cannot change what is cached", async () => {
    const { client, socket } = await connected()
    const first = client.provider.list("docs", {})
    await answer(socket, "fs.list", "docs", { entries: [{ name: "a.md", type: "file" }], truncated: false })
    const entries = await first
    entries.push({ name: "ghost", type: "file" })
    const firstEntry = entries[0]
    if (firstEntry) firstEntry.name = "renamed"
    expect(await client.provider.list("docs", {})).toEqual([{ name: "a.md", type: "file" }])
  })

  it("does not cache reads or errors", async () => {
    const { client, socket } = await connected()
    for (let i = 0; i < 2; i++) {
      const read = client.provider.read("docs/a.md", {})
      await answer(socket, "fs.read", "docs/a.md", { data: "# a\n", eof: true })
      await read
      const stat = client.provider.stat("missing", {})
      const frame = await socket.take()
      socket.receive(failure(idOf(frame), -32000, "no such file or directory", { errno: "ENOENT", path: "missing" }))
      await rejection(stat)
    }
  })

  it("fs.changed drops the path and its parent listing, and nothing else", async () => {
    const { client, socket } = await connected()
    const warm = async (): Promise<void> => {
      const pending = [
        client.provider.stat("docs/a.md", {}), client.provider.stat("docs", {}), client.provider.stat("docs/b.md", {}),
        client.provider.list("docs", {}), client.provider.list("", {}),
      ]
      await answer(socket, "fs.stat", "docs/a.md", FILE)
      await answer(socket, "fs.stat", "docs", DIR)
      await answer(socket, "fs.stat", "docs/b.md", FILE)
      await answer(socket, "fs.list", "docs", { entries: [{ name: "a.md", type: "file" }, { name: "b.md", type: "file" }], truncated: false })
      await answer(socket, "fs.list", "", { entries: [{ name: "docs", type: "dir" }], truncated: false })
      await Promise.all(pending)
    }
    await warm()
    socket.receive(note("fs.changed", { path: "docs/a.md", kind: "modify" }))
    await settle()

    // Still cached: the sibling, the parent's stat, the root listing.
    await client.provider.stat("docs/b.md", {})
    await client.provider.stat("docs", {})
    await client.provider.list("", {})
    await settle()
    expect(socket.untaken).toEqual([])

    // Dropped: the path's stat and the parent's listing.
    const stat = client.provider.stat("docs/a.md", {})
    await answer(socket, "fs.stat", "docs/a.md", { ...FILE, size: 99 })
    expect((await stat).size).toBe(99)
    const list = client.provider.list("docs", {})
    await answer(socket, "fs.list", "docs", { entries: [], truncated: false })
    expect(await list).toEqual([])
  })

  it("fs.changed on a top-level name drops the root listing; a delete drops what was under it", async () => {
    const { client, socket } = await connected()
    const pending = [client.provider.list("", {}), client.provider.list("docs", {}), client.provider.stat("docs/a.md", {}), client.provider.stat("docsother", {})]
    await answer(socket, "fs.list", "", { entries: [{ name: "docs", type: "dir" }], truncated: false })
    await answer(socket, "fs.list", "docs", { entries: [{ name: "a.md", type: "file" }], truncated: false })
    await answer(socket, "fs.stat", "docs/a.md", FILE)
    await answer(socket, "fs.stat", "docsother", FILE)
    await Promise.all(pending)
    socket.receive(note("fs.changed", { path: "docs", kind: "delete" }))
    await settle()

    await client.provider.stat("docsother", {})
    await settle()
    expect(socket.untaken).toEqual([])
    void client.provider.list("", {}).catch(() => undefined)
    expect(methodOf(await socket.take())).toBe("fs.list")
    void client.provider.list("docs", {}).catch(() => undefined)
    expect(paramsOf(await socket.take()).path).toBe("docs")
    void client.provider.stat("docs/a.md", {}).catch(() => undefined)
    expect(paramsOf(await socket.take()).path).toBe("docs/a.md")
  })

  it("a result requested before fs.changed is returned but not cached", async () => {
    const { client, socket } = await connected()
    const stale = client.provider.stat("docs/a.md", {})
    const frame = await socket.take()
    socket.receive(note("fs.changed", { path: "docs/a.md", kind: "modify" }))
    socket.receive(result(idOf(frame), FILE))
    expect((await stale).size).toBe(26)
    const fresh = client.provider.stat("docs/a.md", {})
    await answer(socket, "fs.stat", "docs/a.md", { ...FILE, size: 27 })
    expect((await fresh).size).toBe(27)
  })

  it("tells watchers the changed path until they unsubscribe", async () => {
    const { client, socket } = await connected()
    const seen: string[] = []
    const other: string[] = []
    const off = client.provider.watch?.((rel) => { seen.push(rel) })
    client.provider.watch?.(() => { throw new Error("a bad watcher") })
    client.provider.watch?.((rel) => { other.push(rel) })
    socket.receive(note("fs.changed", { path: "docs/a.md", kind: "create" }))
    socket.receive(note("fs.changed", { path: "", kind: "modify" }))
    // Not a change the client can place: ignored.
    socket.receive(note("fs.changed", { kind: "modify" }))
    await settle()
    expect(seen).toEqual(["docs/a.md", ""])
    off?.()
    socket.receive(note("fs.changed", { path: "docs/b.md", kind: "delete" }))
    await settle()
    expect(seen).toEqual(["docs/a.md", ""])
    expect(other).toEqual(["docs/a.md", "", "docs/b.md"])
  })

  it("forgets everything when the connection goes away: changes were not heard meanwhile", async () => {
    const { client, net, clock, socket } = await connected()
    const first = client.provider.stat("readme.txt", {})
    await answer(socket, "fs.stat", "readme.txt", FILE)
    await first
    socket.drop(1006)
    await settle()
    const again = client.provider.stat("readme.txt", {})
    await clock.tick(1000)
    const second = await accept(net)
    await answer(second, "fs.stat", "readme.txt", { ...FILE, size: 5 })
    expect((await again).size).toBe(5)
  })
})
