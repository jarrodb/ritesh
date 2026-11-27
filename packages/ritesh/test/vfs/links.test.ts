import { describe, expect, it } from "vitest"
import type { Vfs } from "../../src/contracts.js"
import { errnoOf, world } from "./support.js"

/** /chain/0 is a file; /chain/n links to /chain/n-1. */
function chain(vfs: Vfs, length: number): void {
  vfs.put("/chain/0", { type: "file", content: "end" })
  for (let i = 1; i <= length; i++) vfs.put(`/chain/${i}`, { type: "link", target: `${i - 1}` })
}

describe("links", () => {
  it("follows an absolute and a relative target", async () => {
    const { vfs } = world()
    vfs.put("/home/guest/abs", { type: "link", target: "/etc/motd" })
    vfs.put("/home/guest/rel", { type: "link", target: "../../etc/motd" })
    vfs.put("/home/guest/dir", { type: "link", target: "/etc" })
    expect(await vfs.read("/home/guest/abs", "/")).toBe("welcome\n")
    expect(await vfs.read("rel", "/home/guest")).toBe("welcome\n")
    expect(await vfs.read("/home/guest/dir/motd", "/")).toBe("welcome\n")
    expect((await vfs.stat("/home/guest/abs", "/")).type).toBe("file")
    expect((await vfs.list("/home/guest/dir", "/")).map((e) => e.name)).toEqual(["motd"])
    expect(vfs.peek("/home/guest/dir", "/")?.type).toBe("dir")
  })

  it("lists a link as a link", async () => {
    const { vfs } = world()
    vfs.put("/home/guest/abs", { type: "link", target: "/etc/motd" })
    expect(await vfs.list("/home/guest", "/")).toContainEqual({ name: "abs", type: "link" })
  })

  it("writes through a link, and creates the target of a dangling one", async () => {
    const { vfs } = world()
    vfs.put("/tmp/motd", { type: "link", target: "/etc/motd" })
    vfs.put("/tmp/later", { type: "link", target: "/tmp/made" })
    await vfs.write("/tmp/motd", "/", "more\n", { mode: "append" })
    await vfs.write("/tmp/later", "/", "now", { mode: "truncate" })
    expect(await vfs.read("/etc/motd", "/")).toBe("welcome\nmore\n")
    expect(await vfs.read("/tmp/made", "/")).toBe("now")
  })

  it("removes the link, not its target", async () => {
    const { vfs } = world()
    vfs.put("/tmp/dir", { type: "link", target: "/home" })
    await vfs.remove("/tmp/dir", "/")
    expect(await vfs.list("/tmp", "/")).toEqual([])
    expect((await vfs.stat("/home/guest", "/")).type).toBe("dir")
  })

  const depths: Array<[hops: number, errno: string]> = [
    [1, "OK"],
    [16, "OK"],
    [17, "ELOOP"],
  ]
  it.each(depths)("a chain of %i links: %s", async (hops, errno) => {
    const { vfs } = world()
    chain(vfs, hops)
    expect(await errnoOf(vfs.stat(`/chain/${hops}`, "/"))).toBe(errno)
    expect(await errnoOf(vfs.read(`/chain/${hops}`, "/"))).toBe(errno)
    expect(vfs.peek(`/chain/${hops}`, "/")?.type).toBe(errno === "OK" ? "file" : undefined)
  })

  it("counts links in directory components toward the depth", async () => {
    const { vfs } = world()
    vfs.put("/d0/f", { type: "file", content: "deep" })
    for (let i = 1; i <= 17; i++) vfs.put(`/d${i}`, { type: "link", target: `/d${i - 1}` })
    expect(await vfs.read("/d16/f", "/")).toBe("deep")
    expect(await errnoOf(vfs.read("/d17/f", "/"))).toBe("ELOOP")
  })

  const broken: Array<[name: string, call: (v: Vfs) => Promise<unknown>, errno: string]> = [
    ["stat a self loop", (v) => v.stat("/loop/self", "/"), "ELOOP"],
    ["read a two-link loop", (v) => v.read("/loop/a", "/"), "ELOOP"],
    ["list a loop", (v) => v.list("/loop/b", "/"), "ELOOP"],
    ["write a loop", (v) => v.write("/loop/a", "/", "x", { mode: "truncate" }), "ELOOP"],
    ["walk through a loop", (v) => v.stat("/loop/a/x", "/"), "ELOOP"],
    ["access a loop", (v) => v.access("/loop/a", "/", 1000, "r"), "ELOOP"],
    ["stat a dangling link", (v) => v.stat("/loop/dangling", "/"), "ENOENT"],
    ["read a dangling link", (v) => v.read("/loop/dangling", "/"), "ENOENT"],
    ["stat a link into a missing directory", (v) => v.stat("/loop/far", "/"), "ENOENT"],
    ["walk through a link to a file", (v) => v.stat("/loop/file/x", "/"), "ENOTDIR"],
    ["mkdir on a link", (v) => v.mkdir("/loop/dangling", "/"), "EEXIST"],
  ]
  it.each(broken)("%s: %s", async (_name, call, errno) => {
    const { vfs } = world()
    vfs.put("/loop/self", { type: "link", target: "self" })
    vfs.put("/loop/a", { type: "link", target: "b" })
    vfs.put("/loop/b", { type: "link", target: "/loop/a" })
    vfs.put("/loop/dangling", { type: "link", target: "/loop/nothing" })
    vfs.put("/loop/far", { type: "link", target: "/no/such/dir/file" })
    vfs.put("/loop/file", { type: "link", target: "/etc/motd" })
    expect(await errnoOf(call(vfs))).toBe(errno)
  })

  it("peeks nothing for a loop or a dangling link, and removes both", async () => {
    const { vfs } = world()
    vfs.put("/tmp/self", { type: "link", target: "/tmp/self" })
    vfs.put("/tmp/dangling", { type: "link", target: "nothing" })
    expect(vfs.peek("/tmp/self", "/")).toBeUndefined()
    expect(vfs.peek("/tmp/dangling", "/")).toBeUndefined()
    await vfs.remove("/tmp/self", "/")
    await vfs.remove("/tmp/dangling", "/")
    expect(await vfs.list("/tmp", "/")).toEqual([])
  })
})
