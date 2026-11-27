// Paints the input line. The painter lays text out the way xterm will (per
// code point, wrapping at the margin) so the editor knows where the cursor
// is without asking the terminal. Rows wrap by xterm's own autowrap, which
// keeps a long command one logical line for selection and reflow.
//
// Everything the user typed, and every candidate and prompt character, is
// written with the "plain" policy. Only the editor's own control sequences
// are "raw". SGR sequences in the prompt go through "sgr".
import type { OutputPolicy, TermSize } from "../contracts.js"
import { layoutMenu, type MenuView } from "./menu.js"
import { clusters, type Width } from "./text.js"

export interface Chunk {
  policy: OutputPolicy
  data: string
}

export interface Cell {
  row: number
  col: number
}

export const CONTINUATION = "> "
const RESET = "\x1b[0m"
const DIM = "2"

export class Painter {
  readonly chunks: Chunk[] = []
  /** Cell widths of each hard line (a run of rows joined by autowrap). */
  readonly lines: number[][] = [[]]
  /** The first row of each hard line. */
  readonly starts: number[] = [0]
  row = 0
  /** 0 to cols. At cols the terminal cursor is at the margin with a wrap pending. */
  col = 0
  readonly #cols: number
  readonly #width: Width

  constructor(cols: number, width: Width) {
    this.#cols = cols
    this.#width = width
  }

  emit(policy: OutputPolicy, data: string): void {
    if (data === "") return
    const last = this.chunks.at(-1)
    if (last?.policy === policy) last.data += data
    else this.chunks.push({ policy, data })
  }

  raw(data: string): void {
    this.emit("raw", data)
  }

  /** Text without control characters, in a style given as SGR parameters. */
  text(text: string, sgr = ""): void {
    if (text === "") return
    if (sgr !== "") this.raw(`\x1b[${sgr}m`)
    this.emit("plain", text)
    if (sgr !== "") this.raw(RESET)
    for (const ch of text) this.#advance(this.#width(ch.codePointAt(0) ?? 0))
  }

  #advance(width: number): void {
    if (width === 0) return
    if (this.col + width > this.#cols) {
      this.row++
      this.col = 0
    }
    this.col += width
    this.lines.at(-1)?.push(width)
  }

  /** Where the next character of the given width will be drawn. */
  landing(width = 1): Cell {
    return this.col + width > this.#cols ? { row: this.row + 1, col: 0 } : { row: this.row, col: this.col }
  }

  /**
   * Leaves the margin: when the row is full, moves to the next row so the
   * cursor has a cell to rest on. The space makes xterm take the wrap, and
   * is erased again; the row it leaves is a hard line of its own.
   */
  settle(): void {
    if (this.col < this.#cols) return
    this.raw(" \r\x1b[K")
    this.#line()
  }

  #line(): void {
    this.row++
    this.col = 0
    this.lines.push([])
    this.starts.push(this.row)
  }

  /** Ends the hard line. */
  newline(): void {
    this.settle()
    this.raw("\r\n")
    this.#line()
  }
}

export interface View {
  /** Prompt text; SGR sequences in it are kept, other control characters dropped. */
  prompt: string
  text: string
  /** SGR parameters per UTF-16 code unit of text, "" for none. */
  styles: readonly string[] | undefined
  /** Cursor offset in text. */
  cursor: number
  /** Dim text after the line: the autosuggestion. */
  ghost: string
  /** Plain text after the line: "^C". */
  tail: string
  menu: MenuView | undefined
}

export interface Frame {
  chunks: Chunk[]
  /** The row the terminal cursor is left on, from the top of the frame. */
  row: number
  lines: number[][]
  starts: number[]
}

/** Index after the SGR sequence at i, or i when there is none. */
function sgrEnd(text: string, i: number): number {
  if (text.charAt(i + 1) !== "[") return i
  let j = i + 2
  while (j < text.length && "0123456789;:".includes(text.charAt(j))) j++
  return text.charAt(j) === "m" ? j + 1 : i
}

function paintPrompt(p: Painter, prompt: string): void {
  let text = ""
  let styled = false
  const flush = (): void => {
    p.text(text)
    text = ""
  }
  for (let i = 0; i < prompt.length; i++) {
    const code = prompt.charCodeAt(i)
    if (code === 0x1b) {
      const end = sgrEnd(prompt, i)
      if (end === i) continue
      flush()
      p.emit("sgr", prompt.slice(i, end))
      styled = true
      i = end - 1
    } else if (code === 0x0a) {
      flush()
      p.newline()
    } else if (code === 0x09) {
      text += " "
    } else if (code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f)) {
      text += prompt.charAt(i)
    }
  }
  flush()
  if (styled) p.raw(RESET)
}

function firstWidth(cluster: string, width: Width): number {
  for (const ch of cluster) {
    const w = width(ch.codePointAt(0) ?? 0)
    if (w > 0) return w
  }
  return 1
}

/** Paints buffer text and returns where the cluster at `cursor` lands. A newline starts a continuation line. */
function paintText(
  p: Painter, text: string, style: (index: number) => string, cursor: number, width: Width,
): Cell | undefined {
  let at: Cell | undefined
  let run = ""
  let runStyle = ""
  const flush = (): void => {
    p.text(run, runStyle)
    run = ""
  }
  for (const c of clusters(text)) {
    if (c.index === cursor) {
      flush()
      at = p.landing(c.text === "\n" ? 1 : firstWidth(c.text, width))
    }
    if (c.text === "\n") {
      flush()
      p.newline()
      p.text(CONTINUATION)
      continue
    }
    const s = style(c.index)
    if (s !== runStyle) {
      flush()
      runStyle = s
    }
    run += c.text === "\t" ? " " : c.text
  }
  flush()
  if (cursor === text.length) at = p.landing()
  return at
}

/**
 * Builds the output for one view. `prefix` is the raw sequence that returns
 * to the top of the previous frame and clears it. With `park` the cursor is
 * moved to its place in the line; without it the cursor stays after the last
 * character, for the frame that ends a read.
 */
export function paint(view: View, size: TermSize, width: Width, prefix: string, park: boolean): Frame {
  const p = new Painter(Math.max(1, size.cols), width)
  p.raw(prefix)
  paintPrompt(p, view.prompt)
  const cursor = paintText(p, view.text, (i) => view.styles?.[i] ?? "", view.cursor, width) ?? p.landing()
  paintText(p, view.ghost, () => DIM, -1, width)
  p.text(view.tail)
  if (!park) return { chunks: p.chunks, row: p.row, lines: p.lines, starts: p.starts }
  p.settle()
  if (view.menu) {
    for (const row of layoutMenu(view.menu, size.cols, size.rows - (p.row + 1), width)) {
      p.newline()
      for (const cell of row) p.text(cell.text, cell.sgr)
    }
  }
  const up = p.row - cursor.row
  p.raw((up > 0 ? `\x1b[${up}A` : "") + "\r" + (cursor.col > 0 ? `\x1b[${cursor.col}C` : ""))
  return { chunks: p.chunks, row: cursor.row, lines: p.lines, starts: p.starts }
}

/** Rows a hard line of the given cell widths takes at a terminal width. */
function rowsAt(widths: readonly number[], cols: number): number {
  let rows = 1
  let col = 0
  for (const w of widths) {
    if (col + w > cols) {
      rows++
      col = 0
    }
    col += w
  }
  return rows
}

/**
 * The cursor's row, from the top of the frame, after xterm reflowed the
 * frame from `from` columns to `to`. It can be negative: xterm moves the
 * cursor by the rows a reflow adds or removes anywhere in the buffer, not
 * only above it. This follows xterm's Buffer.resize:
 *
 * - Wider: every wrapped hard line but the cursor's is joined, and the
 *   cursor moves up one row for each row that goes.
 * - Narrower: hard lines are rewrapped from the bottom up, the cursor moves
 *   down one row for each row added, and the line left alone is the one the
 *   cursor is on at that point of the pass.
 */
export function reflowedRow(frame: Pick<Frame, "row" | "lines" | "starts">, from: number, to: number): number {
  const count = frame.lines.length
  const start = (i: number): number => frame.starts[i] ?? 0
  const rows = (i: number): number => (i + 1 < count ? start(i + 1) - start(i) : rowsAt(frame.lines[i] ?? [], from))
  let row = frame.row
  if (to > from) {
    for (let i = 0; i < count; i++) {
      const holdsCursor = frame.row >= start(i) && frame.row < start(i) + rows(i)
      if (!holdsCursor) row -= rows(i) - rowsAt(frame.lines[i] ?? [], to)
    }
    return row
  }
  for (let i = count - 1; i >= 0; i--) {
    const widths = frame.lines[i] ?? []
    const fits = rows(i) === 1 && widths.reduce((a, b) => a + b, 0) <= to
    if (fits || (row >= start(i) && row < start(i) + rows(i))) continue
    row += rowsAt(widths, to) - rows(i)
  }
  return row
}
