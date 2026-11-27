import { describe, expect, it } from "vitest"
import { createOutputFilter, filterOutput, isTerminalReply } from "../src/term/filter.js"
import { headlessTerm } from "./support/headless.js"

describe("filterOutput", () => {
  const cases: Array<[string, Parameters<typeof filterOutput>[1], string, string]> = [
    ["newline to CRLF", "plain", "a\nb", "a\r\nb"],
    ["tab kept", "plain", "a\tb", "a\tb"],
    ["SGR stripped in plain", "plain", "\x1b[31mred\x1b[0m", "red"],
    ["SGR kept in sgr", "sgr", "\x1b[31mred\x1b[0m", "\x1b[31mred\x1b[0m"],
    ["cursor move stripped in sgr", "sgr", "a\x1b[2Jb\x1b[10;10Hc", "abc"],
    ["OSC 8 link stripped", "sgr", "\x1b]8;;https://x\x07link\x1b]8;;\x07", "link"],
    ["OSC with ST stripped", "sgr", "\x1b]52;c;Zm9v\x1b\\ok", "ok"],
    ["DCS stripped", "sgr", "\x1bPq#0;2;0;0;0\x1b\\ok", "ok"],
    ["C1 CSI normalized", "sgr", "\x9b1mbold", "\x1b[1mbold"],
    ["C0 and DEL dropped", "plain", "a\x07b\x7fc\x00d", "abcd"],
    ["single ESC sequence dropped", "plain", "a\x1bcb", "ab"],
    ["ESC with intermediate dropped", "plain", "a\x1b(Bb", "ab"],
    ["raw untouched", "raw", "\x1b[2J\n", "\x1b[2J\n"],
    ["wide characters kept", "plain", "日本", "日本"],
  ]
  it.each(cases)("%s", (_name, policy, input, want) => {
    expect(filterOutput(input, policy)).toBe(want)
  })

  it("recognizes terminal replies", () => {
    expect(isTerminalReply("\x1b[12;40R")).toBe(true)
    expect(isTerminalReply("\x1b[?1;2c")).toBe(true)
    expect(isTerminalReply("\x1b[>0;276;0c")).toBe(true)
    expect(isTerminalReply("\x1b]11;rgb:0000/0000/0000\x07")).toBe(true)
    expect(isTerminalReply("\x1b[A")).toBe(false)
    expect(isTerminalReply("a")).toBe(false)
  })
})

describe("createOutputFilter", () => {
  it("keeps a sequence split across chunks", () => {
    const f = createOutputFilter("sgr")
    expect(f("a\x1b[31")).toBe("a")
    expect(f("mred")).toBe("\x1b[31mred")
  })
  it("drops an OSC payload split across chunks", () => {
    const f = createOutputFilter("sgr")
    expect(f("x\x1b]8;;https://ev")).toBe("x")
    expect(f("il\x07link")).toBe("link")
  })
  it("keeps a lone ESC at a chunk end until the next byte", () => {
    const f = createOutputFilter("plain")
    expect(f("a\x1b")).toBe("a")
    expect(f("cb")).toBe("b")
  })
})

describe("term writers", () => {
  it("keeps each writer's pending sequence apart", async () => {
    const h = headlessTerm(20, 4)
    const a = h.term.writer("sgr")
    const b = h.term.writer("plain")
    await a("x\x1b[3")
    await b("yz")
    await a("1mred")
    expect(h.screen()[0]).toBe("xyzred")
    h.term.dispose()
  })

  it("write is self-contained: a cut sequence cannot swallow later text", async () => {
    const h = headlessTerm(20, 4)
    await h.term.write("cut \x1b", "plain")
    await h.term.write("next", "plain")
    expect(h.screen()[0]).toBe("cut next")
    h.term.dispose()
  })
})

describe("term over headless xterm", () => {
  it("writes filtered output and resolves after parsing", async () => {
    const h = headlessTerm(20, 4)
    await h.term.write("hi\x1b[2J\nthere", "sgr")
    expect(h.screen().slice(0, 2)).toEqual(["hi", "there"])
    h.term.dispose()
  })

  it("delivers keys and drops terminal replies", () => {
    const h = headlessTerm()
    const got: string[] = []
    h.term.onInput((d) => got.push(d))
    h.type("a")
    h.type("\x1b[5;5R")
    h.type("\r")
    expect(got).toEqual(["a", "\r"])
    h.term.dispose()
  })

  it("measures width with the unicode11 provider", () => {
    const h = headlessTerm()
    expect(h.term.width("a".codePointAt(0) ?? 0)).toBe(1)
    expect(h.term.width("日".codePointAt(0) ?? 0)).toBe(2)
    expect(h.term.width(0x0301)).toBe(0)
    h.term.dispose()
  })
})
