// The executor: lists, pipelines, redirects, command resolution, and the
// process a command sees.
//
// Two rules keep ^C and pipelines honest. Every write to a session happens
// right after a check that the job was not interrupted, because an
// interrupted job's commands may still be running when exec has returned.
// And a builtin works on a copy of the session, kept only when it finishes.
import {
  type EggDef, type EggResult, type Env, ERRNO_MESSAGES, EXIT, type List, type ParseOptions, type Parser,
  type ParseResult, PASS, type Pipeline, type Proc, type Redirect, RiteError, type Session,
  type SimpleCommand, type StdioStreams, type SudoPolicy, type Sys, type Tty, type Vfs,
} from "../contracts.js"
import type { Builtin } from "./builtins.js"
import { clampStatus, describe, noop, ShellError } from "./errors.js"
import { expandText, expandWord, type Scope } from "./expand.js"
import { infoHelp, nothingToRun, type Outcome, type Parsed, parseArgv } from "./flags.js"
import type { Job } from "./job.js"
import { locate, type Registry } from "./registry.js"
import { cloneSession, commitSession, getVar, procEnv, READ_ONLY, viewOf } from "./session.js"
import {
  borrow, Fd, fileSink, linesOf, Out, pipe, type Source, streamSink, streamSource, textSource,
} from "./stdio.js"

export interface Core {
  readonly parser: Parser
  readonly sudo: SudoPolicy
  readonly builtins: ReadonlyMap<string, Builtin>
  readonly registry: Registry
  readonly eggs: readonly EggDef[]
  readonly tty: () => Tty | null
  /** The vfs as a uid sees it. */
  readonly fs: (uid: number) => Vfs
  readonly history: () => readonly string[]
  resolve: (session: Session, env: Readonly<Env>) => Sys["resolve"]
  commands: Sys["commands"]
}

/** What a line runs with. `stdin` makes the input of one command at a time. */
export interface FrameIo {
  stdin: () => Source
  stdout: Fd
  stderr: Fd
}

export interface Frame {
  job: Job
  session: Session
  io: FrameIo
  /** How many lines deep: `rite -c`, `source`, and `sys.run` nest. */
  depth: number
}

export interface Executor {
  /** A typed line: input eggs, then the language. */
  line(frame: Frame, text: string): Promise<number>
  /** A file's text, line by line, in the frame's session. */
  script(frame: Frame, text: string): Promise<number>
  /** `source`: a script in a builtin's session, on the builtin's stdio. */
  source(p: Proc, session: Session, text: string): Promise<number>
  /** One egg run directly (a key trigger), with argv [id], on the frame's streams. */
  egg(frame: Frame, egg: EggDef): Promise<number>
}

/** One command's streams. The stage holds a reference to each Fd and lets go when it ends. */
interface StageIo {
  stdin: Source
  stdout: Fd
  stderr: Fd
}

interface Stage {
  frame: Frame
  session: Session
  io: StageIo
  control: AbortController
  env: Readonly<Env>
  /** Called when the command's body is entered: a pipeline starts its stages left to right. */
  started: () => void
}

interface Running {
  proc: Proc
  /** The kernel's close of stdout and stderr when run settles. */
  close(): void
}

const MAX_DEPTH = 32
const RAW: Parsed = { flags: {}, args: [], subcommand: [] }

const baseName = (name: string): string => name.slice(name.lastIndexOf("/") + 1)

export function createExecutor(core: Core): Executor {
  const stages = new WeakMap<Proc, Stage>()

  /** The shell's own output. Nothing more is said for an interrupted job. */
  const say = async (frame: Frame, fd: Fd, text: string): Promise<void> => {
    if (frame.job.isAborted()) return
    try {
      await fd.sink.write(text)
    } catch {
      // The sink is gone, and with it the place to report that.
    }
  }

  const scopeOf = (session: Session, scoped: Readonly<Env>): Scope => {
    const fs = core.fs(session.uid)
    const get = (name: string): string | undefined =>
      name === "?" ? String(session.lastStatus) : getVar(scoped, name) ?? getVar(session.env, name)
    return {
      get,
      home: () => get("HOME") ?? session.home,
      list: (dir) => fs.list(dir, session.cwd).catch(noop),
      exists: (path) => fs.stat(path, session.cwd).then(() => true, () => false),
    }
  }

  // ---------------------------------------------------------------- processes

  /** A frame for lines a process runs: its streams, one level down. A file that sources itself ends here. */
  const nested = (stage: Stage, session: Session): Frame => {
    const { frame, io } = stage
    if (frame.depth >= MAX_DEPTH) throw new ShellError("maximum nesting depth exceeded")
    return {
      job: frame.job,
      session,
      io: { stdin: () => borrow(io.stdin), stdout: io.stdout, stderr: io.stderr },
      depth: frame.depth + 1,
    }
  }

  const makeSys = (stage: Stage): Sys => {
    const { frame, session, io, control } = stage
    return {
      resolve: core.resolve(session, stage.env),
      commands: core.commands,
      session: viewOf(session),
      sudo: core.sudo,
      history: core.history,
      run: async (text, options) => {
        // A child session: it sees this one's variables and aliases, and changes none of them.
        const child = cloneSession(session)
        for (const [name, value] of Object.entries({ ...stage.env, ...options?.env })) {
          child.env[name] = value
          child.exported.add(name)
        }
        const status = await runLine(nested(stage, child), text)
        return status
      },
      spawn: async (argv, options = {}) => {
        const depth = nested(stage, session).depth
        // A child process: the exported variables only.
        const child = cloneSession(session)
        child.env = { ...stage.env, ...options.env }
        if (options.uid !== undefined && options.uid !== child.uid) {
          child.uid = options.uid
          child.env.UID = String(options.uid)
          if (options.uid === 0) child.user = "root"
        }
        child.exported = new Set(Object.keys(child.env))
        const detach: Array<() => void> = []
        const fd = (stream: WritableStream<string> | undefined, inherited: Fd): Fd => {
          if (stream === undefined) return inherited.retain()
          const own = streamSink(stream, "pipe")
          detach.push(own.detach)
          return new Fd(own.sink)
        }
        const streams: Partial<StdioStreams> = options.stdio ?? {}
        const childIo: StageIo = {
          stdin: streams.stdin === undefined ? borrow(io.stdin) : streamSource(streams.stdin, "pipe"),
          stdout: fd(streams.stdout, io.stdout),
          stderr: fd(streams.stderr, io.stderr),
        }
        try {
          return await runArgv({ ...frame, depth }, child, childIo, control, [...argv], {}, noop)
        } finally {
          await childIo.stdout.release()
          await childIo.stderr.release()
          for (const release of detach) release()
        }
      },
    }
  }

  const makeProc = (stage: Stage, argv: readonly string[], parsed: Parsed): Running => {
    const { frame, session, io } = stage
    const dead = (): boolean => frame.job.isAborted()
    const out = new Out(io.stdout, dead)
    const err = new Out(io.stderr, dead)
    const proc: Proc = {
      argv,
      flags: parsed.flags,
      args: parsed.args,
      subcommand: parsed.subcommand,
      get stdin() { return io.stdin.open() },
      get stdout() { return out.stream },
      get stderr() { return err.stream },
      out: (text) => out.write(text),
      err: (text) => err.write(text),
      lines: () => linesOf(io.stdin.open()),
      env: stage.env,
      cwd: session.cwd,
      uid: session.uid,
      fs: core.fs(session.uid),
      signal: stage.control.signal,
      tty: io.stdout.sink.kind === "tty" ? core.tty() : null,
      stdio: { stdin: io.stdin.kind, stdout: io.stdout.sink.kind, stderr: io.stderr.sink.kind },
      sys: makeSys(stage),
    }
    stages.set(proc, stage)
    return {
      proc,
      close: () => {
        out.close()
        err.close()
      },
    }
  }

  /** Runs a body as a process: void is 0, a throw is 1 with one stderr line, and its output closes when it settles. */
  const invoke = async (
    stage: Stage, label: string, running: Running, body: (p: Proc) => Promise<EggResult>,
  ): Promise<number | typeof PASS> => {
    try {
      const settled = body(running.proc)
      stage.started()
      const result = await settled
      return result === PASS ? PASS : clampStatus(result)
    } catch (e) {
      // Interrupted, or its reader left: the failure is the signal's, and there is nothing to report.
      if (!stage.frame.job.isAborted() && !stage.control.signal.aborted) {
        await running.proc.err(`${label}: ${describe(e)}\n`).catch(noop)
      }
      return EXIT.FAILURE
    } finally {
      running.close()
    }
  }

  const report = async (stage: Stage, label: string, outcome: Exclude<Outcome, { kind: "run" }>): Promise<number> => {
    // What is written here may go into a pipe, whose reader starts after this stage.
    stage.started()
    if (outcome.kind === "help") {
      await say(stage.frame, stage.io.stdout, outcome.text)
      return EXIT.OK
    }
    await say(stage.frame, stage.io.stderr, `${label}: ${outcome.message}\nusage: ${outcome.usage}\n`)
    return EXIT.USAGE
  }

  /** Resolution, after expansion: command eggs, builtins, PATH, command sources. */
  const runArgv = async (
    frame: Frame, session: Session, io: StageIo, control: AbortController, argv: readonly string[], scoped: Readonly<Env>,
    started: () => void,
  ): Promise<number> => {
    const [name] = argv
    if (name === undefined) return EXIT.OK
    const stage: Stage = { frame, session, io, control, env: procEnv(session, scoped), started }
    const label = baseName(name)
    const fail = async (message: string, status: number): Promise<number> => {
      started()
      await say(frame, io.stderr, `rite: ${message}\n`)
      return status
    }

    for (const egg of core.eggs) {
      const { trigger } = egg
      if (!("command" in trigger) || trigger.command !== name) continue
      if (trigger.when !== undefined && !trigger.when(argv, viewOf(session))) continue
      const result = await invoke(stage, label, makeProc(stage, argv, { ...RAW, args: argv.slice(1) }), egg.run)
      if (result !== PASS) return result
      if (frame.job.isAborted()) return EXIT.INTERRUPTED
    }

    const builtin = core.builtins.get(name)
    if (builtin !== undefined) {
      const parsed = parseArgv(builtin.def, argv)
      if (parsed.kind !== "run") return report(stage, `rite: ${name}`, parsed)
      // A copy, kept when the builtin finishes: one that outlives ^C changes nothing.
      const work = builtin.live === true ? session : cloneSession(session)
      const own: Stage = { ...stage, session: work }
      const result = await invoke(own, `rite: ${name}`, makeProc(own, argv, parsed), (p) => builtin.run(p, work))
      if (work !== session && !frame.job.isAborted()) commitSession(session, work)
      return result === PASS ? EXIT.OK : result
    }

    const found = locate(core.registry, name, getVar(stage.env, "PATH") ?? "", session.cwd)
    switch (found.kind) {
      case "command": {
        const allowed = await core.registry.vfs.access(found.path, "/", session.uid, "x").catch(() => false)
        if (!allowed) return fail(`${name}: ${ERRNO_MESSAGES.EACCES}`, EXIT.NOT_EXECUTABLE)
        if (found.def === undefined) return fail(`${name}: ${ERRNO_MESSAGES.ENOTSUP}`, EXIT.NOT_EXECUTABLE)
        const parsed = parseArgv(found.def, argv)
        if (parsed.kind !== "run") return report(stage, found.def.name, parsed)
        const { run } = parsed.node
        if (run === undefined) return report(stage, found.def.name, nothingToRun(parsed.node, parsed.args))
        const result = await invoke(stage, label, makeProc(stage, argv, parsed), run)
        return result === PASS ? EXIT.OK : result
      }
      case "source": {
        // The server parses a remote command's arguments; only --help is answered here, from its descriptor.
        const help = infoHelp(found.info, argv)
        if (help !== undefined && found.source.info(found.name) !== undefined) {
          started()
          await say(frame, io.stdout, help)
          return EXIT.OK
        }
        const running = makeProc(stage, argv, { ...RAW, args: argv.slice(1) })
        const result = await invoke(stage, label, running, (p) => found.source.run(found.name, p))
        return result === PASS ? EXIT.OK : result
      }
      case "blocked":
        return fail(`${name}: ${found.message}`, EXIT.NOT_EXECUTABLE)
      case "none":
        return fail(`command not found: ${name}`, EXIT.NOT_FOUND)
    }
  }

  // ---------------------------------------------------------------- commands

  /** One redirect, applied to the streams as they stand: the order of redirects is the order of effects. */
  const redirect = async (session: Session, r: Redirect, io: StageIo, scope: Scope): Promise<void> => {
    if (r.target === undefined) {
      const from = r.op === "2>&1" ? io.stdout : io.stderr
      const replaced = r.op === "2>&1" ? io.stderr : io.stdout
      if (r.op === "2>&1") io.stderr = from.retain()
      else io.stdout = from.retain()
      await replaced.release()
      return
    }
    const [path, ...more] = await expandWord(r.target, scope)
    if (path === undefined || more.length > 0) throw new ShellError("ambiguous redirect")
    const fs = core.fs(session.uid)
    try {
      if (r.op === "<") {
        const text = await fs.read(path, session.cwd)
        io.stdin.done()
        io.stdin = textSource(text, "file")
        return
      }
      // Opened, and truncated where the form says, before the command starts.
      const mode = r.op.endsWith(">>") ? "append" : "truncate"
      await fs.write(path, session.cwd, "", { mode })
      const fd = new Fd(fileSink(fs, path, session.cwd, mode))
      const replaced = r.op.startsWith("2") ? io.stderr : io.stdout
      if (r.op.startsWith("2")) io.stderr = fd
      else io.stdout = fd
      await replaced.release()
    } catch (e) {
      throw new ShellError(describe(e))
    }
  }

  const simple = async (
    frame: Frame, session: Session, cmd: SimpleCommand, io: StageIo, control: AbortController, started: () => void,
  ): Promise<number> => {
    // An assignment's value sees the assignments before it; the command's words see the session.
    // No prototype, so a variable named __proto__ is an ordinary property.
    const scoped: Env = Object.create(null) as Env
    const assigning = scopeOf(session, scoped)
    for (const assignment of cmd.assignments) {
      if (READ_ONLY.has(assignment.name)) throw new ShellError(`${assignment.name}: read-only variable`)
      scoped[assignment.name] = expandText(assignment.value, assigning)
    }
    const scope = scopeOf(session, {})
    const argv: string[] = []
    for (const word of cmd.words) argv.push(...await expandWord(word, scope))
    for (const r of cmd.redirects) await redirect(session, r, io, scope)
    if (frame.job.isAborted()) return EXIT.INTERRUPTED
    if (argv.length === 0) {
      // No command word: the assignments are the session's.
      Object.assign(session.env, scoped)
      return EXIT.OK
    }
    return runArgv(frame, session, io, control, argv, scoped, started)
  }

  /** Runs one command and lets go of its streams. Never rejects. */
  const runSimple = async (
    frame: Frame, session: Session, cmd: SimpleCommand, io: StageIo, control: AbortController, started: () => void,
  ): Promise<number> => {
    // The shell's own messages go where stderr pointed before the command's redirects.
    const shell = io.stderr.retain()
    let status: number
    try {
      status = await simple(frame, session, cmd, io, control, started)
    } catch (e) {
      const known = e instanceof ShellError
      await say(frame, shell, `rite: ${known ? e.message : `internal error: ${describe(e)}`}\n`)
      status = known ? e.status : EXIT.FAILURE
    }
    // Reached without a body when the command never ran.
    started()
    for (const fd of [io.stdout, io.stderr]) {
      try {
        // A redirect's file is written here.
        await fd.release()
      } catch (e) {
        await say(frame, shell, `rite: ${describe(e)}\n`)
        if (status === EXIT.OK) status = EXIT.FAILURE
      }
    }
    io.stdin.done()
    await shell.release().catch(noop)
    return frame.job.isAborted() ? EXIT.INTERRUPTED : status
  }

  const runPipeline = async (frame: Frame, pipeline: Pipeline): Promise<number> => {
    const { job, io } = frame
    const pipes = pipeline.commands.slice(1).map(() => pipe())
    const parts = pipeline.commands.map((cmd, i) => ({
      cmd, control: new AbortController(), before: pipes[i - 1], after: pipes[i],
    }))
    // A command alone runs in the session. In a pipeline each stage has its own copy, so nothing it changes persists.
    const alone = parts.length === 1
    for (const p of pipes) job.breakers.add(p.break)
    for (const part of parts) job.controls.add(part.control)
    try {
      const running: Array<Promise<number>> = []
      for (const [i, { cmd, control, before, after }] of parts.entries()) {
        const stageIo: StageIo = {
          stdin: before === undefined ? io.stdin() : streamSource(before.readable, "pipe"),
          stdout: after === undefined ? io.stdout.retain() : new Fd(after.sink),
          stderr: io.stderr.retain(),
        }
        const session = alone ? frame.session : cloneSession(frame.session)
        // Stages run together, and start in order: the next is set up once this one's body is entered.
        await new Promise<void>((started) => {
          running.push(runSimple(frame, session, cmd, stageIo, control, started).then((status) => {
            // This reader is finished: what feeds it has nowhere to write.
            before?.break(new RiteError("EPIPE"))
            for (const upstream of parts.slice(0, i)) upstream.control.abort("EPIPE")
            return status
          }))
        })
      }
      const codes = await Promise.all(running)
      return codes.at(-1) ?? EXIT.OK
    } finally {
      for (const p of pipes) job.breakers.delete(p.break)
      for (const part of parts) job.controls.delete(part.control)
    }
  }

  // ---------------------------------------------------------------- lines

  const syntax = async (frame: Frame, result: Exclude<ParseResult, { ok: true }>): Promise<number> => {
    const message = result.incomplete ? "unexpected end of line" : result.error.message
    await say(frame, frame.io.stderr, `rite: ${message}\n`)
    frame.session.lastStatus = EXIT.USAGE
    return EXIT.USAGE
  }

  const stepsOf = (list: List, op: ";" | "&&" | "||"): List["rest"] => [{ op, pipeline: list.first }, ...list.rest]

  const aliasKey = (session: Session): string => JSON.stringify([...session.aliases])

  const runLine = async (frame: Frame, line: string): Promise<number> => {
    const { job, session } = frame
    const options: ParseOptions = { alias: (name) => session.aliases.get(name) }
    let text = line
    const parsed = core.parser.parse(text, options)
    if (!parsed.ok) return syntax(frame, parsed)
    // An empty line or a comment leaves `$?` as it was.
    if (parsed.ast === null) return session.lastStatus
    let steps = stepsOf(parsed.ast, ";")
    let aliases = aliasKey(session)
    let status = session.lastStatus
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]
      if (step === undefined) break
      if (step.op === "&&" ? status !== EXIT.OK : step.op === "||" && status === EXIT.OK) continue
      if (job.isAborted()) return EXIT.INTERRUPTED
      status = await runPipeline(frame, step.pipeline)
      if (job.isAborted()) return EXIT.INTERRUPTED
      session.lastStatus = status
      if (session.exitRequested !== null) return status
      const next = steps[i + 1]
      // The line was parsed whole, so an alias defined by this pipeline is not yet in what
      // follows: parse the rest again. Pipelines that came out of one alias word share its
      // span, and are not parsed twice.
      if (next === undefined || aliasKey(session) === aliases || next.pipeline.span[0] < step.pipeline.span[1]) continue
      aliases = aliasKey(session)
      text = text.slice(next.pipeline.span[0])
      const rest = core.parser.parse(text, options)
      if (!rest.ok) return syntax(frame, rest)
      if (rest.ast === null) break
      steps = stepsOf(rest.ast, next.op)
      i = -1
    }
    return status
  }

  const script = async (frame: Frame, text: string): Promise<number> => {
    const { job, session } = frame
    const options: ParseOptions = { alias: (name) => session.aliases.get(name) }
    const lines = text.split("\n")
    let status: number = EXIT.OK
    for (let i = 0; i < lines.length; i++) {
      let line = lines[i] ?? ""
      // An open quote or a trailing operator continues on the next line, as it does in the editor.
      for (;;) {
        const next = lines[i + 1]
        const result = core.parser.parse(line, options)
        if (next === undefined || result.ok || !result.incomplete) break
        line += `\n${next}`
        i++
      }
      status = await runLine(frame, line)
      if (job.isAborted()) return EXIT.INTERRUPTED
      if (session.exitRequested !== null) break
    }
    return status
  }

  /** Runs an egg on the frame's streams; PASS when it declines. */
  const runEgg = async (frame: Frame, egg: EggDef, argv: string[]): Promise<number | typeof PASS> => {
    const { job, io } = frame
    const control = new AbortController()
    const stageIo: StageIo = { stdin: io.stdin(), stdout: io.stdout.retain(), stderr: io.stderr.retain() }
    const session = cloneSession(frame.session)
    const stage: Stage = { frame, session, io: stageIo, control, env: procEnv(session, {}), started: noop }
    job.controls.add(control)
    const result = await invoke(stage, egg.id, makeProc(stage, argv, RAW), egg.run)
    job.controls.delete(control)
    stageIo.stdin.done()
    await stageIo.stdout.release()
    await stageIo.stderr.release()
    return result
  }

  const egg = async (frame: Frame, def: EggDef): Promise<number> => {
    const result = await runEgg(frame, def, [def.id])
    if (frame.job.isAborted()) return EXIT.INTERRUPTED
    const status = result === PASS ? EXIT.OK : result
    frame.session.lastStatus = status
    return status
  }

  const line = async (frame: Frame, text: string): Promise<number> => {
    const { job } = frame
    for (const egg of core.eggs) {
      const { trigger } = egg
      if (!("input" in trigger)) continue
      trigger.input.lastIndex = 0
      if (!trigger.input.test(text)) continue
      // An input egg sees the raw line as argv[0], on the line's own streams.
      const result = await runEgg(frame, egg, [text])
      if (job.isAborted()) return EXIT.INTERRUPTED
      if (result === PASS) continue
      frame.session.lastStatus = result
      return result
    }
    return runLine(frame, text)
  }

  const source = async (p: Proc, session: Session, text: string): Promise<number> => {
    const stage = stages.get(p)
    if (stage === undefined) throw new RiteError("EINVAL", undefined, "not a process of this kernel")
    return script(nested(stage, session), text)
  }

  return { line, script, source, egg }
}
