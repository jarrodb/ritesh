import type { HostOptions, Rite } from "./contracts.js"
import { createBrowserTerm } from "./term/xterm.js"

export * from "./contracts.js"
export { defineCommand, defineEgg } from "./define.js"

/** Embed rite in a page. The kernel and editor are wired in phase 3. */
export function createRite(options: HostOptions): Rite {
  const term = createBrowserTerm(options.element, {
    ...(options.theme ? { theme: options.theme } : {}),
    ...(options.screenReaderMode !== undefined ? { screenReaderMode: options.screenReaderMode } : {}),
  })
  const ready = term.write((options.motd ?? "") + "\n", "plain")
  return {
    ready,
    exec: () => Promise.reject(new Error("ritesh: the kernel is not implemented yet")),
    print: (text) => { void term.write(text + "\n", "plain") },
    focus: () => { term.focus() },
    fit: () => { term.fit() },
    dispose: () => { term.dispose() },
  }
}
