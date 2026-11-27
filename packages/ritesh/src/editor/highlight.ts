// Syntax highlighting from parser tokens. Styles are SGR parameter strings,
// one per UTF-16 code unit of the line.
import type { Token } from "../contracts.js"

export interface HighlightHooks {
  /** Whether the name resolves to a command. Synchronous, cache only. */
  isCommand(name: string): boolean
  /** Whether the word names an existing path. Synchronous, cache only. */
  pathExists(word: string): boolean
}

const GREEN = "32"
const RED = "31"
const YELLOW = "33"
const CYAN = "36"
const MAGENTA = "35"
const DIM = "2"
const UNDERLINE = "4"

const PARAM = /\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\}|\?)/y
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const RESERVED_WORD = /^(?:!|[a-z]+)$/

/** Length of the parameter reference at i, or 0. */
function paramLength(text: string, i: number): number {
  PARAM.lastIndex = i
  return PARAM.exec(text)?.[0].length ?? 0
}

/** The word's value when it is all literal; undefined when it holds a parameter or a glob. */
export function unquote(text: string): string | undefined {
  let out = ""
  let i = 0
  while (i < text.length) {
    const c = text.charAt(i)
    if (c === "'") {
      const close = text.indexOf("'", i + 1)
      const end = close < 0 ? text.length : close
      out += text.slice(i + 1, end)
      i = end + 1
    } else if (c === '"') {
      i++
      while (i < text.length && text.charAt(i) !== '"') {
        const d = text.charAt(i)
        const after = text.charAt(i + 1)
        if (d === "\\" && after !== "" && '"\\$\n'.includes(after)) {
          if (after !== "\n") out += after
          i += 2
        } else if (d === "$" && paramLength(text, i) > 0) {
          return undefined
        } else {
          out += d
          i++
        }
      }
      i++
    } else if (c === "\\") {
      const after = text.charAt(i + 1)
      if (after !== "\n") out += after
      i += 2
    } else if (c === "*" || (c === "$" && paramLength(text, i) > 0)) {
      return undefined
    } else {
      out += c
      i++
    }
  }
  return out
}

/** Colors the quoted parts and parameter references of a word. */
function styleParts(text: string, start: number, styles: string[]): void {
  const fill = (from: number, to: number, sgr: string): void => {
    for (let k = from; k < to && k < text.length; k++) styles[start + k] = sgr
  }
  let i = 0
  while (i < text.length) {
    const c = text.charAt(i)
    if (c === "'") {
      const close = text.indexOf("'", i + 1)
      const end = close < 0 ? text.length : close + 1
      fill(i, end, YELLOW)
      i = end
    } else if (c === '"') {
      const open = i
      i++
      const params: Array<[number, number]> = []
      while (i < text.length && text.charAt(i) !== '"') {
        const length = text.charAt(i) === "$" ? paramLength(text, i) : 0
        if (length > 0) {
          params.push([i, i + length])
          i += length
        } else {
          i += text.charAt(i) === "\\" ? 2 : 1
        }
      }
      i = Math.min(i + 1, text.length)
      fill(open, i, YELLOW)
      for (const [from, to] of params) fill(from, to, CYAN)
    } else if (c === "\\") {
      i += 2
    } else if (c === "$") {
      const length = paramLength(text, i)
      fill(i, i + length, CYAN)
      i += Math.max(1, length)
    } else {
      i++
    }
  }
}

/**
 * Command word green when it resolves, red when it does not; strings yellow,
 * parameters cyan, operators and redirects magenta, reserved syntax red,
 * comments dim, existing paths underlined.
 */
export function highlight(line: string, tokens: readonly Token[], hooks: HighlightHooks | undefined): string[] {
  const styles = new Array<string>(line.length).fill("")
  const fill = (token: Token, sgr: string): void => {
    for (let k = token.span[0]; k < token.span[1]; k++) styles[k] = sgr
  }
  let commandPosition = true
  let target = false
  for (const token of tokens) {
    switch (token.kind) {
      case "whitespace":
        break
      case "comment":
        fill(token, DIM)
        break
      case "operator":
        fill(token, MAGENTA)
        commandPosition = true
        target = false
        break
      case "redirect":
        fill(token, MAGENTA)
        target = token.text !== "2>&1" && token.text !== ">&2"
        break
      case "reserved":
        fill(token, RED)
        if (commandPosition && !target && RESERVED_WORD.test(token.text)) commandPosition = false
        break
      case "word": {
        const value = unquote(token.text)
        if (!target && commandPosition && !ASSIGNMENT.test(token.text)) {
          commandPosition = false
          if (value !== undefined && hooks) {
            fill(token, hooks.isCommand(value) ? GREEN : RED)
            break
          }
          styleParts(token.text, token.span[0], styles)
          break
        }
        const assignment = !target && commandPosition
        target = false
        styleParts(token.text, token.span[0], styles)
        if (!assignment && value !== undefined && value !== "" && hooks?.pathExists(value) === true) {
          for (let k = token.span[0]; k < token.span[1]; k++) {
            const sgr = styles[k] ?? ""
            styles[k] = sgr === "" ? UNDERLINE : `${sgr};${UNDERLINE}`
          }
        }
        break
      }
    }
  }
  return styles
}
