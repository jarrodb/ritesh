// Shared by the /bin commands: status and error conventions, stdin and file
// input, and the text helpers ls, help, and man lay their output out with.
import { ERRNO_MESSAGES, EXIT, type Proc, RiteError, type Run } from "../contracts.js"

export const ROOT_UID = 0

/** Lines per stdout write when the output is already in memory. */
const BATCH = 256

export function flag(p: Proc, name: string): boolean {
  return p.flags[name] === true
}

/** Read through a call, so a check after an await is not narrowed away. */
export function halted(p: Proc): boolean {
  return p.signal.aborted
}

/** 130 for ^C. A stage cut off by its reader (EPIPE) fails quietly. */
export function haltStatus(p: Proc): number {
  return p.signal.reason === "EPIPE" ? EXIT.FAILURE : EXIT.INTERRUPTED
}

/** The message half of `<cmd>: <path>: <message>`. */
export function reason(e: RiteError): string {
  return ERRNO_MESSAGES[e.errno]
}

export async function complain(p: Proc, name: string, subject: string, message: string): Promise<void> {
  await p.err(`${name}: ${subject}: ${message}\n`)
}

/** A usage error the flag parser cannot see (a missing operand, a bad count). */
export async function usageError(p: Proc, name: string, usage: string, message: string): Promise<number> {
  await p.err(`${name}: ${message}\nusage: ${usage}\n`)
  return EXIT.USAGE
}

/**
 * Wraps a command body. An abort ends it with the abort's status and no
 * message, and a RiteError that reached the top prints in the common format.
 */
export function body(name: string, run: Run): Run {
  return async (p) => {
    try {
      const code = await run(p)
      return halted(p) ? haltStatus(p) : code
    } catch (e) {
      if (halted(p)) return haltStatus(p)
      if (!(e instanceof RiteError)) throw e
      await p.err(`${name}: ${e.path === undefined ? "" : `${e.path}: `}${reason(e)}\n`)
      return EXIT.FAILURE
    }
  }
}

/**
 * Runs `fn` for each operand. A RiteError is reported against the operand as
 * typed and the rest still run. Returns `failure` if any operand failed.
 */
export async function each(
  p: Proc, name: string, operands: readonly string[], fn: (operand: string) => Promise<void>,
  failure: number = EXIT.FAILURE,
): Promise<number> {
  let status: number = EXIT.OK
  for (const operand of operands) {
    if (halted(p)) break
    try {
      await fn(operand)
    } catch (e) {
      if (halted(p)) break
      if (!(e instanceof RiteError)) throw e
      await complain(p, name, operand, reason(e))
      status = failure
    }
  }
  return status
}

// ---------------------------------------------------------------- input

/** Lines without terminators. A last line with no newline still counts. */
export function splitLines(text: string): string[] {
  if (text === "") return []
  const lines = text.split("\n")
  if (text.endsWith("\n")) lines.pop()
  return lines
}

/** stdin as it arrives, for commands that must not change a byte of it. */
export async function* chunks(p: Proc): AsyncGenerator<string> {
  const reader = p.stdin.getReader()
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done || halted(p)) return
      yield next.value
    }
  } finally {
    reader.releaseLock()
  }
}

async function slurp(p: Proc): Promise<string> {
  let text = ""
  for await (const chunk of chunks(p)) text += chunk
  return text
}

/** The whole of a file operand, or of stdin for "-". */
export function readText(p: Proc, operand: string): Promise<string> {
  return operand === "-" ? slurp(p) : p.fs.read(operand, p.cwd, { signal: p.signal })
}

/** The lines of a file operand, or of stdin for "-" as they arrive. */
export async function* source(p: Proc, operand: string): AsyncGenerator<string> {
  if (operand !== "-") {
    yield* splitLines(await p.fs.read(operand, p.cwd, { signal: p.signal }))
    return
  }
  for await (const line of p.lines()) {
    if (halted(p)) return
    yield line
  }
}

/** File operands, or stdin when there are none. */
export function inputs(p: Proc, operands: readonly string[] = p.args): readonly string[] {
  return operands.length === 0 ? ["-"] : operands
}

/** Writes lines in batches and stops between batches when aborted. */
export async function emit(p: Proc, lines: readonly string[]): Promise<void> {
  for (let i = 0; i < lines.length && !halted(p); i += BATCH) {
    await p.out(lines.slice(i, i + BATCH).join("\n") + "\n")
  }
}

/** A validated line count from a number flag, or undefined when it is not a whole number >= 0. */
export function countFlag(p: Proc, name: string): number | undefined {
  const value = p.flags[name]
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined
}

/**
 * head and tail's line count and files: -n N, or the older first operand -N
 * (`head -5`), which other shells still take.
 */
export function lineCount(p: Proc): { count: number | undefined; operands: readonly string[] } {
  const short = /^-(\d+)$/.exec(p.args[0] ?? "")
  if (short) return { count: Number(short[1]), operands: inputs(p, p.args.slice(1)) }
  return { count: countFlag(p, "lines"), operands: inputs(p) }
}

// ---------------------------------------------------------------- text

/** Order by code point, the order the language uses for glob results. */
export function byCodePoint(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a.codePointAt(i) ?? 0
    const y = b.codePointAt(i) ?? 0
    // Equal code points: the next unit is past it, or the same low surrogate in both.
    if (x !== y) return x - y
  }
  return a.length - b.length
}

/** Width in code points. The terminal's width table is not reachable from a command. */
export function width(text: string): number {
  return Array.from(text).length
}

export function padEnd(text: string, to: number): string {
  return text + " ".repeat(Math.max(0, to - width(text)))
}

export function widest(items: readonly string[]): number {
  return items.reduce((max, item) => Math.max(max, width(item)), 0)
}

/** Lays items out down the columns, as ls does, within `cols` cells. */
export function columns(items: readonly string[], cols: number): string[] {
  if (items.length === 0) return []
  const cell = widest(items) + 2
  const across = Math.max(1, Math.floor((cols + 2) / cell))
  const down = Math.ceil(items.length / across)
  const lines: string[] = []
  for (let row = 0; row < down; row++) {
    let line = ""
    for (let i = row; i < items.length; i += down) {
      const item = items[i] ?? ""
      line += i + down < items.length ? padEnd(item, cell) : item
    }
    lines.push(line)
  }
  return lines
}

/** Two columns: a name and its description, indented. */
export function table(rows: ReadonlyArray<readonly [string, string]>, indent: string): string[] {
  const left = widest(rows.map(([name]) => name))
  return rows.map(([name, text]) => (text === "" ? indent + name : `${indent}${padEnd(name, left)}  ${text}`))
}

const two = (n: number): string => String(n).padStart(2, "0")

/** Local date and time as `YYYY-MM-DD HH:MM`. */
export function stamp(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
}

/** Local date and time with seconds and the UTC offset: `YYYY-MM-DD HH:MM:SS +HHMM`. */
export function stampLong(ms: number): string {
  const d = new Date(ms)
  const offset = -d.getTimezoneOffset()
  const abs = Math.abs(offset)
  return `${stamp(ms)}:${two(d.getSeconds())} ${offset < 0 ? "-" : "+"}${two(Math.floor(abs / 60))}${two(abs % 60)}`
}

/** root for 0, the session's user for its uid, the number otherwise. */
export function userName(p: Proc, uid: number): string {
  if (uid === ROOT_UID) return "root"
  return uid === p.sys.session.uid ? p.sys.session.user : String(uid)
}

export function withNewline(text: string): string {
  return text === "" || text.endsWith("\n") ? text : text + "\n"
}
