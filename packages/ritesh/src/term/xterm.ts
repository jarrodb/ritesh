import { FitAddon } from "@xterm/addon-fit"
import { Unicode11Addon } from "@xterm/addon-unicode11"
import { WebLinksAddon } from "@xterm/addon-web-links"
import { Terminal } from "@xterm/xterm"
import type { Term } from "../contracts.js"
import { createTerm } from "./term.js"

export interface BrowserTermOptions {
  theme?: Record<string, string>
  screenReaderMode?: boolean
}

function safeOpen(uri: string): void {
  let url: URL
  try {
    url = new URL(uri)
  } catch {
    return
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return
  window.open(url.href, "_blank", "noopener,noreferrer")
}

/** The browser Term: xterm 6 with fit, unicode11, and web links limited to http and https. */
export function createBrowserTerm(element: HTMLElement, options: BrowserTermOptions = {}): Term {
  const xterm = new Terminal({
    allowProposedApi: true,
    macOptionIsMeta: true,
    screenReaderMode: options.screenReaderMode ?? false,
    convertEol: false,
    cursorBlink: true,
    theme: options.theme ?? {},
    linkHandler: { activate: (_event, uri) => { safeOpen(uri) } },
  })
  const fit = new FitAddon()
  xterm.loadAddon(fit)
  xterm.loadAddon(new WebLinksAddon((_event, uri) => { safeOpen(uri) }))
  xterm.open(element)
  fit.fit()
  return createTerm(xterm, new Unicode11Addon(), { fit: () => { fit.fit() } })
}
