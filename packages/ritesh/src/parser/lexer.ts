// Lexer for the rite language (docs/language.md). One pass over the line
// produces the highlighting tokens, which cover every code unit, and the
// items the parser builds the AST from. It never throws.
//
// Choices where the language document is silent:
// - An unquoted newline is blank, like a space, so a line continued after a
//   trailing operator parses. A comment ends at a newline.
// - 2>&1 and >&2 are redirects only when a word boundary follows them.
// - A glob part is one `*` or one whole `[...]` class. A class holds plain
//   unquoted characters only, with no `/` and no `[`; otherwise `[` is a literal.
// - `~` at the start of a word, followed by anything but `/` or the end of
//   the word, is the reserved `~user`.
// - `**` is reserved like the rest of the reserved syntax.
// - A backslash-newline is removed inside a word, between words, and inside
//   double quotes. It does not join the halves of an operator, a parameter
//   reference, or a class that it splits.
import type { Assignment, RedirectOp, Span, Token, TokenKind, Word, WordPart } from "../contracts.js"

export type ControlOp = ";" | "&&" | "||" | "|"

export interface WordItem {
  type: "word"
  word: Word
  /** The text, when the word is one unquoted literal: the only form checked for aliases and reserved words. */
  bare: string | undefined
  /** Set when the word has the form NAME=value; it counts only before the command word. */
  assignment: Assignment | undefined
  /** Aliases this word came out of, which are not expanded again. */
  noAlias: ReadonlySet<string> | undefined
}

export type Item =
  | WordItem
  | { type: "op"; op: ControlOp; span: Span }
  | { type: "redirect"; op: RedirectOp; span: Span }
  | { type: "reserved"; token: string; span: Span }

export interface Lexed {
  tokens: Token[]
  items: Item[]
  /** The line ends inside a quote or on an unquoted backslash. */
  incomplete: boolean
}

export const RESERVED_WORDS: ReadonlySet<string> = new Set([
  "!", "if", "then", "else", "elif", "fi", "for", "in", "do", "done", "while", "until",
  "case", "esac", "function", "return", "break", "continue", "local",
])

const NAME = "[A-Za-z_][A-Za-z0-9_]*"
const PARAM = new RegExp(`\\$(?:(${NAME})|\\{(${NAME})\\}|(\\?))`, "y")
export const ASSIGNMENT_PREFIX: RegExp = new RegExp(`^(${NAME})=`)

const BLANK: ReadonlySet<string> = new Set([" ", "\t", "\n"])
/** Characters that end a word when unquoted. */
const WORD_END: ReadonlySet<string> = new Set([" ", "\t", "\n", ";", "&", "|", "<", ">", "(", ")", "{", "}", "`"])
/** Characters that keep `[` from opening a class. */
const CLASS_STOP: ReadonlySet<string> = new Set(["'", '"', "\\", "$", "/", "["])
const RESERVED_PARAMS = "0123456789@*#$!"
const CONTINUATION = "\\\n"

type Dollar = { kind: "param"; name: string } | { kind: "reserved"; token: string } | undefined
type QuoteEnd = "closed" | "open" | { reserved: string }

/** Append literal text, merging with a preceding literal of the same quoting. */
function literal(parts: WordPart[], text: string, quoted: boolean): void {
  const last = parts.at(-1)
  if (last?.kind === "literal" && last.quoted === quoted) last.text += text
  else if (text !== "" || quoted) parts.push({ kind: "literal", text, quoted })
}

function assignmentOf(parts: readonly WordPart[], span: Span, line: string): Assignment | undefined {
  const first = parts[0]
  if (first?.kind !== "literal" || first.quoted) return undefined
  const match = ASSIGNMENT_PREFIX.exec(first.text)
  const name = match?.[1]
  if (match === null || name === undefined) return undefined
  // No globbing in assignment values: glob characters are literals here.
  const value: WordPart[] = []
  literal(value, first.text.slice(match[0].length), false)
  for (const part of parts.slice(1)) {
    if (part.kind === "glob") literal(value, part.text, false)
    else if (part.kind === "literal") literal(value, part.text, part.quoted)
    else value.push(part)
  }
  // The value starts after `NAME=` in the source, where a continuation may split the name.
  let valueStart = span[0]
  for (let left = match[0].length; left > 0; ) {
    if (line.startsWith(CONTINUATION, valueStart)) {
      valueStart += 2
    } else {
      valueStart++
      left--
    }
  }
  return { name, value: { parts: value, span: [valueStart, span[1]] }, span }
}

export function lex(line: string): Lexed {
  const tokens: Token[] = []
  const items: Item[] = []
  const n = line.length
  let incomplete = false
  let i = 0
  // Tracked only to mark reserved words for highlighting; the parser decides
  // command position itself, since it also expands aliases.
  let commandPosition = true
  let targetPending = false

  const token = (kind: TokenKind, start: number, end: number): void => {
    tokens.push({ kind, text: line.slice(start, end), span: [start, end] })
  }

  const reserved = (text: string): void => {
    const span: Span = [i, i + text.length]
    token("reserved", span[0], span[1])
    items.push({ type: "reserved", token: text, span })
    i = span[1]
  }

  const control = (op: ControlOp): void => {
    const span: Span = [i, i + op.length]
    token("operator", span[0], span[1])
    items.push({ type: "op", op, span })
    i = span[1]
    commandPosition = true
    targetPending = false
  }

  const redirect = (op: RedirectOp): void => {
    const span: Span = [i, i + op.length]
    token("redirect", span[0], span[1])
    items.push({ type: "redirect", op, span })
    i = span[1]
    targetPending = op !== "2>&1" && op !== ">&2"
  }

  /** End of the run of blanks and continuations at `at`. */
  const blankEnd = (at: number): number => {
    let j = at
    for (;;) {
      if (BLANK.has(line.charAt(j))) j++
      else if (line.startsWith(CONTINUATION, j)) j += 2
      else return j
    }
  }

  const boundary = (at: number): boolean => at >= n || WORD_END.has(line.charAt(at))

  /** `>` forms at i, with `2` before them when fd is true. */
  const angle = (fd: boolean): void => {
    const dup = fd ? "2>&1" : ">&2"
    if (line.startsWith(dup, i) && boundary(i + dup.length)) redirect(dup)
    else if (line.startsWith(">>", fd ? i + 1 : i)) redirect(fd ? "2>>" : ">>")
    else redirect(fd ? "2>" : ">")
  }

  const finishWord = (start: number, parts: WordPart[]): void => {
    if (i === start) return
    const span: Span = [start, i]
    const first = parts[0]
    const bare = parts.length === 1 && first?.kind === "literal" && !first.quoted ? first.text : undefined
    const assignment = assignmentOf(parts, span, line)
    let kind: TokenKind = "word"
    if (targetPending) {
      targetPending = false
    } else if (commandPosition && assignment === undefined) {
      commandPosition = false
      if (bare !== undefined && RESERVED_WORDS.has(bare)) kind = "reserved"
    }
    token(kind, start, i)
    items.push({ type: "word", word: { parts, span }, bare, assignment, noAlias: undefined })
  }

  /** The rest of the line is an unfinished word. */
  const open = (start: number): void => {
    incomplete = true
    if (start < n) token("word", start, n)
    i = n
  }

  /** The name of the parameter reference at i, consumed, if there is one. */
  const param = (): string | undefined => {
    PARAM.lastIndex = i
    const match = PARAM.exec(line)
    const name = match?.[1] ?? match?.[2] ?? match?.[3]
    if (name !== undefined) i = PARAM.lastIndex
    return name
  }

  /**
   * `$` at i: a parameter (consumed), a reserved form (not consumed), or a
   * literal `$` (not consumed). Inside double quotes a `$` before a quote is a literal.
   */
  const dollar = (quoted: boolean): Dollar => {
    if (line.startsWith("$((", i)) return { kind: "reserved", token: "$((" }
    if (line.startsWith("$(", i)) return { kind: "reserved", token: "$(" }
    const next = line.charAt(i + 1)
    if (next === "'" || next === '"') return quoted ? undefined : { kind: "reserved", token: "$" + next }
    const name = param()
    if (name !== undefined) return { kind: "param", name }
    if (next === "{") return { kind: "reserved", token: "${" }
    if (next !== "" && RESERVED_PARAMS.includes(next)) return { kind: "reserved", token: "$" + next }
    return undefined
  }

  /**
   * `"..."` opening at i, or its rest when resumed after a reserved token.
   * The reserved `$` forms, other than `$'` and `$"`, and the backquote are errors in here too.
   */
  const double = (parts: WordPart[], resumed: boolean): QuoteEnd => {
    const before = parts.length
    let text = ""
    if (!resumed) i++
    while (i < n) {
      const c = line.charAt(i)
      if (c === '"') {
        i++
        // An empty quote still leaves a quoted part, so the word exists.
        if (text !== "" || parts.length === before) literal(parts, text, true)
        return "closed"
      }
      if (c === "\\") {
        const next = line.charAt(i + 1)
        if (next === '"' || next === "\\" || next === "$") {
          text += next
          i += 2
        } else if (next === "\n") {
          i += 2
        } else {
          text += c
          i++
        }
      } else if (c === "$" || c === "`") {
        const found: Dollar = c === "`" ? { kind: "reserved", token: c } : dollar(true)
        if (found === undefined) {
          text += c
          i++
          continue
        }
        if (text !== "") literal(parts, text, true)
        text = ""
        if (found.kind === "reserved") return { reserved: found.token }
        parts.push({ kind: "param", name: found.name, quoted: true })
      } else {
        text += c
        i++
      }
    }
    return "open"
  }

  /** End of the `[...]` class opening at `at`, or -1 when `[` is a literal. */
  const classEnd = (at: number): number => {
    let j = at + 1
    if (line.charAt(j) === "!") j++
    const first = j
    for (; j < n; j++) {
      const c = line.charAt(j)
      if (c === "]") return j > first ? j + 1 : -1
      if (CLASS_STOP.has(c) || WORD_END.has(c)) return -1
    }
    return -1
  }

  /** A word starting at i. With `resume`, i is inside a double quote that a reserved token interrupted. */
  const word = (resume: boolean): void => {
    const start = i
    const parts: WordPart[] = []
    /** A reserved token that cuts the word short. */
    let stop: string | undefined
    let inQuote = resume
    let stoppedInQuote = false
    /** The last continuation consumed: left to the blank after the word when it ends there. */
    let continuation: Span = [-1, -1]
    if (!resume && line.charAt(i) === "~") {
      const next = line.charAt(i + 1)
      if (next === "" || next === "/" || WORD_END.has(next)) {
        parts.push({ kind: "tilde", text: "~" })
        i++
      } else {
        let j = i + 1
        while (j < n && line.charAt(j) !== "/" && !WORD_END.has(line.charAt(j))) j++
        stop = line.slice(i, j)
      }
    }
    while (stop === undefined && (inQuote || i < n)) {
      const c = inQuote ? '"' : line.charAt(i)
      if (WORD_END.has(c)) break
      if (c === "'") {
        const close = line.indexOf("'", i + 1)
        if (close < 0) {
          open(start)
          return
        }
        literal(parts, line.slice(i + 1, close), true)
        i = close + 1
      } else if (c === '"') {
        const end = double(parts, inQuote)
        inQuote = false
        if (end === "open") {
          open(start)
          return
        }
        if (end !== "closed") {
          stop = end.reserved
          stoppedInQuote = true
        }
      } else if (c === "\\") {
        const next = line.codePointAt(i + 1)
        if (next === undefined) {
          open(start)
          return
        }
        const escaped = String.fromCodePoint(next)
        if (escaped === "\n") continuation = [continuation[1] === i ? continuation[0] : i, i + 2]
        else literal(parts, escaped, true)
        i += 1 + escaped.length
      } else if (c === "$") {
        const found = dollar(false)
        if (found === undefined) {
          literal(parts, c, false)
          i++
        } else if (found.kind === "param") {
          parts.push({ kind: "param", name: found.name, quoted: false })
        } else {
          stop = found.token
        }
      } else if (c === "*") {
        if (line.charAt(i + 1) === "*") {
          stop = "**"
        } else {
          parts.push({ kind: "glob", text: "*" })
          i++
        }
      } else if (c === "[") {
        const end = classEnd(i)
        if (line.charAt(i + 1) === "[") {
          stop = "[["
        } else if (end < 0) {
          literal(parts, c, false)
          i++
        } else {
          parts.push({ kind: "glob", text: line.slice(i, end) })
          i = end
        }
      } else {
        literal(parts, c, false)
        i++
      }
    }
    if (stop === undefined && continuation[1] === i) i = continuation[0]
    finishWord(start, parts)
    if (stop === undefined) return
    reserved(stop)
    if (stoppedInQuote) word(true)
  }

  while (i < n) {
    const c = line.charAt(i)
    const blank = blankEnd(i)
    if (blank > i) {
      token("whitespace", i, blank)
      i = blank
      continue
    }
    switch (c) {
      case "#": {
        // Only reached at the start of a word. A comment ends at a newline.
        const newline = line.indexOf("\n", i)
        const end = newline < 0 ? n : newline
        token("comment", i, end)
        i = end
        break
      }
      case ";":
        if (line.startsWith(";;", i)) reserved(";;")
        else control(";")
        break
      case "&":
        if (line.startsWith("&&", i)) control("&&")
        else if (line.startsWith("&>", i)) reserved("&>")
        else reserved("&")
        break
      case "|":
        if (line.startsWith("||", i)) control("||")
        else if (line.startsWith("|&", i)) reserved("|&")
        else control("|")
        break
      case "<":
        if (line.startsWith("<<<", i)) reserved("<<<")
        else if (line.startsWith("<<", i)) reserved("<<")
        else if (line.startsWith("<(", i)) reserved("<(")
        else redirect("<")
        break
      case ">":
        if (line.startsWith(">(", i)) reserved(">(")
        else if (line.startsWith(">|", i)) reserved(">|")
        else angle(false)
        break
      case "(":
        reserved(line.startsWith("((", i) ? "((" : "(")
        break
      case ")":
      case "{":
      case "}":
      case "`":
        reserved(c)
        break
      case "2":
        // A file descriptor only when it starts the word and `>` follows.
        if (line.charAt(i + 1) === ">" && !line.startsWith(">(", i + 1) && !line.startsWith(">|", i + 1)) angle(true)
        else word(false)
        break
      default:
        word(false)
    }
  }

  return { tokens, items, incomplete }
}
