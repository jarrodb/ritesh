import { describe, expect, it } from "vitest"
import type { Span, WordPart } from "../../src/contracts.js"
import { glob, lit, onlyCommand, par, parser, quo, tilde } from "./support.js"

/** The parts of the one argument of `echo <arg>`. */
function arg(source: string): WordPart[] {
  const words = onlyCommand(`echo ${source}`).words
  expect(words).toHaveLength(2)
  return words[1]?.parts ?? []
}

describe("word parts", () => {
  it.each<[string, WordPart[]]>([
    ["hi", [lit("hi")]],
    ["'a  b'", [quo("a  b")]],
    ["a'b'\"c\"", [lit("a"), quo("bc")]],
    ["'it''s'", [quo("its")]],
    ["''", [quo("")]],
    ["\"\"", [quo("")]],
    ["a''b", [lit("a"), quo(""), lit("b")]],
    ["'$HOME'", [quo("$HOME")]],
    ["'a\\'", [quo("a\\")]],
    ["'a\nb'", [quo("a\nb")]],
    // Unquoted backslash: the next character is a quoted literal.
    ["a\\ b", [lit("a"), quo(" "), lit("b")]],
    ["\\*", [quo("*")]],
    ["\\$X", [quo("$"), lit("X")]],
    ["\\~", [quo("~")]],
    ["\\#x", [quo("#"), lit("x")]],
    ["\\\\", [quo("\\")]],
    ["\\\u{1F600}", [quo("\u{1F600}")]],
    // A backslash-newline is removed, except in single quotes.
    ["a\\\nb", [lit("ab")]],
    ["a\\\n\\\nb", [lit("ab")]],
    ["\\\nx", [lit("x")]],
    ["a'b'\\\n\"c\"", [lit("a"), quo("bc")]],
    ["$X\\\ny", [par("X"), lit("y")]],
    ["\"a\\\nb\"", [quo("ab")]],
    ["\"a\\\n\"", [quo("a")]],
    ["\"\\\n\"", [quo("")]],
    ["\"$X\\\n\"", [par("X", true)]],
    ["'a\\\nb'", [quo("a\\\nb")]],
    ["a\\\\\\\nb", [lit("a"), quo("\\"), lit("b")]],
    // Double quotes: \" \\ \$ are the only escapes.
    ["\"a\\\"b\"", [quo("a\"b")]],
    ["\"a\\\\b\"", [quo("a\\b")]],
    ["\"\\$HOME\"", [quo("$HOME")]],
    ["\"a\\nb\"", [quo("a\\nb")]],
    ["\"a\\'b\"", [quo("a\\'b")]],
    ["\"it's\"", [quo("it's")]],
    ["\"* [ab] ~ # & | ; < > ( ) { } [[ (( ** ~root\"", [quo("* [ab] ~ # & | ; < > ( ) { } [[ (( ** ~root")]],
    // Parameters.
    ["$X", [par("X")]],
    ["${X}", [par("X")]],
    ["$?", [par("?")]],
    ["$_a1", [par("_a1")]],
    ["x${UNSET}y", [lit("x"), par("UNSET"), lit("y")]],
    ["$X$Y", [par("X"), par("Y")]],
    ["$X-y", [par("X"), lit("-y")]],
    ["$X.txt", [par("X"), lit(".txt")]],
    ["\"$X\"", [par("X", true)]],
    ["\"a $X ${Y}b $?\"", [quo("a "), par("X", true), quo(" "), par("Y", true), quo("b "), par("?", true)]],
    ["$X''", [par("X"), quo("")]],
    // `$` followed by anything else is literal.
    ["$", [lit("$")]],
    ["a$-b", [lit("a$-b")]],
    ["$=", [lit("$=")]],
    ["a$", [lit("a$")]],
    ["\"$ \"", [quo("$ ")]],
    // Inside double quotes a `$` before a quote is a literal.
    ["\"$\"", [quo("$")]],
    ["\"cost: 5$\"", [quo("cost: 5$")]],
    ["\"a$'b\"", [quo("a$'b")]],
    ["\"$X$\"", [par("X", true), quo("$")]],
    ["\"$\"x", [quo("$"), lit("x")]],
    ["\"a$-b\"", [quo("a$-b")]],
    ["\"a$ b\"", [quo("a$ b")]],
    // \$ is how a reserved `$` form is written inside double quotes.
    ["\"\\$(x) \\$1 \\${x:-y} \\$@\"", [quo("$(x) $1 ${x:-y} $@")]],
    ["'$(x) $1 ${x:-y} $@ `z` $'", [quo("$(x) $1 ${x:-y} $@ `z` $")]],
    // Tilde: unquoted, at the start of the word, before / or the end.
    ["~", [tilde]],
    ["~/x", [tilde, lit("/x")]],
    ["~/", [tilde, lit("/")]],
    ["a~", [lit("a~")]],
    ["a/~", [lit("a/~")]],
    ["'~'", [quo("~")]],
    ["\"~\"", [quo("~")]],
    ["\"~/x\"", [quo("~/x")]],
    // Globs: unquoted * and [...] only.
    ["*", [glob("*")]],
    ["*.txt", [glob("*"), lit(".txt")]],
    ["a*b*c", [lit("a"), glob("*"), lit("b"), glob("*"), lit("c")]],
    ["[ab]", [glob("[ab]")]],
    ["[a-z]x", [glob("[a-z]"), lit("x")]],
    ["[!a]", [glob("[!a]")]],
    ["x[ab]*[c]", [lit("x"), glob("[ab]"), glob("*"), glob("[c]")]],
    ["[a*]", [glob("[a*]")]],
    ["'*'", [quo("*")]],
    ["\"*\"", [quo("*")]],
    ["'[ab]'", [quo("[ab]")]],
    ["*'*'", [glob("*"), quo("*")]],
    ["a?b", [lit("a?b")]],
    ["?", [lit("?")]],
    // `[` with no class is a literal.
    ["[", [lit("[")]],
    ["[ab", [lit("[ab")]],
    ["[]", [lit("[]")]],
    ["[!]", [lit("[!]")]],
    ["]", [lit("]")]],
    ["[a/b]", [lit("[a/b]")]],
    ["[a'b']", [lit("[a"), quo("b"), lit("]")]],
    ["[$X]", [lit("["), par("X"), lit("]")]],
    ["[a\\]]", [lit("[a"), quo("]"), lit("]")]],
    // Never special.
    ["a#b", [lit("a#b")]],
    ["a=b", [lit("a=b")]],
    ["a!b", [lit("a!b")]],
    ["!", [lit("!")]],
    ["if", [lit("if")]],
    ["https://x/?a=1", [lit("https://x/?a=1")]],
    ["2", [lit("2")]],
    ["-", [lit("-")]],
  ])("echo %s", (source, parts) => {
    expect(arg(source)).toEqual(parts)
  })

  it.each<[string, Span[]]>([
    ["echo hi", [[0, 4], [5, 7]]],
    ["  echo   a  ", [[2, 6], [9, 10]]],
    ["echo 'a b'\"c\"d e", [[0, 4], [5, 14], [15, 16]]],
    ["a\tb", [[0, 1], [2, 3]]],
    ["echo \u{1F600} b", [[0, 4], [5, 7], [8, 9]]],
    ["echo a\\ b c", [[0, 4], [5, 9], [10, 11]]],
    ["echo $X ${Y} ~/z", [[0, 4], [5, 7], [8, 12], [13, 16]]],
    // A continuation inside a word is part of it; after a word it is blank.
    ["echo a\\\nb c", [[0, 4], [5, 9], [10, 11]]],
    ["echo a\\\n b", [[0, 4], [5, 6], [9, 10]]],
    ["echo \\\nb", [[0, 4], [7, 8]]],
    ["ec\\\nho a", [[0, 6], [7, 8]]],
  ])("word spans of %j", (line, spans) => {
    expect(onlyCommand(line).words.map((w) => w.span)).toEqual(spans)
  })

  it("splits words on spaces, tabs, and newlines only", () => {
    expect(onlyCommand("a  b\t\tc\nd").words).toHaveLength(4)
    expect(onlyCommand("a\u00a0b\rc").words).toHaveLength(1)
  })

  it("returns no list for an empty line or a comment", () => {
    for (const line of ["", "   ", "# c", "  # c ; d | e", "\n"]) {
      expect(parser.parse(line)).toMatchObject({ ok: true, ast: null })
    }
  })
})
