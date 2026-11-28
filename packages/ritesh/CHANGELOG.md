# riteshjs

## 0.2.0

### Minor Changes

- 59786fa: `riteshjs/jq`: real jq (1.8.2, WebAssembly via jq-wasm) as an opt-in command, in a Web Worker that sees only its input. Input, output, and time limits; control characters in the output are written as text. `jq-worker.js` and `jq.wasm` ship beside it; a strict CSP adds `'wasm-unsafe-eval'` for the worker file alone.
- 59786fa: `riteshjs/net` (and `Rite.net` in the bundle): opt-in network commands that run in the visitor's browser. `ipcalc` (IPv4 and IPv6 address math, strict parsing), `dig` (DNS over HTTPS, the site's resolvers only), `ipv6` (the visitor's IPv4 and IPv6 reachability), and `httping` (HTTPS round trips to endpoints the site names). Output from the network is shown as text, escape sequences included.

## 0.1.0

### Minor Changes

- First release: rite, a shell for the browser on xterm.js. Its own language, an in-memory filesystem with mounts and actions, a line editor with completion and history, 29 commands, easter eggs, and the rite.1 remote protocol with a Go server.
- Themes: `themes.brass`, `themes.tide`, and `themes.dusk` (dark) and `themes.paper` (light), with `rite.setTheme()` to switch at runtime. `rite.size` and `rite.onResize()` report the terminal's size. The host's own motd keeps its SGR colors; one a mount serves is plain.
