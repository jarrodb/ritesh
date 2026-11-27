// Completion: command names in command position, the command's own hook or
// its definition for arguments, and vfs paths otherwise. Candidates carry
// values, never quoting: the editor inserts them through parser.quoteWord.
import type {
  Candidate, CompleteContext, Completion, Entry, InodeType, Parser, Session, Span, Token, Vfs,
} from "../contracts.js"
import { compareCodePoints } from "../vfs/path.js"
import type { Builtin } from "./builtins.js"
import { expandText } from "./expand.js"
import { type CommandNode, flagNames } from "./flags.js"
import { locate, type Registry } from "./registry.js"
import { getVar, procEnv } from "./session.js"

export interface CompleteCore {
  readonly parser: Parser
  readonly registry: Registry
  readonly builtins: ReadonlyMap<string, Builtin>
  fs(uid: number): Vfs
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

const isWord = (token: Token): boolean =>
  token.kind === "word" || (token.kind === "reserved" && /^\w+$/.test(token.text))

const described = (value: string, description: string | undefined): Candidate =>
  description === undefined || description === "" ? { value } : { value, description }

/** Entries of the directory a path prefix names. Dotfiles show only when the prefix asks for them. */
export async function pathCandidates(
  fs: Vfs, cwd: string, prefix: string, signal: AbortSignal, keep: (type: InodeType) => boolean = () => true,
): Promise<Candidate[]> {
  const slash = prefix.lastIndexOf("/")
  const dir = prefix.slice(0, slash + 1)
  const base = prefix.slice(slash + 1)
  const entries: Entry[] = await fs.list(dir === "" ? "." : dir, cwd, { signal }).catch(() => [])
  const candidates: Candidate[] = []
  for (const entry of entries) {
    if (!entry.name.startsWith(base) || (entry.name.startsWith(".") && !base.startsWith("."))) continue
    const value = dir + entry.name
    const type = entry.type === "link" ? fs.peek(value, cwd)?.type ?? "link" : entry.type
    if (!keep(type)) continue
    candidates.push(type === "dir" ? { value, display: entry.name, suffix: "/" } : { value, display: entry.name })
  }
  return candidates
}

export async function complete(
  core: CompleteCore, session: Session, line: string, cursor: number, signal: AbortSignal,
): Promise<Completion> {
  const tokens = core.parser.tokenize(line.slice(0, cursor))
  const last = tokens.at(-1)
  // The word the cursor is in, or at the end of. Candidates replace it up to the cursor.
  const current = last !== undefined && isWord(last) ? last : undefined
  const span: Span = current === undefined ? [cursor, cursor] : [current.span[0], cursor]
  const none: Completion = { span, candidates: [] }
  if (last?.kind === "comment") return none

  // The words of the command the cursor is in, and whether a redirect waits for its target.
  const words: string[] = []
  let target = false
  for (const token of current === undefined ? tokens : tokens.slice(0, -1)) {
    if (token.kind === "whitespace" || token.kind === "comment") continue
    if (token.kind === "operator") {
      words.length = 0
      target = false
    } else if (token.kind === "redirect") {
      target = token.text !== "2>&1" && token.text !== ">&2"
    } else if (!isWord(token)) {
      return none
    } else if (target) {
      target = false
    } else if (words.length > 0 || !ASSIGNMENT.test(token.text)) {
      words.push(token.text)
    }
  }

  const scope = {
    get: (name: string): string | undefined =>
      name === "?" ? String(session.lastStatus) : getVar(session.env, name),
    home: (): string => getVar(session.env, "HOME") ?? session.home,
  }
  /** A word's value as typed so far: expanded, unquoted, an open quote closed. Undefined when it is not one word. */
  const valueOf = (raw: string): string | undefined => {
    if (raw === "") return ""
    for (const close of ["", '"', "'"]) {
      const result = core.parser.parse(`x ${raw}${close}`)
      if (!result.ok || result.ast === null) continue
      const [cmd] = result.ast.first.commands
      const [, word, extra] = cmd?.words ?? []
      if (result.ast.rest.length > 0 || cmd === undefined || extra !== undefined || cmd.redirects.length > 0) return undefined
      return word === undefined ? "" : expandText(word, scope)
    }
    return undefined
  }

  const prefix = valueOf(current?.text ?? "")
  if (prefix === undefined) return none
  const fs = core.fs(session.uid)
  const { cwd } = session
  const env = procEnv(session, {})
  const path = getVar(env, "PATH") ?? ""
  const finish = (candidates: Candidate[]): Completion => (signal.aborted ? none : { span, candidates })
  const paths = (): Promise<Candidate[]> => pathCandidates(fs, cwd, prefix, signal)

  if (target) return finish(await paths())

  if (words.length === 0) {
    if (current !== undefined && ASSIGNMENT.test(current.text)) return none
    if (prefix.includes("/")) return finish(await paths())
    const found = new Map<string, Candidate>()
    const add = (name: string, description: string | undefined): void => {
      if (name.startsWith(prefix) && !found.has(name)) found.set(name, described(name, description))
    }
    for (const [name, body] of session.aliases) add(name, `alias for ${body}`)
    for (const [name, builtin] of core.builtins) add(name, builtin.def.summary)
    for (const dir of path.split(":")) {
      const entries: Entry[] = await fs.list(dir === "" ? "." : dir, cwd, { signal }).catch(() => [])
      for (const entry of entries) {
        const inode = fs.peek(`${dir === "" ? "." : dir}/${entry.name}`, cwd)
        if (inode?.type === "cmd") add(entry.name, inode.command?.summary)
      }
    }
    for (const { source } of core.registry.sources) {
      for (const name of source.names()) add(name, source.info(name)?.summary)
    }
    return finish([...found.values()].sort((a, b) => compareCodePoints(a.value, b.value)))
  }

  const argv = [...words.map((word) => valueOf(word) ?? ""), prefix]
  const index = words.length
  const name = argv[0] ?? ""
  const ctx: CompleteContext = { argv, index, prefix, env, cwd, fs, signal }
  // An alias stands for another line; its arguments complete as paths.
  if (session.aliases.has(name)) return finish(await paths())

  const builtin = core.builtins.get(name)
  const located = builtin === undefined ? locate(core.registry, name, path, cwd) : undefined
  if (located?.kind === "source") {
    const { source } = located
    if (source.complete === undefined) return finish(await paths())
    return finish(await source.complete(argv, index, signal).catch(() => []))
  }
  const def = builtin?.def ?? (located?.kind === "command" ? located.def : undefined)
  if (def === undefined) return finish(await paths())

  // Down the subcommands named so far: the deepest hook wins, and flags add up.
  let node: CommandNode = def
  let hook = def.complete
  let flags = def.flags
  let naming = true
  for (const arg of argv.slice(1, index)) {
    if (flags !== undefined && arg.startsWith("-") && arg !== "-") continue
    const sub = naming && node.subcommands !== undefined && Object.hasOwn(node.subcommands, arg)
      ? node.subcommands[arg]
      : undefined
    if (sub === undefined) {
      naming = false
      continue
    }
    node = sub
    hook = sub.complete ?? hook
    if (sub.flags !== undefined) flags = { ...flags, ...sub.flags }
  }
  if (hook !== undefined) return finish(await hook(ctx).catch(() => []))
  if (naming && node.subcommands !== undefined) {
    const subs = Object.entries(node.subcommands).filter(([sub]) => sub.startsWith(prefix))
    return finish(subs.map(([sub, { summary }]) => described(sub, summary)))
  }
  if (flags !== undefined && prefix.startsWith("-")) {
    const names = flagNames(flags).filter((flag) => flag.name.startsWith(prefix))
    return finish(names.map((flag) => described(flag.name, flag.description)))
  }
  return finish(await paths())
}

