import type { Completion } from "../../src/contracts.js"
import { createEditor, type Editor, type EditorOptions, type StorageChange, type StorageEvents, type StorageLike } from "../../src/editor/index.js"
import { createParser } from "../../src/parser/index.js"
import { headlessTerm, type HeadlessTerm } from "../support/headless.js"

export const parser = createParser("0.1.0")

export const KEY = {
  enter: "\r", tab: "\t", shiftTab: "\x1b[Z", esc: "\x1b", backspace: "\x7f", del: "\x1b[3~",
  left: "\x1b[D", right: "\x1b[C", up: "\x1b[A", down: "\x1b[B", home: "\x1b[H", end: "\x1b[F",
  ctrlA: "\x01", ctrlB: "\x02", ctrlC: "\x03", ctrlD: "\x04", ctrlE: "\x05", ctrlF: "\x06", ctrlG: "\x07",
  ctrlK: "\x0b", ctrlL: "\x0c", ctrlR: "\x12", ctrlU: "\x15", ctrlW: "\x17", ctrlY: "\x19",
  ctrlBackspace: "\x08", altBackspace: "\x1b\x7f", altB: "\x1bb", altF: "\x1bf", altD: "\x1bd",
  paste: (text: string): string => `\x1b[200~${text}\x1b[201~`,
} as const

export interface CellStyle {
  fg: number
  dim: boolean
  underline: boolean
  inverse: boolean
}

export interface Rig extends HeadlessTerm {
  editor: Editor
  /** Resolves when every write so far, and any the pending microtasks make, is on the screen. */
  settled(): Promise<void>
  /** The screen up to the last line that has text. */
  lines(): string[]
  /** [row, column] of the terminal cursor. */
  cursor(): [number, number]
  /** Palette foreground (-1 for the default) and attributes of one cell. */
  style(row: number, col: number): CellStyle
  /** Types, waits for the screen, and returns it. */
  typed(data: string): Promise<string[]>
}

export type RigOptions = Partial<Omit<EditorOptions, "term" | "parser">> & { cols?: number; rows?: number }

const noCompletion = (): Promise<Completion> => Promise.resolve({ span: [0, 0], candidates: [] })

export function rig(options: RigOptions = {}): Rig {
  const { cols = 40, rows = 10, ...rest } = options
  const h = headlessTerm(cols, rows)
  const editor = createEditor({
    term: h.term,
    parser,
    complete: noCompletion,
    prompt: () => "$ ",
    history: "memory",
    historyKey: "rite:test:tester:history",
    ...rest,
  })
  const settled = async (): Promise<void> => {
    // One turn of the event loop lets promise reactions run and queue their writes; this is not a timed wait.
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    await h.term.write("", "raw")
  }
  const lines = (): string[] => {
    const all = h.screen()
    let end = all.length
    while (end > 0 && all[end - 1] === "") end--
    return all.slice(0, end)
  }
  return {
    ...h,
    editor,
    settled,
    lines,
    cursor: () => [h.xterm.buffer.active.cursorY, h.xterm.buffer.active.cursorX],
    style(row, col) {
      const cell = h.xterm.buffer.active.getLine(h.xterm.buffer.active.viewportY + row)?.getCell(col)
      if (!cell) throw new Error(`no cell at ${row},${col}`)
      return {
        fg: cell.isFgPalette() ? cell.getFgColor() : -1,
        dim: cell.isDim() !== 0,
        underline: cell.isUnderline() !== 0,
        inverse: cell.isInverse() !== 0,
      }
    },
    async typed(data) {
      h.type(data)
      await settled()
      return lines()
    },
  }
}

/** Runs one readLine with the given input and returns the line it resolves to. */
export async function line(r: Rig, input: string): Promise<string | null> {
  const read = r.editor.readLine()
  r.type(input)
  return read
}

export interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(reason: unknown): void
}

export function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined
  let reject: (reason: unknown) => void = () => undefined
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Web storage in memory, with switches to make reads and writes throw. */
export class FakeStorage implements StorageLike, StorageEvents {
  readonly data: Map<string, string> = new Map<string, string>()
  failReads = false
  failWrites = false
  readonly #listeners: Set<(event: StorageChange) => void> = new Set<(event: StorageChange) => void>()

  getItem(key: string): string | null {
    if (this.failReads) throw new Error("SecurityError")
    return this.data.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error("QuotaExceededError")
    this.data.set(key, value)
  }

  addEventListener(_type: "storage", listener: (event: StorageChange) => void): void {
    this.#listeners.add(listener)
  }

  removeEventListener(_type: "storage", listener: (event: StorageChange) => void): void {
    this.#listeners.delete(listener)
  }

  get listeners(): number {
    return this.#listeners.size
  }

  /** Another tab wrote the key. */
  change(key: string | null, newValue: string | null): void {
    if (key !== null && newValue !== null) this.data.set(key, newValue)
    for (const listener of this.#listeners) listener({ key, newValue })
  }
}
