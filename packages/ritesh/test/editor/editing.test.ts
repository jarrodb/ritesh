import { describe, expect, it } from "vitest"
import { KEY, line, rig } from "./support.js"

const K = KEY
const ctrlLeft = "\x1b[1;5D"
const ctrlRight = "\x1b[1;5C"

describe("editing keys", () => {
  it.each<[string, string, string]>([
    ["inserts printable text", "echo hi", "echo hi"],
    ["inserts at the cursor", "eco" + K.left + "h", "echo"],
    ["Backspace", "echoo" + K.backspace, "echo"],
    ["Backspace at the start does nothing", K.backspace + "a", "a"],
    ["Delete", "xecho" + K.home + K.del, "echo"],
    ["Delete at the end does nothing", "a" + K.del, "a"],
    ["Left and Right", "ac" + K.left + "b" + K.right + "d", "abcd"],
    ["Left and Right stop at the ends", "b" + K.left + K.left + "a" + K.right + K.right + K.right + "c", "abc"],
    ["Home and End", "bc" + K.home + "a" + K.end + "d", "abcd"],
    ["^A and ^E", "bc" + K.ctrlA + "a" + K.ctrlE + "d", "abcd"],
    ["^B and ^F", "ac" + K.ctrlB + "b" + K.ctrlF + "d", "abcd"],
    ["^K kills to the end of the line", "echo hi" + K.home + K.right.repeat(4) + K.ctrlK, "echo"],
    ["^U kills to the start of the line", "echo hi" + K.left.repeat(2) + K.ctrlU, "hi"],
    ["^W kills back to a blank", "echo foo-bar baz" + K.ctrlW, "echo foo-bar "],
    ["^W twice", "echo foo-bar baz" + K.ctrlW + K.ctrlW, "echo "],
    ["^Y yanks the last kill", "echo hi" + K.ctrlW + K.ctrlY + K.ctrlY, "echo hihi"],
    ["^Y yanks what ^K killed", "ab" + K.home + K.ctrlK + K.ctrlY + K.ctrlY, "abab"],
    ["^Y with nothing killed", K.ctrlY + "a", "a"],
    ["^D deletes the character at the cursor", "echox" + K.left + K.ctrlD, "echo"],
    ["Alt-B", "one two" + K.altB + "X", "one Xtwo"],
    ["Alt-F", "one two" + K.home + K.altF + "X", "oneX two"],
    ["Alt-D", "one two" + K.home + K.altD, " two"],
    ["Alt-Backspace kills a word, not past punctuation", "echo foo-bar" + K.altBackspace, "echo foo-"],
    ["Ctrl-Backspace", "echo foo-bar" + K.ctrlBackspace, "echo foo-"],
    ["Ctrl-Left and Ctrl-Right", "one two" + ctrlLeft + ctrlLeft + ctrlRight + "X", "oneX two"],
    ["Alt-D then ^Y", "one two" + K.home + K.altD + K.end + K.ctrlY, " twoone"],
    ["unknown escape sequences are ignored", "a\x1b[99~\x1b[I\x1bOP\x1b[5~b", "ab"],
    ["moves by grapheme cluster", "éx" + K.left + K.left + "a", "aéx"],
    ["Backspace removes a whole cluster", "aé" + K.backspace, "a"],
    ["a ZWJ sequence is one step", "\u{1F468}‍\u{1F469}‍\u{1F467}b" + K.left + K.left + "a", "a\u{1F468}‍\u{1F469}‍\u{1F467}b"],
    ["Delete removes a whole cluster", "\u{1F1FA}\u{1F1F8}a" + K.home + K.del, "a"],
    ["a combining mark joins the character before it", "e" + "́" + K.left + "a", "aé"],
    ["Alt-B over wide words", "echo 日本語 x" + K.altB + K.altB + "!", "echo !日本語 x"],
  ])("%s", async (_name, input, want) => {
    const r = rig()
    expect(await line(r, input + K.enter)).toBe(want)
  })

  it("Escape alone does nothing", async () => {
    const r = rig()
    const read = r.editor.readLine()
    r.type("a")
    r.type(K.esc)
    r.type("b" + K.enter)
    expect(await read).toBe("ab")
  })

  it("Enter submits the whole line from the middle and moves below it", async () => {
    const r = rig()
    const read = r.editor.readLine()
    r.type("echo hi" + K.home + K.enter)
    expect(await read).toBe("echo hi")
    expect(r.lines()).toEqual(["$ echo hi"])
    expect(r.cursor()).toEqual([1, 0])
  })

  it("puts the cursor where the next character goes", async () => {
    const r = rig()
    void r.editor.readLine()
    expect(await r.typed("")).toEqual(["$ "])
    expect(r.cursor()).toEqual([0, 2])
    expect(await r.typed("echo hi")).toEqual(["$ echo hi"])
    expect(r.cursor()).toEqual([0, 9])
    await r.typed(K.left + K.left)
    expect(r.cursor()).toEqual([0, 7])
    await r.typed(K.home)
    expect(r.cursor()).toEqual([0, 2])
    expect(await r.typed("X")).toEqual(["$ Xecho hi"])
    expect(r.cursor()).toEqual([0, 3])
  })

  it("^D on an empty line is end of input", async () => {
    const r = rig()
    expect(await line(r, K.ctrlD)).toBeNull()
    expect(r.cursor()).toEqual([1, 0])
  })

  it("^D on a line with text is not end of input", async () => {
    const r = rig()
    expect(await line(r, "a" + K.ctrlD + K.ctrlD + K.enter)).toBe("a")
  })

  it("^C abandons the line and starts a new prompt", async () => {
    const r = rig()
    const read = r.editor.readLine()
    expect(await r.typed("foo" + K.left + K.ctrlC)).toEqual(["$ foo^C", "$ "])
    expect(r.cursor()).toEqual([1, 2])
    r.type("bar" + K.enter)
    expect(await read).toBe("bar")
    expect(r.lines()).toEqual(["$ foo^C", "$ bar"])
    expect(r.editor.history()).toEqual(["bar"])
  })

  it("^C asks for the prompt again", async () => {
    let n = 0
    const r = rig({ prompt: () => `${++n}> ` })
    void r.editor.readLine()
    expect(await r.typed("x" + K.ctrlC + "y")).toEqual(["1> x^C", "2> y"])
  })

  it("^L clears the screen and redraws the line", async () => {
    const r = rig()
    await r.term.write("one\ntwo\n", "plain")
    const read = r.editor.readLine()
    expect(await r.typed("echo hi" + K.left)).toEqual(["one", "two", "$ echo hi"])
    expect(await r.typed(K.ctrlL)).toEqual(["$ echo hi"])
    expect(r.cursor()).toEqual([0, 8])
    r.type("!" + K.enter)
    expect(await read).toBe("echo h!i")
  })

  it("^K at the end of a line of several takes the newline, ^U at the start does too", async () => {
    const r = rig()
    void r.editor.readLine()
    expect(await r.typed(K.paste("a\nb\nc"))).toEqual(["$ a", "> b", "> c"])
    expect(await r.typed(K.left.repeat(4) + K.ctrlK)).toEqual(["$ ab", "> c"])
    expect(await r.typed(K.end + K.right + K.ctrlU)).toEqual(["$ abc"])
  })

  it("Home and End stay on the line of a buffer with several", async () => {
    const r = rig()
    const read = r.editor.readLine()
    await r.typed(K.paste("ab\ncd"))
    expect(r.cursor()).toEqual([1, 4])
    await r.typed(K.home)
    expect(r.cursor()).toEqual([1, 2])
    await r.typed(K.left + K.home)
    expect(r.cursor()).toEqual([0, 2])
    await r.typed(K.end)
    expect(r.cursor()).toEqual([0, 4])
    r.type(K.enter)
    expect(await read).toBe("ab\ncd")
  })
})

describe("bracketed paste", () => {
  it("turns bracketed paste on for reads and off on dispose", async () => {
    const r = rig()
    void r.editor.readLine()
    await r.settled()
    expect(r.xterm.modes.bracketedPasteMode).toBe(true)
    r.editor.dispose()
    await r.settled()
    expect(r.xterm.modes.bracketedPasteMode).toBe(false)
  })

  it("inserts a paste literally, newlines as continuation lines", async () => {
    const r = rig()
    const read = r.editor.readLine()
    expect(await r.typed(K.paste("echo a\r\necho b\recho c"))).toEqual(["$ echo a", "> echo b", "> echo c"])
    r.type(K.enter)
    expect(await read).toBe("echo a\necho b\necho c")
  })

  it("drops control characters from a paste and shows a tab as a space", async () => {
    const r = rig()
    const read = r.editor.readLine()
    expect(await r.typed(K.paste("a\x07b\x1b[2J\tc\x9b"))).toEqual(["$ ab[2J c"])
    r.type(K.enter)
    expect(await read).toBe("ab[2J\tc")
  })

  it("does not act on keys inside a paste", async () => {
    const r = rig()
    expect(await line(r, "x" + K.paste("\x03\x04\x1b[A\t") + "y" + K.enter)).toBe("x[A\ty")
  })
})
