import { describe, expect, it } from "vitest"
import * as commands from "../../src/commands/index.js"
import { binCommands, renderManual } from "../../src/commands/index.js"
import { byCodePoint, columns, stamp, stampLong, table } from "../../src/commands/util.js"
import { run } from "./support.js"

/** The /bin list in the design spec. */
const SPEC = [
  "ls", "cat", "echo", "pwd", "env", "which", "type", "clear", "help", "man", "sudo", "whoami", "id", "uname",
  "hostname", "date", "true", "false", "grep", "head", "tail", "wc", "sort", "uniq", "tee", "mkdir", "touch", "rm", "open",
]

describe("binCommands", () => {
  it("is the spec's /bin, each command once", () => {
    expect(binCommands.map((c) => c.name).sort()).toEqual([...SPEC].sort())
  })

  it("exports each command by name", () => {
    const exported: Record<string, unknown> = { ...commands }
    for (const def of binCommands) {
      const key = def.name === "true" || def.name === "false" ? `${def.name}Command` : def.name
      expect(exported[key], def.name).toBe(def)
    }
  })

  it.each(binCommands.map((def) => [def.name, def] as const))("%s has a summary, a usage line, and a body", (name, def) => {
    expect(def.summary).not.toBe("")
    expect(def.summary).not.toMatch(/\.$|^[A-Z]/)
    expect(def.usage === name || def.usage.startsWith(`${name} `)).toBe(true)
    expect(def.run).toBeTypeOf("function")
    expect(def.manual ?? "").not.toMatch(/\u2014|\n$/)
  })

  it.each(binCommands.map((def) => [def.name, def] as const))("%s declares its flags under their canonical names", (_, def) => {
    const shorts = new Set<string>()
    for (const [key, flag] of Object.entries(def.flags ?? {})) {
      expect(key).toBe(flag.long ?? flag.short)
      expect(flag.description ?? "").not.toBe("")
      if (flag.short === undefined) continue
      expect(flag.short).toHaveLength(1)
      expect(shorts.has(flag.short)).toBe(false)
      shorts.add(flag.short)
    }
  })

  it.each(binCommands.map((def) => [def.name, def] as const))("%s renders as a manual page", (name, def) => {
    const page = renderManual(def)
    expect(page.startsWith(`NAME\n    ${name} - ${def.summary}\n\nSYNOPSIS\n    ${def.usage}\n\nDESCRIPTION\n    `)).toBe(true)
    expect(page.includes("\nOPTIONS\n")).toBe(Object.keys(def.flags ?? {}).length > 0)
    expect(page.endsWith("\n")).toBe(true)
    expect(page.endsWith("\n\n")).toBe(false)
  })

  it.each(binCommands.filter((def) => def.flags).map((def) => [def.name, def] as const))("%s leaves --help and unknown options to its definition", async (_, def) => {
    expect(await run(def, ["--help"])).toEqual({ code: 0, stdout: `usage: ${def.usage}\n`, stderr: "" })
    expect((await run(def, ["--no-such-option"])).code).toBe(2)
  })
})

describe("text helpers", () => {
  it("orders by code point, not by UTF-16 unit", () => {
    // U+FF5E sorts before U+1F600 by code point and after it by code unit.
    expect(["\u{1f600}", "\uff5e", "b", "a", "ab", "B", ""].sort(byCodePoint)).toEqual(["", "B", "a", "ab", "b", "\uff5e", "\u{1f600}"])
  })

  it.each([
    [["a", "b", "c"], 80, ["a  b  c"]],
    [["a", "b", "c"], 4, ["a  c", "b"]],
    [["a", "b", "c"], 1, ["a", "b", "c"]],
    [["aaaa", "b", "c", "d", "e"], 13, ["aaaa  d", "b     e", "c"]],
    [["aaaa", "b", "c", "d", "e"], 16, ["aaaa  c     e", "b     d"]],
    [["\u00e9\u00e9", "b"], 6, ["\u00e9\u00e9  b"]],
    [[], 80, []],
  ])("lays %j out in %d cells", (items, cols, lines) => {
    expect(columns(items, cols)).toEqual(lines)
  })

  it("aligns a table and leaves no trailing space", () => {
    expect(table([["a", "one"], ["bbb", ""], ["cc", "three"]], "  ")).toEqual(["  a    one", "  bbb", "  cc   three"])
  })

  it("stamps local time", () => {
    const at = new Date(2026, 0, 5, 3, 4, 9).getTime()
    expect(stamp(at)).toBe("2026-01-05 03:04")
    expect(stampLong(at)).toMatch(/^2026-01-05 03:04:09 [+-]\d{4}$/)
  })
})
