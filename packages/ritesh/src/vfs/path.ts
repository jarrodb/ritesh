/**
 * The one place paths are normalized: joins a relative path to `cwd`, drops
 * empty and "." components, and resolves ".." lexically (never past the root).
 */
export function splitPath(path: string, cwd: string): string[] {
  const parts: string[] = []
  for (const part of (path.startsWith("/") ? path : `${cwd}/${path}`).split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") parts.pop()
    else parts.push(part)
  }
  return parts
}

export function joinPath(parts: readonly string[]): string {
  return "/" + parts.join("/")
}

export function normalize(path: string, cwd: string): string {
  return joinPath(splitPath(path, cwd))
}

/** Order by code point, the order the language uses for glob results. */
export function compareCodePoints(a: string, b: string): number {
  let i = 0
  while (i < a.length && i < b.length) {
    const x = a.codePointAt(i) ?? 0
    const y = b.codePointAt(i) ?? 0
    if (x !== y) return x - y
    // Equal code points: the next unit is past it, or the same low surrogate in both.
    i++
  }
  return a.length - b.length
}
