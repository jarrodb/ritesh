// Writes dist/rite.css: xterm's stylesheet followed by rite's own.
import { readFile, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const xtermCss = await readFile(require.resolve("@xterm/xterm/css/xterm.css"), "utf8")
const riteCss = await readFile(new URL("../src/rite.css", import.meta.url), "utf8")
const banner = "/*! ritesh | MIT | includes xterm.js css (MIT, see THIRD_PARTY_NOTICES) */\n"
await writeFile(new URL("../dist/rite.css", import.meta.url), banner + xtermCss + "\n" + riteCss)
