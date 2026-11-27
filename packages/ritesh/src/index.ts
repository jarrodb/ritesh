import type { HostOptions, Rite } from "./contracts.js"
import { createRiteOn } from "./rite.js"
import { createBrowserTerm } from "./term/xterm.js"

export * from "./contracts.js"
export { defineCommand, defineEgg } from "./define.js"
export { renderPrompt, VERSION } from "./rite.js"

/** Embed rite in a page. */
export function createRite(options: HostOptions): Rite {
  const term = createBrowserTerm(options.element, {
    ...(options.theme ? { theme: options.theme } : {}),
    ...(options.font ? { font: options.font } : {}),
    ...(options.screenReaderMode !== undefined ? { screenReaderMode: options.screenReaderMode } : {}),
  })
  return createRiteOn(term, options)
}
