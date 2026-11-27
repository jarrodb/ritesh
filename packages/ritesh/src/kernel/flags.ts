// Flags, operands, and subcommands from a command's definition, with the
// --help text and usage errors that come from the same definition.
import type { CommandDef, CommandInfo, FlagDef, Flags, FlagValue } from "../contracts.js"

export type CommandNode = Omit<CommandDef, "name">

export interface Parsed {
  flags: Flags
  args: readonly string[]
  subcommand: readonly string[]
}

export type Outcome =
  | ({ kind: "run"; node: CommandNode } & Parsed)
  | { kind: "help"; text: string }
  | { kind: "usage"; message: string; usage: string }

interface Spec {
  /** The key in Proc.flags: the long name when there is one, else the short. */
  key: string
  long: string | undefined
  short: string | undefined
  def: FlagDef
}

/** A definition's key stands for the long name, or for the short one when it is a single character. */
function specsOf(flags: Record<string, FlagDef> | undefined): Spec[] {
  return Object.entries(flags ?? {}).map(([name, def]) => {
    const long = def.long ?? (name.length > 1 ? name : undefined)
    const short = def.short ?? (name.length === 1 ? name : undefined)
    return { key: long ?? short ?? name, long, short, def }
  })
}

function table(rows: ReadonlyArray<readonly [string, string]>): string[] {
  const width = Math.max(...rows.map(([left]) => left.length))
  return rows.map(([left, right]) => `  ${left.padEnd(width)}  ${right}`.trimEnd())
}

interface HelpNode {
  summary: string
  usage: string
  subcommands?: Record<string, { summary: string }>
}

function helpText(node: HelpNode, specs: readonly Spec[]): string {
  const lines = [`usage: ${node.usage}`]
  if (node.summary !== "") lines.push("", node.summary)
  const rows = specs.map(({ long, short, def }): [string, string] => {
    const names = `${short === undefined ? "  " : `-${short}`}${long === undefined ? "" : `${short === undefined ? "  " : ", "}--${long}`}`
    const fallback = def.default === undefined ? "" : `(default: ${String(def.default)})`
    return [
      def.type === "boolean" ? names : `${names} <${def.type}>`,
      [def.description, fallback].filter(Boolean).join(" "),
    ]
  })
  if (!specs.some((spec) => spec.long === "help")) rows.push(["    --help", "show this help"])
  lines.push("", "options:", ...table(rows))
  const subcommands = Object.entries(node.subcommands ?? {})
  if (subcommands.length > 0) {
    lines.push("", "commands:", ...table(subcommands.map(([name, sub]) => [name, sub.summary])))
  }
  return lines.join("\n") + "\n"
}

/**
 * Splits argv by the definition. A command that declares no `flags`, at any
 * level reached, gets its arguments untouched: no option is read, `--help`
 * included. With flags: short and long names, `--name=value`, combined
 * shorts, a value attached or in the next argument, `--` to end options,
 * and `-` or a negative number as an operand.
 */
export function parseArgv(def: CommandDef, argv: readonly string[]): Outcome {
  let node: CommandNode = def
  let specs = def.flags === undefined ? undefined : specsOf(def.flags)
  const subcommand: string[] = []
  const args: string[] = []
  const seen = new Map<string, FlagValue>()
  let operandsOnly = false
  let at = 1

  const usage = (message: string): Outcome => ({ kind: "usage", message, usage: node.usage })

  /** Records one option. `text` is its argument, when the option takes one and one was given. */
  const store = (spec: Spec, text: string | undefined, shown: string): Outcome | undefined => {
    const { type, repeat } = spec.def
    let value: string | number
    if (type === "boolean") {
      const count = seen.get(spec.key)
      seen.set(spec.key, repeat === true ? (typeof count === "number" ? count : 0) + 1 : true)
      return undefined
    } else if (text === undefined) {
      return usage(`option requires an argument: ${shown}`)
    } else if (type === "string") {
      value = text
    } else {
      value = Number(text)
      if (text.trim() === "" || !Number.isFinite(value)) return usage(`invalid number for ${shown}: ${text}`)
    }
    const prior = seen.get(spec.key)
    seen.set(spec.key, repeat === true ? [...(Array.isArray(prior) ? prior : []), value] : value)
    return undefined
  }

  const long = (token: string, flags: readonly Spec[]): Outcome | undefined => {
    const equals = token.indexOf("=")
    const name = equals < 0 ? token.slice(2) : token.slice(2, equals)
    const spec = flags.find((s) => s.long === name)
    if (spec === undefined) {
      return name === "help" && equals < 0
        ? { kind: "help", text: helpText(node, flags) }
        : usage(`unknown option: --${name}`)
    }
    if (spec.def.type === "boolean") {
      return equals < 0 ? store(spec, undefined, token) : usage(`option takes no argument: --${name}`)
    }
    return store(spec, equals < 0 ? argv[++at] : token.slice(equals + 1), `--${name}`)
  }

  const shorts = (token: string, flags: readonly Spec[]): Outcome | undefined => {
    for (let i = 1; i < token.length; i++) {
      const letter = token.charAt(i)
      const spec = flags.find((s) => s.short === letter)
      if (spec === undefined) return usage(`unknown option: -${letter}`)
      if (spec.def.type !== "boolean") {
        // The rest of the token is the argument, or the next argument is.
        return store(spec, i + 1 < token.length ? token.slice(i + 1) : argv[++at], `-${letter}`)
      }
      store(spec, undefined, `-${letter}`)
    }
    return undefined
  }

  for (; at < argv.length; at++) {
    const token = argv[at] ?? ""
    if (specs !== undefined && !operandsOnly && token.startsWith("-") && token !== "-") {
      const negative = /^-\d/.test(token) && !specs.some((s) => s.short === token.charAt(1))
      if (token === "--") {
        operandsOnly = true
        continue
      }
      if (!negative) {
        const stop = token.startsWith("--") ? long(token, specs) : shorts(token, specs)
        if (stop !== undefined) return stop
        continue
      }
    }
    const sub = args.length === 0 && !operandsOnly && node.subcommands !== undefined && Object.hasOwn(node.subcommands, token)
      ? node.subcommands[token]
      : undefined
    if (sub === undefined) {
      args.push(token)
      continue
    }
    node = sub
    subcommand.push(token)
    // A subcommand adds its flags to those above it, and wins a name both declare.
    if (sub.flags !== undefined) specs = [...specsOf(sub.flags), ...(specs ?? [])]
  }

  const flags: Flags = {}
  for (const spec of [...(specs ?? [])].reverse()) {
    const value = seen.get(spec.key) ?? spec.def.default
    if (value !== undefined) flags[spec.key] = value
    else if (spec.def.type === "boolean") flags[spec.key] = spec.def.repeat === true ? 0 : false
    else if (spec.def.repeat === true) flags[spec.key] = []
  }
  return { kind: "run", node, flags, args, subcommand }
}

/** The usage error for a node that has nothing to run: it wanted a subcommand. */
export function nothingToRun(node: CommandNode, args: readonly string[]): Exclude<Outcome, { kind: "run" }> {
  const [first] = args
  const message = node.subcommands === undefined
    ? "nothing to run"
    : first === undefined ? "missing command" : `unknown command: ${first}`
  return { kind: "usage", message, usage: node.usage }
}

/**
 * Help for a command known only by its descriptor (a remote one), when argv
 * asks for it. Its flags are the server's to parse, so only `--help` is read.
 */
export function infoHelp(info: CommandInfo, argv: readonly string[]): string | undefined {
  const end = argv.indexOf("--")
  const head = end < 0 ? argv.slice(1) : argv.slice(1, end)
  if (!head.includes("--help")) return undefined
  const name = head.find((arg) => !arg.startsWith("-"))
  const sub = name !== undefined && info.subcommands !== undefined && Object.hasOwn(info.subcommands, name)
    ? info.subcommands[name]
    : undefined
  return sub === undefined ? helpText(info, specsOf(info.flags)) : helpText(sub, [])
}

/** The option names a definition accepts, as typed: for completion. */
export function flagNames(flags: Record<string, FlagDef> | undefined): Array<{ name: string; description: string | undefined }> {
  const names = specsOf(flags).map(({ long, short, def }) => ({
    name: long === undefined ? `-${short ?? ""}` : `--${long}`,
    description: def.description,
  }))
  return [...names, { name: "--help", description: "show this help" }]
}
