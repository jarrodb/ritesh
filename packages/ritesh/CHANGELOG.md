# riteshjs

## 0.1.0

### Minor Changes

- First release: rite, a shell for the browser on xterm.js. Its own language, an in-memory filesystem with mounts and actions, a line editor with completion and history, 29 commands, easter eggs, and the rite.1 remote protocol with a Go server.
- Themes: `themes.brass`, `themes.tide`, and `themes.dusk` (dark) and `themes.paper` (light), with `rite.setTheme()` to switch at runtime. `rite.size` and `rite.onResize()` report the terminal's size. The host's own motd keeps its SGR colors; one a mount serves is plain.
