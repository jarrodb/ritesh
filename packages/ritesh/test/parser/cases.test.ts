import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { commandsOf, outcome, parser } from "./support.js"

interface Case {
  line: string
  parse: "ok" | "incomplete" | "syntax"
  error?: string
  words?: string[][]
}

const CASES = join(import.meta.dirname, "../../../../docs/language/cases.jsonl")
const cases = readFileSync(CASES, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Case)

describe("docs/language/cases.jsonl", () => {
  it("has the case table", () => {
    expect(cases.length).toBeGreaterThan(80)
  })

  it.each(cases.map((c, i) => [i + 1, c.line, c] as const))("case %i: %j", (_n, line, c) => {
    const result = parser.parse(line)
    expect(outcome(result)).toBe(c.parse)
    if (c.parse === "syntax") expect(c.error).toBeTypeOf("string")
    if (!result.ok && !result.incomplete) {
      expect(result.error.message).toContain(c.error)
      const [start, end] = result.error.span
      expect(start).toBeGreaterThanOrEqual(0)
      expect(start).toBeLessThan(end)
      expect(end).toBeLessThanOrEqual(line.length)
    }
    if (result.ok && c.words !== undefined) {
      // One entry of `words` per command, in order.
      expect(result.ast === null ? 0 : commandsOf(result.ast).length).toBe(c.words.length)
    }
    expect(result.tokens.map((t) => t.text).join("")).toBe(line)
    expect(parser.tokenize(line)).toEqual(result.tokens)
  })
})
