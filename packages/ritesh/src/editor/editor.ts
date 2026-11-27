// The rite line editor: one input line (which may continue over several),
// read from a Term and painted back through it.
import type { Candidate, Completion, EggDef, HistoryMode, OutputPolicy, Parser, Term } from "../contracts.js"
import { commonPrefix, openWord, quoteContext, type QuoteContext, wholeWord } from "./complete.js"
import { highlight, type HighlightHooks } from "./highlight.js"
import { createHistory, type StorageEvents, type StorageLike } from "./history.js"
import { createKeyDecoder, type Key, keyNames, triggerKeys } from "./keys.js"
import { type Frame, paint, reflowedRow, type View } from "./render.js"
import {
  clean, clusters, isNotBlank, lineEnd, lineStart, next, previous, snap, wordLeft, wordRight,
} from "./text.js"

export interface EditorOptions {
  term: Term
  parser: Parser
  /** The kernel's completion. The signal aborts on the next key. */
  complete(line: string, cursor: number, o: { signal: AbortSignal }): Promise<Completion>
  /** The rendered prompt. It may contain SGR sequences. Called when a line starts. */
  prompt(): string
  history: HistoryMode
  /** Storage key for history in "local" mode. */
  historyKey: string
  /** Defaults to localStorage, when the page may use it. */
  storage?: StorageLike
  /** Carries the storage event from other tabs. Defaults to the window. */
  storageEvents?: StorageEvents
  /** Eggs with a keys trigger. Read on every key, so the list may change. */
  keyEggs?: () => readonly EggDef[]
  onKeyEgg?: (egg: EggDef) => void
  highlight?: HighlightHooks
  /** ^C while no line is being read, or while a command reads one (readText, readSecret). */
  onInterrupt?: () => void
}

export interface Editor {
  /** Reads a command line. Null on ^D at an empty line. */
  readLine(): Promise<string | null>
  /** Reads a line for a command: echoed, with no history, completion, or highlighting. Null on ^D or ^C. */
  readText(prompt?: string): Promise<string | null>
  /** Reads a line without echo. Never recorded. Null on ^D or ^C. */
  readSecret(prompt: string): Promise<string | null>
  /** Submits a line at the next command prompt, as if typed. */
  run(line: string): void
  /** ^C from the program: abandons the line being read. */
  interrupt(): void
  /** Prints text above the prompt and redraws the line. */
  notify(text: string): void
  /** Recorded lines, oldest first. */
  history(): readonly string[]
  dispose(): void
}

type Mode = "shell" | "text" | "secret"

interface Search {
  query: string
  /** Index of the matching history entry, -1 for none. */
  match: number
  failed: boolean
  saved: { text: string; cursor: number }
}

/** A completion with several candidates, as applied to the line. */
interface Tabbed {
  text: string
  cursor: number
  span: readonly [number, number]
  candidates: readonly Candidate[]
  context: QuoteContext
}

interface Menu {
  base: Tabbed
  selected: number
}

interface Read {
  mode: Mode
  prompt: string
  text: string
  /** Offset in text, always on a cluster boundary. */
  cursor: number
  resolve: (value: string | null) => void
  /** Position in history while recalling, and the line that was being typed. */
  index: number | undefined
  draft: string
  search: Search | undefined
  tab: Tabbed | undefined
  menu: Menu | undefined
  completing: AbortController | undefined
}

type Drawn = Pick<Frame, "row" | "lines" | "starts"> & { cols: number }

const PASTE_ON = "\x1b[?2004h"
const PASTE_OFF = "\x1b[?2004l"
const CLEAR_SCREEN = "\x1b[H\x1b[2J"
const ERASE_BELOW = "\x1b[J"
/** How many keys back an egg trigger can reach. */
const RECENT_KEYS = 64

/** Moves the cursor up by rows, or down when negative. */
const up = (rows: number): string => (rows > 0 ? `\x1b[${rows}A` : rows < 0 ? `\x1b[${-rows}B` : "")

export function createEditor(options: EditorOptions): Editor {
  const { term, parser } = options
  const width = (codePoint: number): 0 | 1 | 2 => term.width(codePoint)
  const history = createHistory({
    mode: options.history,
    key: options.historyKey,
    storage: options.storage,
    events: options.storageEvents,
  })
  const decode = createKeyDecoder()
  /** Keys not yet handled: typed while nothing was reading, or after the key that ended a read. */
  const queue: Key[] = []
  const recent: string[] = []
  let active: Read | undefined
  /** The frame on screen, when the cursor is inside one. */
  let drawn: Drawn | undefined
  let killed = ""
  let written: Promise<void> = Promise.resolve()
  let pasteOn = false
  let disposed = false

  const write = (data: string, policy: OutputPolicy): void => {
    if (data !== "") written = term.write(data, policy)
  }

  /** Returns to the top of the frame on screen and clears it. */
  const home = (row = drawn?.row ?? 0): string => "\r" + up(row) + ERASE_BELOW

  // ------------------------------------------------------------ painting

  function suggestion(r: Read): string | undefined {
    if (r.mode !== "shell" || r.search || r.menu || r.text === "" || r.cursor !== r.text.length) return undefined
    const entries = history.entries()
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i]
      if (entry !== undefined && entry.length > r.text.length && entry.startsWith(r.text)) return entry
    }
    return undefined
  }

  const styles = (r: Read, text: string): string[] | undefined =>
    r.mode === "shell" ? highlight(text, parser.tokenize(text), options.highlight) : undefined

  /** What to paint. `tail` is set for the frame that ends a line. */
  function view(r: Read, tail: string | undefined): View {
    const closing = tail !== undefined
    const base = { ghost: "", tail: tail ?? "", menu: undefined }
    if (r.mode === "secret") return { ...base, prompt: r.prompt, text: "", styles: undefined, cursor: 0 }
    if (r.search) {
      const s = r.search
      const entry = history.entries()[s.match]
      const text = entry ?? s.saved.text
      const found = entry?.indexOf(s.query) ?? -1
      return {
        ...base,
        prompt: `(${s.failed ? "failed " : ""}reverse-i-search)\`${s.query}': `,
        text,
        styles: styles(r, text),
        cursor: entry === undefined ? s.saved.cursor : found < 0 ? text.length : found,
      }
    }
    return {
      prompt: r.prompt,
      text: r.text,
      styles: styles(r, r.text),
      cursor: r.cursor,
      ghost: closing ? "" : (suggestion(r)?.slice(r.text.length) ?? ""),
      tail: tail ?? "",
      menu: closing || !r.menu ? undefined : { candidates: r.menu.base.candidates, selected: r.menu.selected },
    }
  }

  function draw(r: Read): void {
    const frame = paint(view(r, undefined), term.size, width, home(), true)
    for (const chunk of frame.chunks) write(chunk.data, chunk.policy)
    drawn = { row: frame.row, lines: frame.lines, starts: frame.starts, cols: term.size.cols }
  }

  /** Paints the line a last time, without suggestion or menu, and moves below it. */
  function close(r: Read, tail: string): void {
    for (const chunk of paint(view(r, tail), term.size, width, home(), false).chunks) write(chunk.data, chunk.policy)
    write("\r\n", "raw")
    drawn = undefined
  }

  // ------------------------------------------------------------ reads

  const prompt = (): string => options.prompt()

  function begin(mode: Mode, promptText: string | undefined): Promise<string | null> {
    if (disposed) return Promise.resolve(null)
    if (active) return Promise.reject(new Error("rite: a line is already being read"))
    return new Promise((resolve) => {
      const r: Read = {
        mode, prompt: promptText ?? prompt(), text: "", cursor: 0, resolve,
        index: undefined, draft: "", search: undefined, tab: undefined, menu: undefined, completing: undefined,
      }
      active = r
      if (!pasteOn) {
        pasteOn = true
        write(PASTE_ON, "raw")
      }
      // Output that did not end its line stays: a marker and a row of spaces
      // wrap to the next line unless the cursor is already at column 0.
      write(`\x1b[7m%\x1b[27m${" ".repeat(Math.max(0, term.size.cols - 1))}\r`, "raw")
      drawn = undefined
      draw(r)
      pump()
    })
  }

  function finish(r: Read, value: string | null): void {
    close(r, "")
    active = undefined
    if (value !== null && r.mode === "shell" && value.trim() !== "" && !value.startsWith(" ")) history.add(value)
    void written.then(() => { r.resolve(value) })
  }

  function submit(r: Read): void {
    if (r.mode === "shell") {
      const result = parser.parse(r.text)
      if (!result.ok && result.incomplete) {
        r.text += "\n"
        r.cursor = r.text.length
        return
      }
    }
    finish(r, r.text)
  }

  /** ^C: a command line starts over; a line read for a command ends with null. True when the read goes on. */
  function abandon(r: Read, fromKey: boolean): boolean {
    cancelCompletion(r)
    close(r, "^C")
    if (r.mode !== "shell") {
      active = undefined
      void written.then(() => { r.resolve(null) })
      if (fromKey) options.onInterrupt?.()
      return false
    }
    r.prompt = prompt()
    r.text = ""
    r.cursor = 0
    r.index = undefined
    r.draft = ""
    r.search = undefined
    r.tab = undefined
    r.menu = undefined
    return true
  }

  // ------------------------------------------------------------ editing

  function insert(r: Read, raw: string): void {
    const text = clean(raw)
    if (text === "") return
    r.text = r.text.slice(0, r.cursor) + text + r.text.slice(r.cursor)
    r.cursor = snap(r.text, r.cursor + text.length)
  }

  function remove(r: Read, from: number, to: number, kill: boolean): void {
    if (from >= to) return
    // A secret never reaches the kill buffer.
    if (kill && r.mode !== "secret") killed = r.text.slice(from, to)
    r.text = r.text.slice(0, from) + r.text.slice(to)
    r.cursor = from
  }

  function replace(r: Read, text: string): void {
    r.text = text
    r.cursor = text.length
  }

  function paste(r: Read, raw: string): void {
    const text = clean(raw.replace(/\r\n?/g, "\n"))
    const newline = text.indexOf("\n")
    if (r.mode === "shell" || newline < 0) {
      insert(r, text)
      return
    }
    // A command reads one line at a time; the rest waits for its next read.
    insert(r, text.slice(0, newline))
    const rest = text.slice(newline + 1)
    if (rest !== "") queue.unshift({ type: "paste", text: rest })
    submit(r)
  }

  function recall(r: Read, older: boolean): void {
    if (r.mode !== "shell") return
    const entries = history.entries()
    if (older) {
      const index = (r.index === undefined ? entries.length : Math.min(r.index, entries.length)) - 1
      const entry = entries[index]
      if (entry === undefined) return
      if (r.index === undefined) r.draft = r.text
      r.index = index
      replace(r, entry)
    } else if (r.index !== undefined) {
      const entry = entries[r.index + 1]
      r.index = entry === undefined ? undefined : r.index + 1
      replace(r, entry ?? r.draft)
    }
  }

  /** Takes the suggestion when the cursor is at the end of the line. */
  function acceptSuggestion(r: Read): boolean {
    const entry = suggestion(r)
    if (entry === undefined) return false
    replace(r, entry)
    return true
  }

  // ------------------------------------------------------------ search

  function find(s: Search, from: number): void {
    const entries = history.entries()
    for (let i = s.query === "" ? -1 : Math.min(from, entries.length - 1); i >= 0; i--) {
      if (entries[i]?.includes(s.query) === true) {
        s.match = i
        s.failed = false
        return
      }
    }
    s.failed = s.query !== ""
  }

  /** Leaves search with the match as the line. */
  function acceptSearch(r: Read, s: Search): void {
    const entry = history.entries()[s.match]
    r.search = undefined
    if (entry === undefined) {
      r.text = s.saved.text
      r.cursor = s.saved.cursor
      return
    }
    const found = entry.indexOf(s.query)
    r.text = entry
    r.cursor = found < 0 ? entry.length : found
    r.index = s.match
    if (r.draft === "") r.draft = s.saved.text
  }

  /** True when search consumed the key. Any key it does not know ends the search and is handled as usual. */
  function searchKey(r: Read, s: Search, key: Key): boolean {
    if (key.type === "text") {
      // One character at a time, so a query that stops matching keeps the last match on screen.
      for (const c of clusters(key.text)) {
        s.query += c.text
        find(s, s.match < 0 ? Infinity : s.match)
      }
      return true
    }
    if (key.type === "key") {
      switch (key.name) {
        case "ctrl-r":
          if (s.match >= 0) find(s, s.match - 1)
          return true
        case "backspace":
          s.query = s.query.slice(0, previous(s.query, s.query.length))
          s.match = -1
          find(s, Infinity)
          return true
        case "ctrl-g":
          r.search = undefined
          r.text = s.saved.text
          r.cursor = s.saved.cursor
          return true
        case "escape":
          acceptSearch(r, s)
          return true
        case "ctrl-c":
          return false
      }
    }
    acceptSearch(r, s)
    return false
  }

  // ------------------------------------------------------------ completion

  /** Aborts the completion in flight. True when there was one. */
  function cancelCompletion(r: Read): boolean {
    const controller = r.completing
    r.completing = undefined
    controller?.abort()
    return controller !== undefined
  }

  function splice(r: Read, span: readonly [number, number], insertion: string): void {
    r.text = r.text.slice(0, span[0]) + insertion + r.text.slice(span[1])
    r.cursor = span[0] + insertion.length
  }

  function applyCompletion(r: Read, completion: Completion, openMenu: boolean): void {
    const [start, end] = completion.span
    r.tab = undefined
    if (!(start >= 0 && start <= end && end <= r.text.length)) return
    const { candidates } = completion
    const [only] = candidates
    if (only === undefined) return
    const context = quoteContext(r.text.slice(start, end))
    if (candidates.length === 1) {
      splice(r, [start, end], wholeWord(parser, only, context))
      return
    }
    let span: readonly [number, number] = [start, end]
    const prefix = commonPrefix(candidates.map((c) => c.value))
    if (prefix !== "") {
      const insertion = openWord(parser, prefix, context)
      if (insertion !== r.text.slice(start, end)) {
        splice(r, span, insertion)
        span = [start, start + insertion.length]
      }
    }
    r.tab = { text: r.text, cursor: r.cursor, span, candidates, context }
    if (openMenu) r.menu = { base: r.tab, selected: -1 }
  }

  function startCompletion(r: Read, openMenu: boolean): void {
    const controller = new AbortController()
    r.completing = controller
    void options.complete(r.text, r.cursor, { signal: controller.signal }).then(
      (completion) => {
        if (r.completing !== controller || active !== r) return
        r.completing = undefined
        applyCompletion(r, completion, openMenu)
        draw(r)
      },
      () => {
        if (r.completing === controller) r.completing = undefined
      },
    )
  }

  function choose(r: Read, menu: Menu, step: 1 | -1): void {
    const { base } = menu
    const count = base.candidates.length
    menu.selected = menu.selected < 0 ? (step > 0 ? 0 : count - 1) : (menu.selected + step + count) % count
    const candidate = base.candidates[menu.selected]
    if (candidate === undefined) return
    r.text = base.text
    splice(r, base.span, wholeWord(parser, candidate, base.context))
  }

  /** True when the menu consumed the key. */
  function menuKey(r: Read, menu: Menu, key: Key): boolean {
    if (key.type === "key") {
      switch (key.name) {
        case "tab":
        case "down":
        case "right":
          choose(r, menu, 1)
          return true
        case "shift-tab":
        case "up":
        case "left":
          choose(r, menu, -1)
          return true
        case "escape":
        case "ctrl-g":
          r.menu = undefined
          r.text = menu.base.text
          r.cursor = menu.base.cursor
          return true
        case "enter":
          r.menu = undefined
          if (menu.selected < 0) return false
          r.tab = undefined
          return true
      }
    }
    // Any other key keeps what is selected and is handled as usual.
    r.menu = undefined
    return false
  }

  // ------------------------------------------------------------ keys

  function command(r: Read, name: string, wasCompleting: boolean): void {
    const { text, cursor } = r
    const shell = r.mode === "shell"
    switch (name) {
      case "enter":
        submit(r)
        break
      case "backspace":
        remove(r, previous(text, cursor), cursor, false)
        break
      case "delete":
        remove(r, cursor, next(text, cursor), false)
        break
      case "ctrl-d":
        if (text === "") finish(r, null)
        else remove(r, cursor, next(text, cursor), false)
        break
      case "left":
      case "ctrl-b":
        r.cursor = previous(text, cursor)
        break
      case "right":
      case "ctrl-f":
        if (!acceptSuggestion(r)) r.cursor = next(text, cursor)
        break
      case "home":
      case "ctrl-a":
        r.cursor = lineStart(text, cursor)
        break
      case "end":
      case "ctrl-e":
        if (!acceptSuggestion(r)) r.cursor = lineEnd(text, cursor)
        break
      case "up":
      case "ctrl-p":
        recall(r, true)
        break
      case "down":
      case "ctrl-n":
        recall(r, false)
        break
      case "alt-b":
      case "alt-left":
      case "ctrl-left":
        r.cursor = wordLeft(text, cursor)
        break
      case "alt-f":
      case "alt-right":
      case "ctrl-right":
        r.cursor = wordRight(text, cursor)
        break
      case "ctrl-k":
        // At the end of a line of several, takes the newline.
        remove(r, cursor, Math.max(lineEnd(text, cursor), Math.min(cursor + 1, text.length)), true)
        break
      case "ctrl-u":
        remove(r, Math.min(lineStart(text, cursor), Math.max(cursor - 1, 0)), cursor, true)
        break
      case "ctrl-w":
        remove(r, wordLeft(text, cursor, isNotBlank), cursor, true)
        break
      case "alt-backspace":
      case "ctrl-backspace":
        remove(r, wordLeft(text, cursor), cursor, true)
        break
      case "alt-d":
      case "alt-delete":
      case "ctrl-delete":
        remove(r, cursor, wordRight(text, cursor), true)
        break
      case "ctrl-y":
        insert(r, killed)
        break
      case "ctrl-l":
        write(CLEAR_SCREEN, "raw")
        drawn = undefined
        break
      case "ctrl-c":
        abandon(r, true)
        break
      case "ctrl-r":
        if (shell) r.search = { query: "", match: -1, failed: false, saved: { text, cursor } }
        break
      case "tab":
        if (!shell) break
        if (r.tab && r.tab.text === text && r.tab.cursor === cursor) r.menu = { base: r.tab, selected: -1 }
        else startCompletion(r, wasCompleting)
        break
      default:
        // Keys the editor has no use for, and escape sequences it does not know.
        break
    }
  }

  function handle(r: Read, key: Key): void {
    const wasCompleting = cancelCompletion(r)
    if (r.search && searchKey(r, r.search, key)) return
    if (r.menu && menuKey(r, r.menu, key)) return
    if (key.type === "text") insert(r, key.text)
    else if (key.type === "paste") paste(r, key.text)
    else if (key.type === "run") {
      replace(r, key.text)
      draw(r)
      finish(r, key.text)
    }
    else command(r, key.name, wasCompleting)
  }

  /** Handles queued keys while a read wants them, then paints once. */
  function pump(): void {
    let handled = false
    for (let r = active; r && queue.length > 0; r = active) {
      // A host line waits for a command prompt; a command reading stdin never gets it.
      if (queue[0]?.type === "run" && r.mode !== "shell") break
      const key = queue.shift()
      if (key === undefined) break
      handle(r, key)
      handled = true
    }
    if (handled && active) draw(active)
  }

  function noteKeys(key: Key): void {
    if (!options.keyEggs || active?.mode === "secret") return
    for (const name of keyNames(key)) {
      recent.push(name)
      if (recent.length > RECENT_KEYS) recent.shift()
      for (const egg of options.keyEggs()) {
        if (!("keys" in egg.trigger)) continue
        const keys = triggerKeys(egg.trigger.keys)
        const from = recent.length - keys.length
        if (keys.length === 0 || from < 0 || !keys.every((k, i) => recent[from + i] === k)) continue
        recent.length = 0
        options.onKeyEgg?.(egg)
        break
      }
    }
  }

  const offInput = term.onInput((data) => {
    for (const key of decode(data)) {
      noteKeys(key)
      if (!active && key.type === "key" && key.name === "ctrl-c") {
        // Nothing is reading: ^C goes to the running command and drops what was typed ahead.
        queue.length = 0
        options.onInterrupt?.()
      } else {
        queue.push(key)
      }
    }
    pump()
  })

  const offResize = term.onResize(({ cols }) => {
    if (!active || !drawn) return
    write(home(reflowedRow(drawn, drawn.cols, cols)), "raw")
    drawn = undefined
    draw(active)
  })

  return {
    readLine: () => begin("shell", undefined),
    readText: (text = "") => begin("text", text),
    readSecret: (text) => begin("secret", text),
    run(line) {
      if (disposed) return
      queue.push({ type: "run", text: line })
      pump()
    },
    interrupt() {
      queue.length = 0
      if (active && abandon(active, false)) draw(active)
    },
    notify(text) {
      if (disposed) return
      if (active) write(home(), "raw")
      write(text.replace(/\n+$/, ""), "plain")
      // The line break is the editor's own, so text that ends inside an escape sequence cannot swallow it.
      write("\r\n", "raw")
      drawn = undefined
      if (active) draw(active)
    },
    history: () => history.entries(),
    dispose() {
      if (disposed) return
      disposed = true
      offInput()
      offResize()
      history.dispose()
      queue.length = 0
      if (pasteOn) write(PASTE_OFF, "raw")
      const r = active
      active = undefined
      if (r) {
        cancelCompletion(r)
        r.resolve(null)
      }
    },
  }
}
