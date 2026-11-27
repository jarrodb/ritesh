import { defineCommand } from "../define.js"

/** Cursor home, erase the screen, erase the scrollback. */
const CLEAR = "\x1b[H\x1b[2J\x1b[3J"

export const clear = defineCommand({
  name: "clear",
  summary: "clear the terminal",
  usage: "clear",
  flags: {},
  manual: "Clears the screen and the scrollback. Does nothing when stdout is not the terminal.",
  run: async (p) => {
    await p.tty?.raw(CLEAR)
  },
})
