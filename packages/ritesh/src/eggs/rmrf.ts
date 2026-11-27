import { type Entry, EXIT } from "../contracts.js"
import { defineEgg } from "../define.js"

/** Entries shown from each top-level directory. */
const PER_DIR = 6

/** Lexical: "." and empty components drop, ".." pops and stops at the root. */
function normalize(path: string, cwd: string): string {
  const parts: string[] = []
  for (const part of (path.startsWith("/") ? path : `${cwd}/${path}`).split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") parts.pop()
    else parts.push(part)
  }
  return "/" + parts.join("/")
}

/**
 * True for `rm` with the recursive and the force flag, in any spelling, and
 * an operand that normalizes to "/". Other options are ignored, as rm would
 * read them, and nothing after `--` is an option.
 */
export function wipesRoot(argv: readonly string[], cwd: string): boolean {
  let recursive = false
  let force = false
  let root = false
  let options = true
  for (const word of argv.slice(1)) {
    if (options && word === "--") options = false
    else if (options && word.startsWith("--")) {
      if (word === "--recursive") recursive = true
      else if (word === "--force") force = true
    } else if (options && word.length > 1 && word.startsWith("-")) {
      for (const letter of word.slice(1)) {
        if (letter === "r" || letter === "R") recursive = true
        else if (letter === "f") force = true
      }
    } else if (word !== "" && normalize(word, cwd) === "/") root = true
  }
  return recursive && force && root
}

/** `rm -rf /`: a deletion that is not happening, then the admission. */
export const rmrf = defineEgg({
  id: "rmrf",
  trigger: { command: "rm", when: (argv, session) => wipesRoot(argv, session.cwd) },
  run: async (p) => {
    const list = (path: string): Promise<Entry[]> =>
      p.fs.list(path, "/", { signal: p.signal }).catch((): Entry[] => [])
    try {
      // Plain lines through stdout: the names may come from a mount, so they are never raw.
      for (const entry of await list("/")) {
        if (p.signal.aborted) return EXIT.INTERRUPTED
        const path = `/${entry.name}`
        if (entry.type !== "dir") {
          await p.out(`removed ${path}\n`)
          continue
        }
        for (const child of (await list(path)).slice(0, PER_DIR)) await p.out(`removed ${path}/${child.name}\n`)
        await p.out(`removed directory ${path}\n`)
      }
      await p.out("just kidding. nothing here is yours to delete.\n")
      return EXIT.OK
    } catch (e) {
      if (p.signal.aborted) return EXIT.INTERRUPTED
      throw e
    }
  },
})
