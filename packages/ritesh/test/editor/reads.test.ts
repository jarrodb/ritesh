import { describe, expect, it, vi } from "vitest"
import type { EggDef } from "../../src/contracts.js"
import { KEY, line, rig } from "./support.js"

const K = KEY

describe("readSecret", () => {
  it("does not echo, and returns the line", async () => {
    const r = rig()
    const read = r.editor.readSecret("Password: ")
    expect(await r.typed("hunter2")).toEqual(["Password: "])
    expect(r.cursor()).toEqual([0, 10])
    r.type(K.enter)
    expect(await read).toBe("hunter2")
    expect(r.lines()).toEqual(["Password: "])
    expect(r.cursor()).toEqual([1, 0])
  })

  it("never writes the secret to the terminal", async () => {
    const r = rig()
    const write = vi.spyOn(r.term, "write")
    const read = r.editor.readSecret("Password: ")
    r.type("hunter2" + K.left + K.backspace + K.ctrlA + K.ctrlK + K.ctrlY + "s3cret" + K.tab + K.ctrlR + K.up + K.enter)
    expect(await read).toBe("s3cret")
    const all = write.mock.calls.map(([data]) => data).join("")
    expect(all).not.toMatch(/hunter|s3cret/)
  })

  it("is never recorded, recalled, suggested, or left in the kill buffer", async () => {
    const r = rig()
    const read = r.editor.readSecret("Password: ")
    r.type("hunter2" + K.ctrlU + "hunter2" + K.enter)
    await read
    expect(r.editor.history()).toEqual([])
    const next = r.editor.readLine()
    expect(await r.typed("h" + K.ctrlY + K.up)).toEqual(["Password: ", "$ h"])
    r.type(K.enter)
    expect(await next).toBe("h")
  })

  it("edits without echo", async () => {
    const r = rig()
    const read = r.editor.readSecret("pw: ")
    r.type("abcd" + K.backspace + K.home + K.del + "x" + K.enter)
    expect(await read).toBe("xbc")
  })

  it("^D on nothing is end of input", async () => {
    const r = rig()
    const read = r.editor.readSecret("pw: ")
    r.type(K.ctrlD)
    expect(await read).toBeNull()
  })

  it("^C ends the read with null and tells the kernel", async () => {
    const onInterrupt = vi.fn()
    const r = rig({ onInterrupt })
    const read = r.editor.readSecret("pw: ")
    r.type("abc" + K.ctrlC)
    expect(await read).toBeNull()
    expect(r.lines()).toEqual(["pw: ^C"])
    expect(onInterrupt).toHaveBeenCalledTimes(1)
  })

  it("does not match key eggs", async () => {
    const onKeyEgg = vi.fn()
    const egg: EggDef = { id: "xyzzy", trigger: { keys: "xyzzy" }, run: () => Promise.resolve() }
    const r = rig({ keyEggs: () => [egg], onKeyEgg })
    const read = r.editor.readSecret("pw: ")
    r.type("xyzzy" + K.enter)
    expect(await read).toBe("xyzzy")
    expect(onKeyEgg).not.toHaveBeenCalled()
  })
})

describe("readText", () => {
  it("echoes and returns a line, with no history", async () => {
    const r = rig()
    await line(r, "echo one" + K.enter)
    const read = r.editor.readText("name? ")
    expect(await r.typed("ec" + K.up)).toEqual(["$ echo one", "name? ec"])
    r.type(K.enter)
    expect(await read).toBe("ec")
    expect(r.editor.history()).toEqual(["echo one"])
  })

  it("does not continue an unfinished quote", async () => {
    const r = rig()
    const read = r.editor.readText()
    r.type("it's" + K.enter)
    expect(await read).toBe("it's")
    expect(r.lines()).toEqual(["it's"])
  })

  it("takes a paste one line per read", async () => {
    const r = rig()
    const first = r.editor.readText("1> ")
    r.type(K.paste("one\ntwo\nthr"))
    expect(await first).toBe("one")
    const second = r.editor.readText("2> ")
    expect(await second).toBe("two")
    const third = r.editor.readText("3> ")
    expect(await r.typed("ee")).toEqual(["1> one", "2> two", "3> three"])
    r.type(K.enter)
    expect(await third).toBe("three")
  })

  it("^D on nothing is end of input, ^C ends with null and tells the kernel", async () => {
    const onInterrupt = vi.fn()
    const r = rig({ onInterrupt })
    const eof = r.editor.readText()
    r.type(K.ctrlD)
    expect(await eof).toBeNull()
    expect(onInterrupt).not.toHaveBeenCalled()
    const cut = r.editor.readText("? ")
    r.type("abc" + K.ctrlC)
    expect(await cut).toBeNull()
    expect(r.lines()).toEqual(["", "? abc^C"])
    expect(onInterrupt).toHaveBeenCalledTimes(1)
  })
})

describe("interrupt()", () => {
  it("abandons a command line like ^C and keeps reading", async () => {
    const onInterrupt = vi.fn()
    const r = rig({ onInterrupt })
    const read = r.editor.readLine()
    await r.typed("foo")
    r.editor.interrupt()
    await r.settled()
    expect(r.lines()).toEqual(["$ foo^C", "$ "])
    r.type("bar" + K.enter)
    expect(await read).toBe("bar")
    expect(onInterrupt).not.toHaveBeenCalled()
  })

  it("ends a read made for a command with null", async () => {
    const onInterrupt = vi.fn()
    const r = rig({ onInterrupt })
    const read = r.editor.readSecret("pw: ")
    r.type("abc")
    r.editor.interrupt()
    expect(await read).toBeNull()
    expect(r.lines()).toEqual(["pw: ^C"])
    expect(onInterrupt).not.toHaveBeenCalled()
  })

  it("does nothing but drop typed-ahead keys when no line is being read", async () => {
    const r = rig()
    r.type("stale")
    r.editor.interrupt()
    expect(await line(r, "x" + K.enter)).toBe("x")
    expect(r.lines()).toEqual(["$ x"])
  })
})

describe("typing ahead", () => {
  it("keeps keys typed while nothing reads, for the next read", async () => {
    const r = rig()
    r.type("echo")
    r.type(" hi" + K.left)
    const read = r.editor.readLine()
    await r.settled()
    expect(r.lines()).toEqual(["$ echo hi"])
    expect(r.cursor()).toEqual([0, 8])
    r.type(K.enter)
    expect(await read).toBe("echo hi")
  })

  it("gives each read one line of what was typed", async () => {
    const r = rig()
    r.type("one\rtwo\rthr")
    expect(await r.editor.readLine()).toBe("one")
    expect(await r.editor.readLine()).toBe("two")
    expect(await line(r, "ee" + K.enter)).toBe("three")
    expect(r.lines()).toEqual(["$ one", "$ two", "$ three"])
  })

  it("^C while nothing reads goes to the kernel and drops what was typed", async () => {
    const onInterrupt = vi.fn()
    const r = rig({ onInterrupt })
    r.type("stale" + K.ctrlC + "x")
    expect(onInterrupt).toHaveBeenCalledTimes(1)
    expect(await line(r, K.enter)).toBe("x")
  })
})

describe("one read at a time", () => {
  it("refuses a second read while one is open", async () => {
    const r = rig()
    const read = r.editor.readLine()
    await expect(r.editor.readLine()).rejects.toThrow("already being read")
    await expect(r.editor.readSecret("pw: ")).rejects.toThrow("already being read")
    r.type("ok" + K.enter)
    expect(await read).toBe("ok")
  })
})

describe("dispose", () => {
  it("ends the open read with null and stops listening", async () => {
    const r = rig()
    const read = r.editor.readLine()
    await r.typed("abc")
    r.editor.dispose()
    r.editor.dispose()
    expect(await read).toBeNull()
    expect(await r.typed("def")).toEqual(["$ abc"])
    expect(await r.editor.readLine()).toBeNull()
    r.xterm.resize(20, 5)
    r.editor.notify("late")
    await r.settled()
    expect(r.lines()).toEqual(["$ abc"])
  })
})

describe("key eggs", () => {
  const konami: EggDef = { id: "konami", trigger: { keys: "up up down down left right left right b a" }, run: () => Promise.resolve() }
  const xyzzy: EggDef = { id: "xyzzy", trigger: { keys: "xyzzy" }, run: () => Promise.resolve() }
  const command: EggDef = { id: "sudoers", trigger: { command: "sudo" }, run: () => Promise.resolve() }
  const CODE = K.up + K.up + K.down + K.down + K.left + K.right + K.left + K.right + "ba"

  it("calls onKeyEgg when the keys typed match a trigger", async () => {
    const onKeyEgg = vi.fn()
    const r = rig({ keyEggs: () => [command, xyzzy, konami], onKeyEgg })
    const read = r.editor.readLine()
    r.type(CODE)
    expect(onKeyEgg.mock.calls).toEqual([[konami]])
    r.type(K.enter)
    expect(await read).toBe("ba")
  })

  it("matches across separate key presses and only on the whole sequence", () => {
    const onKeyEgg = vi.fn()
    const r = rig({ keyEggs: () => [xyzzy], onKeyEgg })
    void r.editor.readLine()
    for (const ch of "xyzz") r.type(ch)
    expect(onKeyEgg).not.toHaveBeenCalled()
    r.type("x")
    r.type("xyzzy")
    expect(onKeyEgg).toHaveBeenCalledTimes(1)
    r.type("xyzzyxyzzy")
    expect(onKeyEgg).toHaveBeenCalledTimes(3)
  })

  it("reads the egg list on every key, also while nothing reads, and not from a paste", async () => {
    const onKeyEgg = vi.fn()
    const eggs: EggDef[] = []
    const r = rig({ keyEggs: () => eggs, onKeyEgg })
    r.type("xyzzy")
    eggs.push(xyzzy)
    r.type(K.paste("xyzzy"))
    expect(onKeyEgg).not.toHaveBeenCalled()
    r.type("xyzzy")
    expect(onKeyEgg.mock.calls).toEqual([[xyzzy]])
    expect(await line(r, K.enter)).toBe("xyzzyxyzzyxyzzy")
  })
})
