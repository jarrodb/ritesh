// Records a short rite session into animated SVGs for the README: the real
// shell over headless xterm, each frame read from the terminal's cells. One
// SVG per theme (docs/demo-brass.svg, docs/demo-paper.svg).
//
//   npm run build && node scripts/record-demo.mjs
import { writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { runnerImport } from "vite"

const root = fileURLToPath(new URL("../packages/ritesh/", import.meta.url))
const load = async (path) => (await runnerImport(root + path, { root, configFile: false, logLevel: "error" })).module
const { createRiteOn } = await load("src/rite.ts")
const { createTerm } = await load("src/term/term.ts")
const themes = await load("src/themes.ts")
const { Unicode11Addon } = await import("@xterm/addon-unicode11")
const { Terminal } = await import("@xterm/headless/lib-headless/xterm-headless.mjs")

const COLS = 72
const ROWS = 20
const SESSION = [
  "cat about.txt",
  "ls /bin | head -n 4",
  "echo rite | tee /tmp/x | wc -c",
  "sudo ls",
]
const MOTD = [
  "",
  "\x1b[1m █▀█ █ ▀█▀ █▀▀\x1b[0m",
  "\x1b[1m █▀▄ █  █  ██▄\x1b[0m",
  "",
  "a shell for the browser. type help.",
  "",
].join("\n")

// ---------------------------------------------------------------- record

const xterm = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true })
const term = createTerm(xterm, new Unicode11Addon())
const rite = createRiteOn(term, {
  hostname: "rite.sh",
  user: "guest",
  history: "memory",
  motd: MOTD,
  files: { "/home/guest/about.txt": "rite is a shell for the browser, built on xterm.js.\n" },
})

async function settle() {
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => { setImmediate(r) })
    await term.write("", "plain")
  }
}

const NAMES = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"]
const paletteKey = (n) => (n < 8 ? NAMES[n] : "bright" + NAMES[n - 8][0].toUpperCase() + NAMES[n - 8].slice(1))

// A frame: the visible lines as runs of cells sharing a style, and the cursor.
function capture() {
  const buf = xterm.buffer.active
  const lines = []
  for (let y = 0; y < ROWS; y++) {
    const line = buf.getLine(buf.viewportY + y)
    const runs = []
    for (let x = 0; x < COLS; x++) {
      const cell = line?.getCell(x)
      if (!cell || cell.getWidth() === 0) continue
      const chars = cell.getChars() || " "
      const fg = cell.isFgPalette() ? paletteKey(cell.getFgColor()) : "foreground"
      const bold = cell.isBold() !== 0
      const last = runs[runs.length - 1]
      if (last && last.fg === fg && last.bold === bold && last.x + last.text.length === x) last.text += chars
      else runs.push({ x, text: chars, fg, bold })
    }
    lines.push(runs.map((r) => ({ ...r, text: r.text.replace(/\s+$/, "") })).filter((r) => r.text))
  }
  return { lines, cursor: { x: buf.cursorX, y: buf.cursorY } }
}

const frames = []
const hold = (ms) => { frames.push({ ...capture(), ms }) }

await rite.ready
await settle()
hold(1400)
for (const line of SESSION) {
  for (const ch of line) {
    xterm.input(ch, true)
    await settle()
    hold(55)
  }
  hold(350)
  xterm.input("\r", true)
  await settle()
  hold(1600)
}
hold(2600)
rite.dispose()

// Typing the same frame twice adds its time to the first.
const merged = []
for (const f of frames) {
  const prev = merged[merged.length - 1]
  if (prev && JSON.stringify(prev.lines) === JSON.stringify(f.lines) && prev.cursor.x === f.cursor.x && prev.cursor.y === f.cursor.y) prev.ms += f.ms
  else merged.push({ ...f })
}

// ---------------------------------------------------------------- render

const FONT = 14
const CW = 8.4 // a monospace cell at 14px: 0.6em
const LH = 20
const PAD = 16
const BAR = 30
const W = Math.round(COLS * CW + PAD * 2)
const SCREEN = ROWS * LH + PAD * 2
const H = BAR + SCREEN + BAR

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

// The page's chrome colors per theme (site/index.html).
const CHROME = {
  brass: { bar: "#1f1c15", barFg: "#b5ab95", accent: "#e0ac4c", onAccent: "#17150f" },
  paper: { bar: "#ebe2d5", barFg: "#5a4a40", accent: "#8a5a00", onAccent: "#f5eee3" },
}

// Block elements are drawn as rectangles, so the banner is solid in any font.
const BLOCKS = { "█": [0, 1], "▀": [0, 0.5], "▄": [0.5, 1] }

// One run of styled text: block glyphs as rectangles, the rest as text
// stretched to its cells, so columns line up whatever font the viewer has.
function draw(r, y, fill) {
  let out = ""
  let start = -1
  const flush = (end) => {
    if (start < 0) return
    const s = r.text.slice(start, end)
    if (s.trim()) {
      out += `<text x="${(PAD + (r.x + start) * CW).toFixed(1)}" y="${PAD + y * LH + 15}" textLength="${(s.length * CW).toFixed(1)}" lengthAdjust="spacingAndGlyphs" fill="${fill}"${r.bold ? ' font-weight="700"' : ""}>${esc(s)}</text>`
    }
    start = -1
  }
  ;[...r.text].forEach((ch, i) => {
    const block = BLOCKS[ch]
    if (!block) { if (start < 0) start = i; return }
    flush(i)
    const top = PAD + y * LH + block[0] * LH
    out += `<rect x="${(PAD + (r.x + i) * CW).toFixed(1)}" y="${top.toFixed(1)}" width="${CW}" height="${((block[1] - block[0]) * LH).toFixed(1)}" fill="${fill}"/>`
  })
  flush(r.text.length)
  return out
}

function svg(name) {
  const t = themes[name]
  const c = CHROME[name]
  const total = merged.reduce((n, f) => n + f.ms, 0)
  let at = 0
  const stops = []
  // Each distinct line is drawn once and placed by reference: most lines
  // stay the same from one frame to the next.
  const ids = new Map()
  let defs = ""
  const lineId = (runs) => {
    const key = JSON.stringify(runs)
    if (!ids.has(key)) {
      ids.set(key, ids.size)
      defs += `<g id="l${ids.size - 1}">${runs.map((r) => draw(r, 0, t[r.fg])).join("")}</g>`
    }
    return ids.get(key)
  }
  const reel = merged.map((f, i) => {
    stops.push(`${((at / total) * 100).toFixed(3)}%{transform:translateY(${-i * SCREEN}px)}`)
    at += f.ms
    const text = f.lines.map((runs, y) => (runs.length ? `<use href="#l${lineId(runs)}" y="${y * LH}"/>` : "")).join("")
    const cursor = `<rect x="${(PAD + f.cursor.x * CW).toFixed(1)}" y="${PAD + f.cursor.y * LH + 2}" width="${CW}" height="${LH - 3}" fill="${t.cursor}"/>`
    return `<g transform="translate(0 ${i * SCREEN})">${text}${cursor}</g>`
  }).join("")
  const last = merged.length - 1
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="A rite session: cat, a pipe into head, tee and wc, and sudo refusing the guest">
<style>
rect{shape-rendering:crispEdges}
text{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;font-size:${FONT}px;white-space:pre}
.reel{animation:play ${(total / 1000).toFixed(2)}s step-end infinite}
@keyframes play{${stops.join("")}}
@media (prefers-reduced-motion:reduce){.reel{animation:none;transform:translateY(${-last * SCREEN}px)}}
</style>
<defs>${defs}</defs>
<clipPath id="screen"><rect x="0" y="${BAR}" width="${W}" height="${SCREEN}"/></clipPath>
<rect width="${W}" height="${H}" rx="8" fill="${t.background}"/>
<path d="M0 8a8 8 0 0 1 8-8h${W - 16}a8 8 0 0 1 8 8v${BAR - 8}h-${W}z" fill="${c.bar}"/>
<text x="${W / 2}" y="20" text-anchor="middle" fill="${c.barFg}" style="font-size:12px"><tspan font-weight="700">guest@rite.sh</tspan> · rite · ${COLS}×${ROWS}</text>
<g clip-path="url(#screen)"><g transform="translate(0 ${BAR})"><g class="reel">${reel}</g></g></g>
<path d="M0 ${H - BAR}h${W}v${BAR - 8}a8 8 0 0 1-8 8h-${W - 16}a8 8 0 0 1-8-8z" fill="${c.accent}"/>
<text x="${PAD}" y="${H - 10}" fill="${c.onAccent}" style="font-size:12px"><tspan font-weight="700">[rite] 0:rite*</tspan>  try it: jarrod.md/ritesh</text>
</svg>
`
}

for (const name of ["brass", "paper"]) {
  const out = new URL(`../docs/demo-${name}.svg`, import.meta.url)
  const body = svg(name)
  await writeFile(out, body)
  console.log(`docs/demo-${name}.svg: ${merged.length} frames, ${(body.length / 1024).toFixed(1)} KB`)
}
