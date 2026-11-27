/* eslint-disable no-control-regex -- this module exists to match control sequences */
import type { OutputPolicy } from "../contracts.js"

const ESC = 0x1b
const BEL = 0x07

/** A filter for one output stream. It keeps an escape sequence split across chunks until it completes. */
export interface OutputFilter {
  (chunk: string): string
}

export function createOutputFilter(policy: OutputPolicy): OutputFilter {
  let pending = ""
  return (chunk) => {
    const { text, rest } = filterChunk(pending + chunk, policy)
    pending = rest
    return text
  }
}

/**
 * Filters text for a policy and converts "\n" to "\r\n".
 *
 * plain: printable text, "\n", "\t". Every escape sequence is removed whole.
 * sgr:   plain plus CSI sequences ending in "m" (colors and styles).
 * raw:   unchanged, including newlines.
 *
 * An unterminated sequence at the end is dropped; streams use createOutputFilter.
 */
export function filterOutput(data: string, policy: OutputPolicy): string {
  return filterChunk(data, policy).text
}

function filterChunk(data: string, policy: OutputPolicy): { text: string; rest: string } {
  if (policy === "raw") return { text: data, rest: "" }
  let out = ""
  let i = 0
  while (i < data.length) {
    const c = data.charCodeAt(i)
    if (c === ESC || c === 0x9b || c === 0x9d || c === 0x90 || (c >= 0x98 && c <= 0x9f)) {
      const end = sequenceEnd(data, i)
      if (end < 0) return { text: out, rest: data.slice(i) }
      if (policy === "sgr" && isSgr(data, i, end)) out += normalizeSgr(data.slice(i, end))
      i = end
      continue
    }
    if (c === 0x0a) {
      out += "\r\n"
    } else if (c === 0x09) {
      out += "\t"
    } else if (c >= 0x20 && c !== 0x7f && !(c >= 0x80 && c <= 0x9f)) {
      out += data.charAt(i)
    }
    i++
  }
  return { text: out, rest: "" }
}

/** Index just past the escape sequence that starts at i, or -1 when the data ends first. */
function sequenceEnd(s: string, i: number): number {
  const c = s.charCodeAt(i)
  let j = i + 1
  let kind: "csi" | "string" | "single"
  if (c === 0x9b) {
    kind = "csi"
  } else if (c === 0x9d || c === 0x90 || (c >= 0x98 && c <= 0x9f)) {
    kind = "string"
  } else {
    const n = s[j]
    if (n === undefined) return -1
    j++
    if (n === "[") kind = "csi"
    else if (n === "]" || n === "P" || n === "X" || n === "^" || n === "_") kind = "string"
    else kind = "single"
  }
  if (kind === "single") {
    // ESC, then intermediates (0x20-0x2f), then one final byte. The byte
    // after ESC is either the final or the first intermediate.
    if (s.charCodeAt(j - 1) < 0x20 || s.charCodeAt(j - 1) > 0x2f) return j
    while (j < s.length && s.charCodeAt(j) >= 0x20 && s.charCodeAt(j) <= 0x2f) j++
    return j < s.length ? j + 1 : -1
  }
  if (kind === "csi") {
    while (j < s.length) {
      const b = s.charCodeAt(j)
      j++
      if (b >= 0x40 && b <= 0x7e) return j
    }
    return -1
  }
  // OSC, DCS, SOS, PM, APC: until BEL or ST (ESC \ or 0x9c).
  while (j < s.length) {
    const b = s.charCodeAt(j)
    if (b === BEL || b === 0x9c) return j + 1
    if (b === ESC && s[j + 1] === "\\") return j + 2
    j++
  }
  return -1
}

function isSgr(s: string, start: number, end: number): boolean {
  const seq = s.slice(start, end)
  return /^(?:\x1b\[|\x9b)[0-9;:]*m$/.test(seq)
}

function normalizeSgr(seq: string): string {
  return seq.startsWith("\x9b") ? "\x1b[" + seq.slice(1) : seq
}

/** True for input that is a terminal reply, not a key: cursor and device reports, OSC and DCS strings. */
export function isTerminalReply(data: string): boolean {
  return /^\x1b\[[?>]?[\d;]*[Rcn]$/.test(data) || /^\x1b[\]P]/.test(data)
}
