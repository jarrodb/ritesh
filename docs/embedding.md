# Embedding rite

## Install

```sh
npm install riteshjs
```

```ts
import { createRite } from "riteshjs"
import "riteshjs/rite.css"

const rite = createRite({ element: document.getElementById("term")! })
```

Without a bundler, load the single-script build from a CDN. Each release lists the SRI hashes:

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/riteshjs@0.1.0/dist/rite.css" integrity="sha384-..." crossorigin="anonymous">
<script src="https://cdn.jsdelivr.net/npm/riteshjs@0.1.0/dist/rite.bundle.min.js" integrity="sha384-..." crossorigin="anonymous"></script>
<script>Rite.createRite({ element: document.getElementById("term") })</script>
```

The bundle includes xterm.js; the page needs no other script.

## Options

| Option | Meaning |
|---|---|
| `element` | where the terminal goes; give it a height |
| `hostname`, `user` | the prompt's `user@host`; the user's home is `/home/<user>` |
| `motd` | printed once at the start; SGR colors are kept |
| `files` | `{ path: content }`; content is a string or a function returning one |
| `inodes` | `{ path: InodeSpec }`: directories, links, devices, commands, and actions |
| `mounts` | `[{ path, provider }]`: a subtree served by your own `MountProvider` |
| `commands` | `CommandDef[]` registered in `/bin` (see `commands.md`) |
| `eggs` | easter eggs added to the shipped ones; `false` turns all off |
| `remote` | one rite.1 server, from `riteshjs/remote` |
| `sudo` | `false` (default), `true`, or `(password) => boolean` |
| `history` | `"local"` (default, per host and user), `"memory"`, or `false` |
| `theme`, `font` | xterm colors (`themes.brass`, `tide`, `dusk`, `paper`, or your own) and font; load web fonts before `createRite` |
| `onAction` | called for an action inode; `preventDefault()` stops rite's default |

## Actions

An action inode does something when a visitor `cd`s into it, `open`s it, or `cat`s it:

```ts
inodes: {
  "/home/guest/code": { type: "action", action: { open: "https://github.com/you" } },
  "/home/guest/blog": { type: "action", action: { navigate: "/blog" } },
}
onAction: (e) => { if (e.kind === "navigate") { e.preventDefault(); router.push(e.href!) } },
```

`open` and links accept only `http:` and `https:` URLs.

## Host API

```ts
await rite.ready
const { code } = await rite.exec("ls /bin")   // runs at the prompt, as if typed
rite.print("notice")                           // above the prompt
rite.focus(); rite.fit()                       // call fit() when the element resizes
rite.size                                      // { cols, rows }
const off = rite.onResize(({ cols, rows }) => {}) // after every fit or resize
rite.setTheme(themes.paper)                    // switch colors at runtime
rite.dispose()
```

## Themes

`themes.brass`, `themes.tide`, and `themes.dusk` are dark; `themes.paper` is light. Every text color in each reads at 4.5:1 or more on its background. Both are plain xterm `ITheme` objects, so spread one to change a few colors:

```ts
import { createRite, themes } from "riteshjs"   // or Rite.themes from the bundle
createRite({ element, theme: { ...themes.tide, cursor: "#e0ac4c" } })
```

## A server

```ts
import { remote } from "riteshjs/remote"

createRite({
  element,
  remote: remote({ url: "wss://example.com/rite", at: "/srv", token: () => fetchToken(), commands: ["deploy"] }),
})
```

The server is `github.com/jarrodb/ritesh/server`; see `protocol.md`.

## Content Security Policy

- `style-src 'unsafe-inline'`: xterm writes style elements at runtime.
- `connect-src` must allow the rite.1 server's `wss:` origin.
- `script-src` must allow the CDN, with the SRI hash on the tag.

## Keyboard

Esc then Tab moves focus out of the terminal. The page should say so.
