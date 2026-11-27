import { describe, expect, it } from "vitest"
import { createKeyDecoder, type Key, keyNames, triggerKeys } from "../../src/editor/keys.js"

const key = (name: string): Key => ({ type: "key", name })
const text = (value: string): Key => ({ type: "text", text: value })

describe("key decoder", () => {
  it.each<[string, string, Key[]]>([
    ["printable run", "echo hi", [text("echo hi")]],
    ["enter", "\r", [key("enter")]],
    ["line feed", "\n", [key("enter")]],
    ["tab", "\t", [key("tab")]],
    ["shift-tab", "\x1b[Z", [key("shift-tab")]],
    ["backspace", "\x7f", [key("backspace")]],
    ["ctrl-backspace", "\x08", [key("ctrl-backspace")]],
    ["alt-backspace", "\x1b\x7f", [key("alt-backspace")]],
    ["delete", "\x1b[3~", [key("delete")]],
    ["ctrl-delete", "\x1b[3;5~", [key("ctrl-delete")]],
    ["arrows", "\x1b[A\x1b[B\x1b[C\x1b[D", [key("up"), key("down"), key("right"), key("left")]],
    ["application arrows", "\x1bOA\x1bOD", [key("up"), key("left")]],
    ["home and end", "\x1b[H\x1b[F\x1b[1~\x1b[4~\x1bOH\x1bOF", [key("home"), key("end"), key("home"), key("end"), key("home"), key("end")]],
    ["ctrl and alt arrows", "\x1b[1;5D\x1b[1;3C", [key("ctrl-left"), key("alt-right")]],
    ["control letters", "\x01\x05\x0b\x15\x17\x19\x0c\x03\x04\x12", [
      key("ctrl-a"), key("ctrl-e"), key("ctrl-k"), key("ctrl-u"), key("ctrl-w"), key("ctrl-y"), key("ctrl-l"),
      key("ctrl-c"), key("ctrl-d"), key("ctrl-r"),
    ]],
    ["alt letters", "\x1bb\x1bf\x1bd\x1bB", [key("alt-b"), key("alt-f"), key("alt-d"), key("alt-b")]],
    ["escape alone", "\x1b", [key("escape")]],
    ["escape twice", "\x1b\x1b", [key("escape"), key("escape")]],
    ["keys and text mixed", "ab\x1b[Dc\r", [text("ab"), key("left"), text("c"), key("enter")]],
    ["unknown sequences", "a\x1b[99~\x1b[I\x1b[<0;1;1M\x1bOP\x1b[5~\x1b[1;9Ab", [text("a"), text("b")]],
    ["unfinished sequence", "a\x1b[1;", [text("a")]],
    ["NUL and C1", "a\x00\x9bb", [text("a"), text("b")]],
    ["paste", "\x1b[200~a\rb\x1b[A\x1b[201~c", [{ type: "paste", text: "a\rb\x1b[A" }, text("c")]],
    ["astral text", "\u{1F600}", [text("\u{1F600}")]],
  ])("%s", (_name, input, want) => {
    expect(createKeyDecoder()(input)).toEqual(want)
  })

  it("joins a paste that arrives in pieces", () => {
    const decode = createKeyDecoder()
    expect(decode("x\x1b[200~one ")).toEqual([text("x")])
    expect(decode("two\r")).toEqual([])
    expect(decode("three\x1b[201~\r")).toEqual([{ type: "paste", text: "one two\rthree" }, key("enter")])
  })
})

describe("egg triggers", () => {
  it.each<[string, string[]]>([
    ["up up down down left right left right b a", ["up", "up", "down", "down", "left", "right", "left", "right", "b", "a"]],
    ["xyzzy", ["x", "y", "z", "z", "y"]],
    ["ctrl-x esc space enter", ["ctrl-x", "escape", "space", "enter"]],
    ["  ", []],
  ])("%j", (trigger, want) => {
    expect(triggerKeys(trigger)).toEqual(want)
  })

  it("names keys the way triggers spell them", () => {
    expect(keyNames(text("a b"))).toEqual(["a", "space", "b"])
    expect(keyNames(key("up"))).toEqual(["up"])
    expect(keyNames({ type: "paste", text: "abc" })).toEqual([])
  })
})
