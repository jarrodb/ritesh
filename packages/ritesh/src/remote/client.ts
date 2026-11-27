// Wires the link, the filesystem, and the processes into a RemoteHandle.
import { type RemoteHandle, RiteError } from "../contracts.js"
import { RemoteFs } from "./fs.js"
import { Link } from "./link.js"
import type { RemoteOptions } from "./options.js"
import { parseNotify } from "./parse.js"
import { RemoteProcs } from "./procs.js"
import { defaultSocket, isRecord, systemClock } from "./wire.js"

export const NOTIFY_MAX = 5
export const NOTIFY_WINDOW_MS = 10_000

type NotifyListener = Parameters<RemoteHandle["onNotify"]>[0]

export interface RemoteClient extends RemoteHandle {
  /** The connection itself, for conformance replays and tests. */
  readonly link: Link
}

function absolute(path: string, option: string): string {
  if (!path.startsWith("/")) throw new RiteError("EINVAL", path, `remote: ${option} must be an absolute path`)
  const trimmed = path.replace(/\/+$/, "")
  return trimmed === "" ? "/" : trimmed
}

export function createRemote(options: RemoteOptions): RemoteClient {
  const at = absolute(options.at, "at")
  const root = at === "/" ? "" : at
  const bin = options.bin === undefined ? `${root}/bin` : absolute(options.bin, "bin")
  const clock = options.clock ?? systemClock
  const listeners = new Set<NotifyListener>()
  /** When the notifications still inside the window were delivered. */
  const delivered: number[] = []

  const link: Link = new Link({
    url: options.url,
    token: options.token,
    eager: options.connect === "eager",
    socket: options.socket ?? defaultSocket,
    clock,
    random: options.random ?? Math.random,
    busy: () => procs.busy,
    onUp: () => { procs.connected() },
    onDown: () => {
      procs.lost()
      fs.clear()
    },
    onNotification: (method, params) => {
      if (method === "proc.stdout" || method === "proc.stderr" || method === "proc.exit") procs.notification(method, params)
      else if (method === "fs.changed") changed(params)
      else if (method === "term.notify") notified(params)
      // Unknown notifications are ignored.
    },
  })
  const fs = new RemoteFs(link, clock)
  const procs = new RemoteProcs({ link, clock, root, env: options.env ?? [], declared: options.commands ?? [] })

  function changed(params: unknown): void {
    if (isRecord(params) && typeof params.path === "string") fs.changed(params.path, params.kind)
  }

  function notified(params: unknown): void {
    const note = parseNotify(params)
    if (!note || listeners.size === 0) return
    const now = clock.now()
    while (delivered[0] !== undefined && now - delivered[0] >= NOTIFY_WINDOW_MS) delivered.shift()
    if (delivered.length >= NOTIFY_MAX) return
    delivered.push(now)
    for (const listener of [...listeners]) {
      try {
        listener(note.text, note.level)
      } catch {
        // A listener that throws does not stop the others.
      }
    }
  }

  const client: RemoteClient = {
    at,
    bin,
    provider: fs,
    commands: procs,
    link,
    connect: () => link.ensure(),
    dispose: () => {
      procs.dispose()
      link.dispose()
      fs.clear()
      listeners.clear()
    },
    onNotify: (listener) => {
      const entry: NotifyListener = (text, level) => { listener(text, level) }
      listeners.add(entry)
      return () => { listeners.delete(entry) }
    },
  }
  // An eager remote does not wait for a first use; a failed attempt retries in the link.
  if (options.connect === "eager") void client.connect().catch(() => undefined)
  return client
}
