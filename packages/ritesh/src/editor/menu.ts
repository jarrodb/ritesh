// The completion menu: candidates in columns below the line, or one per row
// with descriptions when the terminal is wide enough for them.
import type { Candidate } from "../contracts.js"
import { label, textWidth, truncate, type Width } from "./text.js"

export interface MenuCell {
  text: string
  /** SGR parameters, "" for none. */
  sgr: string
}

export interface MenuView {
  candidates: readonly Candidate[]
  /** Index of the highlighted candidate, -1 for none. */
  selected: number
}

const GAP = 2
/** Descriptions are shown when at least this many cells are left for them. */
const MIN_DESCRIPTION = 10
const SELECTED = "7"
const DIM = "2"

/** Rows of the menu, at most `maxRows`, each narrower than `cols`. */
export function layoutMenu(menu: MenuView, cols: number, maxRows: number, width: Width): MenuCell[][] {
  // The last column stays empty so a row never leaves the cursor at the margin.
  const available = cols - 1
  if (maxRows < 1 || available < 1 || menu.candidates.length === 0) return []
  const names = menu.candidates.map((c) => truncate(label(c.display ?? c.value), available, width))
  const descriptions = menu.candidates.map((c) => label(c.description ?? ""))
  const nameWidth = Math.max(...names.map((n) => textWidth(n, width)))
  const pad = (name: string, to: number): string => " ".repeat(Math.max(0, to - textWidth(name, width)))
  const cell = (index: number): MenuCell => ({
    text: names[index] ?? "",
    sgr: index === menu.selected ? SELECTED : "",
  })

  let rows: MenuCell[][]
  let selectedRow: number
  const room = available - nameWidth - GAP
  if (descriptions.some((d) => d !== "") && room >= MIN_DESCRIPTION) {
    rows = names.map((name, i) => [
      cell(i),
      { text: pad(name, nameWidth + GAP), sgr: "" },
      { text: truncate(descriptions[i] ?? "", room, width), sgr: DIM },
    ])
    selectedRow = menu.selected
  } else {
    const columnWidth = nameWidth + GAP
    const columns = Math.max(1, Math.floor((available + GAP) / columnWidth))
    const count = Math.ceil(names.length / columns)
    rows = []
    // Column-major, like ls: read down, then across.
    for (let r = 0; r < count; r++) {
      const row: MenuCell[] = []
      for (let c = 0; c * count + r < names.length; c++) {
        const index = c * count + r
        if (c > 0) row.push({ text: pad(names[index - count] ?? "", columnWidth), sgr: "" })
        row.push(cell(index))
      }
      rows.push(row)
    }
    selectedRow = menu.selected < 0 ? -1 : menu.selected % count
  }

  if (rows.length <= maxRows) return rows
  if (maxRows === 1) return [[{ text: truncate(`${rows.length} rows`, available, width), sgr: DIM }]]
  // Too tall: show the page that holds the selection, and say where it is.
  const page = maxRows - 1
  const top = selectedRow < 0 ? 0 : Math.floor(selectedRow / page) * page
  const shown = rows.slice(top, top + page)
  const status = `rows ${top + 1}-${top + shown.length} of ${rows.length}`
  return [...shown, [{ text: truncate(status, available, width), sgr: DIM }]]
}
