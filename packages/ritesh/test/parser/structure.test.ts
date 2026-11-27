import { describe, expect, it } from "vitest"
import type { Redirect, Span, WordPart } from "../../src/contracts.js"
import {
  commandsOf, commandText, glob, listText, lit, onlyCommand, outcome, par, parseError, parseOk, parser, quo,
  wordText,
} from "./support.js"

describe("redirects", () => {
  it.each<[string, Redirect]>([
    ["cmd > f", { op: ">", target: { parts: [lit("f")], span: [6, 7] }, span: [4, 7] }],
    ["cmd >> f", { op: ">>", target: { parts: [lit("f")], span: [7, 8] }, span: [4, 8] }],
    ["cmd < f", { op: "<", target: { parts: [lit("f")], span: [6, 7] }, span: [4, 7] }],
    ["cmd 2> f", { op: "2>", target: { parts: [lit("f")], span: [7, 8] }, span: [4, 8] }],
    ["cmd 2>> f", { op: "2>>", target: { parts: [lit("f")], span: [8, 9] }, span: [4, 9] }],
    ["cmd 2>&1", { op: "2>&1", span: [4, 8] }],
    ["cmd >&2", { op: ">&2", span: [4, 7] }],
    // No space is needed on either side.
    ["cmd>f", { op: ">", target: { parts: [lit("f")], span: [4, 5] }, span: [3, 5] }],
    ["cmd>>f", { op: ">>", target: { parts: [lit("f")], span: [5, 6] }, span: [3, 6] }],
    ["cmd<f", { op: "<", target: { parts: [lit("f")], span: [4, 5] }, span: [3, 5] }],
    ["cmd 2>f", { op: "2>", target: { parts: [lit("f")], span: [6, 7] }, span: [4, 7] }],
    ["cmd 2>>f", { op: "2>>", target: { parts: [lit("f")], span: [7, 8] }, span: [4, 8] }],
    ["cmd>&2", { op: ">&2", span: [3, 6] }],
    // Targets are words like any other; the kernel expands them.
    ["cmd > 'a b'", { op: ">", target: { parts: [quo("a b")], span: [6, 11] }, span: [4, 11] }],
    ["cmd > $X", { op: ">", target: { parts: [par("X")], span: [6, 8] }, span: [4, 8] }],
    ["cmd > /tmp/*", { op: ">", target: { parts: [lit("/tmp/"), glob("*")], span: [6, 12] }, span: [4, 12] }],
  ])("%j", (line, redirect) => {
    const command = onlyCommand(line)
    expect(command.words.map(wordText)).toEqual(["cmd"])
    expect(command.redirects).toEqual([redirect])
  })

  it.each<[string, string]>([
    ["> f cmd a", "cmd a >f"],
    ["cmd > f a", "cmd a >f"],
    ["cmd a > f", "cmd a >f"],
    [">f cmd", "cmd >f"],
    ["2>&1 cmd", "cmd 2>&1"],
    [">&2 cmd a", "cmd a >&2"],
    ["< in cmd > out a 2>> err b", "cmd a b <in >out 2>>err"],
    ["cmd > f 2>&1", "cmd >f 2>&1"],
    ["cmd 2>&1 > f", "cmd 2>&1 >f"],
    ["cmd > a > b >> c", "cmd >a >b >>c"],
    ["cmd 2> e 2>> e2 < i >&2", "cmd 2>e 2>>e2 <i >&2"],
    ["X=1 > f cmd", "X=1 cmd >f"],
    ["> f X=1 cmd", "X=1 cmd >f"],
    ["a > f | b < g", "a >f | b <g"],
    // Only a `2` that starts a word is a file descriptor.
    ["cmd a2> f", "cmd a2 >f"],
    ["cmd 22> f", "cmd 22 >f"],
    ["cmd 1> f", "cmd 1 >f"],
    ["cmd 2 > f", "cmd 2 >f"],
    ["cmd '2'> f", "cmd 2 >f"],
    ["cmd 2>&1 2", "cmd 2 2>&1"],
    ["cmd > 2", "cmd >2"],
  ])("anywhere in a command, in source order: %j", (line, text) => {
    const list = parseOk(line)
    expect(list.rest).toEqual([])
    expect(list.first.commands.map(commandText).join(" | ")).toBe(text)
  })
})

describe("assignments", () => {
  it.each<[string, string, WordPart[], Span, Span]>([
    ["X=1", "X", [lit("1")], [2, 3], [0, 3]],
    ["X=", "X", [], [2, 2], [0, 2]],
    ["_a9=b", "_a9", [lit("b")], [4, 5], [0, 5]],
    ["X='a b'", "X", [quo("a b")], [2, 7], [0, 7]],
    ["X=a'b'\"$Y\"", "X", [lit("a"), quo("b"), par("Y", true)], [2, 10], [0, 10]],
    ["X=$Y", "X", [par("Y")], [2, 4], [0, 4]],
    ["X=a=b", "X", [lit("a=b")], [2, 5], [0, 5]],
    ["X=''", "X", [quo("")], [2, 4], [0, 4]],
    // No globbing and no tilde in a value.
    ["X=*", "X", [lit("*")], [2, 3], [0, 3]],
    ["X=a*[bc]", "X", [lit("a*[bc]")], [2, 8], [0, 8]],
    ["X=~/x", "X", [lit("~/x")], [2, 5], [0, 5]],
    ["X\\\n=1", "X", [lit("1")], [4, 5], [0, 5]],
    ["X=a\\\nb", "X", [lit("ab")], [2, 6], [0, 6]],
  ])("%j", (line, name, parts, valueSpan, span) => {
    const command = onlyCommand(line)
    expect(command.words).toEqual([])
    expect(command.redirects).toEqual([])
    expect(command.assignments).toEqual([{ name, value: { parts, span: valueSpan }, span }])
    expect(command.span).toEqual(span)
  })

  it.each<[string, string[], string[]]>([
    ["X=1 Y=2", ["X=1", "Y=2"], []],
    ["X=1 env", ["X=1"], ["env"]],
    ["X=1 Y=2 env Z=3", ["X=1", "Y=2"], ["env", "Z=3"]],
    ["export X=1", [], ["export", "X=1"]],
    ["echo X=1", [], ["echo", "X=1"]],
    // Not a name, or not unquoted: a word.
    ["1X=2", [], ["1X=2"]],
    ["=x", [], ["=x"]],
    ["a-b=c", [], ["a-b=c"]],
    ["'X'=1", [], ["X=1"]],
    ["X\\=1", [], ["X=1"]],
    ["\"X=1\"", [], ["X=1"]],
    ["$X=1", [], ["$X=1"]],
  ])("%j", (line, assignments, words) => {
    const command = onlyCommand(line)
    expect(command.assignments.map((a) => `${a.name}=${wordText(a.value)}`)).toEqual(assignments)
    expect(command.words.map(wordText)).toEqual(words)
  })

  it("keeps each command's assignments apart", () => {
    expect(listText(parseOk("X=1; Y=2 a | Z=3 b"))).toBe("[X=1] ; [Y=2 a | Z=3 b]")
  })
})

describe("lists and pipelines", () => {
  it.each<[string, string]>([
    ["a", "[a]"],
    ["a;", "[a]"],
    ["a; b", "[a] ; [b]"],
    ["a; b;", "[a] ; [b]"],
    ["a && b", "[a] && [b]"],
    ["a || b", "[a] || [b]"],
    ["a&&b||c;d", "[a] && [b] || [c] ; [d]"],
    // Equal precedence, left to right: (a || b) && c.
    ["a || b && c", "[a] || [b] && [c]"],
    ["a && b || c", "[a] && [b] || [c]"],
    ["a; b && c; d || e", "[a] ; [b] && [c] ; [d] || [e]"],
    // `|` binds tighter than the list operators.
    ["a | b", "[a | b]"],
    ["a | b | c", "[a | b | c]"],
    ["a | b && c | d", "[a | b] && [c | d]"],
    ["a || b | c; d", "[a] || [b | c] ; [d]"],
    ["a x | b y || c z", "[a x | b y] || [c z]"],
    ["a |\nb", "[a | b]"],
    ["a &&\nb", "[a] && [b]"],
    ["a \\\n&& b", "[a] && [b]"],
    ["a |\\\nb", "[a | b]"],
    ["ec\\\nho a\\\nb \\\n c", "[echo ab c]"],
    ["\\\na", "[a]"],
  ])("%j", (line, text) => {
    expect(listText(parseOk(line))).toBe(text)
  })

  it("stores the list flat, left to right", () => {
    const list = parseOk("a || b && c")
    expect(list.type).toBe("list")
    expect(list.first.type).toBe("pipeline")
    expect(list.rest.map((r) => r.op)).toEqual(["||", "&&"])
    expect(list.rest.map((r) => r.pipeline.commands.length)).toEqual([1, 1])
    expect(list.first.commands[0]?.type).toBe("command")
  })

  it("spans commands, pipelines, and the list", () => {
    const list = parseOk("  X=1 a b > f | c ; d && e ;  ")
    expect(list.span).toEqual([2, 26])
    expect([list.first, ...list.rest.map((r) => r.pipeline)].map((p) => p.span)).toEqual([[2, 17], [20, 21], [25, 26]])
    expect(commandsOf(list).map((c) => c.span)).toEqual([[2, 13], [16, 17], [20, 21], [25, 26]])
  })
})

describe("aliases", () => {
  const table: Record<string, string> = {
    ll: "ls -l",
    e: "echo a; echo",
    echo: "echo x",
    a: "b 1",
    b: "a 2",
    p: "ps | grep",
    out: "echo >",
    v: "X=1",
    nothing: "",
    q: "'quoted name' $X *",
    bad: "echo $(x)",
    amp: "sleep 1 &",
    kw: "if",
    open: "echo 'x",
    slash: "echo \\",
    cmt: "echo a # no more",
    tail: "true &&",
    self: "self; self | self",
  }
  const alias = (name: string): string | undefined => (Object.hasOwn(table, name) ? table[name] : undefined)
  const text = (line: string): string => listText(parseOk(line, { alias }))

  it.each<[string, string]>([
    ["ll", "[ls -l]"],
    ["ll /tmp", "[ls -l /tmp]"],
    ["  ll  ", "[ls -l]"],
    // A body may hold operators; the rest of the command follows its last command.
    ["e b", "[echo x a] ; [echo x b]"],
    ["p x | wc", "[ps | grep x | wc]"],
    ["tail ll", "[true] && [ls -l]"],
    ["out f", "[echo x >f]"],
    // Not expanded again inside its own body, directly or through another alias.
    ["echo y", "[echo x y]"],
    ["a", "[a 2 1]"],
    ["b", "[b 1 2]"],
    ["self x", "[self] ; [self | self x]"],
    // Command position only.
    ["foo ll", "[foo ll]"],
    ["foo; ll", "[foo] ; [ls -l]"],
    ["foo | ll", "[foo | ls -l]"],
    ["foo && ll || ll", "[foo] && [ls -l] || [ls -l]"],
    ["X=1 ll", "[X=1 ls -l]"],
    ["> f ll", "[ls -l >f]"],
    ["foo > ll", "[foo >ll]"],
    ["v ll", "[X=1 ls -l]"],
    ["v", "[X=1]"],
    ["ll=1", "[ll=1]"],
    // Unquoted only.
    ["'ll'", "[ll]"],
    ["\"ll\"", "[ll]"],
    ["\\ll", "[ll]"],
    ["l'l'", "[ll]"],
    ["l\\l", "[ll]"],
    // A continuation leaves the word unquoted.
    ["l\\\nl", "[ls -l]"],
    ["$ll", "[$ll]"],
    // The body is parsed like a line.
    ["q", "[quoted name $X *]"],
    ["cmt b", "[echo x a b]"],
    ["nothing", "[]"],
    ["nothing; ll", "[] ; [ls -l]"],
    ["nothing foo", "[foo]"],
  ])("%j", (line, expected) => {
    expect(text(line)).toBe(expected)
  })

  it("keeps the body's word parts", () => {
    const command = onlyCommand("q", { alias })
    expect(command.words.map((w) => w.parts)).toEqual([[quo("quoted name")], [par("X")], [glob("*")]])
  })

  it("gives nodes from a body the alias word's span", () => {
    const list = parseOk("foo; e b", { alias })
    const [, first, second] = commandsOf(list)
    expect(first?.words.map((w) => w.span)).toEqual([[5, 6], [5, 6], [5, 6]])
    expect(first?.span).toEqual([5, 6])
    expect(second?.words.map((w) => w.span)).toEqual([[5, 6], [5, 6], [7, 8]])
    expect(second?.span).toEqual([5, 8])
    expect(list.span).toEqual([0, 8])
  })

  it("spans a redirect from a body to its target in the line", () => {
    expect(onlyCommand("out f", { alias }).redirects).toEqual([
      { op: ">", target: { parts: [lit("f")], span: [4, 5] }, span: [0, 5] },
    ])
  })

  it("does not expand without the option", () => {
    expect(listText(parseOk("ll"))).toBe("[ll]")
    expect(listText(parseOk("ll", {}))).toBe("[ll]")
  })

  it("asks only for unquoted command words", () => {
    const asked: string[] = []
    parser.parse("X=1 foo bar 'baz' > out; 'q' x | $y z | w*", { alias: (name) => void asked.push(name) })
    expect(asked).toEqual(["foo"])
  })

  it.each<[string, string, Span]>([
    ["bad", "'$(' is not supported in rite 0.1.0", [0, 3]],
    ["foo; amp", "'&' is not supported in rite 0.1.0; quote the argument if it is part of a URL", [5, 8]],
    ["kw x", "'if' is not supported in rite 0.1.0", [0, 2]],
    ["open x", "alias 'open' ends inside a quote or on a backslash", [0, 4]],
    ["slash", "alias 'slash' ends inside a quote or on a backslash", [0, 5]],
    ["out", "redirect with no target", [0, 3]],
    ["nothing > f", "redirect with no command", [0, 11]],
    ["nothing if", "'if' is not supported in rite 0.1.0", [8, 10]],
  ])("reports an error in a body at the alias word: %j", (line, message, span) => {
    expect(parseError(line, { alias })).toEqual({ message, span })
  })

  it("is incomplete when a body ends on an operator and the line ends", () => {
    expect(outcome(parser.parse("tail", { alias }))).toBe("incomplete")
    expect(outcome(parser.parse("p |", { alias }))).toBe("incomplete")
  })

  it("stops a set of aliases that never ends", () => {
    const error = parseError("a0", { alias: (name) => `${name}0; ${name}1` })
    expect(error.message).toMatch(/^alias '.*' expands without end$/)
    expect(error.span).toEqual([0, 2])
  })
})
