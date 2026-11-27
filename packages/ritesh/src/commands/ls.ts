import { type InodeType, type Proc, type Stat } from "../contracts.js"
import { defineCommand } from "../define.js"
import { body, byCodePoint, columns, each, emit, flag, halted, padEnd, stamp, userName, widest } from "./util.js"

const TYPE_CHAR: Record<InodeType, string> = { dir: "d", file: "-", cmd: "-", link: "l", action: "a", dev: "c" }
const SUFFIX: Partial<Record<InodeType, string>> = { dir: "/", cmd: "*", link: "@" }

interface Row {
  name: string
  /** The entry's own type: `link` for a link, whatever it points at. */
  type: InodeType
  /** Absent when the entry could not be read (a dangling link). */
  stat: Stat | undefined
}

function modeString(type: InodeType, mode: number): string {
  let text = TYPE_CHAR[type]
  for (const shift of [6, 3, 0]) {
    const bits = (mode >> shift) & 7
    text += (bits & 4 ? "r" : "-") + (bits & 2 ? "w" : "-") + (bits & 1 ? "x" : "-")
  }
  return text
}

function longLines(p: Proc, rows: readonly Row[], label: (row: Row) => string): string[] {
  const cells = rows.map((row) => {
    const { stat, type } = row
    if (!stat) return { mode: TYPE_CHAR[type] + "?????????", owner: "?", size: "?", time: "?", name: label(row) }
    return {
      mode: modeString(type === "link" ? type : stat.type, stat.mode),
      owner: userName(p, stat.uid),
      size: String(stat.size),
      time: stamp(stat.mtime),
      name: label(row),
    }
  })
  const owner = widest(cells.map((c) => c.owner))
  const size = widest(cells.map((c) => c.size))
  const time = widest(cells.map((c) => c.time))
  return cells.map((c) => `${c.mode} ${padEnd(c.owner, owner)} ${c.size.padStart(size)} ${padEnd(c.time, time)} ${c.name}`)
}

export const ls = defineCommand({
  name: "ls",
  summary: "list directory contents",
  usage: "ls [-la1F] [path...]",
  flags: {
    l: { short: "l", type: "boolean", description: "long format: mode, owner, size, modified, name" },
    all: { long: "all", short: "a", type: "boolean", description: "include names that start with a dot" },
    1: { short: "1", type: "boolean", description: "one name per line" },
    classify: { long: "classify", short: "F", type: "boolean", description: "mark directories /, commands *, links @" },
  },
  manual: [
    "Lists the working directory, or each path. Names sort by code point.",
    "On the terminal the names are laid out in columns; in a pipe or a file, one per line.",
    "In the long format the first character is the type: d directory, l link,",
    "a action, c device, - file or command.",
    "Listing never triggers an action; cd, open, and cat do.",
  ].join("\n"),
  run: body("ls", async (p) => {
    const long = flag(p, "l")
    const all = flag(p, "all")
    const classify = flag(p, "classify")
    const label = (row: Row): string => (classify ? row.name + (SUFFIX[row.type] ?? "") : row.name)
    const signal = { signal: p.signal }

    const print = async (rows: readonly Row[]): Promise<void> => {
      if (long) await emit(p, longLines(p, rows, label))
      else if (flag(p, "1") || !p.tty) await emit(p, rows.map(label))
      else await emit(p, columns(rows.map(label), p.tty.cols))
    }

    const operands = p.args.length === 0 ? ["."] : p.args
    const files: Row[] = []
    const dirs: string[] = []
    const missing = await each(p, "ls", operands, async (operand) => {
      const stat = await p.fs.stat(operand, p.cwd, signal)
      if (stat.type === "dir") dirs.push(operand)
      else files.push({ name: operand, type: stat.type, stat })
    })
    if (files.length > 0) await print(files)

    let first = files.length === 0
    const unreadable = await each(p, "ls", dirs, async (dir) => {
      const entries = (await p.fs.list(dir, p.cwd, signal))
        .filter((entry) => all || !entry.name.startsWith("."))
        .sort((a, b) => byCodePoint(a.name, b.name))
      const rows: Row[] = []
      for (const entry of entries) {
        let stat: Stat | undefined
        if (long) {
          if (halted(p)) return
          stat = await p.fs.stat(dir.endsWith("/") ? dir + entry.name : `${dir}/${entry.name}`, p.cwd, signal).catch(() => undefined)
        }
        rows.push({ name: entry.name, type: entry.type, stat })
      }
      if (!first) await p.out("\n")
      first = false
      if (operands.length > 1) await p.out(`${dir}:\n`)
      await print(rows)
    })
    return missing || unreadable
  }),
})
