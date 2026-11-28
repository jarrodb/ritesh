// Network commands that run in the visitor's browser: address math, DNS over
// HTTPS, IPv4/IPv6 reachability, and HTTPS round trips. None of them reaches
// an address the host did not configure. ICMP tools (ping, traceroute, mtr)
// cannot run in a browser and are not imitated here.
// docs/specs/2026-11-27-ritesh-net-and-jq-design.md.
import type { CommandDef } from "../contracts.js"
import { format, hosts, mask, network, parseAddress } from "./ip.js"

export interface NetOptions {
  /** DNS-over-HTTPS JSON resolvers by name; the first is the default. */
  resolvers?: Record<string, string>
  /** The IPv4-only and IPv6-only endpoints `ipv6` fetches; false leaves the command out. */
  reachability?: { ipv4: string; ipv6: string } | false
  /** Endpoints `httping` may time, by name. Without any, httping is left out. */
  endpoints?: Record<string, string>
  fetch?: typeof fetch
  now?: () => number
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

export const DEFAULT_RESOLVERS: Record<string, string> = { cloudflare: "https://cloudflare-dns.com/dns-query" }
export const DEFAULT_REACHABILITY = { ipv4: "https://ipv4.icanhazip.com", ipv6: "https://ipv6.icanhazip.com" }

// Text from the network is shown as text: control characters (escape
// sequences among them) are written as \xNN.
export function printable(s: string): string {
  let out = ""
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0
    const control = (c < 0x20 && c !== 0x09 && c !== 0x0a) || (c >= 0x7f && c <= 0x9f)
    out += control ? `\\x${c.toString(16).padStart(2, "0")}` : ch
  }
  return out
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason as Error); return }
    const t = setTimeout(() => { signal.removeEventListener("abort", stop); resolve() }, ms)
    const stop = (): void => { clearTimeout(t); reject(signal.reason as Error) }
    signal.addEventListener("abort", stop, { once: true })
  })
}

const REACH_TIMEOUT = 5000

// Why a request got no answer, with how long it took.
function failure(err: unknown, ms: number, signal: AbortSignal): string {
  if (signal.aborted) return "(stopped)"
  if (err instanceof DOMException && err.name === "TimeoutError") return `(no answer in ${REACH_TIMEOUT / 1000} s)`
  return `(failed after ${Math.round(ms)} ms)`
}

function rows(pairs: Array<[string, string]>): string {
  const width = Math.max(...pairs.map(([k]) => k.length)) + 2
  return pairs.map(([k, v]) => k.padEnd(width) + v).join("\n") + "\n"
}

// ---------------------------------------------------------------- ipcalc

export const ipcalc: CommandDef = {
  name: "ipcalc",
  summary: "IPv4 and IPv6 address math",
  usage: "ipcalc <address>[/<prefix>] [--split <prefix>] [--contains <address>]",
  flags: {
    split: { long: "split", type: "number", description: "list the subnets of this prefix" },
    contains: { long: "contains", type: "string", description: "whether the network holds this address" },
  },
  manual: [
    "Network, mask, hosts, and the kind of range (private, global, ...) of an address",
    "and prefix. IPv4 is four decimal parts; IPv6 takes no zone id. --split lists up to",
    "256 subnets and otherwise counts them. No hostnames: dig resolves names.",
  ].join("\n"),
  run: async (p) => {
    const arg = p.args[0]
    if (!arg || p.args.length > 1) {
      await p.err("usage: ipcalc <address>[/<prefix>] [--split <prefix>] [--contains <address>]\n")
      return 2
    }
    const a = parseAddress(arg)
    if (typeof a === "string") {
      await p.err(`ipcalc: ${a}\n`)
      return 2
    }
    const n = network(a)
    const contains = p.flags["contains"]
    if (typeof contains === "string") {
      const b = parseAddress(contains)
      if (typeof b === "string" || b.cidr) {
        await p.err(`ipcalc: ${typeof b === "string" ? b : "--contains takes an address, not a network"}\n`)
        return 2
      }
      const inside = b.family === a.family && b.value >= n.network && b.value <= n.last
      await p.out(`${format(b.family, b.value)} ${inside ? "is" : "is not"} in ${format(a.family, n.network)}/${a.prefix}\n`)
      return inside ? 0 : 1
    }
    const split = p.flags["split"]
    if (typeof split === "number") {
      if (!Number.isInteger(split) || split < a.prefix || split > a.bits) {
        await p.err(`ipcalc: --split takes a prefix from /${a.prefix} to /${a.bits}\n`)
        return 2
      }
      const count = 1n << BigInt(split - a.prefix)
      const step = 1n << BigInt(a.bits - split)
      if (count > 256n) {
        await p.out(`${count} subnets of /${split} in ${format(a.family, n.network)}/${a.prefix} (more than 256: not listed)\n`)
        return 0
      }
      const lines: string[] = []
      for (let i = 0n; i < count; i++) lines.push(`${format(a.family, n.network + i * step)}/${split}`)
      await p.out(lines.join("\n") + "\n")
      return 0
    }
    const h = hosts(a)
    const pairs: Array<[string, string]> = []
    if (a.cidr) pairs.push(["address", format(a.family, a.value)])
    pairs.push(["network", `${format(a.family, n.network)}/${a.prefix}`])
    if (a.family === "ipv4") {
      const m = mask(a)
      pairs.push(["netmask", format("ipv4", m)], ["wildcard", format("ipv4", m ^ 0xffffffffn)])
      if (a.prefix < 31) pairs.push(["broadcast", format("ipv4", n.last)])
    }
    const span = h.first === h.last ? format(a.family, h.first) : `${format(a.family, h.first)} - ${format(a.family, h.last)}`
    pairs.push(["hosts", `${span} (${h.count.toLocaleString("en-US")})`], ["kind", a.range])
    await p.out(rows(pairs))
    return 0
  },
}

// ---------------------------------------------------------------- dig

const TYPES: Record<string, number> = { A: 1, NS: 2, CNAME: 5, SOA: 6, MX: 15, TXT: 16, AAAA: 28, CAA: 257 }
const TYPE_NAMES = Object.fromEntries(Object.entries(TYPES).map(([k, v]) => [v, k]))
const STATUS: Record<number, string> = { 0: "NOERROR", 1: "FORMERR", 2: "SERVFAIL", 3: "NXDOMAIN", 4: "NOTIMP", 5: "REFUSED" }
const HOSTNAME = /^(?=.{1,253}\.?$)([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?\.)*[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?\.?$/i

interface DohAnswer { name: string; type: number; TTL: number; data: string }

function dig(o: Required<Pick<NetOptions, "resolvers">> & { fetch: typeof fetch }): CommandDef {
  const names = Object.keys(o.resolvers)
  return {
    name: "dig",
    summary: "DNS lookups over HTTPS",
    usage: `dig [@${names.join("|@")}] <name> [${Object.keys(TYPES).join("|")}]`,
    flags: {},
    manual: [
      "Asks a DNS-over-HTTPS resolver (the site's: " + names.join(", ") + ") and prints the",
      "answer section. It runs in your browser; the resolver sees the name you ask for.",
    ].join("\n"),
    run: async (p) => {
      let resolver = names[0] ?? ""
      const words: string[] = []
      for (const a of p.args) {
        if (a.startsWith("@")) resolver = a.slice(1)
        else words.push(a)
      }
      const [name, typeWord = "A", extra] = words
      // Own names only: "@__proto__" must not reach an inherited value.
      const url = Object.hasOwn(o.resolvers, resolver) ? o.resolvers[resolver] : undefined
      if (!url) {
        await p.err(`dig: no resolver ${resolver}; this site has ${names.join(", ")}\n`)
        return 2
      }
      const type = typeWord.toUpperCase()
      if (!name || extra !== undefined || !HOSTNAME.test(name) || !(type in TYPES)) {
        await p.err(`usage: dig [@resolver] <name> [${Object.keys(TYPES).join("|")}]\n`)
        return 2
      }
      let body: { Status: number; Answer?: DohAnswer[] }
      try {
        const query = new URL(url)
        query.searchParams.set("name", name)
        query.searchParams.set("type", type)
        const res = await o.fetch(query.toString(), {
          headers: { accept: "application/dns-json" },
          // A redirect would reach an address the site did not name.
          redirect: "error",
          signal: p.signal,
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        body = (await res.json()) as typeof body
      } catch (err) {
        await p.err(`dig: ${resolver}: ${err instanceof Error ? err.message : String(err)}\n`)
        return 1
      }
      const status = STATUS[body.Status] ?? `status ${body.Status}`
      const lines = [`;; ${status} from ${resolver}`]
      for (const a of body.Answer ?? []) {
        lines.push([printable(a.name), String(a.TTL), "IN", TYPE_NAMES[a.type] ?? String(a.type), printable(a.data)].join("\t"))
      }
      await p.out(lines.join("\n") + "\n")
      return body.Status === 0 ? 0 : 1
    },
  }
}

// ---------------------------------------------------------------- ipv6

function ipv6(o: { reachability: { ipv4: string; ipv6: string }; fetch: typeof fetch; now: () => number }): CommandDef {
  return {
    name: "ipv6",
    summary: "whether your network reaches the internet over IPv4 and IPv6",
    usage: "ipv6",
    // Declared, so the kernel answers --help and refuses unknown options
    // before anything is fetched.
    flags: {},
    manual: [
      "Fetches an IPv4-only and an IPv6-only endpoint from your browser and shows which",
      "answered, the address each saw, and how long it took. Those endpoints see your",
      "addresses. It tests your network, not this site's.",
    ].join("\n"),
    run: async (p) => {
      if (p.args.length > 0) {
        await p.err("usage: ipv6\n")
        return 2
      }
      const probe = async (url: string): Promise<{ ok: boolean; text: string; ms: number }> => {
        const start = o.now()
        try {
          const res = await o.fetch(url, { cache: "no-store", redirect: "error", signal: AbortSignal.any([p.signal, AbortSignal.timeout(REACH_TIMEOUT)]) })
          const body = (await res.text()).trim()
          const seen = parseAddress(body)
          return { ok: res.ok, text: typeof seen === "string" ? "(an unexpected answer)" : body, ms: o.now() - start }
        } catch (err) {
          const ms = o.now() - start
          return { ok: false, text: failure(err, ms, p.signal), ms }
        }
      }
      const [v4, v6] = await Promise.all([probe(o.reachability.ipv4), probe(o.reachability.ipv6)])
      const line = (label: string, r: typeof v4): string =>
        `${label}  ${r.ok ? "reachable  " : "unreachable"}  ${printable(r.text)}${r.ok ? `  ${Math.round(r.ms)} ms` : ""}`
      const verdict = v4.ok && v6.ok ? "dual stack" : v4.ok ? "IPv4 only" : v6.ok ? "IPv6 only" : "no connectivity"
      await p.out([line("ipv4", v4), line("ipv6", v6), `your network: ${verdict}`].join("\n") + "\n")
      return v4.ok || v6.ok ? 0 : 1
    },
  }
}

// ---------------------------------------------------------------- httping

const MAX_COUNT = 10

function httping(o: { endpoints: Record<string, string>; fetch: typeof fetch; now: () => number; sleep: NonNullable<NetOptions["sleep"]> }): CommandDef {
  const names = Object.keys(o.endpoints)
  return {
    name: "httping",
    summary: "HTTPS round-trip times to this site's endpoints",
    usage: `httping <${names.join("|")}> [-c count]`,
    flags: { count: { long: "count", short: "c", type: "number", default: 4, description: `requests, at most ${MAX_COUNT}` } },
    manual: [
      "Times small HTTPS requests, one a second, from your browser to an endpoint this",
      "site names. Each time covers the request and response (the first also the",
      "connection and TLS). It is not ICMP ping.",
    ].join("\n"),
    run: async (p) => {
      const name = p.args[0] ?? ""
      const url = Object.hasOwn(o.endpoints, name) ? o.endpoints[name] : undefined
      const count = Number(p.flags["count"])
      if (!url || p.args.length !== 1) {
        await p.err(`usage: httping <${names.join("|")}> [-c count]\n`)
        return 2
      }
      if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) {
        await p.err(`httping: -c takes 1 to ${MAX_COUNT}\n`)
        return 2
      }
      await p.out(`HTTPS ${name}: ${count} requests (request and response time, not ICMP)\n`)
      const times: number[] = []
      for (let i = 1; i <= count; i++) {
        const start = o.now()
        try {
          const res = await o.fetch(url, { cache: "no-store", redirect: "error", signal: AbortSignal.any([p.signal, AbortSignal.timeout(REACH_TIMEOUT)]) })
          await res.arrayBuffer()
          const ms = o.now() - start
          times.push(ms)
          await p.out(`seq=${i} status=${res.status} time=${ms.toFixed(1)} ms\n`)
        } catch (err) {
          if (p.signal.aborted) break
          await p.out(`seq=${i} ${failure(err, o.now() - start, p.signal).slice(1, -1)}\n`)
        }
        if (i < count) {
          try { await o.sleep(1000, p.signal) } catch { break }
        }
      }
      if (times.length > 0) {
        const avg = times.reduce((a, b) => a + b, 0) / times.length
        await p.out(`${times.length}/${count} answered, min/avg/max ${Math.min(...times).toFixed(1)}/${avg.toFixed(1)}/${Math.max(...times).toFixed(1)} ms\n`)
      } else {
        await p.out(`0/${count} answered\n`)
      }
      return times.length > 0 ? 0 : 1
    },
  }
}

// ---------------------------------------------------------------- all

/** The network commands, for createRite's `commands`. */
export function commands(options: NetOptions = {}): CommandDef[] {
  const f = options.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a))
  const now = options.now ?? (() => performance.now())
  const out: CommandDef[] = [ipcalc, dig({ resolvers: options.resolvers ?? DEFAULT_RESOLVERS, fetch: f })]
  const reach = options.reachability ?? DEFAULT_REACHABILITY
  if (reach !== false) out.push(ipv6({ reachability: reach, fetch: f, now }))
  if (options.endpoints && Object.keys(options.endpoints).length > 0) {
    out.push(httping({ endpoints: options.endpoints, fetch: f, now, sleep: options.sleep ?? defaultSleep }))
  }
  return out
}

