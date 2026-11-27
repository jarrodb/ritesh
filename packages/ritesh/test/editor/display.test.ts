import { describe, expect, it, vi } from "vitest"
import { reflowedRow } from "../../src/editor/render.js"
import { KEY, line, rig, type Rig } from "./support.js"

const K = KEY
const GREEN = 2
const RED = 1
const YELLOW = 3
const CYAN = 6
const MAGENTA = 5
const DEFAULT = -1

const hooks = {
  isCommand: (name: string): boolean => name === "echo" || name === "cat",
  pathExists: (word: string): boolean => word === "/tmp" || word === "my file" || word === "~/notes",
}

async function shown(text: string, options: Parameters<typeof rig>[0] = {}): Promise<Rig> {
  const r = rig({ cols: 60, highlight: hooks, ...options })
  void r.editor.readLine()
  await r.typed(text)
  return r
}

/** Foreground colors of the cells a piece of the line occupies; the prompt is two cells. */
const fg = (r: Rig, from: number, length = 1): number[] =>
  Array.from({ length }, (_, i) => r.style(0, 2 + from + i).fg)

describe("highlighting", () => {
  it("colors a line by its tokens", async () => {
    const text = "echo \"a $X\" 'b' $Y /tmp | nope >out # c"
    const r = await shown(text)
    const at = (piece: string): number => text.indexOf(piece)
    expect(fg(r, at("echo"), 4)).toEqual([GREEN, GREEN, GREEN, GREEN])
    expect(fg(r, at("echo") + 4)).toEqual([DEFAULT])
    expect(fg(r, at("\"a"), 3)).toEqual([YELLOW, YELLOW, YELLOW])
    expect(fg(r, at("$X"), 3)).toEqual([CYAN, CYAN, YELLOW])
    expect(fg(r, at("'b'"), 3)).toEqual([YELLOW, YELLOW, YELLOW])
    expect(fg(r, at("$Y"), 2)).toEqual([CYAN, CYAN])
    expect(fg(r, at("/tmp"), 4)).toEqual([DEFAULT, DEFAULT, DEFAULT, DEFAULT])
    expect([0, 1, 2, 3].map((i) => r.style(0, 2 + at("/tmp") + i).underline)).toEqual([true, true, true, true])
    expect(fg(r, at("|"))).toEqual([MAGENTA])
    expect(fg(r, at("nope"), 4)).toEqual([RED, RED, RED, RED])
    expect(fg(r, at(">"))).toEqual([MAGENTA])
    expect(fg(r, at("out"), 3)).toEqual([DEFAULT, DEFAULT, DEFAULT])
    expect(r.style(0, 2 + at("out")).underline).toBe(false)
    expect([r.style(0, 2 + at("#")).dim, r.style(0, 2 + at("# c") + 2).dim]).toEqual([true, true])
    expect(r.style(0, 2 + at("echo")).dim).toBe(false)
    expect(r.lines()).toEqual(["$ " + text])
  })

  it.each<[string, string, number, number]>([
    ["a reserved word", "if x", 0, RED],
    ["reserved syntax", "echo $(x)", 5, RED],
    ["a command after an assignment", "X=1 echo", 4, GREEN],
    ["the assignment itself", "X=1 echo", 0, DEFAULT],
    ["a command after an operator", "nope && echo", 8, GREEN],
    ["a command after a redirect and its target", "> out echo", 6, GREEN],
    ["a redirect target is not the command", "> echo", 2, DEFAULT],
    ["a quoted command name", "'echo' hi", 0, GREEN],
    ["an escaped command name", "ec\\ho hi", 0, GREEN],
    ["a command given by a parameter", "$CMD hi", 0, CYAN],
    ["a duplication redirect", "echo 2>&1 x", 5, MAGENTA],
    ["a parameter in braces", "echo ${HOME}/x", 5, CYAN],
    ["a lone dollar is not a parameter", "echo $ x", 5, DEFAULT],
    ["an open quote", "echo 'abc", 8, YELLOW],
    ["a word after an open double quote's parameter", "echo \"$A b", 9, YELLOW],
  ])("%s: %j", async (_name, text, offset, color) => {
    expect(fg(await shown(text), offset)).toEqual([color])
  })

  it("underlines a path that exists, in its quotes", async () => {
    const r = await shown("cat 'my file' ~/notes /nope")
    expect([r.style(0, 6).fg, r.style(0, 6).underline]).toEqual([YELLOW, true])
    expect(r.style(0, 16).underline).toBe(true)
    expect(r.style(0, 24).underline).toBe(false)
  })

  it("asks the hooks with unquoted names", async () => {
    const isCommand = vi.fn(() => true)
    const pathExists = vi.fn(() => false)
    await shown("'my cmd' a\\ b \"c d\" $X *.txt", { highlight: { isCommand, pathExists } })
    expect(isCommand).toHaveBeenLastCalledWith("my cmd")
    expect(new Set(pathExists.mock.calls.map((c: unknown[]) => c[0]))).toEqual(new Set(["a b", "c d"]))
  })

  it("leaves command words alone without hooks", async () => {
    const r = rig()
    void r.editor.readLine()
    await r.typed("echo 'a' | x")
    expect([r.style(0, 2).fg, r.style(0, 7).fg, r.style(0, 11).fg]).toEqual([DEFAULT, YELLOW, MAGENTA])
  })

  it("does not highlight a line read for a command", async () => {
    const r = rig({ highlight: hooks })
    void r.editor.readText("? ")
    await r.typed("echo 'a' | x")
    expect([r.style(0, 2).fg, r.style(0, 7).fg, r.style(0, 11).fg]).toEqual([DEFAULT, DEFAULT, DEFAULT])
  })

  it("keeps the colors on the submitted line", async () => {
    const r = rig({ highlight: hooks })
    await line(r, "echo hi" + K.enter)
    expect(r.style(0, 2).fg).toBe(GREEN)
  })
})

describe("autosuggestion", () => {
  async function seeded(): Promise<Rig> {
    const r = rig()
    for (const text of ["echo hello", "ls", "echo world"]) await line(r, text + K.enter)
    await r.typed(K.ctrlL)
    return r
  }

  it("shows the newest entry that starts with the text, dim, after the cursor", async () => {
    const r = await seeded()
    void r.editor.readLine()
    expect(await r.typed("ec")).toEqual(["$ echo world"])
    expect(r.cursor()).toEqual([0, 4])
    expect([r.style(0, 3).dim, r.style(0, 4).dim, r.style(0, 11).dim]).toEqual([false, true, true])
    expect(await r.typed("ho h")).toEqual(["$ echo hello"])
    expect(await r.typed("x")).toEqual(["$ echo hx"])
  })

  it.each<[string, string]>([["Right", K.right], ["End", K.end], ["^F", K.ctrlF], ["^E", K.ctrlE]])(
    "%s at the end of the line accepts it", async (_name, key) => {
      const r = await seeded()
      const read = r.editor.readLine()
      expect(await r.typed("ec" + key)).toEqual(["$ echo world"])
      expect(r.cursor()).toEqual([0, 12])
      expect(r.style(0, 11).dim).toBe(false)
      r.type(K.enter)
      expect(await read).toBe("echo world")
    })

  it("Enter runs only what was typed", async () => {
    const r = await seeded()
    expect(await line(r, "ec" + K.enter)).toBe("ec")
    expect(r.lines()).toEqual(["$ ec"])
  })

  it("hides while the cursor is not at the end, and Right there just moves", async () => {
    const r = await seeded()
    void r.editor.readLine()
    expect(await r.typed("ec" + K.left)).toEqual(["$ ec"])
    expect(await r.typed(K.right)).toEqual(["$ echo world"])
    expect(r.cursor()).toEqual([0, 4])
  })

  it("suggests nothing for an empty line, an exact match, or with history off", async () => {
    const r = await seeded()
    void r.editor.readLine()
    expect(await r.typed("")).toEqual(["$ "])
    expect(await r.typed("ls")).toEqual(["$ ls"])
    const off = rig({ history: false })
    await line(off, "echo hello" + K.enter)
    void off.editor.readLine()
    expect((await off.typed("ec")).at(-1)).toBe("$ ec")
  })

  it("shows a suggestion of several lines with continuation prompts", async () => {
    const r = rig()
    await line(r, "echo 'a" + K.enter + "b'" + K.enter)
    await r.typed(K.ctrlL)
    void r.editor.readLine()
    expect(await r.typed("ec")).toEqual(["$ echo 'a", "> b'"])
    expect(r.cursor()).toEqual([0, 4])
    expect(await r.typed(K.right)).toEqual(["$ echo 'a", "> b'"])
    expect(r.cursor()).toEqual([1, 4])
  })
})

describe("continuation lines", () => {
  it.each<[string, string, string, string]>([
    ["an open single quote", "echo 'a", "b'", "echo 'a\nb'"],
    ["an open double quote", "echo \"a", "b\"", "echo \"a\nb\""],
    ["a trailing pipe", "echo a |", "cat", "echo a |\ncat"],
    ["a trailing &&", "true &&", "echo a", "true &&\necho a"],
    ["a trailing backslash", "echo a\\", "b", "echo a\\\nb"],
  ])("continues after %s", async (_name, first, second, want) => {
    const r = rig()
    const read = r.editor.readLine()
    expect(await r.typed(first + K.enter)).toEqual(["$ " + first, "> "])
    expect(r.cursor()).toEqual([1, 2])
    expect(await r.typed(second)).toEqual(["$ " + first, "> " + second])
    r.type(K.enter)
    expect(await read).toBe(want)
    expect(r.cursor()).toEqual([2, 0])
  })

  it("submits a syntax error for the kernel to report", async () => {
    const r = rig()
    expect(await line(r, "echo )" + K.enter)).toBe("echo )")
  })

  it("goes on for as many lines as it takes, and edits across them", async () => {
    const r = rig()
    const read = r.editor.readLine()
    expect(await r.typed("echo 'a" + K.enter + K.enter + "c" + K.backspace.repeat(3))).toEqual(["$ echo 'a"])
    r.type("'" + K.enter)
    expect(await read).toBe("echo 'a'")
  })

  it("^C leaves a continued line", async () => {
    const r = rig()
    void r.editor.readLine()
    expect(await r.typed("echo 'a" + K.enter + "b" + K.ctrlC)).toEqual(["$ echo 'a", "> b^C", "$ "])
  })
})

describe("wide characters and combining marks", () => {
  it("counts a wide character as two cells", async () => {
    const r = rig()
    void r.editor.readLine()
    expect(await r.typed("日本")).toEqual(["$ 日本"])
    expect(r.cursor()).toEqual([0, 6])
    await r.typed(K.left)
    expect(r.cursor()).toEqual([0, 4])
    expect(await r.typed("x")).toEqual(["$ 日x本"])
    expect(r.cursor()).toEqual([0, 5])
  })

  it("counts a combining mark as no cells", async () => {
    const r = rig()
    void r.editor.readLine()
    expect(await r.typed("éx")).toEqual(["$ éx"])
    expect(r.cursor()).toEqual([0, 4])
    await r.typed(K.left + K.left)
    expect(r.cursor()).toEqual([0, 2])
  })

  it("measures a cluster the way the terminal draws it", async () => {
    const r = rig()
    void r.editor.readLine()
    // Three wide code points joined by zero-width joiners: one step for the cursor, six cells.
    await r.typed("\u{1F468}‍\u{1F469}‍\u{1F467}")
    expect(r.cursor()).toEqual([0, 8])
    await r.typed(K.left)
    expect(r.cursor()).toEqual([0, 2])
  })

  it("wraps a wide character that does not fit at the margin", async () => {
    const r = rig({ cols: 10 })
    const read = r.editor.readLine()
    expect(await r.typed("a日本語日本")).toEqual(["$ a日本語", "日本"])
    expect(r.cursor()).toEqual([1, 4])
    await r.typed(K.left + K.left)
    expect(r.cursor()).toEqual([1, 0])
    await r.typed(K.left)
    expect(r.cursor()).toEqual([0, 7])
    expect(await r.typed(K.backspace)).toEqual(["$ a日語日", "本"])
    expect(r.cursor()).toEqual([0, 5])
    r.type(K.enter)
    expect(await read).toBe("a日語日本")
  })
})

describe("wrapping at the margin", () => {
  it("wraps a long line and keeps the cursor right on every row", async () => {
    const r = rig({ cols: 10 })
    const read = r.editor.readLine()
    expect(await r.typed("0123456789abcdefghij")).toEqual(["$ 01234567", "89abcdefgh", "ij"])
    expect(r.cursor()).toEqual([2, 2])
    await r.typed(K.left.repeat(3))
    expect(r.cursor()).toEqual([1, 9])
    await r.typed(K.left.repeat(10))
    expect(r.cursor()).toEqual([0, 9])
    await r.typed(K.home)
    expect(r.cursor()).toEqual([0, 2])
    expect(await r.typed("X")).toEqual(["$ X0123456", "789abcdefg", "hij"])
    expect(r.cursor()).toEqual([0, 3])
    expect(await r.typed(K.ctrlK)).toEqual(["$ X"])
    r.type(K.enter)
    expect(await read).toBe("X")
  })

  it("lets the terminal wrap, so the rows are one line to it", async () => {
    const r = rig({ cols: 10 })
    void r.editor.readLine()
    await r.typed("0123456789abcdefghij")
    const buffer = r.xterm.buffer.active
    expect([0, 1, 2].map((y) => buffer.getLine(y)?.isWrapped)).toEqual([false, true, true])
  })

  it("moves to the next row when the line fills the last column", async () => {
    const r = rig({ cols: 10 })
    void r.editor.readLine()
    expect(await r.typed("01234567")).toEqual(["$ 01234567"])
    expect(r.cursor()).toEqual([1, 0])
    await r.typed("8")
    expect(r.lines()).toEqual(["$ 01234567", "8"])
    expect(r.cursor()).toEqual([1, 1])
    await r.typed(K.backspace)
    expect(r.cursor()).toEqual([1, 0])
    expect(await r.typed(K.backspace)).toEqual(["$ 0123456"])
    expect(r.cursor()).toEqual([0, 9])
  })

  it("leaves no blank row after a line that ends at the margin", async () => {
    const r = rig({ cols: 10 })
    await line(r, "01234567" + K.enter)
    void r.editor.readLine()
    await r.settled()
    expect(r.lines()).toEqual(["$ 01234567", "$ "])
    expect(r.cursor()).toEqual([1, 2])
  })

  it("keeps a full row and the continuation line after it apart", async () => {
    const r = rig({ cols: 10 })
    void r.editor.readLine()
    expect(await r.typed("echo 'ab" + K.enter + "c")).toEqual(["$ echo 'ab", "", "> c"])
    await r.typed(K.left + K.left)
    expect(r.cursor()).toEqual([1, 0])
  })

  it("scrolls when the line wraps at the bottom of the screen", async () => {
    const r = rig({ cols: 10, rows: 3 })
    await r.term.write("one\ntwo\n", "plain")
    const read = r.editor.readLine()
    expect(await r.typed("0123456789abcdefghij")).toEqual(["$ 01234567", "89abcdefgh", "ij"])
    expect(r.cursor()).toEqual([2, 2])
    expect(await r.typed(K.home + "X")).toEqual(["$ X0123456", "789abcdefg", "hij"])
    r.type(K.enter)
    expect(await read).toBe("X0123456789abcdefghij")
  })

  it("wraps the suggestion too", async () => {
    const r = rig({ cols: 10 })
    await line(r, "0123456789abc" + K.enter)
    await r.typed(K.ctrlL)
    void r.editor.readLine()
    expect(await r.typed("01")).toEqual(["$ 01234567", "89abc"])
    expect(r.cursor()).toEqual([0, 4])
  })
})

describe("resize", () => {
  const TEXT = "0123456789abcdefghijABCDEFGHIJ"

  async function resized(r: Rig, cols: number, rows: number): Promise<string[]> {
    r.xterm.resize(cols, rows)
    await r.settled()
    return r.lines()
  }

  async function typing(text: string, options: Parameters<typeof rig>[0] = {}): Promise<Rig> {
    const r = rig({ cols: 20, rows: 14, ...options })
    await r.term.write("out put\n", "plain")
    void r.editor.readLine()
    await r.typed(text)
    return r
  }

  it("redraws a wrapped line when the terminal narrows and widens", async () => {
    const r = await typing(TEXT)
    expect(r.lines()).toEqual(["out put", "$ 0123456789abcdefgh", "ijABCDEFGHIJ"])
    expect(await resized(r, 10, 14)).toEqual(["out put", "$ 01234567", "89abcdefgh", "ijABCDEFGH", "IJ"])
    expect(r.cursor()).toEqual([4, 2])
    expect(await resized(r, 40, 14)).toEqual(["out put", "$ " + TEXT])
    expect(r.cursor()).toEqual([1, 32])
    expect(await resized(r, 7, 14)).toEqual(["out put", "$ 01234", "56789ab", "cdefghi", "jABCDEF", "GHIJ"])
    expect(await r.typed("!")).toEqual(["out put", "$ 01234", "56789ab", "cdefghi", "jABCDEF", "GHIJ!"])
  })

  it("redraws with the cursor on an upper row", async () => {
    const r = await typing(TEXT + K.home)
    expect(await resized(r, 10, 14)).toEqual(["out put", "$ 01234567", "89abcdefgh", "ijABCDEFGH", "IJ"])
    expect(r.cursor()).toEqual([1, 2])
    expect(await resized(r, 40, 14)).toEqual(["out put", "$ " + TEXT])
    expect(r.cursor()).toEqual([1, 2])
  })

  it("redraws continuation lines, with the cursor on any of them", async () => {
    const first = "echo '" + "a".repeat(31)
    const second = "b".repeat(50)
    const r = await typing(first + K.enter + second + K.enter + "cc")
    const at20 = ["out put", "$ echo 'aaaaaaaaaaaa", "a".repeat(19), "> " + "b".repeat(18), "b".repeat(20), "b".repeat(12), "> cc"]
    const at40 = ["out put", "$ " + first, "> " + "b".repeat(38), "b".repeat(12), "> cc"]
    expect(r.lines()).toEqual(at20)
    expect(await resized(r, 40, 14)).toEqual(at40)
    expect(r.cursor()).toEqual([4, 4])
    expect(await resized(r, 20, 14)).toEqual(at20)
    expect(r.cursor()).toEqual([6, 4])
    await r.typed(K.left.repeat(60))
    expect(r.cursor()).toEqual([2, 13])
    expect(await resized(r, 40, 14)).toEqual(at40)
    expect(r.cursor()).toEqual([1, 33])
    expect(await resized(r, 12, 14)).toEqual([
      "out put", "$ echo 'aaaa", "a".repeat(12), "a".repeat(12), "aaa", "> " + "b".repeat(10), "b".repeat(12),
      "b".repeat(12), "b".repeat(12), "bbbb", "> cc",
    ])
    expect(r.cursor()).toEqual([3, 9])
    expect(await resized(r, 20, 14)).toEqual(at20)
  })

  it("redraws an open menu", async () => {
    const names = ["echo-one-long-name", "echo-two-long-name", "echo-333-long-name", "echo-444-long-name"]
    const r = await typing("ec", { complete: () => Promise.resolve({ span: [0, 2], candidates: names.map((value) => ({ value })) }) })
    await r.typed(K.tab)
    expect(await r.typed(K.tab)).toEqual(["out put", "$ echo-", ...names])
    expect(await resized(r, 10, 14)).toEqual(["out put", "$ echo-", "echo-one…", "echo-two…", "echo-333…", "echo-444…"])
    expect(await resized(r, 45, 14)).toEqual([
      "out put", "$ echo-", "echo-one-long-name  echo-333-long-name", "echo-two-long-name  echo-444-long-name",
    ])
    expect(r.cursor()).toEqual([1, 7])
  })

  it("redraws a line that ends at the margin", async () => {
    const r = await typing("0123456789abcdefgh")
    expect(r.lines()).toEqual(["out put", "$ 0123456789abcdefgh"])
    expect(r.cursor()).toEqual([2, 0])
    expect(await resized(r, 10, 14)).toEqual(["out put", "$ 01234567", "89abcdefgh"])
    expect(r.cursor()).toEqual([3, 0])
    expect(await resized(r, 40, 14)).toEqual(["out put", "$ 0123456789abcdefgh"])
    expect(r.cursor()).toEqual([1, 20])
    expect(await resized(r, 20, 14)).toEqual(["out put", "$ 0123456789abcdefgh"])
    expect(r.cursor()).toEqual([2, 0])
  })

  it("redraws when only the height changes", async () => {
    const r = await typing(TEXT)
    expect(await resized(r, 20, 5)).toEqual(["out put", "$ 0123456789abcdefgh", "ijABCDEFGHIJ"])
    expect(r.cursor()).toEqual([2, 12])
  })

  it("does nothing while no line is being read", async () => {
    const r = rig({ cols: 20 })
    await r.term.write("out put\n", "plain")
    expect(await resized(r, 10, 10)).toEqual(["out put"])
  })

  it.each<[string, { row: number; lines: number[][]; starts: number[] }, number, number, number]>([
    ["one row", { row: 0, lines: [[1, 1, 1]], starts: [0] }, 20, 10, 0],
    ["cursor's own line is left alone", { row: 1, lines: [Array<number>(30).fill(1)], starts: [0] }, 20, 10, 1],
    ["a line above rewraps narrower", { row: 2, lines: [Array<number>(30).fill(1), [1]], starts: [0, 2] }, 20, 10, 3],
    ["a line above rejoins wider", { row: 2, lines: [Array<number>(30).fill(1), [1]], starts: [0, 2] }, 20, 40, 1],
    ["rows removed below pull the cursor up", { row: 0, lines: [[1], Array<number>(30).fill(1)], starts: [0, 1] }, 20, 40, -1],
    ["wide characters wrap early", { row: 1, lines: [Array<number>(6).fill(2), [1]], starts: [0, 1] }, 12, 5, 3],
  ])("predicts the cursor row after reflow: %s", (_name, frame, from, to, want) => {
    expect(reflowedRow(frame, from, to)).toBe(want)
  })
})

describe("notify", () => {
  it("prints above the prompt and redraws the line being typed", async () => {
    const r = rig()
    const read = r.editor.readLine()
    await r.typed("echo hi" + K.left)
    r.editor.notify("connection lost\nretrying")
    await r.settled()
    expect(r.lines()).toEqual(["connection lost", "retrying", "$ echo hi"])
    expect(r.cursor()).toEqual([2, 8])
    r.type("!" + K.enter)
    expect(await read).toBe("echo h!i")
  })

  it("prints above a wrapped line and an open menu", async () => {
    const r = rig({ cols: 10, complete: () => Promise.resolve({ span: [0, 0], candidates: [{ value: "aa" }, { value: "ab" }] }) })
    void r.editor.readLine()
    await r.typed(K.tab)
    await r.typed(K.tab)
    r.editor.notify("note\n")
    await r.settled()
    expect(r.lines()).toEqual(["note", "$ a", "aa  ab"])
    await r.typed(K.esc)
    await r.typed("0123456789")
    r.editor.notify("again")
    await r.settled()
    expect(r.lines()).toEqual(["note", "again", "$ a0123456", "789"])
    expect(r.cursor()).toEqual([3, 3])
  })

  it("prints plain text: escape sequences in it do nothing", async () => {
    const r = rig()
    void r.editor.readLine()
    await r.typed("ec")
    r.editor.notify("\x1b[2J\x1b[31mred\x1b[0m \x1b]0;title\x07done")
    await r.settled()
    expect(r.lines()).toEqual(["red done", "$ ec"])
    expect(r.style(0, 0).fg).toBe(DEFAULT)
  })

  it("keeps its line break when the text ends inside an escape sequence", async () => {
    const r = rig()
    r.editor.notify("cut \x1b")
    await r.settled()
    expect(r.lines()).toEqual(["cut "])
    expect(r.cursor()).toEqual([1, 0])
  })

  it("prints a line when nothing is being read", async () => {
    const r = rig()
    r.editor.notify("hello")
    r.editor.notify("world\n")
    await r.settled()
    expect(r.lines()).toEqual(["hello", "world"])
    expect(r.cursor()).toEqual([2, 0])
  })
})

describe("prompt", () => {
  it("keeps SGR in the prompt and measures only its text", async () => {
    const r = rig({ prompt: () => "\x1b[1;32muser\x1b[0m \x1b[34m~\x1b[0m % " })
    void r.editor.readLine()
    expect(await r.typed("ls")).toEqual(["user ~ % ls"])
    expect(r.cursor()).toEqual([0, 11])
    expect([r.style(0, 0).fg, r.style(0, 5).fg, r.style(0, 9).fg]).toEqual([GREEN, 4, DEFAULT])
  })

  it("does not let prompt styles reach the line", async () => {
    const r = rig({ prompt: () => "\x1b[31m$ " })
    void r.editor.readLine()
    await r.typed("ls")
    expect([r.style(0, 0).fg, r.style(0, 2).fg]).toEqual([RED, DEFAULT])
  })

  it("drops every other control sequence from the prompt", async () => {
    const r = rig({ prompt: () => "\x1b[2J\x1b[5;5H\x07a\tb\x1b]0;t\x07$ " })
    await r.term.write("kept\n", "plain")
    void r.editor.readLine()
    await r.settled()
    expect(r.lines()[0]).toBe("kept")
    expect(r.lines()[1]?.startsWith("[2J[5;5Ha b")).toBe(true)
  })

  it("draws a prompt of several lines", async () => {
    const r = rig({ prompt: () => "host:/srv\n$ " })
    const read = r.editor.readLine()
    expect(await r.typed("ls")).toEqual(["host:/srv", "$ ls"])
    expect(r.cursor()).toEqual([1, 4])
    expect(await r.typed(K.ctrlC + "x")).toEqual(["host:/srv", "$ ls^C", "host:/srv", "$ x"])
    r.type(K.enter)
    expect(await read).toBe("x")
  })

  it("starts on a fresh line when the output before it did not end one", async () => {
    const r = rig({ cols: 20 })
    await r.term.write("no newline", "plain")
    void r.editor.readLine()
    expect((await r.typed("ls")).map((l) => l.trimEnd())).toEqual(["no newline%", "$ ls"])
    expect(r.style(0, 10).inverse).toBe(true)
  })

  it("leaves no marker when the output ended its line, or filled the row exactly", async () => {
    const r = rig({ cols: 10 })
    await r.term.write("0123456789", "plain")
    void r.editor.readLine()
    expect(await r.typed("ls")).toEqual(["0123456789", "$ ls"])
    const clean = rig({ cols: 10 })
    await clean.term.write("done\n", "plain")
    void clean.editor.readLine()
    expect(await clean.typed("ls")).toEqual(["done", "$ ls"])
  })
})

describe("output policy", () => {
  it("never writes what the user typed, the prompt, or a candidate as raw", async () => {
    const r = rig({
      prompt: () => "PROMPTTEXT $ ",
      complete: () => Promise.resolve({ span: [0, 5], candidates: [{ value: "TYPEDcandidateA", description: "DESCRIBED" }, { value: "TYPEDcandidateB" }] }),
    })
    const write = vi.spyOn(r.term, "write")
    await line(r, "HISTORYLINE" + K.enter)
    void r.editor.readLine()
    await r.typed("TYPED" + K.tab)
    await r.typed(K.tab + K.tab)
    await r.typed(K.esc)
    await r.typed(K.ctrlU + "HIS" + K.ctrlR + "LINE" + K.ctrlC)
    r.editor.notify("NOTIFIED")
    await r.settled()
    const raw = write.mock.calls.filter(([, policy]) => policy === "raw").map(([data]) => data).join("")
    for (const text of ["TYPED", "candidate", "DESCRIBED", "HISTORY", "LINE", "PROMPTTEXT", "NOTIFIED", "reverse"]) {
      expect(raw).not.toContain(text)
    }
    const plain = write.mock.calls.filter(([, policy]) => policy === "plain").map(([data]) => data).join("")
    for (const text of ["TYPED", "candidateA", "DESCRIBED", "HISTORYLINE", "PROMPTTEXT", "NOTIFIED", "reverse-i-search"]) {
      expect(plain).toContain(text)
    }
    // eslint-disable-next-line no-control-regex -- the test looks for control characters
    expect(plain).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f]/)
  })
})
