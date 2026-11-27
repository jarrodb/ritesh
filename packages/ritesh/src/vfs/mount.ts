import {
  type CallOptions, type Entry, type Errno, ERRNOS, type Inode, type MountProvider, RiteError,
  type Stat, type WriteOptions,
} from "../contracts.js"
import { compareCodePoints } from "./path.js"
import { permits, ROOT_UID, type Want } from "./tree.js"

/** How long a provider's stat and list answers are served from the cache. */
export const CACHE_MS = 30_000

/** Above this many entries a cache drops its expired ones on the next insert. */
const SWEEP_AT = 512

interface Cached<T> {
  value: T
  expires: number
}

function errnoOf(e: unknown): Errno | undefined {
  if (e instanceof RiteError) return e.errno
  // A provider built from another copy of the package throws a different RiteError class.
  if (typeof e !== "object" || e === null || !("errno" in e)) return undefined
  const { errno } = e
  return ERRNOS.find((known) => known === errno)
}

function parentOf(rel: string): string {
  const i = rel.lastIndexOf("/")
  return i < 0 ? "" : rel.slice(0, i)
}

function cleanRel(rel: string): string {
  return rel.split("/").filter((part) => part !== "" && part !== ".").join("/")
}

/**
 * One mount-table entry: the provider, and a cache of its stat and list
 * answers. Every method takes the caller's path for error reporting.
 */
export class Mount {
  readonly path: string
  private readonly provider: MountProvider
  private readonly now: () => number
  private readonly stats = new Map<string, Cached<Stat>>()
  private readonly lists = new Map<string, Cached<Entry[]>>()
  private readonly unwatch: (() => void) | undefined

  constructor(path: string, provider: MountProvider, now: () => number) {
    this.path = path
    this.provider = provider
    this.now = now
    this.unwatch = provider.watch?.((rel) => { this.invalidate(cleanRel(rel)) })
  }

  dispose(): void {
    this.unwatch?.()
    this.stats.clear()
    this.lists.clear()
  }

  async stat(rel: string, path: string, o: CallOptions): Promise<Stat> {
    const hit = this.fresh(this.stats, rel)
    if (hit) return { ...hit }
    const stat = { ...await this.call(path, o, () => this.provider.stat(rel, o)), mount: this.path }
    this.store(this.stats, rel, stat)
    return { ...stat }
  }

  async list(rel: string, path: string, o: CallOptions): Promise<Entry[]> {
    const hit = this.fresh(this.lists, rel)
    if (hit) return hit.map((entry) => ({ ...entry }))
    const entries = (await this.call(path, o, () => this.provider.list(rel, o)))
      .map((entry) => ({ name: entry.name, type: entry.type }))
      .sort((a, b) => compareCodePoints(a.name, b.name))
    this.store(this.lists, rel, entries)
    return entries.map((entry) => ({ ...entry }))
  }

  read(rel: string, path: string, o: CallOptions): Promise<string> {
    return this.call(path, o, () => this.provider.read(rel, o))
  }

  async write(rel: string, path: string, data: string, o: WriteOptions): Promise<void> {
    this.writable(path, "write")
    await this.call(path, o, async () => { await this.provider.write?.(rel, data, o) })
    this.invalidate(rel)
  }

  async mkdir(rel: string, path: string, o: CallOptions, parents: boolean): Promise<void> {
    if (rel === "") {
      if (parents) return
      throw new RiteError("EEXIST", path)
    }
    this.writable(path, "mkdir")
    const make = async (sub: string): Promise<void> => {
      await this.call(path, o, async () => { await this.provider.mkdir?.(sub, o) })
      this.invalidate(sub)
    }
    if (!parents) {
      await make(rel)
      return
    }
    const parts = rel.split("/")
    for (let i = 1; i <= parts.length; i++) {
      const sub = parts.slice(0, i).join("/")
      const existing = await this.statIfPresent(sub, path, o)
      if (!existing) await make(sub)
      else if (existing.type !== "dir") throw new RiteError(i === parts.length ? "EEXIST" : "ENOTDIR", path)
    }
  }

  /**
   * The provider's remove takes no recursive flag, so the rule is applied
   * here: a directory with entries is ENOTEMPTY unless `recursive`, and a
   * recursive remove deletes depth first. Reads bypass the cache.
   */
  async remove(rel: string, path: string, o: CallOptions, recursive: boolean): Promise<void> {
    if (rel === "") throw new RiteError("EPERM", path, "is a mount point")
    this.writable(path, "remove")
    const removeTree = async (sub: string, deep: boolean): Promise<void> => {
      if ((await this.provider.stat(sub, o)).type === "dir") {
        const entries = await this.provider.list(sub, o)
        if (entries.length > 0 && !deep) throw new RiteError("ENOTEMPTY", path)
        for (const entry of entries) await removeTree(`${sub}/${entry.name}`, true)
      }
      await this.provider.remove?.(sub, o)
    }
    try {
      await this.call(path, o, () => removeTree(rel, recursive))
    } finally {
      this.invalidateTree(rel)
    }
  }

  /** Needs `x` on every directory from the mount root down, then `want` on the target. */
  async access(rel: string, path: string, uid: number, want: Want): Promise<boolean> {
    if (uid !== ROOT_UID && rel !== "") {
      const parts = rel.split("/")
      for (let i = 0; i < parts.length; i++) {
        const dir = await this.stat(parts.slice(0, i).join("/"), path, {})
        if (!permits(dir.mode, dir.uid, uid, "x")) return false
      }
    }
    const stat = await this.stat(rel, path, {})
    if (want === "w" && this.provider.readonly) throw new RiteError("EROFS", path)
    return permits(stat.mode, stat.uid, uid, want)
  }

  /**
   * Cache only. A cached stat answers in full. A cached listing of the parent
   * knows the type alone, so mode and uid are conventional (root, 0755 or 0644).
   */
  peek(rel: string): Inode | undefined {
    const stat = this.fresh(this.stats, rel)
    if (stat) return { type: stat.type, mode: stat.mode, uid: stat.uid }
    if (rel === "") return { type: "dir", mode: 0o755, uid: ROOT_UID }
    const name = rel.slice(rel.lastIndexOf("/") + 1)
    const entry = this.fresh(this.lists, parentOf(rel))?.find((e) => e.name === name)
    if (!entry) return undefined
    return { type: entry.type, mode: entry.type === "dir" ? 0o755 : 0o644, uid: ROOT_UID }
  }

  /** Forget a path's stat and listing, and the listing of its parent. */
  invalidate(rel: string): void {
    this.stats.delete(rel)
    this.lists.delete(rel)
    if (rel !== "") this.lists.delete(parentOf(rel))
  }

  private invalidateTree(rel: string): void {
    for (const cache of [this.stats, this.lists]) {
      for (const key of cache.keys()) {
        if (key.startsWith(`${rel}/`)) cache.delete(key)
      }
    }
    this.invalidate(rel)
  }

  private fresh<T>(cache: Map<string, Cached<T>>, rel: string): T | undefined {
    const hit = cache.get(rel)
    if (!hit) return undefined
    if (this.now() < hit.expires) return hit.value
    cache.delete(rel)
    return undefined
  }

  private store<T>(cache: Map<string, Cached<T>>, rel: string, value: T): void {
    const now = this.now()
    if (cache.size >= SWEEP_AT) {
      for (const [key, entry] of cache) {
        if (now >= entry.expires) cache.delete(key)
      }
    }
    cache.set(rel, { value, expires: now + CACHE_MS })
  }

  private async statIfPresent(rel: string, path: string, o: CallOptions): Promise<Stat | undefined> {
    try {
      return await this.stat(rel, path, o)
    } catch (e) {
      if (errnoOf(e) === "ENOENT") return undefined
      throw e
    }
  }

  /** EROFS for a read-only provider, ENOTSUP when a writable one lacks the method. */
  private writable(path: string, method: "write" | "mkdir" | "remove"): void {
    if (this.provider.readonly) throw new RiteError("EROFS", path)
    if (typeof this.provider[method] !== "function") throw new RiteError("ENOTSUP", path)
  }

  /** Runs a provider call. Whatever it throws leaves as a RiteError carrying the caller's path. */
  private async call<T>(path: string, o: CallOptions, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (e) {
      const errno = errnoOf(e)
      if (errno) throw new RiteError(errno, path, e instanceof Error ? e.message : undefined)
      if (o.signal?.aborted) throw new RiteError("ECANCELED", path)
      throw new RiteError("EIO", path, e instanceof Error ? e.message : undefined)
    }
  }
}
