import { describe, expect, it } from "vitest"
import type { TokenKind } from "../../src/contracts.js"
import { parser } from "./support.js"

const kinds = (line: string): Array<[TokenKind, string]> => parser.tokenize(line).map((t) => [t.kind, t.text])

describe("tokenize", () => {
  it.each<[string, Array<[TokenKind, string]>]>([
    ["", []],
    ["  \t", [["whitespace", "  \t"]]],
    ["echo hi", [["word", "echo"], ["whitespace", " "], ["word", "hi"]]],
    ["# c", [["comment", "# c"]]],
    ["echo a #b", [["word", "echo"], ["whitespace", " "], ["word", "a"], ["whitespace", " "], ["comment", "#b"]]],
    ["echo a#b", [["word", "echo"], ["whitespace", " "], ["word", "a#b"]]],
    ["a|b", [["word", "a"], ["operator", "|"], ["word", "b"]]],
    ["a&&b||c;d;", [
      ["word", "a"], ["operator", "&&"], ["word", "b"], ["operator", "||"], ["word", "c"], ["operator", ";"],
      ["word", "d"], ["operator", ";"],
    ]],
    ["a>f", [["word", "a"], ["redirect", ">"], ["word", "f"]]],
    ["a >>f <g 2>h 2>>i 2>&1 >&2", [
      ["word", "a"], ["whitespace", " "], ["redirect", ">>"], ["word", "f"], ["whitespace", " "],
      ["redirect", "<"], ["word", "g"], ["whitespace", " "], ["redirect", "2>"], ["word", "h"], ["whitespace", " "],
      ["redirect", "2>>"], ["word", "i"], ["whitespace", " "], ["redirect", "2>&1"], ["whitespace", " "],
      ["redirect", ">&2"],
    ]],
    // `2` is a file descriptor only at the start of a word.
    ["a2>f", [["word", "a2"], ["redirect", ">"], ["word", "f"]]],
    ["a 12>f", [["word", "a"], ["whitespace", " "], ["word", "12"], ["redirect", ">"], ["word", "f"]]],
    ["echo 'a b'\"c d\"e\\ f", [["word", "echo"], ["whitespace", " "], ["word", "'a b'\"c d\"e\\ f"]]],
    ["echo 'open # x", [["word", "echo"], ["whitespace", " "], ["word", "'open # x"]]],
    ["echo \\", [["word", "echo"], ["whitespace", " "], ["word", "\\"]]],
    ["a$(b)", [["word", "a"], ["reserved", "$("], ["word", "b"], ["reserved", ")"]]],
    ["echo ~root/x", [["word", "echo"], ["whitespace", " "], ["reserved", "~root"], ["word", "/x"]]],
    ["a &", [["word", "a"], ["whitespace", " "], ["reserved", "&"]]],
    ["echo \"a`b`\" c", [
      ["word", "echo"], ["whitespace", " "], ["word", "\"a"], ["reserved", "`"], ["word", "b"], ["reserved", "`"],
      ["word", "\""], ["whitespace", " "], ["word", "c"],
    ]],
    ["a \"$(x", [["word", "a"], ["whitespace", " "], ["word", "\""], ["reserved", "$("], ["word", "x"]]],
    ["a \"x$1", [["word", "a"], ["whitespace", " "], ["word", "\"x"], ["reserved", "$1"]]],
    // A continuation is blank between words and part of the word it splits.
    ["a \\\n b", [["word", "a"], ["whitespace", " \\\n "], ["word", "b"]]],
    ["a\\\n b", [["word", "a"], ["whitespace", "\\\n "], ["word", "b"]]],
    ["a\\\nb", [["word", "a\\\nb"]]],
    ["\\\n", [["whitespace", "\\\n"]]],
    ["# c \\\nb", [["comment", "# c \\"], ["whitespace", "\n"], ["word", "b"]]],
    ["a # c\nb", [
      ["word", "a"], ["whitespace", " "], ["comment", "# c"], ["whitespace", "\n"], ["word", "b"],
    ]],
  ])("%j", (line, expected) => {
    expect(kinds(line)).toEqual(expected)
  })

  it.each<[string, string[]]>([
    ["if true", ["if"]],
    ["echo if", []],
    ["a; then b", ["then"]],
    ["a | while b", ["while"]],
    ["a && ! b || done", ["!", "done"]],
    ["X=1 for x", ["for"]],
    ["> f case x", ["case"]],
    ["> if echo", []],
    ["if=1 echo", []],
    ["'if' x", []],
    ["i\\f x", []],
    ["echo !", []],
  ])("marks reserved words in command position only: %j", (line, reserved) => {
    expect(parser.tokenize(line).filter((t) => t.kind === "reserved").map((t) => t.text)).toEqual(reserved)
  })

  it.each([
    "echo hi | cat > /tmp/x # done",
    "  a\t\tb  ",
    "echo 'open",
    "echo \"open $X \\",
    "echo $(x) `y` ${z:-1} $1 {a,b} (c) [[ d ]] <<EOF <<<s <(e) >(f) |& &> >| ;; & ** ~u",
    "a 2>&1x >&22 2>&- >&",
    "X=1 Y='a b' cmd \"$X\"'y'\\z*[ab]?~ ~/x",
    "echo \u{1F600} 'café' \ud83d x\udc00",
    "\\",
    "'",
    "\"",
    "$",
    "~",
    "a\nb\n\n# c\n",
    "echo \"a $(x) `y` $1 ${z:-1} b\" c \"$(",
    "a\\\nb \\\n c\\\n \"d\\\ne\" 'f\\\ng' \\\n",
    ";;;;||||&&&&<<<<>>>>",
  ])("covers every code unit of %j with contiguous spans", (line) => {
    const tokens = parser.tokenize(line)
    let at = 0
    for (const t of tokens) {
      expect(t.span[0]).toBe(at)
      expect(t.span[1]).toBeGreaterThan(at)
      expect(t.text).toBe(line.slice(t.span[0], t.span[1]))
      at = t.span[1]
    }
    expect(at).toBe(line.length)
  })

  it("counts spans in UTF-16 code units", () => {
    expect(parser.tokenize("\u{1F600} \u{1F600}b").map((t) => t.span)).toEqual([[0, 2], [2, 3], [3, 6]])
  })

  it("returns the same tokens from parse, whatever the outcome", () => {
    for (const line of ["echo hi", "echo 'open", "echo $(x) y", "ll -a"]) {
      expect(parser.parse(line, { alias: () => "ls -l; true" }).tokens).toEqual(parser.tokenize(line))
    }
  })
})
