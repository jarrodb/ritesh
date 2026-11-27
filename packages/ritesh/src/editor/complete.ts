// What Tab inserts. Candidate values are raw; they reach the line through
// parser.quoteWord, in the quoting the word under the cursor is already in.
import type { Candidate, Parser } from "../contracts.js"

export type QuoteContext = "bare" | "single" | "double"

/** The quoting in force at the end of the text of a word being typed. */
export function quoteContext(text: string): QuoteContext {
  let i = 0
  while (i < text.length) {
    const c = text.charAt(i)
    if (c === "\\") {
      i += 2
    } else if (c === "'") {
      const close = text.indexOf("'", i + 1)
      if (close < 0) return "single"
      i = close + 1
    } else if (c === '"') {
      i++
      while (i < text.length && text.charAt(i) !== '"') i += text.charAt(i) === "\\" ? 2 : 1
      if (i >= text.length) return "double"
      i++
    } else {
      i++
    }
  }
  return "bare"
}

/** The longest prefix every value shares, never ending inside a surrogate pair. */
export function commonPrefix(values: readonly string[]): string {
  let prefix = values[0] ?? ""
  for (const value of values) {
    let i = 0
    while (i < prefix.length && i < value.length && prefix.charCodeAt(i) === value.charCodeAt(i)) i++
    prefix = prefix.slice(0, i)
  }
  const last = prefix.charCodeAt(prefix.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? prefix.slice(0, -1) : prefix
}

/** A value quoted with its quote left open, so the word can go on. */
export function openWord(parser: Parser, value: string, context: QuoteContext): string {
  if (context === "bare") return value === "" ? "" : parser.quoteWord(value, "bare")
  const quote = context === "single" ? "'" : '"'
  if (value === "") return quote
  const quoted = parser.quoteWord(value, context)
  // quoteWord closes the quote unless the value ends in the character it had to write outside the quotes.
  const outside = context === "single" ? "'" : "`"
  return value.endsWith(outside) ? quoted : quoted.slice(0, -1)
}

/** A candidate as inserted: quoted, then its suffix (a space by default). */
export function wholeWord(parser: Parser, candidate: Candidate, context: QuoteContext): string {
  const suffix = candidate.suffix ?? " "
  // A blank suffix ends the word, so the quote closes. Any other suffix ("/", "") keeps the word open.
  if (suffix !== "" && suffix.trim() === "") return parser.quoteWord(candidate.value, context) + suffix
  if (context === "bare") return openWord(parser, candidate.value, "bare") + suffix
  return openWord(parser, candidate.value + suffix, context)
}
