// A Term backed by @xterm/headless, for editor and term tests. The package's
// "module" field points at a file the tarball does not contain, so the
// headless build is imported by its path.
import { Unicode11Addon } from "@xterm/addon-unicode11"
import type { Terminal as HeadlessTerminal } from "@xterm/headless"
// @ts-expect-error: no types for the deep path; the shape is HeadlessTerminal.
import { Terminal } from "@xterm/headless/lib-headless/xterm-headless.mjs"
import type { Term } from "../../src/contracts.js"
import { createTerm } from "../../src/term/term.js"

export interface HeadlessTerm {
  term: Term
  xterm: HeadlessTerminal
  /** The visible screen as lines, trailing spaces trimmed. */
  screen(): string[]
  /** Simulate typed input. */
  type(data: string): void
}

export function headlessTerm(cols = 80, rows = 24): HeadlessTerm {
  const xterm = new (Terminal as typeof HeadlessTerminal)({ cols, rows, allowProposedApi: true })
  const term = createTerm(xterm, new Unicode11Addon())
  return {
    term,
    xterm,
    screen() {
      const buf = xterm.buffer.active
      const lines: string[] = []
      for (let y = 0; y < xterm.rows; y++) lines.push(buf.getLine(buf.viewportY + y)?.translateToString(true) ?? "")
      return lines
    },
    type(data) {
      xterm.input(data, true)
    },
  }
}
