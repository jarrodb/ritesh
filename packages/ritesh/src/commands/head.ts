import { defineCommand } from "../define.js"
import { body, each, emit, lineCount, source, splitLines, usageError } from "./util.js"

const USAGE = "head [-n lines] [file...]"

export const head = defineCommand({
  name: "head",
  summary: "output the first lines",
  usage: USAGE,
  flags: {
    lines: { long: "lines", short: "n", type: "number", default: 10, description: "how many lines to print" },
  },
  manual: [
    "Prints the first lines of each file, or of stdin. With several files each",
    "is headed by `==> name <==`. Reading stdin stops once the lines are printed.",
  ].join("\n"),
  run: body("head", async (p) => {
    const { count, operands } = lineCount(p)
    if (count === undefined) return usageError(p, "head", USAGE, "invalid number of lines")
    let first = true
    return each(p, "head", operands, async (operand) => {
      // Read before the header, so a missing file prints only its error.
      const lines = operand === "-" ? undefined : splitLines(await p.fs.read(operand, p.cwd, { signal: p.signal }))
      if (operands.length > 1) await p.out(`${first ? "" : "\n"}==> ${operand === "-" ? "standard input" : operand} <==\n`)
      first = false
      if (lines) {
        await emit(p, lines.slice(0, count))
        return
      }
      let left = count
      if (left === 0) return
      for await (const line of source(p, operand)) {
        await p.out(line + "\n")
        if (--left === 0) break
      }
    })
  }),
})
