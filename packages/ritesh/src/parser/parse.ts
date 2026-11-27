// Builds the AST from lexed items: list, pipeline, command. Alias bodies are
// lexed and spliced in at the command word, so a body may hold operators.
import type {
  Assignment, List, ParseOptions, ParseResult, Pipeline, Redirect, RedirectOp, SimpleCommand, Span,
  SyntaxErrorInfo, Word,
} from "../contracts.js"
import { type Item, lex, RESERVED_WORDS, type WordItem } from "./lexer.js"

/** A guard against alias sets that grow without end (a; a where a is b; b, and so on). */
const MAX_ALIAS_EXPANSIONS = 1000

type TargetOp = Exclude<RedirectOp, "2>&1" | ">&2">

/** Why parsing ended early. */
class Stop {
  readonly error: SyntaxErrorInfo | undefined
  constructor(error?: SyntaxErrorInfo) {
    this.error = error
  }
}

function fail(message: string, span: Span): Stop {
  return new Stop({ message, span })
}

function spanOf(item: Item): Span {
  return item.type === "word" ? item.word.span : item.span
}

export function reservedMessage(token: string, version: string): string {
  const base = `'${token}' is not supported in rite ${version}`
  return token === "&" ? `${base}; quote the argument if it is part of a URL` : base
}

/** An item from an alias body takes the alias word's place in the line. */
function relocate(item: Item, span: Span, noAlias: ReadonlySet<string>): Item {
  if (item.type !== "word") return { ...item, span }
  const a = item.assignment
  return {
    type: "word",
    word: { parts: item.word.parts, span },
    bare: item.bare,
    assignment: a && { name: a.name, value: { parts: a.value.parts, span }, span },
    noAlias,
  }
}

class Run {
  private pos = 0
  private expansions = 0
  private readonly items: Item[]
  private readonly incomplete: boolean
  private readonly version: string
  private readonly alias: ParseOptions["alias"]

  constructor(items: Item[], incomplete: boolean, version: string, alias: ParseOptions["alias"]) {
    this.items = items
    this.incomplete = incomplete
    this.version = version
    this.alias = alias
  }

  private atEnd(): boolean {
    return this.pos >= this.items.length
  }

  list(): List | null | Stop {
    if (this.atEnd()) return this.incomplete ? new Stop() : null
    const first = this.pipeline()
    if (first instanceof Stop) return first
    const rest: List["rest"] = []
    let end = first.span[1]
    for (;;) {
      const item = this.items[this.pos]
      if (item === undefined) break
      // Not reached: a pipeline ends only at a list operator or the end of the line.
      if (item.type !== "op" || item.op === "|") return fail("unexpected token", spanOf(item))
      this.pos++
      if (this.atEnd()) {
        // A trailing `;` ends the list; a trailing `&&` or `||` wants more.
        if (this.incomplete || item.op !== ";") return new Stop()
        break
      }
      const pipeline = this.pipeline()
      if (pipeline instanceof Stop) return pipeline
      rest.push({ op: item.op, pipeline })
      end = pipeline.span[1]
    }
    return { type: "list", first, rest, span: [first.span[0], end] }
  }

  private pipeline(): Pipeline | Stop {
    const first = this.command()
    if (first instanceof Stop) return first
    const commands = [first]
    let end = first.span[1]
    for (;;) {
      const item = this.items[this.pos]
      if (item?.type !== "op" || item.op !== "|") break
      this.pos++
      if (this.atEnd()) return new Stop()
      const command = this.command()
      if (command instanceof Stop) return command
      commands.push(command)
      end = command.span[1]
    }
    return { type: "pipeline", commands, span: [first.span[0], end] }
  }

  private command(): SimpleCommand | Stop {
    const assignments: Assignment[] = []
    const words: Word[] = []
    const redirects: Redirect[] = []
    let pending: { op: TargetOp; span: Span } | undefined
    let start: number | undefined
    let end = 0
    for (;;) {
      const item = this.items[this.pos]
      if (item === undefined || item.type === "op") {
        if (item === undefined && this.incomplete) return new Stop()
        if (pending) return fail("redirect with no target", pending.span)
        if (start === undefined) {
          return item === undefined ? new Stop() : fail(`unexpected '${item.op}'`, item.span)
        }
        if (words.length === 0 && redirects.length > 0) return fail("redirect with no command", [start, end])
        return { type: "command", assignments, words, redirects, span: [start, end] }
      }
      const span = spanOf(item)
      if (item.type === "reserved") return fail(reservedMessage(item.token, this.version), span)
      start ??= span[0]
      end = span[1]
      if (item.type === "redirect") {
        if (pending) return fail("redirect with no target", pending.span)
        if (item.op === "2>&1" || item.op === ">&2") redirects.push({ op: item.op, span })
        else pending = { op: item.op, span }
      } else if (pending) {
        redirects.push({ op: pending.op, target: item.word, span: [pending.span[0], span[1]] })
        pending = undefined
      } else if (words.length > 0) {
        words.push(item.word)
      } else if (item.assignment) {
        assignments.push(item.assignment)
      } else {
        // Command position.
        if (item.bare !== undefined) {
          if (RESERVED_WORDS.has(item.bare)) return fail(reservedMessage(item.bare, this.version), span)
          const expanded = this.expand(item, item.bare)
          if (expanded instanceof Stop) return expanded
          if (expanded) continue
        }
        words.push(item.word)
      }
      this.pos++
    }
  }

  /** Replace the alias word at pos with its body's items. False when the word is not an alias. */
  private expand(item: WordItem, name: string): boolean | Stop {
    if (this.alias === undefined || item.noAlias?.has(name) === true) return false
    const body = this.alias(name)
    if (body === undefined) return false
    const span = item.word.span
    if (++this.expansions > MAX_ALIAS_EXPANSIONS) return fail(`alias '${name}' expands without end`, span)
    const lexed = lex(body)
    if (lexed.incomplete) return fail(`alias '${name}' ends inside a quote or on a backslash`, span)
    const noAlias = new Set(item.noAlias).add(name)
    this.items.splice(this.pos, 1, ...lexed.items.map((it) => relocate(it, span, noAlias)))
    return true
  }
}

export function parse(line: string, version: string, options?: ParseOptions): ParseResult {
  const { tokens, items, incomplete } = lex(line)
  const result = new Run(items, incomplete, version, options?.alias).list()
  if (!(result instanceof Stop)) return { ok: true, ast: result, tokens }
  if (result.error === undefined) return { ok: false, incomplete: true, tokens }
  return { ok: false, incomplete: false, error: result.error, tokens }
}
