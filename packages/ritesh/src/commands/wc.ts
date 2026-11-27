import { type Proc } from "../contracts.js"
import { defineCommand } from "../define.js"
import { body, each, emit, flag, inputs, readText } from "./util.js"

interface Counts {
  lines: number
  words: number
  bytes: number
}

const COLUMNS = ["lines", "words", "bytes"] as const
const encoder = new TextEncoder()

function measure(text: string): Counts {
  let lines = 0
  for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1)) lines++
  return { lines, words: text.match(/\S+/g)?.length ?? 0, bytes: encoder.encode(text).length }
}

function shown(p: Proc): ReadonlyArray<(typeof COLUMNS)[number]> {
  const picked = COLUMNS.filter((column) => flag(p, column))
  return picked.length === 0 ? COLUMNS : picked
}

export const wc = defineCommand({
  name: "wc",
  summary: "count lines, words, and bytes",
  usage: "wc [-lwc] [file...]",
  flags: {
    lines: { long: "lines", short: "l", type: "boolean", description: "count newlines" },
    words: { long: "words", short: "w", type: "boolean", description: "count words" },
    bytes: { long: "bytes", short: "c", type: "boolean", description: "count bytes of UTF-8" },
  },
  manual: [
    "Counts each file, or stdin. With no option it prints lines, words, and bytes,",
    "in that order whichever options are given. Several files end with a total.",
  ].join("\n"),
  run: body("wc", async (p) => {
    const columns = shown(p)
    const rows: Array<{ counts: Counts; name: string }> = []
    const status = await each(p, "wc", inputs(p), async (operand) => {
      rows.push({ counts: measure(await readText(p, operand)), name: operand === "-" ? "" : operand })
    })
    if (p.args.length > 1) {
      const total: Counts = { lines: 0, words: 0, bytes: 0 }
      for (const { counts } of rows) for (const column of COLUMNS) total[column] += counts[column]
      rows.push({ counts: total, name: "total" })
    }
    const cells = rows.map((row) => columns.map((column) => String(row.counts[column])))
    const size = Math.max(0, ...cells.flat().map((cell) => cell.length))
    await emit(p, rows.map((row, i) => {
      const numbers = (cells[i] ?? []).map((cell) => cell.padStart(size)).join(" ")
      return row.name === "" ? numbers : `${numbers} ${row.name}`
    }))
    return status
  }),
})
