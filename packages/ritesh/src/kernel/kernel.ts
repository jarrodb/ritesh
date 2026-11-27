import {
  type ActionEvent, type CommandDef, type CommandInfo, type CommandSource, type EggDef, type Env, EXIT,
  type Kernel, type Parser, type Resolution, type Session, type StdioStreams, type SudoPolicy, type Tty, type Vfs,
} from "../contracts.js"
import { compareCodePoints } from "../vfs/path.js"
import { createBuiltins } from "./builtins.js"
import { complete, pathCandidates } from "./complete.js"
import { describe, noop } from "./errors.js"
import { createExecutor, type Frame, type FrameIo } from "./exec.js"
import { type ActionHooks, fsFor } from "./fs.js"
import { Job } from "./job.js"
import { locate, type Registry, sourceInfo } from "./registry.js"
import { createSession, getVar, viewOf } from "./session.js"
import { Fd, lazySource, streamSink, streamSource, textSource } from "./stdio.js"

export interface KernelOptions {
  parser: Parser
  vfs: Vfs
  hostname: string
  /** The host's user, uid 1000. */
  user: string
  home: string
  /** Printed by `rite --version` and held in RITE_VERSION. */
  version: string
  /** Variables set and exported at the start. The read-only kernel variables are not overridden. */
  env?: Env
  /** Default false. */
  sudo?: SudoPolicy
  /** Opens an `open` action's URL. False means the browser refused, and the URL is printed. Default: refuse. */
  openUrl?: (url: string) => boolean
  onAction?: (event: ActionEvent) => void
  /** The terminal, or null when there is none. Given to a process whose stdout is the terminal. */
  tty?: () => Tty | null
  /** The terminal's output. The kernel holds their writers and never closes them. */
  stdout: WritableStream<string>
  stderr: WritableStream<string>
  /**
   * The terminal's input, cooked: a new stream for each process that reads,
   * asked for at its first read and cancelled when the process is gone.
   * Without it stdin is empty.
   */
  stdin?: () => ReadableStream<string>
  /** The editor's history, when it keeps one. Otherwise the kernel lists the lines given to exec. */
  history?: () => readonly string[]
  /** Called when a line given to exec ends with `exit`. */
  onExit?: (code: number) => void
}

/** The Kernel contract, and what the contract does not have yet. */
export interface RiteKernel extends Kernel {
  /** Sources ~/.riterc when it exists. Queued like a line. */
  init(): Promise<void>
  /** The status of the last `exit`, until the next line starts. */
  readonly exitRequested: number | null
  /** A session variable: the editor reads PROMPT. */
  getenv(name: string): string | undefined
}

const USER_UID = 1000
const HISTORY_MAX = 1000

function infoOf(def: CommandDef): CommandInfo {
  const info: CommandInfo = { name: def.name, summary: def.summary, usage: def.usage, builtin: true, remote: false }
  if (def.flags !== undefined) info.flags = def.flags
  if (def.manual !== undefined) info.manual = def.manual
  return info
}

export function createKernel(options: KernelOptions): RiteKernel {
  const { parser, vfs } = options
  const session: Session = createSession({
    user: options.user, uid: USER_UID, home: options.home, hostname: options.hostname,
    version: options.version, env: options.env,
  })
  const registry: Registry = { vfs, defs: new Map(), sources: [] }
  const eggs: EggDef[] = []
  const typed: string[] = []

  const hooks: ActionHooks = { onAction: options.onAction, openUrl: options.openUrl ?? (() => false) }
  const views = new Map<number, Vfs>()
  const fs = (uid: number): Vfs => {
    let view = views.get(uid)
    if (view === undefined) {
      view = fsFor(vfs, uid, hooks)
      views.set(uid, view)
    }
    return view
  }
  const history = (): readonly string[] => options.history?.() ?? typed

  const builtins = createBuiltins({
    version: options.version,
    quote: (value) => parser.quoteWord(value, "single"),
    history,
    source: (p, into, text) => executor.source(p, into, text),
    // `cd` enters directories and activates actions.
    directories: (ctx) => pathCandidates(ctx.fs, ctx.cwd, ctx.prefix, ctx.signal, (type) => type === "dir" || type === "action"),
  })

  const resolve = (from: Session, env: Readonly<Env>) => (name: string): Resolution => {
    const body = from.aliases.get(name)
    if (body !== undefined) return { kind: "alias", name, body }
    const builtin = builtins.get(name)
    if (builtin !== undefined) return { kind: "builtin", name, info: infoOf(builtin.def) }
    const found = locate(registry, name, getVar(env, "PATH") ?? "", from.cwd)
    if (found.kind === "command") {
      // The vfs keeps a summary; the definition has the manual.
      const info = found.def?.manual === undefined ? found.info : { ...found.info, manual: found.def.manual }
      return { kind: "command", name, path: found.path, info }
    }
    if (found.kind === "source") return { kind: "command", name, path: found.path, info: found.info }
    const egg = eggs.find((e) => "command" in e.trigger && e.trigger.command === name)
    return egg === undefined ? { kind: "not-found", name } : { kind: "egg", name, id: egg.id }
  }

  const commands = (): CommandInfo[] => {
    const all = new Map<string, CommandInfo>()
    const add = (info: CommandInfo): void => {
      if (!all.has(info.name)) all.set(info.name, info)
    }
    for (const builtin of builtins.values()) add(infoOf(builtin.def))
    for (const path of registry.defs.keys()) {
      const inode = vfs.peek(path, "/")
      if (inode?.type === "cmd" && inode.command !== undefined) add(inode.command)
    }
    for (const { source } of registry.sources) {
      for (const name of source.names()) add(sourceInfo(source, name))
    }
    return [...all.values()].sort((a, b) => compareCodePoints(a.name, b.name))
  }

  const executor = createExecutor({
    parser, registry, builtins, eggs, fs, history, resolve, commands,
    sudo: options.sudo ?? false,
    tty: () => options.tty?.() ?? null,
  })

  const terminalOut = streamSink(options.stdout, "tty")
  const terminalErr = options.stderr === options.stdout ? terminalOut : streamSink(options.stderr, "tty")
  const terminal = { stdout: new Fd(terminalOut.sink), stderr: new Fd(terminalErr.sink) }

  /** A job's streams: the caller's where given, else the terminal's. `close` gives the caller's back. */
  const openIo = (job: Job, stdio: Partial<StdioStreams> = {}): { io: FrameIo; close: () => void } => {
    const detach: Array<() => void> = []
    const own = new Map<WritableStream<string>, Fd>()
    const fd = (stream: WritableStream<string> | undefined, fallback: Fd): Fd => {
      if (stream === undefined) return fallback
      let made = own.get(stream)
      if (made === undefined) {
        const taken = streamSink(stream, "pipe")
        detach.push(taken.detach)
        made = new Fd(taken.sink)
        own.set(stream, made)
      }
      return made
    }
    const given = stdio.stdin === undefined ? undefined : streamSource(stdio.stdin, "pipe")
    const open = options.stdin
    const stdin = (): ReturnType<FrameIo["stdin"]> => {
      if (given !== undefined) return given
      if (open === undefined) return textSource("", "null")
      const source = lazySource(open, "tty")
      const stop = (): void => { source.done() }
      job.breakers.add(stop)
      return {
        kind: source.kind,
        open: source.open,
        done: () => {
          job.breakers.delete(stop)
          source.done()
        },
      }
    }
    return {
      io: { stdin, stdout: fd(stdio.stdout, terminal.stdout), stderr: fd(stdio.stderr, terminal.stderr) },
      close: () => {
        for (const release of detach) release()
      },
    }
  }

  // ---------------------------------------------------------------- jobs

  let tail: Promise<unknown> = Promise.resolve()
  let waiting = 0
  let current: Job | undefined

  /** One job at a time, in the order asked for. */
  const enqueue = <T>(work: (job: Job) => Promise<T>): Promise<T> => {
    waiting++
    const result = tail.then(async () => {
      const job = new Job()
      current = job
      try {
        return await work(job)
      } finally {
        current = undefined
        waiting--
      }
    })
    tail = result.catch(noop)
    return result
  }

  /** Runs to a status, or to 130 at ^C without waiting for commands that ignore the abort. */
  const foreground = (job: Job, io: FrameIo, run: (frame: Frame) => Promise<number>): Promise<number> => {
    const frame: Frame = { job, session, io, depth: 0 }
    const work = run(frame).catch(async (e: unknown) => {
      if (!job.isAborted()) await io.stderr.sink.write(`rite: internal error: ${describe(e)}\n`).catch(noop)
      return EXIT.FAILURE
    })
    return Promise.race([work, job.interrupted])
  }

  const exitRequested = (): number | null => session.exitRequested

  const exec = (line: string, stdio?: Partial<StdioStreams>): Promise<number> => enqueue(async (job) => {
    if (options.history === undefined && line.trim() !== "" && !line.startsWith(" ")) {
      typed.push(line)
      if (typed.length > HISTORY_MAX) typed.shift()
    }
    session.exitRequested = null
    const { io, close } = openIo(job, stdio)
    try {
      const status = await foreground(job, io, (frame) => executor.line(frame, line))
      session.lastStatus = status
      const requested = exitRequested()
      if (requested !== null) options.onExit?.(requested)
      return status
    } finally {
      close()
    }
  })

  const runEgg = (egg: EggDef): Promise<number> => enqueue(async (job) => {
    const { io, close } = openIo(job)
    try {
      return await foreground(job, io, (frame) => executor.egg(frame, egg))
    } finally {
      close()
    }
  })

  const init = (): Promise<void> => enqueue(async (job) => {
    const rc = `${session.home}/.riterc`
    if (vfs.peek(rc, "/") === undefined) return
    const { io, close } = openIo(job)
    try {
      await foreground(job, io, async (frame) => executor.script(frame, await fs(session.uid).read(rc, "/")))
    } finally {
      close()
    }
  })

  return {
    session: viewOf(session),
    vfs,
    parser,
    exec,
    runEgg,
    init,
    complete: (line, cursor, o) => complete({ parser, registry, builtins, fs }, session, line, cursor, o.signal),
    interrupt: () => {
      if (current === undefined) return
      session.lastStatus = EXIT.INTERRUPTED
      current.interrupt()
    },
    get running() { return waiting > 0 },
    get exitRequested() { return exitRequested() },
    getenv: (name) => getVar(session.env, name),
    register: (def, at = "/bin") => {
      const path = vfs.resolve(def.name, at)
      vfs.put(path, { type: "cmd", command: def })
      registry.defs.set(path, def)
    },
    registerEgg: (def) => { eggs.push(def) },
    keyEggs: () => eggs.filter((egg) => "keys" in egg.trigger),
    addCommandSource: (at, source: CommandSource) => { registry.sources.push({ at: vfs.resolve(at, "/"), source }) },
  }
}
