// Command history: in memory, or persisted to web storage and merged with
// other tabs. Storage can be missing, full, or forbidden, so every access is
// in try/catch and a failure leaves the history in memory.
import type { HistoryMode } from "../contracts.js"

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** The part of a StorageEvent the history reads. */
export interface StorageChange {
  key: string | null
  newValue: string | null
}

export interface StorageEvents {
  addEventListener(type: "storage", listener: (event: StorageChange) => void): void
  removeEventListener(type: "storage", listener: (event: StorageChange) => void): void
}

export const MAX_ENTRIES = 1000
export const MAX_BYTES: number = 256 * 1024

export interface History {
  /** Oldest first. */
  entries(): readonly string[]
  add(line: string): void
  dispose(): void
}

export interface HistoryOptions {
  mode: HistoryMode
  key: string
  storage: StorageLike | undefined
  events: StorageEvents | undefined
}

const encoder = new TextEncoder()

/** The newest entries that fit both caps. The size is that of the stored JSON, in UTF-8. */
export function cap(entries: readonly string[]): string[] {
  let bytes = 2
  let start = entries.length
  while (start > 0 && entries.length - start < MAX_ENTRIES) {
    const size = encoder.encode(JSON.stringify(entries[start - 1])).length + 1
    if (bytes + size > MAX_BYTES) break
    bytes += size
    start--
  }
  return entries.slice(start)
}

function decode(raw: string): string[] {
  try {
    const value: unknown = JSON.parse(raw)
    return Array.isArray(value) ? cap(value.filter((v): v is string => typeof v === "string")) : []
  } catch {
    return []
  }
}

function defaultStorage(): StorageLike | undefined {
  try {
    const storage: StorageLike | undefined = globalThis.localStorage
    return storage
  } catch {
    return undefined
  }
}

function defaultEvents(): StorageEvents | undefined {
  // Outside a browser there is no window to carry the storage event.
  const target: Partial<StorageEvents> = globalThis
  return typeof target.addEventListener === "function" && typeof target.removeEventListener === "function"
    ? { addEventListener: (t, l) => { globalThis.addEventListener(t, l) }, removeEventListener: (t, l) => { globalThis.removeEventListener(t, l) } }
    : undefined
}

export function createHistory(options: HistoryOptions): History {
  const { mode, key } = options
  if (mode === false) return { entries: () => [], add: () => undefined, dispose: () => undefined }

  const storage = mode === "local" ? (options.storage ?? defaultStorage()) : undefined
  let entries: string[] = []
  /** Entries no write has stored yet; they survive adopting another tab's list. */
  let unsaved: string[] = []

  /** The stored list, or undefined when storage cannot be read. */
  const load = (): string[] | undefined => {
    if (!storage) return undefined
    try {
      const raw = storage.getItem(key)
      return raw === null ? [] : decode(raw)
    } catch {
      return undefined
    }
  }

  const save = (): boolean => {
    if (!storage) return false
    try {
      storage.setItem(key, JSON.stringify(entries))
      return true
    } catch {
      return false
    }
  }

  const adopt = (stored: readonly string[]): void => {
    entries = cap([...stored, ...unsaved])
  }

  adopt(load() ?? [])

  const onStorage = (event: StorageChange): void => {
    // A null key is storage.clear().
    if (event.key !== null && event.key !== key) return
    adopt(event.newValue === null ? [] : decode(event.newValue))
  }
  const events = storage ? (options.events ?? defaultEvents()) : undefined
  events?.addEventListener("storage", onStorage)

  return {
    entries: () => entries,
    add(line) {
      // Another tab may have written since the last read.
      const stored = load()
      if (stored) adopt(stored)
      if (entries.at(-1) === line) return
      entries = cap([...entries, line])
      if (save()) unsaved = []
      else if (storage) unsaved = cap([...unsaved, line])
    },
    dispose() {
      events?.removeEventListener("storage", onStorage)
    },
  }
}
