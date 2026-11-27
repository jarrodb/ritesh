// Splits stdin so each proc.stdin message stays under maxMessageBytes.

const encoder = new TextEncoder()

export function byteLength(text: string): number {
  return encoder.encode(text).length
}

/** UTF-8 bytes one code point takes inside a JSON string, as JSON.stringify writes it. */
function jsonBytes(codePoint: number): number {
  if (codePoint === 0x22 || codePoint === 0x5c) return 2
  if (codePoint < 0x20) {
    // \b \t \n \f \r have short escapes; the rest are \u00XX.
    return codePoint === 0x08 || codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0c || codePoint === 0x0d ? 2 : 6
  }
  if (codePoint < 0x80) return 1
  if (codePoint < 0x800) return 2
  // A lone surrogate is escaped as \uDXXX.
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return 6
  return codePoint < 0x10000 ? 3 : 4
}

/**
 * Pieces of `text`, in order, whose JSON string bodies are each at most
 * `budget` bytes. Never splits a surrogate pair. A piece holds at least one
 * code point, so a budget below one code point's size is exceeded by it.
 */
export function splitByJsonBytes(text: string, budget: number): string[] {
  if (text === "") return []
  // No code unit takes more than 6 bytes.
  if (text.length * 6 <= budget) return [text]
  const pieces: string[] = []
  let start = 0
  let used = 0
  let i = 0
  while (i < text.length) {
    const codePoint = text.codePointAt(i) ?? 0
    const cost = jsonBytes(codePoint)
    if (used + cost > budget && i > start) {
      pieces.push(text.slice(start, i))
      start = i
      used = 0
    }
    used += cost
    i += codePoint > 0xffff ? 2 : 1
  }
  pieces.push(text.slice(start))
  return pieces
}
