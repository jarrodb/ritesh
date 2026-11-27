import {
  type CallOptions, type CommandDef, type Entry, type InodeType, type MountProvider, RiteError,
  type Stat, type Vfs, type WriteOptions,
} from "../../src/contracts.js"
import { createVfs, type VfsOptions } from "../../src/vfs/index.js"

export const GUEST = 1000
export const ROOT = 0

export const echo: CommandDef = {
  name: "echo", summary: "print arguments", usage: "echo [arg...]",
  flags: { n: { short: "n", type: "boolean" } },
  subcommands: { loud: { summary: "print in capitals", usage: "echo loud [arg...]" } },
}

export interface World {
  vfs: Vfs
  /** The injected clock; tests move time by assigning `t`. */
  clock: { t: number }
  /** URLs handed to the injected `open`. */
  opened: string[]
}

/** A vfs with a small tree shaped like the one createRite builds. */
export function world(options: VfsOptions = {}): World {
  const clock = { t: 1_000 }
  const opened: string[] = []
  const vfs = createVfs({
    now: () => clock.t,
    open: (url) => {
      opened.push(url)
      return true
    },
    ...options,
  })
  vfs.put("/home/guest", { type: "dir", uid: GUEST })
  vfs.put("/home/guest/notes.txt", { type: "file", content: "hello\n" })
  vfs.put("/etc/motd", { type: "file", content: "welcome\n" })
  vfs.put("/root", { type: "dir", mode: 0o700 })
  vfs.put("/root/secret", { type: "file", content: "s3cret\n" })
  vfs.put("/tmp", { type: "dir", mode: 0o777 })
  vfs.put("/bin/echo", { type: "cmd", command: echo })
  vfs.put("/dev/null", { type: "dev" })
  return { vfs, clock, opened }
}

/** The errno a promise rejects with, or "OK" when it resolves. */
export async function errnoOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (e) {
    if (e instanceof RiteError) return e.errno
    throw e
  }
  return "OK"
}

/** The errno a synchronous call throws, or "OK". */
export function thrownErrno(fn: () => unknown): string {
  try {
    fn()
  } catch (e) {
    if (e instanceof RiteError) return e.errno
    throw e
  }
  return "OK"
}

type Op = "stat" | "list" | "read" | "write" | "mkdir" | "remove"

interface FakeNode {
  type: InodeType
  data: string
  mode: number
  uid: number
}

/** An in-memory MountProvider that counts and records every call. */
export class FakeProvider implements MountProvider {
  readonly readonly: boolean
  readonly calls: Record<Op, number> = { stat: 0, list: 0, read: 0, write: 0, mkdir: 0, remove: 0 }
  /** Every call in order, as "op rel". */
  readonly log: string[] = []
  readonly signals: Array<AbortSignal | undefined> = []
  readonly nodes = new Map<string, FakeNode>([["", { type: "dir", data: "", mode: 0o755, uid: ROOT }]])
  unsubscribed = 0
  private readonly listeners = new Set<(rel: string) => void>()

  constructor(files: Record<string, string | null> = {}, options: { readonly?: boolean } = {}) {
    this.readonly = options.readonly ?? false
    for (const [rel, data] of Object.entries(files)) this.set(rel, data)
  }

  /** A string is a file; null is a directory. */
  set(rel: string, data: string | null, mode?: number, uid: number = ROOT): void {
    const type: InodeType = data === null ? "dir" : "file"
    this.nodes.set(rel, { type, data: data ?? "", mode: mode ?? (type === "dir" ? 0o755 : 0o644), uid })
  }

  get total(): number {
    return Object.values(this.calls).reduce((sum, n) => sum + n, 0)
  }

  /** Report a change, as a provider does when something under the mount moves. */
  emit(rel: string): void {
    for (const listener of this.listeners) listener(rel)
  }

  private enter(op: Op, rel: string, o: CallOptions): void {
    this.calls[op]++
    this.log.push(`${op} ${rel}`)
    this.signals.push(o.signal)
  }

  private node(rel: string): FakeNode {
    const node = this.nodes.get(rel)
    if (!node) throw new RiteError("ENOENT", `provider:${rel}`)
    return node
  }

  stat(rel: string, o: CallOptions): Promise<Stat> {
    this.enter("stat", rel, o)
    return new Promise((resolve) => {
      const node = this.node(rel)
      resolve({ type: node.type, mode: node.mode, uid: node.uid, gid: node.uid, size: node.data.length, mtime: 7 })
    })
  }

  list(rel: string, o: CallOptions): Promise<Entry[]> {
    this.enter("list", rel, o)
    return new Promise((resolve) => {
      if (this.node(rel).type !== "dir") throw new RiteError("ENOTDIR", `provider:${rel}`)
      const prefix = rel === "" ? "" : `${rel}/`
      const entries: Entry[] = []
      for (const [path, node] of this.nodes) {
        if (path !== "" && path.startsWith(prefix) && !path.slice(prefix.length).includes("/")) {
          entries.push({ name: path.slice(prefix.length), type: node.type })
        }
      }
      // Reverse order, so a sorted answer is the vfs's doing.
      resolve(entries.sort((a, b) => (a.name < b.name ? 1 : -1)))
    })
  }

  read(rel: string, o: CallOptions): Promise<string> {
    this.enter("read", rel, o)
    return new Promise((resolve) => {
      resolve(this.node(rel).data)
    })
  }

  write(rel: string, data: string, o: WriteOptions): Promise<void> {
    this.enter("write", rel, o)
    const prior = o.mode === "append" ? (this.nodes.get(rel)?.data ?? "") : ""
    this.set(rel, prior + data)
    return Promise.resolve()
  }

  mkdir(rel: string, o: CallOptions): Promise<void> {
    this.enter("mkdir", rel, o)
    this.set(rel, null)
    return Promise.resolve()
  }

  remove(rel: string, o: CallOptions): Promise<void> {
    this.enter("remove", rel, o)
    this.nodes.delete(rel)
    return Promise.resolve()
  }

  watch(onChange: (rel: string) => void): () => void {
    this.listeners.add(onChange)
    return () => {
      this.unsubscribed++
      this.listeners.delete(onChange)
    }
  }
}
