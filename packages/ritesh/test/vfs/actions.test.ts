import { describe, expect, it } from "vitest"
import type { ActionDef, ActionVia } from "../../src/contracts.js"
import { createVfs } from "../../src/vfs/index.js"
import { errnoOf, FakeProvider, thrownErrno, world } from "./support.js"

describe("activate", () => {
  const cases: Array<[name: string, action: ActionDef, via: ActionVia, event: object, output: string | undefined, opened: string[]]> = [
    ["navigate", { navigate: "/docs/start" }, "cd", { kind: "navigate", href: "/docs/start" }, undefined, []],
    ["navigate to another site", { navigate: "https://example.com/a?b=1" }, "open", { kind: "navigate", href: "https://example.com/a?b=1" }, undefined, []],
    ["open", { open: "https://example.com/" }, "open", { kind: "open", url: "https://example.com/" }, undefined, ["https://example.com/"]],
    ["event with detail", { event: "enroll", detail: { id: 7 } }, "cat", { kind: "event", name: "enroll", detail: { id: 7 } }, undefined, []],
    ["event without detail", { event: "ping" }, "cd", { kind: "event", name: "ping" }, undefined, []],
    ["print", { print: "hello\n" }, "cat", { kind: "print" }, "hello\n", []],
  ]
  it.each(cases)("%s", async (_name, action, via, event, output, opened) => {
    const w = world()
    w.vfs.put("/home/guest/act", { type: "action", action })
    const result = await w.vfs.activate("act", "/home/guest", via)
    expect(result?.event).toMatchObject({ ...event, path: "/home/guest/act", via, defaultPrevented: false })
    expect(result?.output).toBe(output)
    expect(w.opened).toEqual(opened)
  })

  it("carries only the fields of its kind", async () => {
    const { vfs } = world()
    vfs.put("/a", { type: "action", action: { event: "ping" } })
    const event = (await vfs.activate("/a", "/", "cd"))?.event
    expect(event && Object.keys(event).sort()).toEqual(["defaultPrevented", "kind", "name", "path", "preventDefault", "via"])
  })

  it("lets the host prevent the default", async () => {
    const { vfs } = world()
    vfs.put("/a", { type: "action", action: { navigate: "/x" } })
    const first = await vfs.activate("/a", "/", "cd")
    const second = await vfs.activate("/a", "/", "cd")
    first?.event.preventDefault()
    expect(first?.event.defaultPrevented).toBe(true)
    expect(second?.event.defaultPrevented).toBe(false)
  })

  const blocked: Array<[name: string, open: ((url: string) => boolean) | undefined]> = [
    ["the browser refuses", () => false],
    ["no open is injected", undefined],
  ]
  it.each(blocked)("open answers the URL as output when %s", async (_name, open) => {
    const vfs = createVfs(open ? { open } : {})
    vfs.put("/a", { type: "action", action: { open: "https://example.com/x" } })
    const result = await vfs.activate("/a", "/", "open")
    expect(result?.output).toBe("https://example.com/x")
    expect(result?.event).toMatchObject({ kind: "open", url: "https://example.com/x" })
  })

  it("reports the action's own path when reached through a link", async () => {
    const { vfs } = world()
    vfs.put("/actions/docs", { type: "action", action: { navigate: "/docs" } })
    vfs.put("/home/guest/docs", { type: "link", target: "/actions/docs" })
    expect((await vfs.activate("docs", "/home/guest", "cd"))?.event.path).toBe("/actions/docs")
  })

  const inert: Array<[name: string, path: string]> = [
    ["a file", "/etc/motd"],
    ["a directory", "/etc"],
    ["a cmd", "/bin/echo"],
    ["a dev", "/dev/null"],
    ["a missing path", "/nope"],
    ["a path under a missing directory", "/nope/x"],
    ["a path through a file", "/etc/motd/x"],
    ["a link loop", "/tmp/loop"],
    ["a dangling link", "/tmp/dangling"],
    ["a mount point", "/mnt"],
    ["a path in a mount", "/mnt/file"],
  ]
  it.each(inert)("is null for %s", async (_name, path) => {
    const { vfs } = world()
    const provider = new FakeProvider({ file: "x" })
    vfs.put("/tmp/loop", { type: "link", target: "/tmp/loop" })
    vfs.put("/tmp/dangling", { type: "link", target: "/tmp/nothing" })
    vfs.mount("/mnt", provider)
    expect(await vfs.activate(path, "/", "cat")).toBeNull()
    expect(provider.total).toBe(0)
  })

  it("is never triggered by stat, list, peek, read, or access", async () => {
    const w = world()
    const { vfs } = w
    vfs.put("/site", { type: "action", action: { open: "https://example.com/" } })
    expect(await vfs.stat("/site", "/")).toMatchObject({ type: "action", mode: 0o755, size: 0 })
    expect(await vfs.list("/", "/")).toContainEqual({ name: "site", type: "action" })
    expect(vfs.peek("/site", "/")?.type).toBe("action")
    expect(await vfs.access("/site", "/", 1000, "x")).toBe(true)
    expect(await errnoOf(vfs.read("/site", "/"))).toBe("EINVAL")
    expect(await errnoOf(vfs.write("/site", "/", "x", { mode: "truncate" }))).toBe("EINVAL")
    expect(await errnoOf(vfs.list("/site", "/"))).toBe("ENOTDIR")
    expect(w.opened).toEqual([])
  })
})

describe("action URLs", () => {
  const urls: Array<[url: string, errno: string]> = [
    ["https://example.com/", "OK"],
    ["http://example.com/a?b=1&c=2#d", "OK"],
    ["HTTPS://EXAMPLE.COM/", "OK"],
    ["/docs/start", "OK"],
    ["docs/start", "OK"],
    ["//example.com/x", "OK"],
    ["#section", "OK"],
    ["?q=1", "OK"],
    ["javascript:alert(1)", "EINVAL"],
    ["JavaScript:alert(1)", "EINVAL"],
    [" javascript:alert(1)", "EINVAL"],
    ["java\tscript:alert(1)", "EINVAL"],
    ["data:text/html,<script>alert(1)</script>", "EINVAL"],
    ["file:///etc/passwd", "EINVAL"],
    ["mailto:someone@example.com", "EINVAL"],
    ["ftp://example.com/", "EINVAL"],
    ["blob:https://example.com/1", "EINVAL"],
    ["http://[bad", "EINVAL"],
    ["", "EINVAL"],
  ]
  it.each(urls)("put %j: %s", (url, errno) => {
    const { vfs } = world()
    expect(thrownErrno(() => { vfs.put("/open", { type: "action", action: { open: url } }) })).toBe(errno)
    expect(thrownErrno(() => { vfs.put("/nav", { type: "action", action: { navigate: url } }) })).toBe(errno)
    expect(vfs.peek("/open", "/")?.type).toBe(errno === "OK" ? "action" : undefined)
  })

  const kinds: Array<[name: string, make: (url: string) => ActionDef, set: (def: ActionDef, url: string) => void]> = [
    ["open", (url) => ({ open: url }), (def, url) => { if ("open" in def) def.open = url }],
    ["navigate", (url) => ({ navigate: url }), (def, url) => { if ("navigate" in def) def.navigate = url }],
  ]
  it.each(kinds)("activate checks a %s URL again and opens nothing", async (_name, make, set) => {
    const w = world()
    const action = make("https://example.com/")
    w.vfs.put("/a", { type: "action", action })
    set(action, "javascript:alert(1)")
    await expect(w.vfs.activate("/a", "/", "open")).rejects.toMatchObject({ errno: "EINVAL", path: "/a" })
    expect(w.opened).toEqual([])
  })

  it("does not check an event name or printed text as a URL", async () => {
    const { vfs } = world()
    vfs.put("/e", { type: "action", action: { event: "javascript:alert(1)" } })
    vfs.put("/p", { type: "action", action: { print: "javascript:alert(1)" } })
    expect((await vfs.activate("/p", "/", "cat"))?.output).toBe("javascript:alert(1)")
  })
})
