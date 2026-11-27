// The remote filesystem as a read-only MountProvider, with the stat and list cache.
import { type CallOptions, type Entry, type MountProvider, RiteError, type Stat } from "../contracts.js"
import { byteLength } from "./chunk.js"
import type { Link } from "./link.js"
import { parseList, parseRead, parseStat } from "./parse.js"
import type { PathParams, ReadParams } from "./protocol.gen.js"
import type { Clock } from "./wire.js"

export const CACHE_TTL_MS = 30_000
/** Past this many entries the expired ones are swept; if that is not enough the cache starts over. */
const CACHE_MAX_ENTRIES = 2048

interface Cached<T> {
  at: number
  value: T
}

function parentOf(path: string): string {
  const slash = path.lastIndexOf("/")
  return slash < 0 ? "" : path.slice(0, slash)
}

export class RemoteFs implements MountProvider {
  readonly readonly = true

  private readonly link: Link
  private readonly clock: Clock
  private readonly stats = new Map<string, Cached<Stat>>()
  private readonly lists = new Map<string, Cached<Entry[]>>()
  private readonly watchers = new Set<(rel: string) => void>()
  /** Bumped on every invalidation, so a result requested before it is not cached after it. */
  private epoch = 0

  constructor(link: Link, clock: Clock) {
    this.link = link
    this.clock = clock
  }

  async stat(rel: string, o: CallOptions): Promise<Stat> {
    const hit = this.fresh(this.stats, rel)
    if (hit) return { ...hit }
    const epoch = this.epoch
    const params: PathParams = { path: rel }
    const stat = parseStat(await this.link.request("fs.stat", params, o.signal))
    if (!stat) throw new RiteError("EIO", rel, "malformed fs.stat result")
    if (epoch === this.epoch) this.store(this.stats, rel, stat)
    return { ...stat }
  }

  async list(rel: string, o: CallOptions): Promise<Entry[]> {
    const hit = this.fresh(this.lists, rel)
    if (hit) return hit.map((entry) => ({ ...entry }))
    const epoch = this.epoch
    const params: PathParams = { path: rel }
    const entries = parseList(await this.link.request("fs.list", params, o.signal))
    if (!entries) throw new RiteError("EIO", rel, "malformed fs.list result")
    if (epoch === this.epoch) this.store(this.lists, rel, entries)
    return entries.map((entry) => ({ ...entry }))
  }

  /** Reads to the end, continuing by byte offset while the server answers eof: false. */
  async read(rel: string, o: CallOptions): Promise<string> {
    let text = ""
    let offset = 0
    for (;;) {
      const params: ReadParams = offset === 0 ? { path: rel } : { path: rel, offset }
      const chunk = parseRead(await this.link.request("fs.read", params, o.signal))
      if (!chunk) throw new RiteError("EIO", rel, "malformed fs.read result")
      text += chunk.data
      if (chunk.eof) return text
      if (chunk.data === "") throw new RiteError("EIO", rel, "fs.read made no progress")
      offset += byteLength(chunk.data)
    }
  }

  write(rel: string): Promise<void> {
    return Promise.reject(new RiteError("EROFS", rel))
  }

  mkdir(rel: string): Promise<void> {
    return Promise.reject(new RiteError("EROFS", rel))
  }

  remove(rel: string): Promise<void> {
    return Promise.reject(new RiteError("EROFS", rel))
  }

  watch(onChange: (rel: string) => void): () => void {
    // A wrapper per call, so one function subscribed twice unsubscribes once per call.
    const watcher = (rel: string): void => { onChange(rel) }
    this.watchers.add(watcher)
    return () => { this.watchers.delete(watcher) }
  }

  /** fs.changed: drops the path and its parent listing, then tells the watchers. */
  changed(path: string, kind: unknown): void {
    this.epoch++
    this.stats.delete(path)
    this.lists.delete(path)
    this.lists.delete(parentOf(path))
    if (kind === "delete") {
      // What was under a deleted directory is gone with it.
      const prefix = path === "" ? "" : path + "/"
      for (const cache of [this.stats, this.lists]) {
        for (const key of [...cache.keys()]) if (key.startsWith(prefix)) cache.delete(key)
      }
    }
    for (const watcher of [...this.watchers]) {
      try {
        watcher(path)
      } catch {
        // A watcher that throws does not stop the others.
      }
    }
  }

  /** Changes cannot be heard while disconnected, so nothing cached then can be trusted. */
  clear(): void {
    this.epoch++
    this.stats.clear()
    this.lists.clear()
  }

  private fresh<T>(cache: Map<string, Cached<T>>, key: string): T | undefined {
    const hit = cache.get(key)
    if (!hit) return undefined
    if (this.clock.now() - hit.at < CACHE_TTL_MS) return hit.value
    cache.delete(key)
    return undefined
  }

  private store<T>(cache: Map<string, Cached<T>>, key: string, value: T): void {
    const now = this.clock.now()
    if (cache.size >= CACHE_MAX_ENTRIES) {
      for (const [k, cached] of cache) if (now - cached.at >= CACHE_TTL_MS) cache.delete(k)
      if (cache.size >= CACHE_MAX_ENTRIES) cache.clear()
    }
    cache.set(key, { at: now, value })
  }
}
