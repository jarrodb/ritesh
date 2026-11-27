// Decodes terminal input into keys. xterm delivers one string per key press,
// but a chunk may hold several keys (type-ahead, tests) and a paste may span
// chunks, so the decoder keeps state.

export type Key =
  | { type: "text"; text: string }
  | { type: "paste"; text: string }
  | { type: "key"; name: string }
  /** A whole line from the host (Rite.exec), submitted as if typed at a command prompt. */
  | { type: "run"; text: string }

const ESC = "\x1b"
const PASTE_START = "\x1b[200~"
const PASTE_END = "\x1b[201~"

const CSI_LETTER: Readonly<Record<string, string>> = {
  A: "up", B: "down", C: "right", D: "left", H: "home", F: "end",
}
const CSI_TILDE: Readonly<Record<string, string>> = {
  "1": "home", "7": "home", "4": "end", "8": "end", "3": "delete",
}
const MODIFIER: Readonly<Record<string, string>> = { "": "", "1": "", "2": "shift-", "3": "alt-", "5": "ctrl-" }

/** The key a CSI sequence stands for, or undefined when it is not a key rite knows. */
function csiKey(params: string, final: string): string | undefined {
  if (final === "Z" && params === "") return "shift-tab"
  const [first = "", second = ""] = params.split(";")
  const modifier = MODIFIER[second]
  if (modifier === undefined) return undefined
  const name = final === "~" ? CSI_TILDE[first] : first === "" || first === "1" ? CSI_LETTER[final] : undefined
  return name === undefined ? undefined : modifier + name
}

function controlKey(code: number): string | undefined {
  switch (code) {
    case 0x00: return undefined
    case 0x08: return "ctrl-backspace"
    case 0x09: return "tab"
    case 0x0a:
    case 0x0d: return "enter"
    case 0x7f: return "backspace"
    default: return "ctrl-" + String.fromCharCode(code + 0x60)
  }
}

const isPrintable = (code: number): boolean => code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f)

export function createKeyDecoder(): (data: string) => Key[] {
  /** Paste text so far, while inside a bracketed paste. */
  let paste: string | undefined

  return (data) => {
    const keys: Key[] = []
    let i = 0
    while (i < data.length) {
      if (paste !== undefined) {
        const end = data.indexOf(PASTE_END, i)
        if (end < 0) {
          paste += data.slice(i)
          break
        }
        keys.push({ type: "paste", text: paste + data.slice(i, end) })
        paste = undefined
        i = end + PASTE_END.length
        continue
      }
      const code = data.charCodeAt(i)
      if (data.startsWith(PASTE_START, i)) {
        paste = ""
        i += PASTE_START.length
      } else if (data.charAt(i) === ESC) {
        i = escape(data, i, keys)
      } else if (isPrintable(code)) {
        let end = i + 1
        while (end < data.length && isPrintable(data.charCodeAt(end))) end++
        keys.push({ type: "text", text: data.slice(i, end) })
        i = end
      } else {
        const name = code < 0x80 ? controlKey(code) : undefined
        if (name !== undefined) keys.push({ type: "key", name })
        i++
      }
    }
    return keys
  }
}

/** Decodes the escape sequence at i and returns the index after it. Unknown sequences produce no key. */
function escape(data: string, i: number, keys: Key[]): number {
  const following = data.codePointAt(i + 1)
  if (following === undefined) {
    keys.push({ type: "key", name: "escape" })
    return i + 1
  }
  const ch = String.fromCodePoint(following)
  if (ch === "[") {
    let j = i + 2
    while (j < data.length && data.charCodeAt(j) >= 0x30 && data.charCodeAt(j) <= 0x3f) j++
    const params = data.slice(i + 2, j)
    while (j < data.length && data.charCodeAt(j) >= 0x20 && data.charCodeAt(j) <= 0x2f) j++
    if (j >= data.length) return data.length
    const name = csiKey(params, data.charAt(j))
    if (name !== undefined) keys.push({ type: "key", name })
    return j + 1
  }
  if (ch === "O" && i + 2 < data.length) {
    const name = CSI_LETTER[data.charAt(i + 2)]
    if (name !== undefined) keys.push({ type: "key", name })
    return i + 3
  }
  if (ch === ESC) {
    keys.push({ type: "key", name: "escape" })
    return i + 1
  }
  if (ch === "\x7f" || ch === "\x08") keys.push({ type: "key", name: "alt-backspace" })
  else if (ch === "\r" || ch === "\n") keys.push({ type: "key", name: "alt-enter" })
  else if (isPrintable(following)) keys.push({ type: "key", name: "alt-" + ch.toLowerCase() })
  return i + 1 + ch.length
}

const NAMED: ReadonlySet<string> = new Set([
  "up", "down", "left", "right", "enter", "tab", "escape", "space", "backspace", "delete", "home", "end",
])

/**
 * The keys of an egg trigger. The trigger is words separated by spaces: a
 * key name (up, down, left, right, enter, tab, escape, space, backspace,
 * delete, home, end, or one with a ctrl-, alt-, or shift- prefix), or
 * characters, each one a key. "up up down down b a" is six keys.
 */
export function triggerKeys(trigger: string): string[] {
  const out: string[] = []
  for (const word of trigger.split(/\s+/u)) {
    if (word === "") continue
    if (word === "esc") out.push("escape")
    else if (NAMED.has(word) || /^(?:ctrl|alt|shift)-./u.test(word)) out.push(word)
    else out.push(...Array.from(word))
  }
  return out
}

/** The names a key is matched by in egg triggers. A paste is not a key. */
export function keyNames(key: Key): string[] {
  if (key.type === "key") return [key.name]
  if (key.type === "paste" || key.type === "run") return []
  return Array.from(key.text, (ch) => (ch === " " ? "space" : ch))
}
