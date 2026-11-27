import { defineCommand } from "../define.js"
import { body, each, emit, lineCount, source, splitLines, usageError } from "./util.js"

const USAGE = "tail [-n lines] [file...]"

export const tail = defineCommand({
  name: "tail",
  summary: "output the last lines",
  usage: USAGE,
  flags: {
    lines: { long: "lines", short: "n", type: "number", default: 10, description: "how many lines to print" },
  },
  manual: [
    "Prints the last lines of each file, or of stdin. With several files each",
    "is headed by `==> name <==`. There is no -f: nothing is followed.",
  ].join("\n"),
  run: body("tail", async (p) => {
    const { count, operands } = lineCount(p)
    if (count === undefined) return usageError(p, "tail", USAGE, "invalid number of lines")
    let first = true
    return each(p, "tail", operands, async (operand) => {
      let lines: string[]
      if (operand === "-") {
        // Keep only what can still be printed while reading.
        lines = []
        for await (const line of source(p, operand)) {
          lines.push(line)
          if (lines.length > count) lines.shift()
        }
      } else {
        const all = splitLines(await p.fs.read(operand, p.cwd, { signal: p.signal }))
        lines = all.slice(Math.max(0, all.length - count))
      }
      if (operands.length > 1) await p.out(`${first ? "" : "\n"}==> ${operand === "-" ? "standard input" : operand} <==\n`)
      first = false
      await emit(p, lines)
    })
  }),
})
