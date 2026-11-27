// Narrows what the server sends into contract types. Nothing from the wire is
// trusted to have its declared shape.
import type { Candidate, CommandInfo, Entry, FlagDef, Stat } from "../contracts.js"
import type { HelloResult } from "./protocol.gen.js"
import { isRecord } from "./wire.js"

export type Limits = HelloResult["limits"]

export interface Hello {
  session: string
  commands: CommandInfo[]
  limits: Limits
}

/**
 * Owner of remote files as rite shows them. The protocol carries no owner;
 * the host's user owns them so the mode's owner bits are the ones that apply.
 */
export const REMOTE_UID = 1000

function items(value: unknown): unknown[] | undefined {
  // Array.isArray narrows unknown to any[]; unknown[] is the same value, typed safely.
  return Array.isArray(value) ? (value as unknown[]) : undefined
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function isRemoteType(value: unknown): value is "dir" | "file" {
  return value === "dir" || value === "file"
}

function parseFlag(value: unknown): FlagDef | undefined {
  if (!isRecord(value)) return undefined
  const { type, long, short, repeat, description } = value
  if (type !== "boolean" && type !== "string" && type !== "number") return undefined
  return {
    type,
    ...(typeof long === "string" ? { long } : {}),
    ...(typeof short === "string" ? { short } : {}),
    ...(typeof repeat === "boolean" ? { repeat } : {}),
    ...(typeof description === "string" ? { description } : {}),
  }
}

function parseCommand(value: unknown): CommandInfo | undefined {
  if (!isRecord(value)) return undefined
  const { name, summary, usage } = value
  if (typeof name !== "string" || typeof summary !== "string" || typeof usage !== "string") return undefined
  // A command becomes a file name under bin.
  if (name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\0")) return undefined
  const info: CommandInfo = { name, summary, usage, builtin: false, remote: true }
  if (isRecord(value.flags)) {
    const flags: Record<string, FlagDef> = {}
    for (const [key, raw] of Object.entries(value.flags)) {
      const flag = parseFlag(raw)
      if (flag) flags[key] = flag
    }
    info.flags = flags
  }
  if (isRecord(value.subcommands)) {
    const subcommands: Record<string, { summary: string; usage: string }> = {}
    for (const [key, raw] of Object.entries(value.subcommands)) {
      if (isRecord(raw) && typeof raw.summary === "string" && typeof raw.usage === "string") {
        subcommands[key] = { summary: raw.summary, usage: raw.usage }
      }
    }
    info.subcommands = subcommands
  }
  return info
}

export function parseHello(value: unknown): Hello | undefined {
  if (!isRecord(value) || typeof value.session !== "string" || !isRecord(value.limits)) return undefined
  const descriptors = items(value.commands)
  const { maxMessageBytes, maxProcs, maxOutputBytes, idleSeconds } = value.limits
  if (!descriptors || !isCount(maxMessageBytes) || !isCount(maxProcs) || !isCount(maxOutputBytes) || !isCount(idleSeconds)) return undefined
  const commands = new Map<string, CommandInfo>()
  for (const descriptor of descriptors) {
    const info = parseCommand(descriptor)
    if (info && !commands.has(info.name)) commands.set(info.name, info)
  }
  return {
    session: value.session,
    commands: [...commands.values()],
    limits: { maxMessageBytes, maxProcs, maxOutputBytes, idleSeconds },
  }
}

export function parseStat(value: unknown): Stat | undefined {
  if (!isRecord(value)) return undefined
  const { type, size, mode, mtime } = value
  if (!isRemoteType(type) || !isCount(size) || !isCount(mode) || typeof mtime !== "number") return undefined
  return { type, mode, uid: REMOTE_UID, gid: REMOTE_UID, size, mtime }
}

export function parseList(value: unknown): Entry[] | undefined {
  if (!isRecord(value)) return undefined
  const entries = items(value.entries)
  if (!entries) return undefined
  const out: Entry[] = []
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.name !== "string" || !isRemoteType(entry.type)) return undefined
    out.push({ name: entry.name, type: entry.type })
  }
  return out
}

export function parseRead(value: unknown): { data: string; eof: boolean } | undefined {
  if (!isRecord(value) || typeof value.data !== "string" || typeof value.eof !== "boolean") return undefined
  return { data: value.data, eof: value.eof }
}

export function parseCandidates(value: unknown): Candidate[] | undefined {
  if (!isRecord(value)) return undefined
  const candidates = items(value.candidates)
  if (!candidates) return undefined
  const out: Candidate[] = []
  for (const candidate of candidates) {
    if (!isRecord(candidate) || typeof candidate.value !== "string") return undefined
    const { display, description, suffix } = candidate
    out.push({
      value: candidate.value,
      ...(typeof display === "string" ? { display } : {}),
      ...(typeof description === "string" ? { description } : {}),
      ...(typeof suffix === "string" ? { suffix } : {}),
    })
  }
  return out
}

export function parseNotify(value: unknown): { text: string; level: "info" | "warn" | "error" } | undefined {
  if (!isRecord(value) || typeof value.text !== "string") return undefined
  const level = value.level
  if (level !== "info" && level !== "warn" && level !== "error") return undefined
  return { text: value.text, level }
}
