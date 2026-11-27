import { describe, expect, it } from "vitest"
import { KEY, line, rig, type Rig } from "./support.js"

const K = KEY

async function seeded(): Promise<Rig> {
  const r = rig({ cols: 60, rows: 6 })
  for (const text of ["echo one", "ls -l", "echo two"]) await line(r, text + K.enter)
  await r.typed(K.ctrlL)
  return r
}

describe("reverse search (^R)", () => {
  it("shows the newest match as the query grows", async () => {
    const r = await seeded()
    void r.editor.readLine()
    expect(await r.typed(K.ctrlR)).toEqual(["(reverse-i-search)`': "])
    expect(await r.typed("ec")).toEqual(["(reverse-i-search)`ec': echo two"])
    expect(r.cursor()).toEqual([0, 24])
    expect(await r.typed("ho o")).toEqual(["(reverse-i-search)`echo o': echo one"])
  })

  it("^R again finds the next older match", async () => {
    const r = await seeded()
    const read = r.editor.readLine()
    expect(await r.typed(K.ctrlR + "echo" + K.ctrlR)).toEqual(["(reverse-i-search)`echo': echo one"])
    expect(await r.typed(K.ctrlR)).toEqual(["(failed reverse-i-search)`echo': echo one"])
    r.type(K.enter)
    expect(await read).toBe("echo one")
    expect(r.lines()).toEqual(["$ echo one"])
  })

  it("Enter runs the match", async () => {
    const r = await seeded()
    expect(await line(r, K.ctrlR + "ls" + K.enter)).toBe("ls -l")
  })

  it("says when nothing matches and keeps the last match", async () => {
    const r = await seeded()
    void r.editor.readLine()
    expect(await r.typed(K.ctrlR + "lsx")).toEqual(["(failed reverse-i-search)`lsx': ls -l"])
    expect(await r.typed(K.backspace)).toEqual(["(reverse-i-search)`ls': ls -l"])
    expect(await r.typed(K.backspace + K.backspace)).toEqual(["(reverse-i-search)`': "])
  })

  it("shows the line being typed while nothing matches", async () => {
    const r = await seeded()
    const read = r.editor.readLine()
    expect(await r.typed("draft" + K.ctrlR + "zzz")).toEqual(["(failed reverse-i-search)`zzz': draft"])
    r.type(K.enter)
    expect(await read).toBe("draft")
  })

  it("Escape keeps the match for editing, the cursor on the match", async () => {
    const r = await seeded()
    const read = r.editor.readLine()
    r.type(K.ctrlR + "two")
    expect(await r.typed(K.esc)).toEqual(["$ echo two"])
    expect(r.cursor()).toEqual([0, 7])
    r.type("2 " + K.enter)
    expect(await read).toBe("echo 2 two")
  })

  it("^G gives the line back", async () => {
    const r = await seeded()
    const read = r.editor.readLine()
    expect(await r.typed("dra" + K.left + K.ctrlR + "echo" + K.ctrlG)).toEqual(["$ dra"])
    expect(r.cursor()).toEqual([0, 4])
    r.type(K.enter)
    expect(await read).toBe("dra")
  })

  it("an editing key takes the match and then acts", async () => {
    const r = await seeded()
    expect(await line(r, K.ctrlR + "one" + K.ctrlE + "!" + K.enter)).toBe("echo one!")
    expect(await line(r, K.ctrlR + "ls" + K.ctrlK + K.enter)).toBe("")
  })

  it("Up after a search goes on from the match", async () => {
    const r = await seeded()
    expect(await line(r, K.ctrlR + "ls" + K.up + K.enter)).toBe("echo one")
  })

  it("^C abandons the search and the line", async () => {
    const r = await seeded()
    const read = r.editor.readLine()
    expect(await r.typed(K.ctrlR + "ls" + K.ctrlC)).toEqual(["(reverse-i-search)`ls': ls -l^C", "$ "])
    r.type("x" + K.enter)
    expect(await read).toBe("x")
  })

  it("is not offered to a command reading a line", async () => {
    const r = await seeded()
    const read = r.editor.readText("? ")
    expect(await r.typed(K.ctrlR + "ls")).toEqual(["? ls"])
    r.type(K.enter)
    expect(await read).toBe("ls")
  })
})
