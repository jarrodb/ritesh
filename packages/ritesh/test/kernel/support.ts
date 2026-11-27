import type {
  ActionEvent, CommandDef, StdioStreams, Tty, Vfs,
} from "../../src/contracts.js"
import { createKernel, type KernelOptions, type RiteKernel } from "../../src/kernel/index.js"
import { createParser } from "../../src/parser/index.js"
import { createVfs, type VfsOptions } from "../../src/vfs/index.js"

export const VERSION = "0.1.0"
export const HOME = "/home/guest"

export interface Result {
  code: number
  stdout: string
  stderr: string
}

export interface Shell {
  kernel: RiteKernel
  vfs: Vfs
  /** Everything written to the terminal so far. */
  terminal: { stdout: string; stderr: string }
  /** argv of every test command run, in order of start. */
  calls: string[][]
  actions: ActionEvent[]
  opened: string[]
  /** Runs a line on the terminal and returns what that line wrote. */
  run(line: string, stdio?: Partial<StdioStreams>): Promise<Result>
}

/** A promise with its resolver: how tests hold a command open without timers. */
export function gate<T = void>(): { promise: Promise<T>; open: (value: T) => void } {
  let open: (value: T) => void = () => undefined
  const promise = new Promise<T>((resolve) => { open = resolve })
  return { promise, open }
}

/** A command with the given body, for `kernel.register`. */
export function command(name: string, run: NonNullable<CommandDef["run"]>, more: Partial<CommandDef> = {}): CommandDef {
  return { name, summary: `test ${name}`, usage: `${name} [arg...]`, run, ...more }
}

/** A sink that collects what is written to it. */
export function collector(): { stream: WritableStream<string>; text: () => string } {
  let text = ""
  return { stream: new WritableStream<string>({ write: (chunk) => { text += chunk } }), text: () => text }
}

export function commands(calls: string[][]): CommandDef[] {
  const def = (name: string, run: NonNullable<CommandDef["run"]>): CommandDef => ({
    name, summary: `test ${name}`, usage: `${name} [arg...]`,
    run: (p) => {
      calls.push([...p.argv])
      return run(p)
    },
  })
  return [
    def("echo", async (p) => { await p.out(p.args.join(" ") + "\n") }),
    def("cat", async (p) => {
      if (p.args.length === 0) {
        for await (const line of p.lines()) await p.out(line + "\n")
        return
      }
      for (const file of p.args) await p.out(await p.fs.read(file, p.cwd))
    }),
    def("true", () => Promise.resolve(0)),
    def("false", () => Promise.resolve(1)),
    def("env", async (p) => {
      await p.out(Object.entries(p.env).map(([name, value]) => `${name}=${value}\n`).join(""))
    }),
    def("whoami", async (p) => { await p.out(p.sys.session.user + "\n") }),
    def("pwd", async (p) => { await p.out(p.cwd + "\n") }),
    def("grep", async (p) => {
      const pattern = new RegExp(p.args[0] ?? "")
      let found = false
      for await (const line of p.lines()) {
        if (!pattern.test(line)) continue
        found = true
        await p.out(line + "\n")
      }
      return found ? 0 : 1
    }),
    def("ls", async (p) => {
      const entries = await p.fs.list(p.args[0] ?? ".", p.cwd)
      await p.out(entries.map((entry) => entry.name + "\n").join(""))
    }),
  ]
}

export interface ShellOptions {
  files?: Record<string, string>
  kernel?: Partial<KernelOptions>
  vfs?: VfsOptions
  tty?: Tty | null
}

/** A real parser, vfs, and kernel, with a tree shaped like the one createRite builds and the test commands in /bin. */
export function shell(options: ShellOptions = {}): Shell {
  const vfs = createVfs({ now: () => 1_000, ...options.vfs })
  vfs.put(HOME, { type: "dir", uid: 1000 })
  vfs.put("/root", { type: "dir", mode: 0o700 })
  vfs.put("/root/secret", { type: "file", content: "s3cret\n" })
  vfs.put("/tmp", { type: "dir", mode: 0o777 })
  vfs.put("/dev/null", { type: "dev" })
  for (const [path, content] of Object.entries(options.files ?? {})) vfs.put(path, { type: "file", content })

  const terminal = { stdout: "", stderr: "" }
  const calls: string[][] = []
  const actions: ActionEvent[] = []
  const opened: string[] = []
  const kernel = createKernel({
    parser: createParser(VERSION),
    vfs,
    hostname: "enroll",
    user: "guest",
    home: HOME,
    version: VERSION,
    stdout: new WritableStream<string>({ write: (chunk) => { terminal.stdout += chunk } }),
    stderr: new WritableStream<string>({ write: (chunk) => { terminal.stderr += chunk } }),
    onAction: (event) => { actions.push(event) },
    openUrl: (url) => {
      opened.push(url)
      return true
    },
    tty: () => options.tty ?? null,
    ...options.kernel,
  })
  for (const command of commands(calls)) kernel.register(command)

  const run = async (line: string, stdio?: Partial<StdioStreams>): Promise<Result> => {
    const from = { stdout: terminal.stdout.length, stderr: terminal.stderr.length }
    const code = await kernel.exec(line, stdio)
    return { code, stdout: terminal.stdout.slice(from.stdout), stderr: terminal.stderr.slice(from.stderr) }
  }
  return { kernel, vfs, terminal, calls, actions, opened, run }
}
