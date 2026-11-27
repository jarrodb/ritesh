// Where a command name leads: a cmd inode on PATH, or a command source.
import {
  type CommandDef, type CommandInfo, type CommandSource, ERRNO_MESSAGES, type Vfs,
} from "../contracts.js"

export interface Registry {
  readonly vfs: Vfs
  /**
   * Definitions by the path they were registered at. The vfs hands back a
   * cmd inode's descriptor, not its definition, so the kernel keeps these.
   */
  readonly defs: Map<string, CommandDef>
  readonly sources: Array<{ at: string; source: CommandSource }>
}

export type Located =
  | { kind: "command"; path: string; info: CommandInfo; def: CommandDef | undefined }
  | { kind: "source"; path: string; name: string; info: CommandInfo; source: CommandSource }
  | { kind: "blocked"; message: string }
  | { kind: "none" }

export function sourceInfo(source: CommandSource, name: string): CommandInfo {
  return source.info(name) ?? { name, summary: "", usage: name, builtin: false, remote: true }
}

const offers = (source: CommandSource, name: string): boolean =>
  source.info(name) !== undefined || source.names().includes(name)

/** Synchronous: cmd inodes live in the local tree, which `peek` reads in full. */
export function locate(registry: Registry, name: string, path: string, cwd: string): Located {
  const { vfs, defs, sources } = registry
  const direct = name.includes("/")

  const local = (candidate: string): Located | undefined => {
    const inode = vfs.peek(candidate, cwd)
    if (inode === undefined) return undefined
    if (inode.type !== "cmd" || inode.command === undefined) {
      if (!direct) return undefined
      return { kind: "blocked", message: inode.type === "dir" ? ERRNO_MESSAGES.EISDIR : ERRNO_MESSAGES.EACCES }
    }
    const abs = vfs.resolve(candidate, cwd)
    const info = inode.command
    // A link to a command, or a cmd inode put there without `register`, is known by its name alone.
    const def = defs.get(abs) ?? [...defs.values()].find((d) => d.name === info.name)
    return { kind: "command", path: abs, info, def }
  }

  if (direct) {
    const found = local(name)
    if (found !== undefined) return found
    const abs = vfs.resolve(name, cwd)
    const base = abs.slice(abs.lastIndexOf("/") + 1)
    for (const { at, source } of sources) {
      if (abs === vfs.resolve(base, at) && offers(source, base)) {
        return { kind: "source", path: abs, name: base, info: sourceInfo(source, base), source }
      }
    }
    return { kind: "none" }
  }
  for (const dir of path.split(":")) {
    const found = local(`${dir === "" ? "." : dir}/${name}`)
    if (found !== undefined) return found
  }
  for (const { at, source } of sources) {
    if (offers(source, name)) {
      return { kind: "source", path: vfs.resolve(name, at), name, info: sourceInfo(source, name), source }
    }
  }
  return { kind: "none" }
}
