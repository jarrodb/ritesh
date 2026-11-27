// In-memory fakes for the contracts. Wave units test against these until the
// real modules replace them; the exit test proves the contracts compose.
import {
  type CommandDef, type Entry, type Env, type Inode, type InodeSpec, type List,
  type Proc, RiteError, type Stat, type Sys, type Vfs, type Word, type WriteOptions,
} from "../../src/contracts.js"

// ---------------------------------------------------------------- vfs

type Node = { type: "dir" } | { type: "file"; data: string } | { type: "cmd"; command: CommandDef }

export class FakeVfs implements Vfs {
  readonly nodes: Map<string, Node> = new Map<string, Node>([["/", { type: "dir" }]])

  resolve(path: string, cwd: string): string {
    const parts: string[] = []
    for (const p of (path.startsWith("/") ? path : `${cwd}/${path}`).split("/")) {
      if (p === "" || p === ".") continue
      if (p === "..") parts.pop()
      else parts.push(p)
    }
    return "/" + parts.join("/")
  }

  private node(path: string, cwd: string): Node {
    const n = this.nodes.get(this.resolve(path, cwd))
    if (!n) throw new RiteError("ENOENT", path)
    return n
  }

  stat(path: string, cwd: string): Promise<Stat> {
    const n = this.node(path, cwd)
    const size = n.type === "file" ? n.data.length : 0
    return Promise.resolve({ type: n.type, mode: n.type === "file" ? 0o644 : 0o755, uid: 1000, gid: 1000, size, mtime: 0 })
  }

  list(path: string, cwd: string): Promise<Entry[]> {
    const dir = this.resolve(path, cwd)
    const prefix = dir === "/" ? "/" : dir + "/"
    const out: Entry[] = []
    for (const [p, n] of this.nodes) {
      if (p !== dir && p.startsWith(prefix) && !p.slice(prefix.length).includes("/")) out.push({ name: p.slice(prefix.length), type: n.type })
    }
    return Promise.resolve(out.sort((a, b) => (a.name < b.name ? -1 : 1)))
  }

  read(path: string, cwd: string): Promise<string> {
    const n = this.node(path, cwd)
    if (n.type !== "file") throw new RiteError("EISDIR", path)
    return Promise.resolve(n.data)
  }

  write(path: string, cwd: string, data: string, o: WriteOptions): Promise<void> {
    const abs = this.resolve(path, cwd)
    const parent = this.nodes.get(this.resolve("..", abs))
    if (parent?.type !== "dir") throw new RiteError("ENOENT", path)
    const cur = this.nodes.get(abs)
    if (cur && cur.type !== "file") throw new RiteError("EISDIR", path)
    const prev = o.mode === "append" && cur?.type === "file" ? cur.data : ""
    this.nodes.set(abs, { type: "file", data: prev + data })
    return Promise.resolve()
  }

  mkdir(path: string, cwd: string): Promise<void> {
    this.nodes.set(this.resolve(path, cwd), { type: "dir" })
    return Promise.resolve()
  }

  remove(path: string, cwd: string): Promise<void> {
    this.nodes.delete(this.resolve(path, cwd))
    return Promise.resolve()
  }

  activate(): Promise<null> {
    return Promise.resolve(null)
  }

  peek(path: string, cwd: string): Inode | undefined {
    const n = this.nodes.get(this.resolve(path, cwd))
    if (!n) return undefined
    return { type: n.type, mode: 0o755, uid: 1000 }
  }

  put(path: string, spec: InodeSpec): void {
    if (spec.type === "dir") this.nodes.set(path, { type: "dir" })
    else if (spec.type === "file" && typeof spec.content === "string") this.nodes.set(path, { type: "file", data: spec.content })
    else if (spec.type === "cmd") this.nodes.set(path, { type: "cmd", command: spec.command })
    else throw new RiteError("ENOTSUP", path)
  }

  mount(): void {
    throw new RiteError("ENOTSUP")
  }

  unmount(): void {
    throw new RiteError("ENOTSUP")
  }

  access(): Promise<boolean> {
    return Promise.resolve(true)
  }
}

// ---------------------------------------------------------------- commands

export const echo: CommandDef = {
  name: "echo", summary: "print arguments", usage: "echo [arg...]",
  run: async (p) => { await p.out(p.args.join(" ") + "\n") },
}

export const cat: CommandDef = {
  name: "cat", summary: "print files or stdin", usage: "cat [file...]",
  run: async (p) => {
    if (p.args.length === 0) {
      for await (const line of p.lines()) await p.out(line + "\n")
      return
    }
    for (const f of p.args) await p.out(await p.fs.read(f, p.cwd))
  },
}

// ---------------------------------------------------------------- a minimal executor

const lit = (w: Word): string => w.parts.map((x) => ("text" in x ? x.text : "")).join("")

/** Hand-built AST for: echo hi | cat > /tmp/x */
export const echoPipeCat: List = {
  type: "list",
  span: [0, 22],
  rest: [],
  first: {
    type: "pipeline",
    span: [0, 22],
    commands: [
      { type: "command", assignments: [], redirects: [], span: [0, 7], words: [w("echo", 0), w("hi", 5)] },
      { type: "command", assignments: [], span: [10, 22], words: [w("cat", 10)], redirects: [{ op: ">", target: w("/tmp/x", 16), span: [14, 22] }] },
    ],
  },
}

function w(text: string, at: number): Word {
  return { parts: [{ kind: "literal", text, quoted: false }], span: [at, at + text.length] }
}

function lines(stream: ReadableStream<string>): AsyncIterable<string> {
  return {
    async *[Symbol.asyncIterator]() {
      let buf = ""
      for await (const chunk of stream) {
        buf += chunk
        let i: number
        while ((i = buf.indexOf("\n")) >= 0) {
          yield buf.slice(0, i)
          buf = buf.slice(i + 1)
        }
      }
      if (buf) yield buf
    },
  }
}

function writerOf(stream: WritableStream<string>): { write: (s: string) => Promise<void>; close: () => Promise<void> } {
  const writer = stream.getWriter()
  return { write: (s) => writer.write(s), close: () => writer.close() }
}

/**
 * Runs one pipeline the way the kernel contract says: stages connected by
 * streams, a redirect target opened (truncated) before the command starts and
 * written at close, stdout closed by the executor when run settles, status of
 * the last stage.
 */
export async function runPipeline(ast: List, vfs: Vfs, commands: Map<string, CommandDef>, env: Env = {}, cwd = "/"): Promise<{ code: number; stdout: string }> {
  let terminal = ""
  const stages = ast.first.commands
  let input: ReadableStream<string> = new ReadableStream({ start: (c) => { c.close() } })
  const running: Array<Promise<number>> = []
  for (const [i, cmd] of stages.entries()) {
    const argv = cmd.words.map(lit)
    const def = commands.get(argv[0] ?? "")
    if (!def?.run) throw new RiteError("ENOENT", argv[0])
    const run = def.run
    let stdout: WritableStream<string>
    let next: ReadableStream<string> | undefined
    const redirect = cmd.redirects.find((r) => r.op === ">")
    if (redirect?.target) {
      const target = lit(redirect.target)
      await vfs.write(target, cwd, "", { mode: "truncate" })
      let buf = ""
      stdout = new WritableStream({ write: (c) => { buf += c }, close: () => vfs.write(target, cwd, buf, { mode: "truncate" }) })
    } else if (i < stages.length - 1) {
      const t = new TransformStream<string, string>()
      stdout = t.writable
      next = t.readable
    } else {
      stdout = new WritableStream({ write: (c) => { terminal += c } })
    }
    const stderr = new WritableStream<string>({ write: () => undefined })
    const out = writerOf(stdout)
    const err = writerOf(stderr)
    const stdin = input
    const proc: Proc = {
      argv, flags: {}, args: argv.slice(1), subcommand: [],
      stdin, stdout, stderr,
      out: out.write, err: err.write, lines: () => lines(stdin),
      env, cwd, uid: 1000, fs: vfs, signal: new AbortController().signal,
      tty: null, stdio: { stdin: i === 0 ? "null" : "pipe", stdout: redirect ? "file" : "pipe", stderr: "pipe" },
      sys: undefined as unknown as Sys,
    }
    running.push(run(proc).then(async (code) => {
      await out.close()
      await err.close()
      return code ?? 0
    }))
    if (next) input = next
  }
  const codes = await Promise.all(running)
  return { code: codes.at(-1) ?? 0, stdout: terminal }
}
