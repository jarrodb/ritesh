// Text measures for the line editor. The cursor moves by grapheme cluster;
// width is counted per code point, the way xterm advances its cursor.

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })

export type Width = (codePoint: number) => 0 | 1 | 2

export interface Cluster {
  text: string
  /** Offset in UTF-16 code units. */
  index: number
}

export function clusters(text: string): Cluster[] {
  const out: Cluster[] = []
  for (const s of segmenter.segment(text)) out.push({ text: s.segment, index: s.index })
  return out
}

/** The cluster boundary before `at`. */
export function previous(text: string, at: number): number {
  let last = 0
  for (const s of segmenter.segment(text)) {
    if (s.index >= at) break
    last = s.index
  }
  return last
}

/** The cluster boundary after `at`. */
export function next(text: string, at: number): number {
  for (const s of segmenter.segment(text)) {
    const end = s.index + s.segment.length
    if (end > at) return end
  }
  return text.length
}

/** The first cluster boundary at or after `at`. */
export function snap(text: string, at: number): number {
  for (const s of segmenter.segment(text)) {
    if (s.index >= at) return s.index
  }
  return text.length
}

const WORD = /[\p{L}\p{N}_]/u

export const isWord = (cluster: string): boolean => WORD.test(cluster)
export const isNotBlank = (cluster: string): boolean => !/\s/u.test(cluster)

/** Start of the word before `at`: skips what is not a word, then the word. */
export function wordLeft(text: string, at: number, word: (cluster: string) => boolean = isWord): number {
  const list = clusters(text.slice(0, at))
  let i = list.length
  while (i > 0 && !word(list[i - 1]?.text ?? "")) i--
  while (i > 0 && word(list[i - 1]?.text ?? "")) i--
  return list[i]?.index ?? at
}

/** End of the word after `at`. */
export function wordRight(text: string, at: number): number {
  const list = clusters(text.slice(at))
  let i = 0
  while (i < list.length && !isWord(list[i]?.text ?? "")) i++
  while (i < list.length && isWord(list[i]?.text ?? "")) i++
  return at + (list[i]?.index ?? text.length - at)
}

export function lineStart(text: string, at: number): number {
  return text.lastIndexOf("\n", at - 1) + 1
}

export function lineEnd(text: string, at: number): number {
  const end = text.indexOf("\n", at)
  return end < 0 ? text.length : end
}

function isControl(code: number): boolean {
  return code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)
}

/** Text as the buffer holds it: no control characters except newline and tab. */
export function clean(text: string): string {
  let out = ""
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code === 0x0a || code === 0x09 || !isControl(code)) out += text.charAt(i)
  }
  return out
}

/** Text for one display line: newline and tab become a space, other control characters go. */
export function label(text: string): string {
  let out = ""
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code === 0x0a || code === 0x09) out += " "
    else if (!isControl(code)) out += text.charAt(i)
  }
  return out
}

export function textWidth(text: string, width: Width): number {
  let total = 0
  for (const ch of text) total += width(ch.codePointAt(0) ?? 0)
  return total
}

/** Cuts text to at most `max` cells, ending in an ellipsis when it was cut. */
export function truncate(text: string, max: number, width: Width): string {
  if (textWidth(text, width) <= max) return text
  let out = ""
  let used = 0
  for (const c of clusters(text)) {
    const w = textWidth(c.text, width)
    if (used + w > max - 1) break
    out += c.text
    used += w
  }
  return max > 0 ? out + "…" : ""
}
