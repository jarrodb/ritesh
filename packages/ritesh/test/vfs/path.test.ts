import { describe, expect, it } from "vitest"
import { createVfs } from "../../src/vfs/index.js"

describe("resolve", () => {
  const cases: Array<[name: string, path: string, cwd: string, want: string]> = [
    ["absolute", "/a/b", "/x", "/a/b"],
    ["relative to cwd", "b", "/a", "/a/b"],
    ["relative to the root", "b", "/", "/b"],
    ["dot-dot", "../x", "/a/b", "/a/x"],
    ["dot-dot in the middle", "/a/b/../c", "/", "/a/c"],
    ["dot-dot past the root", "../../..", "/a", "/"],
    ["dot-dot at the root", "/..", "/", "/"],
    ["dot", ".", "/a/b", "/a/b"],
    ["dot components", "./a/./b", "/x", "/x/a/b"],
    ["doubled slashes", "//a///b", "/", "/a/b"],
    ["trailing slash", "/a/b/", "/", "/a/b"],
    ["empty path is cwd", "", "/a/b", "/a/b"],
    ["cwd is normalized too", "c", "/a//b/./", "/a/b/c"],
    ["cancels to the root", "a/..", "/", "/"],
    ["does not check existence", "/no/such/file", "/", "/no/such/file"],
  ]
  it.each(cases)("%s", (_name, path, cwd, want) => {
    expect(createVfs().resolve(path, cwd)).toBe(want)
  })

  it("resolves dot-dot lexically, not through a link", async () => {
    const vfs = createVfs()
    vfs.put("/deep/dir/file", { type: "file", content: "deep" })
    vfs.put("/file", { type: "file", content: "top" })
    vfs.put("/link", { type: "link", target: "/deep/dir" })
    expect(vfs.resolve("/link/../file", "/")).toBe("/file")
    expect(await vfs.read("/link/../file", "/")).toBe("top")
    expect(await vfs.read("../file", "/link")).toBe("top")
  })
})
