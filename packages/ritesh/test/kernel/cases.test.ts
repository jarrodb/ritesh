import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { commands, shell } from "./support.js"

interface Case {
  line: string
  parse: "ok" | "incomplete" | "syntax"
  words?: string[][]
  error?: string
  env?: Record<string, string>
  files?: Record<string, string>
  stdout?: string
  stderr?: string
  exit?: number
}

const CASES = join(import.meta.dirname, "../../../../docs/language/cases.jsonl")
const cases = readFileSync(CASES, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Case)
const TEST_COMMANDS = new Set(commands([]).map((command) => command.name))

describe("docs/language/cases.jsonl through the kernel", () => {
  it("has the case table", () => {
    expect(cases.length).toBeGreaterThan(80)
  })

  it.each(cases.map((c, i) => [i + 1, c.line, c] as const))("case %i: %j", async (_n, line, c) => {
    const sh = shell({ ...(c.files && { files: c.files }), ...(c.env && { kernel: { env: c.env } }) })
    const parsed = sh.kernel.parser.parse(line)
    expect(parsed.ok ? "ok" : parsed.incomplete ? "incomplete" : "syntax").toBe(c.parse)

    const result = await sh.run(line)
    if (c.parse === "incomplete") {
      // Not a line the editor would hand over; given one anyway, the kernel refuses it.
      expect(result).toEqual({ code: 2, stdout: "", stderr: "rite: unexpected end of line\n" })
      return
    }
    if (c.exit !== undefined) expect(result.code).toBe(c.exit)
    if (c.stdout !== undefined) expect(result.stdout).toBe(c.stdout)
    if (c.stderr !== undefined) expect(result.stderr).toBe(c.stderr)
    if (c.parse === "syntax") {
      expect(result.stdout).toBe("")
      expect(result.stderr).toMatch(/^rite: .*\n$/)
      expect(result.stderr).toContain(c.error)
      expect(sh.calls).toEqual([])
    }
    // A case that states neither stream expects that stream to be empty when the other is stated.
    if (c.parse === "ok" && c.stdout !== undefined && c.stderr === undefined) expect(result.stderr).toBe("")
    if (c.parse === "ok" && c.stderr !== undefined && c.stdout === undefined) expect(result.stdout).toBe("")

    // `words` is each command's argv after expansion. The test commands record theirs.
    const expected = (c.words ?? []).filter((words) => words.length > 0)
    if (c.words !== undefined && expected.every(([name]) => name !== undefined && TEST_COMMANDS.has(name))) {
      expect(sh.calls).toEqual(expected)
    }
  })
})
