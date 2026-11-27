import { EXIT } from "../contracts.js"
import { defineCommand } from "../define.js"
import { body, byCodePoint, each, emit, flag, inputs, readText, splitLines } from "./util.js"

function numeric(a: string, b: string): number {
  return leading(a) - leading(b)
}

/** The number a line starts with, 0 when it starts with none. */
function leading(line: string): number {
  const value = Number.parseFloat(line)
  return Number.isFinite(value) ? value : 0
}

export const sort = defineCommand({
  name: "sort",
  summary: "sort lines",
  usage: "sort [-rnu] [file...]",
  flags: {
    reverse: { long: "reverse", short: "r", type: "boolean", description: "reverse the order" },
    "numeric-sort": { long: "numeric-sort", short: "n", type: "boolean", description: "order by the number each line starts with" },
    unique: { long: "unique", short: "u", type: "boolean", description: "print one of each run of equal lines" },
  },
  manual: [
    "Sorts the lines of all files together, or of stdin, by code point.",
    "With -n, lines that start with no number count as 0 and equal numbers",
    "fall back to code point order. With -u, lines that compare equal print once.",
    "If a file cannot be read nothing is printed.",
  ].join("\n"),
  run: body("sort", async (p) => {
    const lines: string[] = []
    const status = await each(p, "sort", inputs(p), async (operand) => {
      for (const line of splitLines(await readText(p, operand))) lines.push(line)
    })
    if (status !== EXIT.OK) return status
    const unique = flag(p, "unique")
    const sign = flag(p, "reverse") ? -1 : 1
    const primary = flag(p, "numeric-sort") ? numeric : byCodePoint
    // With -u the first of a run of equals is kept, so equals must stay in input order.
    lines.sort((a, b) => sign * (primary(a, b) || (unique ? 0 : byCodePoint(a, b))))
    await emit(p, unique ? lines.filter((line, i) => i === 0 || primary(lines[i - 1] ?? "", line) !== 0) : lines)
    return EXIT.OK
  }),
})
