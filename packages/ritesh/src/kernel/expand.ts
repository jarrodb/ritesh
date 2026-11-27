// Word expansion (docs/language.md): tilde, parameter, glob, quote removal.
// Aliases are the parser's. There is no field splitting: a word becomes one
// word, or several only through a glob, or none when it expands to nothing
// and no part of it was quoted.
import type { Entry, Word } from "../contracts.js"
import { compareCodePoints } from "../vfs/path.js"
import { ShellError } from "./errors.js"

export interface Scope {
  /** A variable, or `?`. */
  get(name: string): string | undefined
  home(): string
  /** A directory's entries, or undefined when it cannot be listed. */
  list(dir: string): Promise<Entry[] | undefined>
  exists(path: string): Promise<boolean>
}

type Atom = { kind: "text"; text: string } | { kind: "glob"; text: string }

interface Expanded {
  atoms: Atom[]
  quoted: boolean
  globbed: boolean
}

function atomsOf(word: Word, scope: Pick<Scope, "get" | "home">): Expanded {
  const atoms: Atom[] = []
  let quoted = false
  let globbed = false
  for (const part of word.parts) {
    switch (part.kind) {
      case "literal":
        atoms.push({ kind: "text", text: part.text })
        quoted ||= part.quoted
        break
      case "param":
        atoms.push({ kind: "text", text: scope.get(part.name) ?? "" })
        quoted ||= part.quoted
        break
      case "tilde":
        atoms.push({ kind: "text", text: scope.home() })
        break
      case "glob":
        atoms.push(part)
        globbed = true
        break
    }
  }
  return { atoms, quoted, globbed }
}

const textOf = (atoms: readonly Atom[]): string => atoms.map((atom) => atom.text).join("")

/** A word as one string, glob characters literal: assignment values, and words being completed. */
export function expandText(word: Word, scope: Pick<Scope, "get" | "home">): string {
  return textOf(atomsOf(word, scope).atoms)
}

export async function expandWord(word: Word, scope: Scope): Promise<string[]> {
  const { atoms, quoted, globbed } = atomsOf(word, scope)
  if (!globbed) {
    const value = textOf(atoms)
    return value === "" && !quoted ? [] : [value]
  }
  const matches = await glob(atoms, scope)
  if (matches.length === 0) throw new ShellError(`no matches found: ${textOf(atoms)}`)
  return matches
}

/** One path segment as a pattern, or undefined when a class is not one RegExp accepts. */
function matcher(segment: readonly Atom[]): ((name: string) => boolean) | undefined {
  const source = segment.map((atom) => {
    if (atom.kind === "text") return atom.text.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&")
    if (atom.text === "*") return "[^/]*"
    const negated = atom.text.startsWith("[!")
    const body = atom.text.slice(negated ? 2 : 1, -1).replace(/[\\^\]]/g, "\\$&")
    return `[${negated ? "^" : ""}${body}]`
  }).join("")
  // `*` does not match a leading dot: a dotfile needs the dot spelled out.
  const first = segment[0]
  const dotfiles = first?.kind === "text" && first.text.startsWith(".")
  try {
    const pattern = new RegExp(`^${source}$`, "u")
    return (name) => (dotfiles || !name.startsWith(".")) && pattern.test(name)
  } catch {
    return undefined
  }
}

async function glob(atoms: readonly Atom[], scope: Scope): Promise<string[]> {
  // Split on the `/` of text atoms. A leading empty segment is the root.
  const segments: Atom[][] = [[]]
  for (const atom of atoms) {
    if (atom.kind === "glob") {
      segments.at(-1)?.push(atom)
      continue
    }
    for (const [i, piece] of atom.text.split("/").entries()) {
      if (i > 0) segments.push([])
      if (piece !== "") segments.at(-1)?.push({ kind: "text", text: piece })
    }
  }
  // Paths stay as typed: relative ones relative, doubled slashes doubled.
  let paths = [""]
  for (const [i, segment] of segments.entries()) {
    const last = i === segments.length - 1
    const join = (path: string, name: string): string => (i === 0 ? name : `${path}/${name}`)
    if (!segment.some((atom) => atom.kind === "glob")) {
      const name = textOf(segment)
      paths = paths.map((path) => join(path, name))
      continue
    }
    const matches = matcher(segment)
    if (matches === undefined) return []
    const next: string[] = []
    for (const path of paths) {
      const entries = await scope.list(i === 0 ? "." : path === "" ? "/" : path) ?? []
      for (const entry of entries) {
        if (!matches(entry.name)) continue
        if (last || entry.type === "dir" || entry.type === "link") next.push(join(path, entry.name))
      }
    }
    paths = next
  }
  // A literal tail after a glob (`*/notes`) names something that may not be there.
  if (segments.at(-1)?.some((atom) => atom.kind === "glob") !== true) {
    const present = await Promise.all(paths.map((path) => scope.exists(path)))
    paths = paths.filter((_, i) => present[i] === true)
  }
  return paths.sort(compareCodePoints)
}
