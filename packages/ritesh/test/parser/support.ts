import type {
  List, ParseOptions, ParseResult, Pipeline, SimpleCommand, SyntaxErrorInfo, Word, WordPart,
} from "../../src/contracts.js"
import { createParser } from "../../src/parser/index.js"

export const VERSION = "0.1.0"
export const parser = createParser(VERSION)

export function outcome(result: ParseResult): "ok" | "incomplete" | "syntax" {
  if (result.ok) return "ok"
  return result.incomplete ? "incomplete" : "syntax"
}

export function parseOk(line: string, options?: ParseOptions): List {
  const result = parser.parse(line, options)
  if (!result.ok || result.ast === null) throw new Error(`${JSON.stringify(line)} parsed as ${outcome(result)}`)
  return result.ast
}

export function parseError(line: string, options?: ParseOptions): SyntaxErrorInfo {
  const result = parser.parse(line, options)
  if (result.ok || result.incomplete) throw new Error(`${JSON.stringify(line)} parsed as ${outcome(result)}`)
  return result.error
}

export function commandsOf(list: List): SimpleCommand[] {
  return [list.first, ...list.rest.map((r) => r.pipeline)].flatMap((p) => p.commands)
}

/** The only command of a one-command line. */
export function onlyCommand(line: string, options?: ParseOptions): SimpleCommand {
  const commands = commandsOf(parseOk(line, options))
  const [first] = commands
  if (first === undefined || commands.length !== 1) {
    throw new Error(`${JSON.stringify(line)} has ${commands.length} commands`)
  }
  return first
}

export const lit = (text: string): WordPart => ({ kind: "literal", text, quoted: false })
export const quo = (text: string): WordPart => ({ kind: "literal", text, quoted: true })
export const par = (name: string, quoted = false): WordPart => ({ kind: "param", name, quoted })
export const glob = (text: string): WordPart => ({ kind: "glob", text })
export const tilde: WordPart = { kind: "tilde", text: "~" }

/** A word as text, enough to compare shapes: parameters as $NAME, every other part as its text. */
export function wordText(word: Word): string {
  return word.parts.map((p) => (p.kind === "param" ? `$${p.name}` : p.text)).join("")
}

export function commandText(command: SimpleCommand): string {
  return [
    ...command.assignments.map((a) => `${a.name}=${wordText(a.value)}`),
    ...command.words.map(wordText),
    ...command.redirects.map((r) => (r.target ? `${r.op}${wordText(r.target)}` : r.op)),
  ].join(" ")
}

/** The list as text with every pipeline bracketed, in the order the contract stores it. */
export function listText(list: List): string {
  const pipe = (p: Pipeline): string => `[${p.commands.map(commandText).join(" | ")}]`
  return [pipe(list.first), ...list.rest.map((r) => `${r.op} ${pipe(r.pipeline)}`)].join(" ")
}
