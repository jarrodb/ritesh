import { describe, expect, it, vi } from "vitest"
import type { Candidate, Completion } from "../../src/contracts.js"
import { commonPrefix, openWord, quoteContext, wholeWord } from "../../src/editor/complete.js"
import { deferred, KEY, line, parser, rig, type Rig } from "./support.js"

const K = KEY

/** A completer for the word that ends at the cursor: candidates are the names that start with it. */
function words(names: ReadonlyArray<string | Candidate>): (text: string, cursor: number) => Promise<Completion> {
  const all = names.map((n) => (typeof n === "string" ? { value: n } : n))
  return (text, cursor) => {
    const start = text.lastIndexOf(" ", cursor - 1) + 1
    const typed = text.slice(start, cursor).replace(/['"\\]/g, "")
    return Promise.resolve({ span: [start, cursor], candidates: all.filter((c) => c.value.startsWith(typed)) })
  }
}

const TWO = ["echo-one", "echo-two"]

describe("quoting", () => {
  it.each<[string, "bare" | "single" | "double"]>([
    ["", "bare"], ["abc", "bare"], ["a\\'b", "bare"], ["'a b'", "bare"], ["\"a\"'b'c", "bare"],
    ["'a b", "single"], ["a'b", "single"], ["'a'\\''b", "single"],
    ["\"a b", "double"], ["\"a\\\"b", "double"], ["'a'\"b", "double"],
  ])("context of %j is %s", (text, want) => {
    expect(quoteContext(text)).toBe(want)
  })

  it.each<[string[], string]>([
    [["echo-one", "echo-two"], "echo-"],
    [["abc"], "abc"],
    [["abc", "xbc"], ""],
    [["a\u{1F600}", "a\u{1F601}"], "a"],
    [[], ""],
  ])("common prefix of %j is %j", (values, want) => {
    expect(commonPrefix(values)).toBe(want)
  })

  it.each<[string, "bare" | "single" | "double", string]>([
    ["my fi", "bare", "my\\ fi"], ["my fi", "single", "'my fi"], ["my fi", "double", "\"my fi"],
    ["", "bare", ""], ["", "single", "'"], ["", "double", "\""],
    ["it's", "single", "'it'\\''s"], ["a'", "single", "'a'\\'"], ["a`", "double", "\"a\"\\`"],
    ["$x", "double", "\"\\$x"],
  ])("open word %j in %s is %j", (value, context, want) => {
    expect(openWord(parser, value, context)).toBe(want)
  })

  it.each<[Candidate, "bare" | "single" | "double", string]>([
    [{ value: "my file" }, "bare", "my\\ file "],
    [{ value: "my file" }, "single", "'my file' "],
    [{ value: "my file" }, "double", "\"my file\" "],
    [{ value: "my dir", suffix: "/" }, "bare", "my\\ dir/"],
    [{ value: "my dir", suffix: "/" }, "single", "'my dir/"],
    [{ value: "--name=", suffix: "" }, "bare", "--name="],
    [{ value: "x", suffix: "" }, "double", "\"x"],
  ])("candidate %j in %s is %j", (candidate, context, want) => {
    expect(wholeWord(parser, candidate, context)).toBe(want)
  })
})

describe("Tab completion", () => {
  it("inserts the only candidate and a space", async () => {
    const r = rig({ complete: words(["echo"]) })
    const read = r.editor.readLine()
    expect(await r.typed("ec" + K.tab)).toEqual(["$ echo "])
    expect(r.cursor()).toEqual([0, 7])
    r.type("hi" + K.enter)
    expect(await read).toBe("echo hi")
  })

  it("uses the candidate's suffix", async () => {
    const r = rig({ complete: words([{ value: "Documents", suffix: "/" }, { value: "--depth=", suffix: "" }]) })
    void r.editor.readLine()
    expect(await r.typed("cd Do" + K.tab)).toEqual(["$ cd Documents/"])
    expect(await r.typed(" --" + K.tab)).toEqual(["$ cd Documents/ --depth="])
  })

  it("replaces the span it was given, in the middle of a line", async () => {
    const complete = vi.fn((): Promise<Completion> => Promise.resolve({ span: [5, 7], candidates: [{ value: "hello" }] }))
    const r = rig({ complete })
    const read = r.editor.readLine()
    expect(await r.typed("echo he | wc" + K.left.repeat(5) + K.tab)).toEqual(["$ echo hello  | wc"])
    expect(complete).toHaveBeenCalledWith("echo he | wc", 7, { signal: expect.any(AbortSignal) as AbortSignal })
    expect(r.cursor()).toEqual([0, 13])
    r.type(K.enter)
    expect(await read).toBe("echo hello  | wc")
  })

  it.each<[string, string, string]>([
    ["a bare word", "cat my", "cat my\\ file "],
    ["a single-quoted word", "cat 'my", "cat 'my file' "],
    ["a double-quoted word", "cat \"my", "cat \"my file\" "],
  ])("quotes the value for %s", async (_name, typed, want) => {
    const r = rig({ complete: words(["my file"]) })
    const read = r.editor.readLine()
    await r.typed(typed + K.tab)
    r.type(K.enter)
    expect(await read).toBe(want)
  })

  it("keeps a quote open after a directory", async () => {
    const r = rig({ complete: words([{ value: "my dir", suffix: "/" }]) })
    void r.editor.readLine()
    expect(await r.typed("cd 'my" + K.tab)).toEqual(["$ cd 'my dir/"])
  })

  it("quotes characters the shell would read", async () => {
    const r = rig({ complete: words(["a$b*c;d"]) })
    const read = r.editor.readLine()
    await r.typed("echo a" + K.tab)
    r.type(K.enter)
    expect(await read).toBe(String.raw`echo a\$b\*c\;d `)
  })

  it("inserts the common prefix of several candidates, without a menu", async () => {
    const r = rig({ complete: words(TWO) })
    void r.editor.readLine()
    expect(await r.typed("ec" + K.tab)).toEqual(["$ echo-"])
    expect(r.cursor()).toEqual([0, 7])
  })

  it("quotes the common prefix and leaves its quote open", async () => {
    const r = rig({ complete: words(["my file", "my film"]) })
    void r.editor.readLine()
    expect(await r.typed("cat m" + K.tab)).toEqual(["$ cat my\\ fil"])
    expect(await r.typed(K.ctrlU + "cat 'm" + K.tab)).toEqual(["$ cat 'my fil"])
  })

  it("does nothing when there are no candidates, or the span is not in the line", async () => {
    const r = rig({ complete: words([]) })
    void r.editor.readLine()
    await r.typed("zz" + K.tab)
    expect(await r.typed(K.tab)).toEqual(["$ zz"])
    const bad = rig({ complete: () => Promise.resolve({ span: [3, 9], candidates: [{ value: "x" }] }) })
    void bad.editor.readLine()
    expect(await bad.typed("zz" + K.tab)).toEqual(["$ zz"])
  })

  it("survives a completion that fails", async () => {
    const r = rig({ complete: () => Promise.reject(new Error("offline")) })
    const read = r.editor.readLine()
    await r.typed("ec" + K.tab)
    r.type("ho" + K.enter)
    expect(await read).toBe("echo")
  })

  it("is not offered to a command reading a line", async () => {
    const complete = vi.fn(words(["echo"]))
    const r = rig({ complete })
    const read = r.editor.readText("? ")
    r.type("ec" + K.tab + K.enter)
    expect(await read).toBe("ec")
    expect(complete).not.toHaveBeenCalled()
  })
})

describe("completion menu", () => {
  async function open(options: Parameters<typeof rig>[0] = {}): Promise<Rig> {
    const r = rig({ complete: words(TWO), ...options })
    void r.editor.readLine()
    await r.typed("ec" + K.tab)
    return r
  }

  it("opens on the second Tab, below the line, in columns", async () => {
    const r = await open()
    expect(await r.typed(K.tab)).toEqual(["$ echo-", "echo-one  echo-two"])
    expect(r.cursor()).toEqual([0, 7])
    expect(r.style(1, 0).inverse).toBe(false)
  })

  it("further Tabs cycle through the candidates, Shift-Tab goes back", async () => {
    const r = await open()
    expect(await r.typed(K.tab + K.tab)).toEqual(["$ echo-one ", "echo-one  echo-two"])
    expect([r.style(1, 0).inverse, r.style(1, 10).inverse]).toEqual([true, false])
    expect(await r.typed(K.tab)).toEqual(["$ echo-two ", "echo-one  echo-two"])
    expect([r.style(1, 0).inverse, r.style(1, 10).inverse]).toEqual([false, true])
    expect(await r.typed(K.tab)).toEqual(["$ echo-one ", "echo-one  echo-two"])
    expect(await r.typed(K.shiftTab)).toEqual(["$ echo-two ", "echo-one  echo-two"])
    expect(r.cursor()).toEqual([0, 11])
  })

  it("Shift-Tab from an open menu starts at the last candidate", async () => {
    const r = await open()
    expect(await r.typed(K.tab + K.shiftTab)).toEqual(["$ echo-two ", "echo-one  echo-two"])
  })

  it("Enter accepts the selection without running the line", async () => {
    const r = await open()
    const done = vi.fn()
    expect(await r.typed(K.tab + K.tab + K.enter)).toEqual(["$ echo-one "])
    expect(done).not.toHaveBeenCalled()
    expect(await r.typed("x" + K.enter)).toEqual(["$ echo-one x"])
    expect(r.editor.history()).toEqual(["echo-one x"])
  })

  it("Escape cancels and restores the line; Tab opens the menu again", async () => {
    const r = await open()
    expect(await r.typed(K.tab + K.tab + K.tab)).toEqual(["$ echo-two ", "echo-one  echo-two"])
    r.type(K.esc)
    await r.settled()
    expect(r.lines()).toEqual(["$ echo-"])
    expect(r.cursor()).toEqual([0, 7])
    expect(await r.typed(K.tab)).toEqual(["$ echo-", "echo-one  echo-two"])
  })

  it("Enter on a menu with nothing selected runs the line", async () => {
    const r = rig({ complete: words(TWO) })
    const read = r.editor.readLine()
    await r.typed("ec" + K.tab)
    r.type(K.tab + K.enter)
    expect(await read).toBe("echo-")
    expect(r.lines()).toEqual(["$ echo-"])
  })

  it("any other key keeps the selection and acts", async () => {
    const r = await open()
    expect(await r.typed(K.tab + K.tab + "x")).toEqual(["$ echo-one x"])
    await r.typed(K.ctrlU + "ec" + K.tab)
    expect(await r.typed(K.tab + "h")).toEqual(["$ echo-h"])
  })

  it("arrows move the selection", async () => {
    const r = await open()
    expect(await r.typed(K.tab + K.down + K.down)).toEqual(["$ echo-two ", "echo-one  echo-two"])
    expect(await r.typed(K.up)).toEqual(["$ echo-one ", "echo-one  echo-two"])
  })

  it("asks again after the line changed", async () => {
    const complete = vi.fn(words(["echo-one", "echo-two", "echo-three"]))
    const r = rig({ complete })
    void r.editor.readLine()
    await r.typed("ec" + K.tab)
    expect(await r.typed("t" + K.tab)).toEqual(["$ echo-t"])
    expect(complete).toHaveBeenCalledTimes(2)
    expect(await r.typed(K.tab)).toEqual(["$ echo-t", "echo-two    echo-three"])
    expect(complete).toHaveBeenCalledTimes(2)
  })

  it("shows descriptions when they fit", async () => {
    const candidates = [
      { value: "ls", description: "list a directory" },
      { value: "lsblk", description: "list block devices, with a description too long to show whole" },
    ]
    const r = rig({ complete: words(candidates) })
    void r.editor.readLine()
    await r.typed("l" + K.tab)
    expect(await r.typed(K.tab + K.tab)).toEqual([
      "$ ls ",
      "ls     list a directory",
      "lsblk  list block devices, with a desc\u2026",
    ])
    expect(r.style(1, 0).inverse).toBe(true)
    expect(r.style(1, 7).dim).toBe(true)
    expect(r.style(2, 0).inverse).toBe(false)
  })

  it("leaves descriptions out when the terminal is too narrow for them", async () => {
    const candidates = [{ value: "ls", description: "list a directory" }, { value: "lsblk", description: "list block devices" }]
    const r = rig({ cols: 16, complete: words(candidates) })
    void r.editor.readLine()
    await r.typed("l" + K.tab)
    expect(await r.typed(K.tab)).toEqual(["$ ls", "ls     lsblk"])
  })

  it("shows the display text and inserts the value", async () => {
    const r = rig({ complete: words([{ value: "a/b/one", display: "one" }, { value: "a/b/two", display: "two\x1b[2J\n" }]) })
    void r.editor.readLine()
    await r.typed("a" + K.tab)
    expect(await r.typed(K.tab + K.tab)).toEqual(["$ a/b/one ", "one      two[2J "])
    expect(r.style(1, 0).inverse).toBe(true)
  })

  it("fills columns downwards and pages a menu taller than the screen", async () => {
    const names = Array.from({ length: 20 }, (_, i) => `item-${String(i).padStart(2, "0")}`)
    const r = rig({ cols: 20, rows: 6, complete: words(names) })
    void r.editor.readLine()
    // Two columns of ten rows; five rows are free below the line: four of items and one of status.
    await r.typed("i" + K.tab)
    expect(await r.typed(K.tab)).toEqual([
      "$ item-", "item-00  item-10", "item-01  item-11", "item-02  item-12", "item-03  item-13", "rows 1-4 of 10",
    ])
    expect(await r.typed(K.tab.repeat(5))).toEqual([
      "$ item-04 ", "item-04  item-14", "item-05  item-15", "item-06  item-16", "item-07  item-17", "rows 5-8 of 10",
    ])
    expect(r.style(1, 0).inverse).toBe(true)
    expect(r.cursor()).toEqual([0, 10])
  })

  it("clears the menu when the line is submitted or abandoned", async () => {
    const r = await open()
    expect(await r.typed(K.tab + K.ctrlC)).toEqual(["$ echo-^C", "$ "])
  })
})

describe("slow completion", () => {
  it("is cancelled by the next key, and its answer is dropped", async () => {
    const slow = deferred<Completion>()
    const signals: AbortSignal[] = []
    const r = rig({
      complete: (_text, _cursor, { signal }) => {
        signals.push(signal)
        return slow.promise
      },
    })
    const read = r.editor.readLine()
    expect(await r.typed("ec" + K.tab)).toEqual(["$ ec"])
    expect(signals[0]?.aborted).toBe(false)
    expect(await r.typed("x")).toEqual(["$ ecx"])
    expect(signals[0]?.aborted).toBe(true)
    slow.resolve({ span: [0, 2], candidates: [{ value: "echo" }] })
    await r.settled()
    expect(r.lines()).toEqual(["$ ecx"])
    r.type(K.enter)
    expect(await read).toBe("ecx")
  })

  it("is applied when it answers before any key", async () => {
    const slow = deferred<Completion>()
    const r = rig({ complete: () => slow.promise })
    void r.editor.readLine()
    await r.typed("ec" + K.tab)
    slow.resolve({ span: [0, 2], candidates: [{ value: "echo" }] })
    await r.settled()
    expect(r.lines()).toEqual(["$ echo "])
  })

  it("a second Tab while waiting asks again and opens the menu with the answer", async () => {
    const answers = [deferred<Completion>(), deferred<Completion>()]
    const signals: AbortSignal[] = []
    const r = rig({
      complete: (_text, _cursor, { signal }) => {
        const answer = answers[signals.length]
        signals.push(signal)
        if (!answer) throw new Error("asked a third time")
        return answer.promise
      },
    })
    void r.editor.readLine()
    await r.typed("ec" + K.tab + K.tab)
    expect(signals.map((s) => s.aborted)).toEqual([true, false])
    const completion: Completion = { span: [0, 2], candidates: TWO.map((value) => ({ value })) }
    answers[0]?.resolve(completion)
    await r.settled()
    expect(r.lines()).toEqual(["$ ec"])
    answers[1]?.resolve(completion)
    await r.settled()
    expect(r.lines()).toEqual(["$ echo-", "echo-one  echo-two"])
  })

  it("is cancelled when the line is submitted, abandoned, or the editor is disposed", async () => {
    const signals: AbortSignal[] = []
    const never = (): Promise<Completion> => new Promise<Completion>(() => undefined)
    const r = rig({
      complete: (_text, _cursor, { signal }) => {
        signals.push(signal)
        return never()
      },
    })
    await line(r, "a" + K.tab + K.enter)
    const read = r.editor.readLine()
    r.type("b" + K.tab)
    r.editor.interrupt()
    r.type("c" + K.tab)
    r.editor.dispose()
    expect(await read).toBeNull()
    expect(signals.map((s) => s.aborted)).toEqual([true, true, true])
  })

  it("an answer that arrives after the read ended is dropped", async () => {
    const slow = deferred<Completion>()
    const r = rig({ complete: () => slow.promise })
    const read = r.editor.readSecret("pw: ")
    r.type(K.enter)
    await read
    const next = r.editor.readLine()
    r.type("ec" + K.tab + K.ctrlC)
    slow.resolve({ span: [0, 2], candidates: [{ value: "echo" }] })
    await r.settled()
    expect(r.lines().at(-1)).toBe("$ ")
    r.type(K.ctrlD)
    expect(await next).toBeNull()
  })
})
