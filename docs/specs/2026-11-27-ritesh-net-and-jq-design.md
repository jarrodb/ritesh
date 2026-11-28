# Network tools and jq

## Goal

Two opt-in add-ons for rite, both running in the visitor's browser with no server of the host's:

- `riteshjs/net`: `ipcalc` (IPv4 and IPv6 address math), `dig` (DNS over HTTPS), `ipv6` (the visitor's IPv4 and IPv6 reachability), and `httping` (HTTPS round-trip time to an endpoint the host names).
- `riteshjs/jq`: real jq (1.8, WebAssembly, `jq-wasm`) in a Web Worker.

ICMP ping, traceroute, and mtr cannot run in a browser (no ICMP, no TTL control). They belong to a server-side probe service over rite.1, specified separately. Nothing here imitates them: each command says what it measures.

## Constraints

- Opt-in: a host registers the commands it wants (`commands: [...net.commands()]`, `jq.command()`). The core stays within its size budget; jq's WebAssembly (333 KB gzipped) loads the first time `jq` runs.
- Output is untrusted text. It goes through rite's output filter like any command's, so DNS answers, endpoint replies, and jq output cannot carry escape sequences other than colors.
- No command reaches an address the host did not configure, except `dig`, which only talks to the configured DNS-over-HTTPS resolver. `httping` takes a name from the host's list, never a URL from the visitor: an open "time any URL" tool is a scanner.
- Library-first: `ipaddr.js` for parsing, `jq-wasm` for jq.

## ipcalc

`ipcalc <address>[/<prefix>]`, `ipcalc <cidr> --split <prefix>`, `ipcalc <cidr> --contains <address>`.

- Strict parsing (`ipaddr.js`): no octal-looking octets (`010.1.1.1`), no short forms (`10.1`), no zone ids; IPv4-mapped IPv6 only as written.
- Network, broadcast (IPv4), first and last host, host count (BigInt, so `/0` in IPv6 is exact), mask and wildcard (IPv4), the range's kind (private, loopback, link-local, CGNAT, multicast, documentation, global).
- `--split` prints the subnets up to 256 and otherwise only their count. No hostnames: resolving belongs to `dig`.

## dig

`dig [@resolver] <name> [A|AAAA|MX|TXT|CAA|NS|CNAME|SOA]` over DNS-over-HTTPS JSON (`application/dns-json`). The resolver is the host's (default `https://cloudflare-dns.com/dns-query`); `@` picks from the host's list only. Answers print like dig's answer section, with the status (NOERROR, NXDOMAIN, SERVFAIL).

## ipv6

`ipv6`: fetches the host's IPv4-only and IPv6-only endpoints (default `ipv4.icanhazip.com`, `ipv6.icanhazip.com`, which answer with the caller's address and allow any origin) and reports, for each, reachable or not, the address seen, and the time. The default endpoints see the visitor's addresses; a host that does not want that names its own.

## httping

`httping <name> [-c count]`: times `count` (at most 10, one a second) small HTTPS requests to a named endpoint from the host's list and prints each time and the summary. It measures connection, TLS, and HTTP together; the output says so.

## jq

`jq [flags] <filter>`, reading stdin: `mdm keys ls --json | jq '.[].client_id'`.

- In a dedicated Web Worker: it gets the input text and the filter, nothing of the page (no token, no DOM, no cookies).
- Limits: input 10 MB, output 10,000 lines, 5 seconds per run (the worker is terminated and the next run starts a fresh one).
- The worker loads `jq.wasm` itself. A host with a strict CSP serves the worker file with a policy that adds `'wasm-unsafe-eval'` for it alone; the page's policy does not change.

## Phases

1. `riteshjs/net`: ipcalc, dig, ipv6, httping, with tests against known answers and hostile output.
2. `riteshjs/jq`: the worker, limits, and tests (timeout, oversized input, escape sequences in output).
3. The demo page and the mdm developer portal register them.

## Decisions

- Browser tools say where they ran and what they measured; a probe service will run the ICMP tools server-side.
- Network endpoints are the host's configuration, never a visitor's argument.
