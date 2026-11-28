import { describe, expect, it, vi } from "vitest"
import type { CommandDef } from "../src/contracts.js"
import { commands, ipcalc, printable } from "../src/net.js"
import { run } from "./commands/support.js"

const byName = (list: CommandDef[], name: string): CommandDef => {
  const c = list.find((d) => d.name === name)
  if (!c) throw new Error(`no ${name}`)
  return c
}

describe("ipcalc", () => {
  it("describes an IPv4 network", async () => {
    const r = await run(ipcalc, ["10.0.0.17/22"])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain("network    10.0.0.0/22")
    expect(r.stdout).toContain("netmask    255.255.252.0")
    expect(r.stdout).toContain("wildcard   0.0.3.255")
    expect(r.stdout).toContain("broadcast  10.0.3.255")
    expect(r.stdout).toContain("hosts      10.0.0.1 - 10.0.3.254 (1,022)")
    expect(r.stdout).toContain("kind       private")
  })

  it.each([
    ["192.168.1.0/31", "192.168.1.0 - 192.168.1.1 (2)", false],
    ["8.8.8.8/32", "8.8.8.8 (1)", false],
    ["8.8.8.8", "8.8.8.8 (1)", false],
    ["100.64.1.1/10", "100.64.0.1 - 100.127.255.254 (4,194,302)", true],
  ])("hosts of %s", async (arg, want, broadcast) => {
    const r = await run(ipcalc, [arg])
    expect(r.stdout).toContain(want)
    expect(r.stdout.includes("broadcast")).toBe(broadcast)
  })

  it("counts IPv6 exactly", async () => {
    expect((await run(ipcalc, ["2001:db8::/32"])).stdout).toContain("(79,228,162,514,264,337,593,543,950,336)")
    expect((await run(ipcalc, ["::/0"])).stdout).toContain("(340,282,366,920,938,463,463,374,607,431,768,211,456)")
    expect((await run(ipcalc, ["fe80::1/64"])).stdout).toMatch(/kind\s+link-local/)
  })

  it.each([
    ["010.1.1.1", "four decimal parts"],
    ["10.1", "four decimal parts"],
    ["fe80::1%eth0", "zone ids"],
    ["10.0.0.0/33", "not a prefix"],
    ["10.0.0.0/08", "not a prefix"],
    ["example.com", "not an address"],
    ["1.2.3.4/24/1", "not an address"],
    ["::ffff:010.1.1.1", "four decimal parts"],
    ["::ffff:0x0a.1.1.1", "not an address"],
  ])("refuses %s", async (arg, why) => {
    const r = await run(ipcalc, [arg])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain(why)
  })

  it("splits a network, and only counts a large split", async () => {
    expect((await run(ipcalc, ["10.0.0.0/24", "--split", "26"])).stdout).toBe(
      "10.0.0.0/26\n10.0.0.64/26\n10.0.0.128/26\n10.0.0.192/26\n",
    )
    const big = await run(ipcalc, ["2001:db8::/48", "--split", "128"])
    expect(big.stdout).toContain("1208925819614629174706176 subnets")
    expect(big.stdout).toContain("not listed")
    expect((await run(ipcalc, ["10.0.0.0/24", "--split", "20"])).code).toBe(2)
  })

  it("answers whether a network holds an address", async () => {
    const yes = await run(ipcalc, ["10.0.0.0/22", "--contains", "10.0.3.9"])
    expect(yes.code).toBe(0)
    expect(yes.stdout).toContain("is in")
    expect((await run(ipcalc, ["10.0.0.0/22", "--contains", "10.0.4.1"])).code).toBe(1)
    expect((await run(ipcalc, ["10.0.0.0/22", "--contains", "::1"])).code).toBe(1)
  })
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/dns-json" } })
}

describe("dig", () => {
  it("asks the resolver and prints the answers, escapes written as text", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(jsonResponse({ Status: 0, Answer: [{ name: "x.test.", type: 16, TTL: 60, data: '"hi\x1b]52;c;Zm9v\x07"' }] })),
    )
    const dig = byName(commands({ fetch }), "dig")
    const r = await run(dig, ["x.test", "txt"])
    expect(r.code).toBe(0)
    const [url, init] = fetch.mock.calls[0] ?? []
    expect(url as string).toBe("https://cloudflare-dns.com/dns-query?name=x.test&type=TXT")
    expect((init?.headers as Record<string, string>).accept).toBe("application/dns-json")
    expect(init?.redirect).toBe("error")
    expect(r.stdout).toContain(";; NOERROR from cloudflare")
    expect(r.stdout).toContain("\\x1b]52;c;Zm9v\\x07")
    expect(r.stdout).not.toContain("\x1b")
  })

  it("reports NXDOMAIN", async () => {
    const dig = byName(commands({ fetch: () => Promise.resolve(jsonResponse({ Status: 3 })) }), "dig")
    const r = await run(dig, ["nope.test"])
    expect(r.code).toBe(1)
    expect(r.stdout).toContain("NXDOMAIN")
  })

  it("talks only to the site's resolvers, and only about names", async () => {
    const fetch = vi.fn()
    const dig = byName(commands({ fetch }), "dig")
    expect((await run(dig, ["@https://evil.test", "x.test"])).code).toBe(2)
    expect((await run(dig, ["x.test/../../a"])).code).toBe(2)
    expect((await run(dig, ["x.test", "ANY"])).code).toBe(2)
    expect((await run(dig, ["@__proto__", "x.test"])).code).toBe(2)
    expect((await run(dig, ["--help"])).stdout).toContain("usage: dig")
    expect((await run(dig, ["@constructor", "x.test"])).code).toBe(2)
    expect(fetch).not.toHaveBeenCalled()
  })

  it("keeps a query the site's resolver URL already has", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(jsonResponse({ Status: 0 })))
    const dig = byName(commands({ fetch, resolvers: { mine: "https://dns.example.test/q?token=abc" } }), "dig")
    await run(dig, ["x.test", "AAAA"])
    expect(fetch.mock.calls[0]?.[0] as string).toBe("https://dns.example.test/q?token=abc&name=x.test&type=AAAA")
  })
})

describe("ipv6", () => {
  it("reports which family reached, and the verdict", async () => {
    let t = 0
    const fetch = (u: string | URL | Request): Promise<Response> =>
      (u as string).includes("ipv4") ? Promise.resolve(new Response("203.0.113.7\n")) : Promise.reject(new TypeError("network"))
    const ipv6 = byName(commands({ fetch, now: () => (t += 40) }), "ipv6")
    const r = await run(ipv6, [])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain("ipv4  reachable    203.0.113.7")
    expect(r.stdout).toContain("ipv6  unreachable  (failed after 40 ms)")
    expect(r.stdout).toContain("your network: IPv4 only")
  })

  it("does not echo an answer that is not an address", async () => {
    const fetch = (): Promise<Response> => Promise.resolve(new Response("<html>\x1b[2J</html>"))
    const r = await run(byName(commands({ fetch }), "ipv6"), [])
    expect(r.stdout).toContain("(an unexpected answer)")
    expect(r.stdout).not.toContain("html")
  })

  it("never follows a redirect", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(new Response("203.0.113.7")))
    await run(byName(commands({ fetch }), "ipv6"), [])
    expect(fetch.mock.calls.every(([, init]) => init?.redirect === "error")).toBe(true)
  })

  it("probes nothing for help, options, or operands", async () => {
    const fetch = vi.fn()
    const ipv6 = byName(commands({ fetch }), "ipv6")
    expect((await run(ipv6, ["--help"])).stdout).toContain("usage: ipv6")
    expect((await run(ipv6, ["--typo"])).code).toBe(2)
    expect((await run(ipv6, ["example.com"])).code).toBe(2)
    expect(fetch).not.toHaveBeenCalled()
  })

  it("is left out when the site turns it off", () => {
    expect(commands({ reachability: false }).map((c) => c.name)).not.toContain("ipv6")
  })
})

describe("httping", () => {
  it("times the site's endpoint, never a URL from the visitor", async () => {
    let t = 0
    const fetch = vi.fn(() => Promise.resolve(new Response("ok")))
    const sleep = vi.fn(() => Promise.resolve())
    const list = commands({ endpoints: { api: "https://api.example.test/healthz" }, fetch, now: () => (t += 20), sleep })
    const h = byName(list, "httping")
    const r = await run(h, ["api", "-c", "3"])
    expect(r.code).toBe(0)
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
    expect(r.stdout).toContain("not ICMP")
    expect(r.stdout).toContain("3/3 answered")
    expect((await run(h, ["https://evil.test/"])).code).toBe(2)
    expect((await run(h, ["__proto__"])).code).toBe(2)
    expect((await run(h, ["toString"])).code).toBe(2)
    expect((await run(h, ["api", "-c", "11"])).code).toBe(2)
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it("prints the summary when nothing answered", async () => {
    const fetch = (): Promise<Response> => Promise.reject(new TypeError("network"))
    const h = byName(commands({ endpoints: { api: "https://api.example.test/" }, fetch, sleep: () => Promise.resolve() }), "httping")
    const r = await run(h, ["api", "-c", "2"])
    expect(r.code).toBe(1)
    expect(r.stdout).toContain("0/2 answered")
  })

  it("exists only when the site names endpoints", () => {
    expect(commands().map((c) => c.name)).toEqual(["ipcalc", "dig", "ipv6"])
  })
})

describe("printable", () => {
  it("writes control characters as text and keeps newlines and tabs", () => {
    expect(printable("a\x1b[31mb\tc\nd\x9be")).toBe("a\\x1b[31mb\tc\nd\\x9be")
  })
})
