import { describe, expect, it } from "vitest"
import * as themes from "../src/themes.js"

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

// Text colors only: black is the background's neighbour by convention, and
// the cursor and selection are not text.
const notText = new Set(["background", "cursor", "cursorAccent", "selectionBackground", "black"])

describe("themes", () => {
  it.each(Object.entries(themes))("%s keeps every text color at 4.5:1 or more", (_name, theme) => {
    for (const [key, color] of Object.entries(theme)) {
      if (notText.has(key)) continue
      expect(contrast(color, theme.background), key).toBeGreaterThanOrEqual(4.5)
    }
  })
})
