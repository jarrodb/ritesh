import {
  type ActionResult, type ActionVia, type CallOptions, type Entry, type Errno, type Inode,
  type InodeSpec, type InodeType, type MountProvider, RiteError, type Stat, type Vfs, type WriteOptions,
} from "../contracts.js"
import { checkAction, runAction } from "./action.js"
import { Mount } from "./mount.js"
import { compareCodePoints, joinPath, normalize, splitPath } from "./path.js"
import {
  byteLength, type DirNode, type FileNode, fromSpec, inodeOf, newDir, newFile, type Node, ownerIn,
  permits, ROOT_UID, statOf,
} from "./tree.js"

export interface VfsOptions {
  /** Milliseconds since the epoch. Stamps mtimes and ages the mount cache. */
  now?: () => number
  /** Largest file `write` accepts, in UTF-8 bytes. Default 1 MiB. */
  maxFileBytes?: number
  /** Largest total `write` may hold, in UTF-8 bytes. Default 8 MiB. */
  maxTotalBytes?: number
  /** Opens a URL for an `open` action. False means the browser refused, and the URL is printed instead. */
  open?: (url: string) => boolean
}

const MAX_LINK_DEPTH = 16
const MIB = 1024 * 1024

type Located =
  | { kind: "node"; node: Node; parent: DirNode | undefined; name: string; path: string }
  | { kind: "missing"; parent: DirNode; name: string; path: string }
  | { kind: "mount"; mount: Mount; rel: string }

export function createVfs(options: VfsOptions = {}): Vfs {
  const now = options.now ?? (() => Date.now())
  const maxFileBytes = options.maxFileBytes ?? MIB
  const maxTotalBytes = options.maxTotalBytes ?? 8 * MIB
  const open = options.open ?? (() => false)

  const root = newDir(ROOT_UID, now())
  const mounts = new Map<string, Mount>()
  let used = 0

  /**
   * Walks the local tree to `path`, following links in every component but
   * the last, and in the last when `follow` is set. Stops at a mount point.
   * With `uid`, entering a directory needs `x` and a refusal is EACCES.
   * Errors carry `path` as the caller gave it.
   */
  const locate = (path: string, cwd: string, follow: boolean, uid?: number): Located => {
    let parts = splitPath(path, cwd)
    let hops = 0
    restart: for (;;) {
      let dir = root
      const at: string[] = []
      for (const [i, name] of parts.entries()) {
        if (uid !== undefined && !permits(dir.mode, dir.uid, uid, "x")) throw new RiteError("EACCES", path)
        const here = joinPath([...at, name])
        const mount = mounts.get(here)
        if (mount) return { kind: "mount", mount, rel: parts.slice(i + 1).join("/") }
        const child = dir.children.get(name)
        const last = i === parts.length - 1
        if (!child) {
          if (last) return { kind: "missing", parent: dir, name, path: here }
          throw new RiteError("ENOENT", path)
        }
        if (child.type === "link" && (follow || !last)) {
          if (++hops > MAX_LINK_DEPTH) throw new RiteError("ELOOP", path)
          parts = [...splitPath(child.target, joinPath(at)), ...parts.slice(i + 1)]
          continue restart
        }
        if (last) return { kind: "node", node: child, parent: dir, name, path: here }
        if (child.type !== "dir") throw new RiteError("ENOTDIR", path)
        dir = child
        at.push(name)
      }
      return { kind: "node", node: root, parent: undefined, name: "", path: "/" }
    }
  }

  /** What a provider is handed: the signal and nothing else. */
  const only = (o: CallOptions | undefined): CallOptions => (o?.signal ? { signal: o.signal } : {})

  const begin = (path: string, o: CallOptions | undefined): void => {
    if (path === "") throw new RiteError("ENOENT", path)
    if (o?.signal?.aborted) throw new RiteError("ECANCELED", path)
  }

  const hasMountUnder = (path: string): boolean => {
    const prefix = path === "/" ? "/" : `${path}/`
    for (const at of mounts.keys()) {
      if (at.startsWith(prefix)) return true
    }
    return false
  }

  const release = (node: Node): void => {
    if (node.type === "file") used -= node.charged
    else if (node.type === "dir") node.children.forEach(release)
  }

  const attach = (parent: DirNode, name: string, node: Node): void => {
    parent.children.set(name, node)
    parent.mtime = now()
  }

  /** Sets a file's content, or refuses with ENOSPC and leaves the file as it was. */
  const store = (file: FileNode, content: string, path: string): void => {
    const size = byteLength(content)
    if (size > maxFileBytes || used - file.charged + size > maxTotalBytes) throw new RiteError("ENOSPC", path)
    used += size - file.charged
    file.content = content
    file.size = size
    file.charged = size
    file.mtime = now()
  }

  /**
   * Creates the missing directories along `parts`. Returns the mount the
   * walk ran into, with the rest of the path, for the caller to handle.
   * `leaf` is the errno when the last component exists and is not a directory.
   */
  const makeDirs = (parts: readonly string[], path: string, leaf: Errno): { mount: Mount; rel: string } | undefined => {
    for (let i = 1; i <= parts.length; i++) {
      let loc: Located
      try {
        loc = locate(joinPath(parts.slice(0, i)), "/", true)
      } catch (e) {
        throw e instanceof RiteError ? new RiteError(e.errno, path) : e
      }
      if (loc.kind === "mount") {
        return { mount: loc.mount, rel: [...(loc.rel === "" ? [] : [loc.rel]), ...parts.slice(i)].join("/") }
      }
      if (loc.kind === "missing") attach(loc.parent, loc.name, newDir(ownerIn(loc.parent), now()))
      else if (loc.node.type !== "dir") throw new RiteError(i === parts.length ? leaf : "ENOTDIR", path)
    }
    return undefined
  }

  /** The mount-table key for a path: the real path of its parent, plus its name. */
  const mountKey = (parts: readonly string[], path: string): string => {
    const name = parts.at(-1)
    if (name === undefined) throw new RiteError("EINVAL", path, "cannot mount on /")
    const parent = locate(joinPath(parts.slice(0, -1)), "/", true)
    if (parent.kind === "mount") throw new RiteError("ENOTSUP", path, "mounts do not nest")
    if (parent.kind === "missing") throw new RiteError("ENOENT", path)
    if (parent.node.type !== "dir") throw new RiteError("ENOTDIR", path)
    return normalize(name, parent.path)
  }

  const stat = async (path: string, cwd: string, o?: CallOptions): Promise<Stat> => {
    begin(path, o)
    const loc = locate(path, cwd, true)
    if (loc.kind === "mount") return loc.mount.stat(loc.rel, path, only(o))
    if (loc.kind === "missing") throw new RiteError("ENOENT", path)
    return statOf(loc.node)
  }

  const list = async (path: string, cwd: string, o?: CallOptions): Promise<Entry[]> => {
    begin(path, o)
    const loc = locate(path, cwd, true)
    if (loc.kind === "mount") return loc.mount.list(loc.rel, path, only(o))
    if (loc.kind === "missing") throw new RiteError("ENOENT", path)
    if (loc.node.type !== "dir") throw new RiteError("ENOTDIR", path)
    const types = new Map<string, InodeType>()
    for (const [name, child] of loc.node.children) types.set(name, child.type)
    // Mounts are table entries, not inodes: each shows in its parent as a directory.
    const prefix = loc.path === "/" ? "/" : `${loc.path}/`
    for (const at of mounts.keys()) {
      if (at.startsWith(prefix) && !at.includes("/", prefix.length)) types.set(at.slice(prefix.length), "dir")
    }
    return [...types]
      .map(([name, type]) => ({ name, type }))
      .sort((a, b) => compareCodePoints(a.name, b.name))
  }

  const read = async (path: string, cwd: string, o?: CallOptions): Promise<string> => {
    begin(path, o)
    const loc = locate(path, cwd, true)
    if (loc.kind === "mount") return loc.mount.read(loc.rel, path, only(o))
    if (loc.kind === "missing") throw new RiteError("ENOENT", path)
    const { node } = loc
    switch (node.type) {
      case "dir":
        throw new RiteError("EISDIR", path)
      case "file":
        return typeof node.content === "string" ? node.content : await produce(node.content, path)
      case "dev":
        return node.read?.() ?? ""
      default:
        // cmd and action inodes hold no data to read.
        throw new RiteError("EINVAL", path)
    }
  }

  const write = async (path: string, cwd: string, data: string, o: WriteOptions): Promise<void> => {
    begin(path, o)
    const loc = locate(path, cwd, true)
    if (loc.kind === "mount") {
      await loc.mount.write(loc.rel, path, data, o)
      return
    }
    if (loc.kind === "missing") {
      const file = newFile(ownerIn(loc.parent), now())
      store(file, data, path)
      attach(loc.parent, loc.name, file)
      return
    }
    const { node } = loc
    switch (node.type) {
      case "dir":
        throw new RiteError("EISDIR", path)
      case "file": {
        let prior = ""
        if (o.mode === "append") prior = typeof node.content === "string" ? node.content : await produce(node.content, path)
        store(node, prior + data, path)
        return
      }
      case "dev":
        node.write?.(data)
        return
      default:
        throw new RiteError("EINVAL", path)
    }
  }

  const mkdir = async (path: string, cwd: string, o?: CallOptions & { parents?: boolean }): Promise<void> => {
    begin(path, o)
    if (o?.parents) {
      const hit = makeDirs(splitPath(path, cwd), path, "EEXIST")
      if (hit) await hit.mount.mkdir(hit.rel, path, only(o), true)
      return
    }
    const loc = locate(path, cwd, false)
    if (loc.kind === "mount") {
      await loc.mount.mkdir(loc.rel, path, only(o), false)
      return
    }
    if (loc.kind === "node") throw new RiteError("EEXIST", path)
    attach(loc.parent, loc.name, newDir(ownerIn(loc.parent), now()))
  }

  const remove = async (path: string, cwd: string, o?: CallOptions & { recursive?: boolean }): Promise<void> => {
    begin(path, o)
    const loc = locate(path, cwd, false)
    if (loc.kind === "mount") {
      await loc.mount.remove(loc.rel, path, only(o), o?.recursive === true)
      return
    }
    if (loc.kind === "missing") throw new RiteError("ENOENT", path)
    if (!loc.parent) throw new RiteError("EPERM", path, "cannot remove /")
    if (loc.node.type === "dir") {
      if (hasMountUnder(loc.path)) throw new RiteError("EPERM", path, "holds a mount point")
      if (loc.node.children.size > 0 && !o?.recursive) throw new RiteError("ENOTEMPTY", path)
    }
    release(loc.node)
    loc.parent.children.delete(loc.name)
    loc.parent.mtime = now()
  }

  const activate = (path: string, cwd: string, via: ActionVia): Promise<ActionResult | null> =>
    new Promise((resolve) => {
      let loc: Located
      try {
        loc = locate(path, cwd, true)
      } catch (e) {
        // Not an action as far as this call can tell; the caller's own stat or read reports the error.
        if (!(e instanceof RiteError)) throw e
        resolve(null)
        return
      }
      if (loc.kind !== "node" || loc.node.type !== "action") resolve(null)
      else resolve(runAction(loc.node.action, loc.path, via, open))
    })

  const peek = (path: string, cwd: string): Inode | undefined => {
    try {
      const loc = locate(path, cwd, true)
      if (loc.kind === "mount") return loc.mount.peek(loc.rel)
      return loc.kind === "node" ? inodeOf(loc.node) : undefined
    } catch {
      return undefined
    }
  }

  const put = (path: string, spec: InodeSpec): void => {
    if (spec.type === "action") checkAction(spec.action, path)
    const parts = splitPath(path, "/")
    if (makeDirs(parts.slice(0, -1), path, "ENOTDIR")) throw new RiteError("ENOTSUP", path, "is inside a mount")
    const loc = locate(joinPath(parts), "/", false)
    if (loc.kind === "mount") throw new RiteError("ENOTSUP", path, "is inside a mount")
    if (loc.kind === "node" && loc.node.type === "dir") {
      if (spec.type === "dir") {
        // A directory over a directory keeps its entries.
        loc.node.mode = (spec.mode ?? loc.node.mode) & 0o777
        loc.node.uid = spec.uid ?? loc.node.uid
        return
      }
      if (!loc.parent) throw new RiteError("EINVAL", path, "/ is a directory")
      if (hasMountUnder(loc.path)) throw new RiteError("EPERM", path, "holds a mount point")
    }
    // The root is a directory, so a located node here has a parent.
    if (!loc.parent) return
    if (loc.kind === "node") release(loc.node)
    attach(loc.parent, loc.name, fromSpec(spec, ownerIn(loc.parent), now()))
  }

  const mount = (path: string, provider: MountProvider): void => {
    const parts = splitPath(path, "/")
    if (makeDirs(parts.slice(0, -1), path, "ENOTDIR")) throw new RiteError("ENOTSUP", path, "mounts do not nest")
    const key = mountKey(parts, path)
    if (mounts.has(key)) throw new RiteError("EEXIST", path, "already mounted")
    if (hasMountUnder(key)) throw new RiteError("ENOTSUP", path, "mounts do not nest")
    mounts.set(key, new Mount(key, provider, now))
  }

  const unmount = (path: string): void => {
    const key = mountKey(splitPath(path, "/"), path)
    const mounted = mounts.get(key)
    if (!mounted) throw new RiteError("EINVAL", path, "not mounted")
    mounted.dispose()
    mounts.delete(key)
  }

  const access = async (path: string, cwd: string, uid: number, want: "r" | "w" | "x"): Promise<boolean> => {
    begin(path, undefined)
    try {
      const loc = locate(path, cwd, true, uid)
      if (loc.kind === "mount") return await loc.mount.access(loc.rel, path, uid, want)
      if (loc.kind === "missing") throw new RiteError("ENOENT", path)
      return permits(loc.node.mode, loc.node.uid, uid, want)
    } catch (e) {
      if (e instanceof RiteError && e.errno === "EACCES") return false
      throw e
    }
  }

  return {
    stat, list, read, write, mkdir, remove, activate, peek, put, mount, unmount, access,
    resolve: normalize,
  }
}

/** Runs a host content function. Whatever it throws leaves as a RiteError. */
async function produce(content: () => string | Promise<string>, path: string): Promise<string> {
  try {
    return await content()
  } catch (e) {
    if (e instanceof RiteError) throw e
    throw new RiteError("EIO", path, e instanceof Error ? e.message : undefined)
  }
}
