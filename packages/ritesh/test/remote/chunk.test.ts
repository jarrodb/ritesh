import { describe, expect, it } from "vitest"
import { byteLength, splitByJsonBytes } from "../../src/remote/chunk.js"
import { wellFormed } from "./support.js"

/** The bytes a piece takes as the body of a JSON string. */
const jsonBody = (text: string): number => byteLength(JSON.stringify(text)) - 2

describe("splitByJsonBytes", () => {
  it("returns nothing for the empty string and one piece when it fits", () => {
    expect(splitByJsonBytes("", 10)).toEqual([])
    expect(splitByJsonBytes("abc", 18)).toEqual(["abc"])
    expect(splitByJsonBytes("abc", 3)).toEqual(["abc"])
  })

  const cases: Array<[string, string]> = [
    ["ascii", "the quick brown fox jumps over the lazy dog"],
    ["quotes and backslashes", "\"\\\"\\\\\"\"\\\\"],
    ["short escapes", "\n\t\r\b\f\n\n\t"],
    ["control characters", "\u0000\u0001\u001f\u0002\u0003"],
    ["two-byte", "éèêëàâäôöùûü"],
    ["three-byte", "日本語のテキストです"],
    ["astral", "😀🎉🚀🌍😀🎉🚀🌍"],
    ["lone surrogates", "a\ud800b\udc00c\ud83d"],
    ["line and paragraph separators", "a b c"],
    ["mixed", "a\"é日😀\n\u0001\\".repeat(9)],
  ]
  it.each(cases)("%s: every piece fits the budget and the pieces join back", (_name, text) => {
    for (let budget = 1; budget <= 40; budget++) {
      const pieces = splitByJsonBytes(text, budget)
      expect(pieces.join("")).toBe(text)
      for (const piece of pieces) {
        expect(piece.length).toBeGreaterThan(0)
        // A single code point may be larger than a budget this small; nothing else may.
        if (Array.from(piece).length > 1 || budget >= 6) expect(jsonBody(piece), `budget ${budget}: ${JSON.stringify(piece)}`).toBeLessThanOrEqual(budget)
      }
    }
  })

  it("never splits a surrogate pair", () => {
    for (let budget = 1; budget <= 12; budget++) {
      for (const piece of splitByJsonBytes("😀a🎉bb🚀", budget)) expect(wellFormed(piece)).toBe(true)
    }
  })

  it("fills each piece as far as the budget allows", () => {
    expect(splitByJsonBytes("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"])
    expect(splitByJsonBytes("日本語", 6)).toEqual(["日本", "語"])
    expect(splitByJsonBytes("a\nb\nc", 3)).toEqual(["a\n", "b\n", "c"])
  })
})
