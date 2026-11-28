// Writes dist/rite.css: xterm's stylesheet followed by rite's own.
import { readFile, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const xtermCss = await readFile(require.resolve("@xterm/xterm/css/xterm.css"), "utf8")
const riteCss = await readFile(new URL("../src/rite.css", import.meta.url), "utf8")
const banner = "/*! ritesh | MIT | includes xterm.js css (MIT, see THIRD_PARTY_NOTICES) */\n"
await writeFile(new URL("../dist/rite.css", import.meta.url), banner + xtermCss + "\n" + riteCss)

// jq.wasm, beside jq-worker.js: the jq worker loads it.
const { copyFile } = await import("node:fs/promises")
await copyFile(require.resolve("jq-wasm/jq.wasm"), new URL("../dist/jq.wasm", import.meta.url))
