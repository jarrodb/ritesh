import { describe, expect, it } from "vitest"
import type { Candidate, CommandDef, CompleteContext, Completion } from "../../src/contracts.js"
import { command, shell } from "./support.js"

const FILES = {
  "/home/guest/notes.txt": "", "/home/guest/nothing": "", "/home/guest/my file.txt": "", "/home/guest/.hidden": "",
  "/home/guest/docs/a.txt": "", "/home/guest/docs/b.md": "",
}

function world(): ReturnType<typeof shell> {
  const sh = shell({ files: FILES })
  sh.vfs.put("/home/guest/go", { type: "action", action: { navigate: "/docs" } })
  sh.vfs.put("/home/guest/shortcut", { type: "link", target: "/home/guest/docs" })
  return sh
}

async function complete(sh: ReturnType<typeof shell>, line: string, cursor = line.length): Promise<Completion> {
  return sh.kernel.complete(line, cursor, { signal: new AbortController().signal })
}

const values = (completion: Completion): string[] => completion.candidates.map((candidate) => candidate.value)

describe("completion in command position", () => {
  it("offers builtins, PATH commands, source commands, and aliases, sorted", async () => {
    const sh = world()
    sh.kernel.addCommandSource("/sandbox/bin", { names: () => ["mdm", "echo"], info: () => undefined, run: () => Promise.resolve(0) })
    await sh.run("alias ll='ls -l' echo='echo -n'")
    const all = await complete(sh, "")
    expect(all.span).toEqual([0, 0])
    expect(values(all)).toEqual([
      "alias", "cat", "cd", "echo", "env", "exit", "export", "false", "grep", "history", "ll", "ls", "mdm", "pwd",
      "rite", "source", "true", "unalias", "unset", "whoami",
    ])
    // A name is offered once, described by what the shell would run.
    expect(all.candidates.filter((candidate) => candidate.value === "echo")).toEqual([
      { value: "echo", description: "alias for echo -n" },
    ])
    expect(all.candidates.find((candidate) => candidate.value === "cd")).toEqual({
      value: "cd", description: "change the working directory",
    })
    expect(all.candidates.find((candidate) => candidate.value === "mdm")).toEqual({ value: "mdm" })
  })

  it.each([
    ["e", [0, 1], ["echo", "env", "exit", "export"]],
    ["ec", [0, 2], ["echo"]],
    ["zz", [0, 2], []],
    ["echo hi | gr", [10, 12], ["grep"]],
    ["true && ca", [8, 10], ["cat"]],
    ["false || ", [9, 9], undefined],
    ["a; ex", [3, 5], ["exit", "export"]],
    ["X=1 Y=2 ec", [8, 10], ["echo"]],
    ["> /tmp/o ec", [9, 11], ["echo"]],
    ["'ec", [0, 3], ["echo"]],
    ["\"ec", [0, 3], ["echo"]],
    ["X=ec", [0, 4], []],
  ])("%j", async (line, span, expected) => {
    const result = await complete(world(), line)
    expect(result.span).toEqual(span)
    if (expected !== undefined) expect(values(result)).toEqual(expected)
    else expect(values(result)).toContain("echo")
  })

  it("completes a path when the word has a slash", async () => {
    const sh = world()
    expect((await complete(sh, "/bi")).candidates).toEqual([{ value: "/bin", display: "bin", suffix: "/" }])
    expect(values(await complete(sh, "/bin/ec"))).toEqual(["/bin/echo"])
    expect(values(await complete(sh, "./do"))).toEqual(["./docs"])
  })
})

describe("completion of paths", () => {
  it.each([
    ["cat ", [4, 4], ["docs", "go", "my file.txt", "notes.txt", "nothing", "shortcut"]],
    ["cat no", [4, 6], ["notes.txt", "nothing"]],
    ["cat .", [4, 5], [".hidden"]],
    ["cat docs/", [4, 9], ["docs/a.txt", "docs/b.md"]],
    ["cat docs/a", [4, 10], ["docs/a.txt"]],
    ["cat ./no", [4, 8], ["./notes.txt", "./nothing"]],
    ["cat /t", [4, 6], ["/tmp"]],
    ["cat /home/guest/do", [4, 18], ["/home/guest/docs"]],
    ["cat /none/", [4, 10], []],
    // Listed as the user: a directory they cannot read offers nothing.
    ["cat /root/", [4, 10], []],
    // The word's value is what completes: expanded, unquoted, an open quote closed.
    ["cat ~/no", [4, 8], ["/home/guest/notes.txt", "/home/guest/nothing"]],
    ["cat $HOME/docs/", [4, 15], ["/home/guest/docs/a.txt", "/home/guest/docs/b.md"]],
    ["cat \"no", [4, 7], ["notes.txt", "nothing"]],
    ["cat 'my f", [4, 9], ["my file.txt"]],
    ["cat my\\ f", [4, 9], ["my file.txt"]],
    ["cat \"$HOME\"/no", [4, 14], ["/home/guest/notes.txt", "/home/guest/nothing"]],
    // Any argument, and a redirect's target.
    ["cat a b no", [8, 10], ["notes.txt", "nothing"]],
    ["echo hi > no", [10, 12], ["notes.txt", "nothing"]],
    ["echo hi >no", [9, 11], ["notes.txt", "nothing"]],
    ["cat < docs/", [6, 11], ["docs/a.txt", "docs/b.md"]],
    ["echo hi 2>> no", [12, 14], ["notes.txt", "nothing"]],
    ["nosuch no", [7, 9], ["notes.txt", "nothing"]],
  ])("%j", async (line, span, expected) => {
    const result = await complete(world(), line)
    expect(result.span).toEqual(span)
    expect(values(result)).toEqual(expected)
  })

  it("marks directories, links to them included, with a slash suffix", async () => {
    expect((await complete(world(), "cat ")).candidates).toEqual([
      { value: "docs", display: "docs", suffix: "/" },
      { value: "go", display: "go" },
      { value: "my file.txt", display: "my file.txt" },
      { value: "notes.txt", display: "notes.txt" },
      { value: "nothing", display: "nothing" },
      { value: "shortcut", display: "shortcut", suffix: "/" },
    ])
  })

  it("completes the word the cursor is in, up to the cursor", async () => {
    const sh = world()
    const result = await complete(sh, "cat notes | grep x", 6)
    expect(result.span).toEqual([4, 6])
    expect(values(result)).toEqual(["notes.txt", "nothing"])
    expect((await complete(sh, "cat notes | grep x", 3)).span).toEqual([0, 3])
    expect(values(await complete(sh, "cat notes | grep x", 3))).toEqual(["cat"])
  })

  it("follows the session's directory", async () => {
    const sh = world()
    await sh.run("cd docs")
    expect(values(await complete(sh, "cat "))).toEqual(["a.txt", "b.md"])
    expect(values(await complete(sh, "cat ../no"))).toEqual(["../notes.txt", "../nothing"])
  })

  it("offers nothing inside a comment or after syntax it cannot place", async () => {
    const sh = world()
    expect(values(await complete(sh, "echo hi # no"))).toEqual([])
    expect(values(await complete(sh, "echo $(ca"))).toEqual([])
    expect(values(await complete(sh, "cat no*"))).toEqual([])
  })

  it("offers cd directories and actions only", async () => {
    const sh = world()
    expect(values(await complete(sh, "cd "))).toEqual(["docs", "go", "shortcut"])
    expect(values(await complete(sh, "cd /ho"))).toEqual(["/home"])
  })
})

describe("completion from a command", () => {
  const offered: Candidate[] = [{ value: "alpha", description: "first" }, { value: "beta", suffix: "" }]

  function withHook(): { sh: ReturnType<typeof shell>; calls: CompleteContext[] } {
    const sh = world()
    const calls: CompleteContext[] = []
    sh.kernel.register(command("pick", () => Promise.resolve(), {
      complete: (ctx) => {
        calls.push(ctx)
        return Promise.resolve(offered)
      },
    }))
    return { sh, calls }
  }

  it("asks the command's hook, with the words as values", async () => {
    const { sh, calls } = withHook()
    await sh.run("cd /tmp; export A=1; B=2")
    const controller = new AbortController()
    const result = await sh.kernel.complete("X=1 pick 'one two' $A ~/al | cat", 26, { signal: controller.signal })
    // Returned as the hook gave them: filtering is the editor's.
    expect(result).toEqual({ span: [22, 26], candidates: offered })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      argv: ["pick", "one two", "1", "/home/guest/al"], index: 3, prefix: "/home/guest/al", cwd: "/tmp",
    })
    expect(calls[0]?.env).toMatchObject({ A: "1", PWD: "/tmp" })
    expect(calls[0]?.env).not.toHaveProperty("B")
    expect(calls[0]?.signal).toBe(controller.signal)
    expect(await calls[0]?.fs.read("/home/guest/notes.txt", "/")).toBe("")
    await expect(calls[0]?.fs.read("/root/secret", "/")).rejects.toMatchObject({ errno: "EACCES" })
  })

  it("does not ask the hook for the command word, or for a redirect's target", async () => {
    const { sh, calls } = withHook()
    expect(values(await complete(sh, "pic"))).toEqual(["pick"])
    expect(values(await complete(sh, "pick > no"))).toEqual(["notes.txt", "nothing"])
    expect(calls).toEqual([])
  })

  it("offers nothing when the hook fails, or when the request was cancelled", async () => {
    const sh = world()
    sh.kernel.register(command("bad", () => Promise.resolve(), { complete: () => Promise.reject(new Error("no")) }))
    expect(await complete(sh, "bad x")).toEqual({ span: [4, 5], candidates: [] })
    const controller = new AbortController()
    controller.abort()
    expect(await sh.kernel.complete("cat no", 6, { signal: controller.signal })).toEqual({ span: [4, 6], candidates: [] })
  })

  it("offers subcommands and flags from the definition", async () => {
    const sh = world()
    const mdm: CommandDef = {
      name: "mdm", summary: "manage devices", usage: "mdm <command>",
      flags: { json: { type: "boolean", description: "print JSON" }, n: { type: "number" } },
      subcommands: {
        devices: {
          summary: "device commands", usage: "mdm devices <command>",
          subcommands: {
            ls: { summary: "list devices", usage: "mdm devices ls", flags: { all: { short: "a", type: "boolean" } } },
            lock: { summary: "lock a device", usage: "mdm devices lock", complete: () => Promise.resolve([{ value: "iphone-1" }]) },
          },
        },
        whoami: { summary: "who am I", usage: "mdm whoami" },
      },
    }
    sh.kernel.register(mdm)
    expect((await complete(sh, "mdm ")).candidates).toEqual([
      { value: "devices", description: "device commands" }, { value: "whoami", description: "who am I" },
    ])
    expect(values(await complete(sh, "mdm w"))).toEqual(["whoami"])
    expect(values(await complete(sh, "mdm --json devices l"))).toEqual(["ls", "lock"])
    expect(values(await complete(sh, "mdm devices lock "))).toEqual(["iphone-1"])
    expect((await complete(sh, "mdm devices ls -")).candidates).toEqual([
      { value: "--json", description: "print JSON" }, { value: "-n" }, { value: "--all" },
      { value: "--help", description: "show this help" },
    ])
    expect(values(await complete(sh, "mdm whoami --j"))).toEqual(["--json"])
    // Past the subcommands, with no hook: paths.
    expect(values(await complete(sh, "mdm devices ls no"))).toEqual(["notes.txt", "nothing"])
  })

  it("asks a command source for its commands' arguments", async () => {
    const sh = world()
    const asked: Array<{ argv: readonly string[]; index: number; signal: AbortSignal }> = []
    sh.kernel.addCommandSource("/sandbox/bin", {
      names: () => ["mdm", "bare"],
      info: () => undefined,
      run: () => Promise.resolve(0),
      complete: (argv, index, signal) => {
        asked.push({ argv, index, signal })
        return argv[0] === "bare" ? Promise.reject(new Error("offline")) : Promise.resolve([{ value: "devices" }])
      },
    })
    const controller = new AbortController()
    expect(await sh.kernel.complete("mdm --json de", 13, { signal: controller.signal })).toEqual({
      span: [11, 13], candidates: [{ value: "devices" }],
    })
    expect(asked).toEqual([{ argv: ["mdm", "--json", "de"], index: 2, signal: controller.signal }])
    expect(values(await complete(sh, "bare x"))).toEqual([])
    // A source with no hook: paths.
    const plain = world()
    plain.kernel.addCommandSource("/sandbox/bin", { names: () => ["mdm"], info: () => undefined, run: () => Promise.resolve(0) })
    expect(values(await complete(plain, "mdm no"))).toEqual(["notes.txt", "nothing"])
  })

  it("completes an alias's arguments as paths", async () => {
    const { sh, calls } = withHook()
    await sh.run("alias pick='echo'")
    expect(values(await complete(sh, "pick no"))).toEqual(["notes.txt", "nothing"])
    expect(calls).toEqual([])
  })
})
