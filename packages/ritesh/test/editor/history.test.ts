import { afterEach, describe, expect, it } from "vitest"
import { cap, MAX_BYTES, MAX_ENTRIES } from "../../src/editor/history.js"
import { FakeStorage, KEY, line, rig, type Rig } from "./support.js"

const K = KEY
const STORE = "rite:host:user:history"

async function run(r: Rig, ...lines: string[]): Promise<void> {
  for (const text of lines) await line(r, text + K.enter)
}

function local(storage: FakeStorage): Rig {
  return rig({ history: "local", historyKey: STORE, storage, storageEvents: storage })
}

const stored = (storage: FakeStorage): unknown => JSON.parse(storage.data.get(STORE) ?? "null")

describe("history in memory", () => {
  it("recalls lines with Up and Down and restores the draft", async () => {
    const r = rig()
    await run(r, "echo one", "echo two")
    const read = r.editor.readLine()
    expect(await r.typed("dra" + K.up)).toEqual(["$ echo one", "$ echo two", "$ echo two"])
    expect(r.cursor()).toEqual([2, 10])
    expect((await r.typed(K.up)).at(-1)).toBe("$ echo one")
    expect((await r.typed(K.up)).at(-1)).toBe("$ echo one")
    expect((await r.typed(K.down)).at(-1)).toBe("$ echo two")
    expect((await r.typed(K.down)).at(-1)).toBe("$ dra")
    expect((await r.typed(K.down)).at(-1)).toBe("$ dra")
    r.type(K.up + K.up + "!" + K.enter)
    expect(await read).toBe("echo one!")
    expect(r.editor.history()).toEqual(["echo one", "echo two", "echo one!"])
  })

  it("^P and ^N recall too", async () => {
    const r = rig()
    await run(r, "a", "b")
    expect(await line(r, "\x10\x10\x0e" + K.enter)).toBe("b")
  })

  it.each<[string, string[], string[]]>([
    ["skips a line that starts with a space", ["a", " secret", "b"], ["a", "b"]],
    ["skips empty and blank lines", ["a", "", "\t"], ["a"]],
    ["records a repeated line once", ["a", "a", "b", "a"], ["a", "b", "a"]],
    ["keeps the lines of a continued command together", ["echo 'a" + K.enter + "b'"], ["echo 'a\nb'"]],
  ])("%s", async (_name, lines, want) => {
    const r = rig()
    await run(r, ...lines)
    expect(r.editor.history()).toEqual(want)
  })

  it("does not record an abandoned line or end of input", async () => {
    const r = rig()
    await line(r, "nope" + K.ctrlC + K.ctrlD)
    expect(r.editor.history()).toEqual([])
  })

  it("does not touch storage", async () => {
    const storage = new FakeStorage()
    const r = rig({ history: "memory", historyKey: STORE, storage, storageEvents: storage })
    await run(r, "a")
    expect(storage.data.size).toBe(0)
    expect(storage.listeners).toBe(0)
  })
})

describe("history off", () => {
  it("records and recalls nothing", async () => {
    const storage = new FakeStorage()
    const r = rig({ history: false, historyKey: STORE, storage, storageEvents: storage })
    await run(r, "echo one")
    expect(await line(r, K.up + "x" + K.enter)).toBe("x")
    expect(r.editor.history()).toEqual([])
    expect(storage.data.size).toBe(0)
  })
})

describe("history in storage", () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, "localStorage")
  })

  it("persists under the key and loads it back", async () => {
    const storage = new FakeStorage()
    await run(local(storage), "echo one", " hidden", "echo two")
    expect(stored(storage)).toEqual(["echo one", "echo two"])
    const again = local(storage)
    expect(again.editor.history()).toEqual(["echo one", "echo two"])
    expect(await line(again, K.up + K.enter)).toBe("echo two")
  })

  it.each<[string, string]>([
    ["not JSON", "{oops"],
    ["not an array", "{\"a\":1}"],
    ["null", "null"],
  ])("starts empty when the stored value is %s", async (_name, value) => {
    const storage = new FakeStorage()
    storage.data.set(STORE, value)
    const r = local(storage)
    expect(r.editor.history()).toEqual([])
    await run(r, "a")
    expect(stored(storage)).toEqual(["a"])
  })

  it("keeps only the strings of a stored array", () => {
    const storage = new FakeStorage()
    storage.data.set(STORE, JSON.stringify(["a", 1, null, "b", ["c"]]))
    expect(local(storage).editor.history()).toEqual(["a", "b"])
  })

  it("keeps the newest 1000 entries", async () => {
    const storage = new FakeStorage()
    storage.data.set(STORE, JSON.stringify(Array.from({ length: MAX_ENTRIES }, (_, i) => `cmd ${i}`)))
    const r = local(storage)
    await run(r, "newest")
    const entries = r.editor.history()
    expect(entries).toHaveLength(MAX_ENTRIES)
    expect(entries[0]).toBe("cmd 1")
    expect(entries.at(-1)).toBe("newest")
    expect(stored(storage)).toEqual(entries)
  })

  it("keeps the stored value within 256 KiB of UTF-8, dropping the oldest", () => {
    const big = "x".repeat(100 * 1024)
    // 40 Ki characters, 80 KiB stored.
    const accented = "\u00e9".repeat(40 * 1024)
    const kept = cap(["a", big + "1", big + "2", accented, "z"])
    expect(kept.map((e) => e.length)).toEqual([big.length + 1, accented.length, 1])
    expect(kept[0]?.endsWith("2")).toBe(true)
    expect(new TextEncoder().encode(JSON.stringify(kept)).length).toBeLessThanOrEqual(MAX_BYTES)
    expect(cap(["a", "x".repeat(MAX_BYTES)])).toEqual([])
  })

  it("does not record a line larger than the cap", async () => {
    const storage = new FakeStorage()
    const r = local(storage)
    await run(r, "a")
    await line(r, KEY.paste("x".repeat(MAX_BYTES)) + K.enter)
    expect(r.editor.history()).toEqual([])
  })

  it("works in memory when storage cannot be read", async () => {
    const storage = new FakeStorage()
    storage.data.set(STORE, JSON.stringify(["old"]))
    storage.failReads = true
    const r = local(storage)
    expect(r.editor.history()).toEqual([])
    await run(r, "a")
    expect(await line(r, K.up + K.enter)).toBe("a")
  })

  it("keeps lines in memory when storage cannot be written, and stores them once it can", async () => {
    const storage = new FakeStorage()
    storage.data.set(STORE, JSON.stringify(["old"]))
    const r = local(storage)
    storage.failWrites = true
    await run(r, "a", "b")
    expect(r.editor.history()).toEqual(["old", "a", "b"])
    expect(stored(storage)).toEqual(["old"])
    storage.failWrites = false
    await run(r, "c")
    expect(stored(storage)).toEqual(["old", "a", "b", "c"])
  })

  it("works in memory when there is no localStorage", async () => {
    const r = rig({ history: "local", historyKey: STORE })
    await run(r, "a")
    expect(await line(r, K.up + K.enter)).toBe("a")
  })

  it("works in memory when reaching localStorage throws", async () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get: () => {
        throw new Error("SecurityError")
      },
    })
    const r = rig({ history: "local", historyKey: STORE })
    await run(r, "a")
    expect(r.editor.history()).toEqual(["a"])
  })

  it("uses localStorage by default", async () => {
    const storage = new FakeStorage()
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage })
    await run(rig({ history: "local", historyKey: STORE }), "a")
    expect(stored(storage)).toEqual(["a"])
  })

  it("takes another tab's lines on the storage event", async () => {
    const storage = new FakeStorage()
    const r = local(storage)
    await run(r, "mine")
    storage.change(STORE, JSON.stringify(["mine", "theirs"]))
    expect(r.editor.history()).toEqual(["mine", "theirs"])
    expect(await line(r, K.up + K.enter)).toBe("theirs")
  })

  it("reads what another tab stored before it writes", async () => {
    const storage = new FakeStorage()
    const r = local(storage)
    await run(r, "mine")
    storage.data.set(STORE, JSON.stringify(["mine", "theirs"]))
    await run(r, "more")
    expect(stored(storage)).toEqual(["mine", "theirs", "more"])
  })

  it("keeps lines it could not store when another tab writes", async () => {
    const storage = new FakeStorage()
    const r = local(storage)
    storage.failWrites = true
    await run(r, "unsaved")
    storage.failWrites = false
    storage.change(STORE, JSON.stringify(["theirs"]))
    expect(r.editor.history()).toEqual(["theirs", "unsaved"])
  })

  it("ignores other keys, and empties when the key is removed or storage is cleared", async () => {
    const storage = new FakeStorage()
    const r = local(storage)
    await run(r, "mine")
    storage.change("rite:other:user:history", JSON.stringify(["x"]))
    expect(r.editor.history()).toEqual(["mine"])
    storage.change(STORE, null)
    expect(r.editor.history()).toEqual([])
    await run(r, "again")
    storage.change(null, null)
    expect(r.editor.history()).toEqual([])
  })

  it("stops listening on dispose", () => {
    const storage = new FakeStorage()
    const r = local(storage)
    expect(storage.listeners).toBe(1)
    r.editor.dispose()
    expect(storage.listeners).toBe(0)
  })
})
