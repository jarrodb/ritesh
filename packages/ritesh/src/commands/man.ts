import { EXIT, type FlagDef, RiteError } from "../contracts.js"
import { defineCommand } from "../define.js"
import { body, table, usageError, withNewline } from "./util.js"

const USAGE = "man name..."
const PAGES = "/usr/share/man"
const INDENT = "    "

/** What a manual is rendered from. A CommandDef and a CommandInfo both fit. */
export interface ManualSource {
  name: string
  summary: string
  usage: string
  flags?: Record<string, FlagDef>
  subcommands?: Record<string, { summary: string; usage: string }>
  manual?: string
}

function flagLabel(key: string, def: FlagDef): string {
  const long = def.long ?? (def.short === undefined && key.length > 1 ? key : undefined)
  const short = def.short ?? (long === undefined ? key : undefined)
  const names = [short === undefined ? "" : `-${short}`, long === undefined ? "" : `--${long}`].filter((n) => n !== "")
  return names.join(", ") + (def.type === "boolean" ? "" : ` <${def.type}>`) + (def.repeat ? "..." : "")
}

function flagText(def: FlagDef): string {
  const fallback = def.default === undefined || def.default === false ? "" : `(default ${String(def.default)})`
  return [def.description ?? "", fallback].filter((part) => part !== "").join(" ")
}

function indented(text: string): string[] {
  return text.split("\n").map((line) => (line === "" ? "" : INDENT + line))
}

/** The manual page for a command definition, ending in a newline. */
export function renderManual(def: ManualSource): string {
  const lines = [
    "NAME", `${INDENT}${def.name} - ${def.summary}`, "",
    "SYNOPSIS", ...indented(def.usage), "",
    "DESCRIPTION", ...indented((def.manual ?? def.summary).replace(/\n+$/, "")),
  ]
  const flags = Object.entries(def.flags ?? {})
  if (flags.length > 0) {
    lines.push("", "OPTIONS", ...table(flags.map(([key, flag]) => [flagLabel(key, flag), flagText(flag)] as const), INDENT))
  }
  const subs = Object.entries(def.subcommands ?? {})
  if (subs.length > 0) {
    lines.push("", "SUBCOMMANDS", ...table(subs.map(([name, sub]) => [name, sub.summary] as const), INDENT))
  }
  return lines.join("\n") + "\n"
}

/** Errnos that mean there is no page, as opposed to a page that failed to load. */
const NO_PAGE = new Set(["ENOENT", "ENOTDIR", "EISDIR", "EINVAL"])

export const man = defineCommand({
  name: "man",
  summary: "show a command's manual",
  usage: USAGE,
  flags: {},
  manual: [
    "Renders the definition of a command or builtin: its name, synopsis, description,",
    "options, and subcommands. A name that is not a command is looked up as a page",
    `under ${PAGES}.`,
  ].join("\n"),
  run: body("man", async (p) => {
    if (p.args.length === 0) return usageError(p, "man", USAGE, "missing name")
    let status: number = EXIT.OK
    for (const [i, name] of p.args.entries()) {
      const found = p.sys.resolve(name)
      let page: string | undefined
      if (found.kind === "builtin" || found.kind === "command") {
        page = renderManual(found.info)
      } else if (name !== "" && !name.includes("/")) {
        try {
          page = withNewline(await p.fs.read(`${PAGES}/${name}`, "/", { signal: p.signal }))
        } catch (e) {
          if (!(e instanceof RiteError) || !NO_PAGE.has(e.errno)) throw e
        }
      }
      if (page === undefined) {
        await p.err(`man: no manual entry for ${name}\n`)
        status = EXIT.FAILURE
        continue
      }
      await p.out((i > 0 ? "\n" : "") + page)
    }
    return status
  }),
})
