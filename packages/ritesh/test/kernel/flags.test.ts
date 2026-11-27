import { describe, expect, it } from "vitest"
import type { CommandDef, Run } from "../../src/contracts.js"
import { shell } from "./support.js"

interface Seen {
  flags: Record<string, unknown>
  args: string[]
  sub: string[]
}

const show: Run = async (p) => {
  await p.out(JSON.stringify({ flags: p.flags, args: p.args, sub: p.subcommand }) + "\n")
}

const tool: CommandDef = {
  name: "tool", summary: "a tool with flags", usage: "tool [-n lines] [-v] [file...]",
  flags: {
    // The design spec's shape: the key is the short name, `long` the long one.
    n: { long: "lines", type: "number", default: 10, description: "how many lines" },
    verbose: { short: "v", type: "boolean", description: "say more" },
    q: { type: "boolean" },
    tag: { short: "t", type: "string", repeat: true },
    level: { short: "l", type: "boolean", repeat: true },
    out: { short: "o", type: "string" },
  },
  run: show,
}

const mdm: CommandDef = {
  name: "mdm", summary: "manage devices", usage: "mdm <command>",
  flags: { json: { type: "boolean" } },
  subcommands: {
    devices: {
      summary: "device commands", usage: "mdm devices <command>",
      subcommands: {
        ls: {
          summary: "list devices", usage: "mdm devices ls [-a] [name...]",
          flags: { all: { short: "a", type: "boolean" } }, run: show,
        },
      },
    },
    whoami: { summary: "who am I", usage: "mdm whoami", run: show },
  },
}

/** Subcommands and no flags anywhere: arguments stay raw below the subcommand. */
const plain: CommandDef = {
  name: "plain", summary: "no flags", usage: "plain go [arg...]",
  subcommands: { go: { summary: "go", usage: "plain go [arg...]", run: show } },
}

function world(): ReturnType<typeof shell> {
  const sh = shell()
  for (const def of [tool, mdm, plain]) sh.kernel.register(def)
  return sh
}

async function seen(line: string): Promise<Seen> {
  const result = await world().run(line)
  expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" })
  return JSON.parse(result.stdout) as Seen
}

const DEFAULTS = { lines: 10, verbose: false, q: false, tag: [], level: 0 }

describe("flags", () => {
  it.each([
    ["tool", {}, []],
    ["tool a b", {}, ["a", "b"]],
    ["tool -n 5 a", { lines: 5 }, ["a"]],
    ["tool -n5", { lines: 5 }, []],
    ["tool --lines 5", { lines: 5 }, []],
    ["tool --lines=5", { lines: 5 }, []],
    ["tool -n 1 -n 2", { lines: 2 }, []],
    ["tool -n -5", { lines: -5 }, []],
    ["tool -n 1.5", { lines: 1.5 }, []],
    ["tool -v", { verbose: true }, []],
    ["tool --verbose", { verbose: true }, []],
    ["tool -vq", { verbose: true, q: true }, []],
    ["tool -vn5 a", { verbose: true, lines: 5 }, ["a"]],
    ["tool -vn 5 a", { verbose: true, lines: 5 }, ["a"]],
    ["tool -t a -tb --tag c --tag=d", { tag: ["a", "b", "c", "d"] }, []],
    ["tool -lll", { level: 3 }, []],
    ["tool -l --level", { level: 2 }, []],
    ["tool -o x", { out: "x" }, []],
    ["tool --out=", { out: "" }, []],
    ["tool --out=a=b", { out: "a=b" }, []],
    ["tool a -v b", { verbose: true }, ["a", "b"]],
    ["tool -- -v --lines", {}, ["-v", "--lines"]],
    ["tool a -- -v", {}, ["a", "-v"]],
    ["tool -", {}, ["-"]],
    ["tool -5", {}, ["-5"]],
    ["tool -- --help", {}, ["--help"]],
  ])("%s", async (line, flags, args) => {
    expect(await seen(line)).toEqual({ flags: { ...DEFAULTS, ...flags }, args, sub: [] })
  })

  it.each([
    ["tool -x", "tool: unknown option: -x"],
    ["tool -vx", "tool: unknown option: -x"],
    ["tool --nope", "tool: unknown option: --nope"],
    ["tool --nope=1", "tool: unknown option: --nope"],
    ["tool -n", "tool: option requires an argument: -n"],
    ["tool --lines", "tool: option requires an argument: --lines"],
    ["tool -n abc", "tool: invalid number for -n: abc"],
    ["tool --lines=", "tool: invalid number for --lines: "],
    ["tool --verbose=1", "tool: option takes no argument: --verbose"],
    ["tool --n 5", "tool: unknown option: --n"],
  ])("usage error: %s", async (line, message) => {
    const result = await world().run(line)
    // The command does not run.
    expect(result).toEqual({ code: 2, stdout: "", stderr: `${message}\nusage: tool [-n lines] [-v] [file...]\n` })
  })

  it("prints --help from the definition and exits 0", async () => {
    const help = [
      "usage: tool [-n lines] [-v] [file...]",
      "",
      "a tool with flags",
      "",
      "options:",
      "  -n, --lines <number>  how many lines (default: 10)",
      "  -v, --verbose         say more",
      "  -q",
      "  -t, --tag <string>",
      "  -l, --level",
      "  -o, --out <string>",
      "      --help            show this help",
      "",
    ].join("\n")
    const sh = world()
    expect(await sh.run("tool --help")).toEqual({ code: 0, stdout: help, stderr: "" })
    expect(await sh.run("tool -v a --help b | cat")).toEqual({ code: 0, stdout: help, stderr: "" })
  })

  it("leaves argv alone for a command that declares no flags", async () => {
    const sh = world()
    expect(await sh.run("echo --help -n -- -x")).toEqual({ code: 0, stdout: "--help -n -- -x\n", stderr: "" })
  })

  it("gives the command its own --help flag when it declares one", async () => {
    const sh = world()
    sh.kernel.register({ ...tool, name: "own", flags: { help: { type: "boolean" } } })
    expect(JSON.parse((await sh.run("own --help")).stdout)).toMatchObject({ flags: { help: true } })
  })
})

describe("subcommands", () => {
  it.each([
    ["mdm whoami", { json: false }, [], ["whoami"]],
    ["mdm devices ls", { json: false, all: false }, [], ["devices", "ls"]],
    ["mdm devices ls -a x y", { json: false, all: true }, ["x", "y"], ["devices", "ls"]],
    ["mdm --json devices ls", { json: true, all: false }, [], ["devices", "ls"]],
    ["mdm devices ls --json x -a", { json: true, all: true }, ["x"], ["devices", "ls"]],
    ["mdm whoami whoami", { json: false }, ["whoami"], ["whoami"]],
    ["plain go --help -x", {}, ["--help", "-x"], ["go"]],
  ])("%s", async (line, flags, args, sub) => {
    expect(await seen(line)).toEqual({ flags, args, sub })
  })

  it.each([
    ["mdm", "mdm: missing command\nusage: mdm <command>\n"],
    ["mdm nope", "mdm: unknown command: nope\nusage: mdm <command>\n"],
    ["mdm devices", "mdm: missing command\nusage: mdm devices <command>\n"],
    ["mdm devices rm", "mdm: unknown command: rm\nusage: mdm devices <command>\n"],
    ["mdm whoami -a", "mdm: unknown option: -a\nusage: mdm whoami\n"],
    ["mdm -- whoami", "mdm: unknown command: whoami\nusage: mdm <command>\n"],
    ["plain", "plain: missing command\nusage: plain go [arg...]\n"],
  ])("usage error: %s", async (line, stderr) => {
    expect(await world().run(line)).toEqual({ code: 2, stdout: "", stderr })
  })

  it("prints help for the level asked", async () => {
    const sh = world()
    expect((await sh.run("mdm --help")).stdout).toBe([
      "usage: mdm <command>", "", "manage devices", "",
      "options:", "      --json", "      --help  show this help", "",
      "commands:", "  devices  device commands", "  whoami   who am I", "",
    ].join("\n"))
    expect((await sh.run("mdm devices ls --help")).stdout).toBe([
      "usage: mdm devices ls [-a] [name...]", "", "list devices", "",
      "options:", "  -a, --all", "      --json", "      --help  show this help", "",
    ].join("\n"))
  })
})

describe("builtin flags", () => {
  it.each([
    ["unalias -x", "rite: unalias: unknown option: -x\nusage: unalias [-a] name...\n"],
    ["export --nope", "rite: export: unknown option: --nope\nusage: export [name[=value]...]\n"],
    ["rite --lines", "rite: rite: unknown option: --lines\nusage: rite --version | rite -c line\n"],
  ])("%s", async (line, stderr) => {
    expect(await world().run(line)).toEqual({ code: 2, stdout: "", stderr })
  })

  it("prints a builtin's help", async () => {
    expect((await world().run("rite --help")).stdout).toBe([
      "usage: rite --version | rite -c line", "", "the rite shell", "",
      "options:",
      "      --version  print the version",
      "  -c <string>    run a line in a child session",
      "      --help     show this help",
      "",
    ].join("\n"))
  })
})
