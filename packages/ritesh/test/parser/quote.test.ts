import { describe, expect, it } from "vitest"
import type { ParseResult, Word } from "../../src/contracts.js"
import { parser } from "./support.js"

const CONTEXTS = ["bare", "double", "single"] as const

const VALUES = [
  "", "plain", "a b", "  lead and trail  ", "a\tb", "a\nb", "\n", "a\r\nb", "it's", "'", "''", "'a'", "a'",
  "say \"hi\"", "\"", "\"\"", "a\\b", "\\", "\\\\", "a\\", "\\'", "\\\"", "'\"'\"", "$HOME", "${HOME}", "$", "$$",
  "$1", "$(x)", "$((1))", "$?", "a$b", "\\$HOME", "*", "**", "a*b", "*.txt", "[ab]", "[[", "]", "[", "a?b", "?",
  "#", "#tag", "a#b", "a #b", "~", "~/x", "~root", "a~", "&", "a&b", "&&", "https://x/?a=1&b=2", "|", "||", "|&",
  ";", ";;", "<", ">", "<<", ">>", "2>&1", ">&2", "2>", "2", "&>", ">|", "(", ")", "((", "{", "}", "{\"a\":1}",
  "`", "`x`", "X=1", "X=", "_a=b c", "=", "a=b=c", "!", "if", "then", "done", "local", "for", "in", "-n", "--",
  "caf\u00e9", "\u{1F600}", "\u{1F600} \u{1F600}", "a\u00a0b", "\u0007", "\u001b[31m", "\ud83d", "a\\ b",
  "a\\\nb", "\\\n", "a`b", "``", "`a`", "a\\`b", "$`\"",
  "'; rm -rf /; '", "\"; x; \"", "$(x) `y` ${z}", "a\nb\n", " ", "\t",
]

/** The words of a line that must be one command with no redirects or assignments. */
function words(result: ParseResult): Word[] {
  if (!result.ok || result.ast === null) throw new Error("not parsed")
  expect(result.ast.rest).toEqual([])
  expect(result.ast.first.commands).toHaveLength(1)
  const command = result.ast.first.commands[0]
  expect(command?.assignments).toEqual([])
  expect(command?.redirects).toEqual([])
  return command?.words ?? []
}

function literalValue(word: Word | undefined): string {
  expect(word).toBeDefined()
  expect(word?.parts.length).toBeGreaterThan(0)
  for (const part of word?.parts ?? []) expect(part.kind).toBe("literal")
  return (word?.parts ?? []).map((p) => (p.kind === "literal" ? p.text : "")).join("")
}

describe("quoteWord", () => {
  describe.each(CONTEXTS)("%s", (context) => {
    it.each(VALUES)("round-trips %j", (value) => {
      const quoted = parser.quoteWord(value, context)
      // Alone, where the word is in command position.
      const alone = words(parser.parse(quoted))
      expect(alone).toHaveLength(1)
      expect(literalValue(alone[0])).toBe(value)
      // As an argument, between other words.
      const between = words(parser.parse(`echo ${quoted} end`))
      expect(between).toHaveLength(3)
      expect(literalValue(between[1])).toBe(value)
      // As a redirect target, with no space before it.
      const target = parser.parse(`echo >${quoted}`)
      if (!target.ok || target.ast === null) throw new Error("not parsed")
      expect(literalValue(target.ast.first.commands[0]?.redirects[0]?.target)).toBe(value)
      // Twice, adjacent: still one word.
      const twice = words(parser.parse(`echo ${quoted}${quoted}`))
      expect(twice).toHaveLength(2)
      expect(literalValue(twice[1])).toBe(value + value)
    })
  })

  it.each<[string, "bare" | "double" | "single", string]>([
    ["", "bare", "''"],
    ["", "double", "\"\""],
    ["", "single", "''"],
    ["plain", "bare", "plain"],
    ["plain", "double", "\"plain\""],
    ["plain", "single", "'plain'"],
    ["a b", "bare", "a\\ b"],
    ["my file.txt", "single", "'my file.txt'"],
    ["it's", "bare", "it\\'s"],
    ["it's", "double", "\"it's\""],
    ["it's", "single", "'it'\\''s'"],
    ["'", "single", "\\'"],
    ["a\"b$c\\d", "double", "\"a\\\"b\\$c\\\\d\""],
    ["a\"b$c\\d", "single", "'a\"b$c\\d'"],
    ["$HOME", "bare", "\\$HOME"],
    ["*.txt", "bare", "\\*.txt"],
    ["[ab]", "bare", "\\[ab]"],
    ["#tag", "bare", "\\#tag"],
    ["a#b", "bare", "a#b"],
    ["~/x", "bare", "\\~/x"],
    ["a~", "bare", "a~"],
    ["a&b", "bare", "a\\&b"],
    ["a\nb", "bare", "a'\n'b"],
    ["a\nb", "double", "\"a\nb\""],
    ["a\\\nb", "bare", "a\\\\'\n'b"],
    ["a\\\nb", "double", "\"a\\\\\nb\""],
    ["a`b", "bare", "a\\`b"],
    ["a`b", "double", "\"a\"\\`\"b\""],
    ["a`b", "single", "'a`b'"],
    ["`", "double", "\\`"],
    ["X=1", "bare", "X\\=1"],
    ["a=b=c", "bare", "a\\=b=c"],
    ["-x=1", "bare", "-x=1"],
    ["if", "bare", "\\if"],
    ["!", "bare", "\\!"],
    ["a!b?c", "bare", "a!b?c"],
    ["/usr/bin/ls", "bare", "/usr/bin/ls"],
    ["caf\u00e9", "bare", "caf\u00e9"],
  ])("quoteWord(%j, %s) is %j", (value, context, expected) => {
    expect(parser.quoteWord(value, context)).toBe(expected)
  })
})
