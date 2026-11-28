// Address parsing and math for ipcalc, over ipaddr.js. Parsing is strict:
// ipaddr.parse alone reads "010.1.1.1" as octal and "10.1" as 10.0.0.1, so
// IPv4 must be four decimal parts, and IPv6 takes no zone id.
import ipaddr from "ipaddr.js"

export type Family = "ipv4" | "ipv6"

export interface Parsed {
  family: Family
  bits: 32 | 128
  value: bigint
  prefix: number
  // The address as written had a prefix.
  cidr: boolean
  range: string
}

export function parseAddress(text: string): Parsed | string {
  const [addr = "", prefixText, extra] = text.split("/")
  if (extra !== undefined) return `not an address: ${text}`
  if (addr.includes("%")) return "zone ids are not taken"
  let parsed: ipaddr.IPv4 | ipaddr.IPv6
  if (addr.includes(":")) {
    if (!ipaddr.IPv6.isValid(addr)) return `not an address: ${addr}`
    // A dotted IPv4 tail (::ffff:1.2.3.4) is held to the same four decimal parts.
    const tail = addr.slice(addr.lastIndexOf(":") + 1)
    if (tail.includes(".") && !ipaddr.IPv4.isValidFourPartDecimal(tail)) return `not an address: ${addr} (IPv4 is four decimal parts)`
    parsed = ipaddr.IPv6.parse(addr)
  } else {
    if (!ipaddr.IPv4.isValidFourPartDecimal(addr)) return `not an address: ${addr} (IPv4 is four decimal parts)`
    parsed = ipaddr.IPv4.parse(addr)
  }
  const family: Family = parsed.kind() === "ipv4" ? "ipv4" : "ipv6"
  const bits = family === "ipv4" ? 32 : 128
  let prefix = bits
  if (prefixText !== undefined) {
    if (!/^(0|[1-9]\d{0,2})$/.test(prefixText) || Number(prefixText) > bits) return `not a prefix: /${prefixText}`
    prefix = Number(prefixText)
  }
  return {
    family,
    bits,
    value: toBigInt(parsed.toByteArray()),
    prefix,
    cidr: prefixText !== undefined,
    range: rangeName(parsed.range()),
  }
}

function toBigInt(bytes: number[]): bigint {
  return bytes.reduce((n, b) => (n << 8n) | BigInt(b), 0n)
}

export function format(family: Family, value: bigint): string {
  const count = family === "ipv4" ? 4 : 16
  const bytes: number[] = []
  for (let i = count - 1; i >= 0; i--) bytes.push(Number((value >> BigInt(i * 8)) & 0xffn))
  return ipaddr.fromByteArray(bytes).toString()
}

const RANGES: Record<string, string> = {
  unicast: "global",
  private: "private",
  loopback: "loopback",
  linkLocal: "link-local",
  carrierGradeNat: "carrier-grade NAT",
  multicast: "multicast",
  reserved: "reserved (documentation or future use)",
  broadcast: "broadcast",
  unspecified: "unspecified",
  uniqueLocal: "unique local",
  ipv4Mapped: "IPv4-mapped",
}

function rangeName(r: string): string {
  return RANGES[r] ?? r
}

export interface Network {
  network: bigint
  last: bigint
  size: bigint
}

export function network(p: Parsed): Network {
  const hostBits = BigInt(p.bits - p.prefix)
  const size = 1n << hostBits
  const network = (p.value >> hostBits) << hostBits
  return { network, last: network + size - 1n, size }
}

export function mask(p: Parsed): bigint {
  const all = (1n << BigInt(p.bits)) - 1n
  return all ^ ((1n << BigInt(p.bits - p.prefix)) - 1n)
}

// The usable hosts of an IPv4 network: all of a /31 (RFC 3021) and /32, else
// without the network and broadcast addresses. In IPv6 every address is one.
export function hosts(p: Parsed): { first: bigint; last: bigint; count: bigint } {
  const n = network(p)
  if (p.family === "ipv6" || p.prefix >= 31) return { first: n.network, last: n.last, count: n.size }
  return { first: n.network + 1n, last: n.last - 1n, count: n.size - 2n }
}
