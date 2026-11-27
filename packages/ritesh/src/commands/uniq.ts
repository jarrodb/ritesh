import { defineCommand } from "../define.js"
import { body, each, flag, halted, inputs, source, usageError } from "./util.js"

const USAGE = "uniq [-c] [file]"

export const uniq = defineCommand({
  name: "uniq",
  summary: "drop repeated adjacent lines",
  usage: USAGE,
  flags: {
    count: { long: "count", short: "c", type: "boolean", description: "prefix each line with how many times it repeated" },
  },
  manual: "Reads a file, or stdin, and prints each run of equal lines once. Sort first to count every repeat.",
  run: body("uniq", async (p) => {
    if (p.args.length > 1) return usageError(p, "uniq", USAGE, "too many files")
    const counted = flag(p, "count")
    const print = (line: string, times: number): Promise<void> =>
      p.out(`${counted ? `${String(times).padStart(7)} ` : ""}${line}\n`)
    return each(p, "uniq", inputs(p), async (operand) => {
      let held: string | undefined
      let times = 0
      for await (const line of source(p, operand)) {
        if (line === held) {
          times++
          continue
        }
        if (held !== undefined) await print(held, times)
        held = line
        times = 1
      }
      if (held !== undefined && !halted(p)) await print(held, times)
    })
  }),
})
