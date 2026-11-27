import { describe, expect, it } from "vitest"
import { command, shell } from "./support.js"

/** A shell with `both`, which writes one line to each stream. */
function world(options: Parameters<typeof shell>[0] = {}): ReturnType<typeof shell> {
  const sh = shell(options)
  sh.kernel.register(command("both", async (p) => {
    await p.out("out\n")
    await p.err("err\n")
  }))
  return sh
}

describe("redirect order", () => {
  it.each([
    ["both > /tmp/a 2> /tmp/b", { a: "out\n", b: "err\n" }, "", ""],
    ["both > /tmp/a 2>&1", { a: "out\nerr\n" }, "", ""],
    ["both 2>&1 > /tmp/a", { a: "out\n" }, "err\n", ""],
    ["both 2> /tmp/a >&2", { a: "out\nerr\n" }, "", ""],
    ["both >&2 2> /tmp/a", { a: "err\n" }, "", "out\n"],
    ["both >&2", {}, "", "out\nerr\n"],
    ["both 2>&1", {}, "out\nerr\n", ""],
    ["both > /tmp/a > /tmp/b", { a: "", b: "out\n" }, "", "err\n"],
    ["> /tmp/a both 2>&1", { a: "out\nerr\n" }, "", ""],
    ["both 2>&1 >&2 > /tmp/a", { a: "out\n" }, "err\n", ""],
  ])("%s", async (line, files, stdout, stderr) => {
    const sh = world()
    expect(await sh.run(line)).toEqual({ code: 0, stdout, stderr })
    for (const [name, content] of Object.entries(files)) expect(await sh.vfs.read(`/tmp/${name}`, "/")).toBe(content)
  })

  it("lets a redirect sit between the words", async () => {
    const sh = world()
    expect(await sh.run("echo a > /tmp/x b 2> /tmp/e c")).toEqual({ code: 0, stdout: "", stderr: "" })
    expect(await sh.vfs.read("/tmp/x", "/")).toBe("a b c\n")
    expect(sh.calls).toEqual([["echo", "a", "b", "c"]])
  })
})

describe("redirect targets", () => {
  it("truncates before the command starts and writes when it ends", async () => {
    const sh = world({ files: { "/tmp/t": "old\n" } })
    const seen: string[] = []
    sh.kernel.register(command("probe", async (p) => {
      seen.push(await p.fs.read("/tmp/t", "/"))
      await p.out("new\n")
      seen.push(await p.fs.read("/tmp/t", "/"))
    }))
    expect((await sh.run("probe > /tmp/t")).code).toBe(0)
    expect(seen).toEqual(["", ""])
    expect(await sh.vfs.read("/tmp/t", "/")).toBe("new\n")
    // The classic: the file is empty by the time cat reads it.
    expect(await sh.run("cat /tmp/t > /tmp/t; cat /tmp/t")).toEqual({ code: 0, stdout: "", stderr: "" })
  })

  it("appends, creating the file", async () => {
    const sh = world({ files: { "/tmp/t": "old\n" } })
    await sh.run("echo a >> /tmp/n; echo b >> /tmp/n; both >> /tmp/t 2>> /tmp/t2; both 2>> /tmp/t2 > /dev/null")
    expect(await sh.vfs.read("/tmp/n", "/")).toBe("a\nb\n")
    expect(await sh.vfs.read("/tmp/t", "/")).toBe("old\nout\n")
    expect(await sh.vfs.read("/tmp/t2", "/")).toBe("err\nerr\n")
  })

  it("leaves an appended file as it was until the command ends", async () => {
    const sh = world({ files: { "/tmp/t": "old\n" } })
    const seen: string[] = []
    sh.kernel.register(command("probe", async (p) => {
      await p.out("new\n")
      seen.push(await p.fs.read("/tmp/t", "/"))
    }))
    await sh.run("probe >> /tmp/t")
    expect(seen).toEqual(["old\n"])
    expect(await sh.vfs.read("/tmp/t", "/")).toBe("old\nnew\n")
  })

  it("reads stdin from a file, expanded like any word", async () => {
    const sh = world({ files: { "/home/guest/in": "x\ny\n" } })
    expect(await sh.run("cat < ~/in | grep y")).toEqual({ code: 0, stdout: "y\n", stderr: "" })
    expect(await sh.run("F=in; cat < $F")).toEqual({ code: 0, stdout: "x\ny\n", stderr: "" })
    expect(await sh.run("cat < i[mn]")).toEqual({ code: 0, stdout: "x\ny\n", stderr: "" })
  })

  it("takes the pipe's place, so the next stage reads nothing", async () => {
    const sh = world()
    expect(await sh.run("echo hi > /tmp/x | cat")).toEqual({ code: 0, stdout: "", stderr: "" })
    expect(await sh.vfs.read("/tmp/x", "/")).toBe("hi\n")
  })

  it("writes to a device", async () => {
    const written: string[] = []
    const sh = world()
    sh.vfs.put("/dev/log", { type: "dev", write: (data) => { written.push(data) } })
    expect(await sh.run("both > /dev/null 2> /dev/log")).toEqual({ code: 0, stdout: "", stderr: "" })
    expect(written.join("")).toBe("err\n")
  })

  it("is honored by builtins", async () => {
    const sh = world()
    expect(await sh.run("alias a=b; alias > /tmp/al; cd /nowhere 2> /tmp/err; cd - > /tmp/dash"))
      .toEqual({ code: 0, stdout: "", stderr: "" })
    expect(await sh.vfs.read("/tmp/al", "/")).toBe("a='b'\n")
    expect(await sh.vfs.read("/tmp/err", "/")).toBe("rite: cd: /nowhere: no such file or directory\n")
    expect(await sh.vfs.read("/tmp/dash", "/")).toBe("/home/guest\n")
  })
})

describe("redirect errors", () => {
  it.each([
    ["echo hi > /tmp", "rite: /tmp: is a directory\n"],
    ["echo hi >> /tmp", "rite: /tmp: is a directory\n"],
    ["echo hi 2> /tmp", "rite: /tmp: is a directory\n"],
    ["echo hi > /tmp/*", "rite: ambiguous redirect\n"],
    ["echo hi > $UNSET", "rite: ambiguous redirect\n"],
    ["cat < /tmp/*", "rite: ambiguous redirect\n"],
    ["echo hi > /tmp/*.none", "rite: no matches found: /tmp/*.none\n"],
    ["echo hi > /nodir/x", "rite: /nodir/x: no such file or directory\n"],
    ["echo hi > /root/x", "rite: /root/x: permission denied\n"],
    ["echo hi > /root/secret", "rite: /root/secret: permission denied\n"],
    ["cat < /none", "rite: /none: no such file or directory\n"],
    ["cat < /root/secret", "rite: /root/secret: permission denied\n"],
    ["cat < /tmp", "rite: /tmp: is a directory\n"],
    ["cd /tmp > /root/x", "rite: /root/x: permission denied\n"],
  ])("%s", async (line, stderr) => {
    const sh = world({ files: { "/tmp/a": "", "/tmp/b": "" } })
    expect(await sh.run(line)).toEqual({ code: 1, stdout: "", stderr })
    // The command does not run.
    expect(sh.calls).toEqual([])
    expect((await sh.run("pwd")).stdout).toBe("/home/guest\n")
  })

  it("reports an error to the shell's stderr, not the redirected one", async () => {
    const sh = world()
    expect(await sh.run("echo hi 2> /tmp/e > /tmp")).toEqual({ code: 1, stdout: "", stderr: "rite: /tmp: is a directory\n" })
    // The earlier target was opened all the same.
    expect(await sh.vfs.read("/tmp/e", "/")).toBe("")
  })

  it("opens nothing when a word fails to expand", async () => {
    const sh = world()
    expect(await sh.run("echo *.none > /tmp/never")).toEqual({ code: 1, stdout: "", stderr: "rite: no matches found: *.none\n" })
    expect(sh.vfs.peek("/tmp/never", "/")).toBeUndefined()
  })

  it("fails the command when the file cannot be written at close", async () => {
    const sh = world({ vfs: { maxFileBytes: 4 } })
    expect(await sh.run("echo too long > /tmp/x; echo $?")).toEqual({
      code: 0, stdout: "1\n", stderr: "rite: /tmp/x: no space left on device\n",
    })
  })

  it("continues the list after a failed redirect", async () => {
    const sh = world()
    expect(await sh.run("echo a > /tmp || echo b")).toEqual({ code: 0, stdout: "b\n", stderr: "rite: /tmp: is a directory\n" })
  })
})
