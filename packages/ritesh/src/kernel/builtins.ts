// The builtins: commands that change the session. Each runs on a copy of the
// session, which the executor keeps when the builtin finishes; in a pipeline
// the stage's session is itself a copy, so nothing persists.
import {
  type BuiltinRun, type CommandDef, type Completer, EXIT, type Proc, RiteError, type Session,
} from "../contracts.js"
import { compareCodePoints } from "../vfs/path.js"
import { clampStatus } from "./errors.js"
import { getVar, NAME, READ_ONLY } from "./session.js"

export interface Builtin {
  def: CommandDef
  run: BuiltinRun
  /**
   * Runs on the session itself, not a copy. For `source`, whose lines each
   * change the session as they finish, so ^C keeps what ran before it.
   */
  live?: true
}

export interface BuiltinHost {
  readonly version: string
  /** A value in single quotes, as `alias` and `export` print it. */
  quote(value: string): string
  history(): readonly string[]
  /** Runs a file's text line by line in the builtin's session. */
  source(p: Proc, session: Session, text: string): Promise<number>
  /** Directory candidates, for `cd`. */
  directories: Completer
}

const ALIAS_NAME = /^[\w.:+@%,!?^-]+$/u

export function createBuiltins(host: BuiltinHost): Map<string, Builtin> {
  const cd: Builtin = {
    def: {
      name: "cd", summary: "change the working directory", usage: "cd [dir | -]", flags: {},
      complete: host.directories,
    },
    run: async (p, session) => {
      const [arg, extra] = p.args
      if (extra !== undefined) {
        await p.err("rite: cd: too many arguments\n")
        return EXIT.FAILURE
      }
      const back = arg === "-"
      const target = back ? session.oldCwd : arg ?? getVar(session.env, "HOME") ?? session.home
      const stat = await p.fs.stat(target, session.cwd)
      if (stat.type === "action") {
        const result = await p.fs.activate(target, session.cwd, "cd")
        const text = result?.output
        if (text !== undefined) await p.out(text.endsWith("\n") ? text : `${text}\n`)
        return EXIT.OK
      }
      if (stat.type !== "dir") throw new RiteError("ENOTDIR", target)
      if (!(await p.fs.access(target, session.cwd, session.uid, "x"))) throw new RiteError("EACCES", target)
      session.oldCwd = session.cwd
      session.cwd = p.fs.resolve(target, session.cwd)
      session.env.OLDPWD = session.oldCwd
      session.env.PWD = session.cwd
      if (back) await p.out(`${session.cwd}\n`)
      return EXIT.OK
    },
  }

  const exportVars: Builtin = {
    def: { name: "export", summary: "mark variables for child processes", usage: "export [name[=value]...]", flags: {} },
    run: async (p, session) => {
      if (p.args.length === 0) {
        const lines = [...session.exported].sort(compareCodePoints).flatMap((name) => {
          const value = getVar(session.env, name)
          return value === undefined ? [] : [`export ${name}=${host.quote(value)}\n`]
        })
        await p.out(lines.join(""))
        return EXIT.OK
      }
      let status: number = EXIT.OK
      for (const arg of p.args) {
        const equals = arg.indexOf("=")
        const name = equals < 0 ? arg : arg.slice(0, equals)
        if (!NAME.test(name)) {
          await p.err(`rite: export: ${arg}: not a valid identifier\n`)
          status = EXIT.FAILURE
        } else if (equals >= 0 && READ_ONLY.has(name)) {
          await p.err(`rite: export: ${name}: read-only variable\n`)
          status = EXIT.FAILURE
        } else {
          if (equals >= 0) session.env[name] = arg.slice(equals + 1)
          session.exported.add(name)
        }
      }
      return status
    },
  }

  const unset: Builtin = {
    def: { name: "unset", summary: "remove variables", usage: "unset name...", flags: {} },
    run: async (p, session) => {
      let status: number = EXIT.OK
      for (const name of p.args) {
        if (READ_ONLY.has(name)) {
          await p.err(`rite: unset: ${name}: read-only variable\n`)
          status = EXIT.FAILURE
        } else {
          Reflect.deleteProperty(session.env, name)
          session.exported.delete(name)
        }
      }
      return status
    },
  }

  const alias: Builtin = {
    def: { name: "alias", summary: "define or list aliases", usage: "alias [name[=body]...]", flags: {} },
    run: async (p, session) => {
      const show = (name: string, body: string): string => `${name}=${host.quote(body)}\n`
      if (p.args.length === 0) {
        const names = [...session.aliases.keys()].sort(compareCodePoints)
        await p.out(names.map((name) => show(name, session.aliases.get(name) ?? "")).join(""))
        return EXIT.OK
      }
      let status: number = EXIT.OK
      for (const arg of p.args) {
        const equals = arg.indexOf("=")
        const name = equals < 0 ? arg : arg.slice(0, equals)
        const body = session.aliases.get(name)
        if (equals >= 0 && ALIAS_NAME.test(name)) {
          session.aliases.set(name, arg.slice(equals + 1))
        } else if (equals < 0 && body !== undefined) {
          await p.out(show(name, body))
        } else {
          await p.err(`rite: alias: ${name}: ${equals < 0 ? "not found" : "invalid alias name"}\n`)
          status = EXIT.FAILURE
        }
      }
      return status
    },
  }

  const unalias: Builtin = {
    def: {
      name: "unalias", summary: "remove aliases", usage: "unalias [-a] name...",
      flags: { a: { type: "boolean", description: "remove every alias" } },
    },
    run: async (p, session) => {
      if (p.flags.a === true) session.aliases.clear()
      let status: number = EXIT.OK
      for (const name of p.args) {
        if (session.aliases.delete(name)) continue
        await p.err(`rite: unalias: ${name}: not found\n`)
        status = EXIT.FAILURE
      }
      return status
    },
  }

  const exit: Builtin = {
    // No flags: `exit -1` is a status, not an option.
    def: { name: "exit", summary: "end the session", usage: "exit [status]" },
    run: async (p, session) => {
      const [arg] = p.args
      let code = session.lastStatus
      if (arg !== undefined) {
        if (/^-?\d+$/.test(arg)) {
          code = clampStatus(Number(arg))
        } else {
          await p.err(`rite: exit: ${arg}: numeric argument required\n`)
          code = EXIT.USAGE
        }
      }
      session.exitRequested = code
      return code
    },
  }

  const history: Builtin = {
    def: { name: "history", summary: "list the lines entered", usage: "history", flags: {} },
    run: async (p) => {
      await p.out(host.history().map((line, i) => `${String(i + 1).padStart(5)}  ${line}\n`).join(""))
    },
  }

  const source: Builtin = {
    live: true,
    def: { name: "source", summary: "run a file's lines in this session", usage: "source file", flags: {} },
    run: async (p, session) => {
      const [file] = p.args
      if (file === undefined) {
        await p.err("rite: source: missing file\nusage: source file\n")
        return EXIT.USAGE
      }
      return host.source(p, session, await p.fs.read(file, session.cwd))
    },
  }

  const rite: Builtin = {
    def: {
      name: "rite", summary: "the rite shell", usage: "rite --version | rite -c line",
      flags: {
        version: { type: "boolean", description: "print the version" },
        c: { type: "string", description: "run a line in a child session" },
      },
    },
    run: async (p) => {
      if (p.flags.version === true) {
        await p.out(`rite ${host.version}\n`)
        return EXIT.OK
      }
      if (typeof p.flags.c === "string") return p.sys.run(p.flags.c)
      await p.err("rite: rite: interactive child shells are not supported\nusage: rite --version | rite -c line\n")
      return EXIT.USAGE
    },
  }

  return new Map([cd, exportVars, unset, alias, unalias, exit, history, source, rite].map((b) => [b.def.name, b]))
}
