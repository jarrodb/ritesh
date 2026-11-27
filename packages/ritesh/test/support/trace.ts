// Loads protocol/traces and compares messages. Both the client replay (wave A)
// and the cross-language CI job use this matcher.
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

export const PROTOCOL_DIR: string = join(import.meta.dirname, "../../../../protocol")

export type TraceLine =
  | { dir: "c2s" | "s2c"; match: "exact" | "shape"; msg: Record<string, unknown> }
  | { dir: "s2c"; close: number }

export function loadTraces(): Map<string, TraceLine[]> {
  const out = new Map<string, TraceLine[]>()
  for (const f of readdirSync(join(PROTOCOL_DIR, "traces")).sort()) {
    if (!f.endsWith(".jsonl")) continue
    const lines = readFileSync(join(PROTOCOL_DIR, "traces", f), "utf8").split("\n").filter(Boolean)
    out.set(f.replace(/\.jsonl$/, ""), lines.map((l) => JSON.parse(l) as TraceLine))
  }
  return out
}

/** exact: deep equal. shape: same keys and types; string values under "session" and "data" may differ. */
export function matches(want: unknown, got: unknown, mode: "exact" | "shape", key = ""): boolean {
  if (mode === "shape" && (key === "session" || key === "data") && typeof want === "string") return typeof got === "string"
  if (Array.isArray(want)) {
    return Array.isArray(got) && want.length === got.length && want.every((w, i) => matches(w, got[i], mode, key))
  }
  if (want !== null && typeof want === "object") {
    if (got === null || typeof got !== "object" || Array.isArray(got)) return false
    const g = got as Record<string, unknown>
    const w = want as Record<string, unknown>
    const keys = new Set([...Object.keys(w), ...Object.keys(g)])
    for (const k of keys) if (!matches(w[k], g[k], mode, k)) return false
    return true
  }
  if (mode === "shape" && typeof want === "number" && key !== "code" && key !== "id" && key !== "pid") return typeof got === "number"
  return want === got
}
