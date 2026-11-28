# Probe service

Status: designed, not built. Network probes sent from a server are easy to turn against other people's networks, so this ships only after its abuse limits have been reviewed and the people who may use it are decided. The browser tools (`riteshjs/net`) ship without it.

## Goal

Real `ping`, `traceroute`, `mtr`, and IPv6 reachability, sent from a server and streamed to a rite terminal over rite.1. A browser cannot do these: it has no ICMP and no control of a packet's TTL. They test from the server's network, where the browser tools test from the visitor's.

## Who may use it

- Signed-in people only. The rite.1 connection carries a token, checked when it opens; a connection without one gets no probe commands. Open demo visitors get none.
- Each probe is recorded with who asked, the target, the kind, and the result, so abuse can be traced and its account stopped.

## What it will probe

- A name is resolved once and that address is probed, so a DNS answer cannot change between the check and the packets (rebinding).
- Every resolved address must be public. Refused, IPv4 and IPv6: private, loopback, link-local, carrier-grade NAT, multicast, broadcast, documentation, reserved, unique local, IPv4-mapped forms of those, and the service's own ranges and its host's.
- Only ICMP echo for ping; traceroute and mtr use their normal probes with the limits below.

## How much

- ping: at most 10 packets, one a second or slower, a small fixed size.
- traceroute: at most 30 hops, 3 probes a hop. mtr: at most 10 cycles.
- One running probe per person, a quota per person per minute and per day, a global limit on concurrent probes, and a limit per target address across all people, so many accounts cannot aim at one host.
- A probe that passes its time limit is ended and counted.

## Where it runs

- Its own small service (for example `probe.rite.sh`), apart from any product, so its traffic and its abuse never touch them.
- One pod with only `NET_RAW` among capabilities, non-root, read-only root filesystem. A network policy lets it reach the internet only: no cluster addresses, no private ranges.
- Behind Cloudflare: the WebSocket upgrade passes the tunnel; rate-limiting rules and the WAF act on the upgrade. Cloudflare counts connections, not the messages inside one, so the service's own limits are the ones that hold. Keepalives keep a long traceroute under Cloudflare's 100 second idle limit.

## Output

Lines stream as they arrive. Text from the network (names in reverse DNS, for one) is shown as text: control characters are written as `\xNN`.

## Before building

- A Codex review of this design for abuse paths.
- Tests that try to break each limit: private targets by every spelling, rebinding, concurrency, quotas, per-target limits.
- Who may use it, and where it is hosted, decided by the owner.
