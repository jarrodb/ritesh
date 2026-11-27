import type { Theme } from "./contracts.js"

// Ready-made terminal themes (xterm ITheme keys): brass (rite's default on its
// own site), tide, and dusk are dark; paper is light. Each text color reads on
// its background at 4.5:1 or more, the dim ones included.

/** Dark: warm olive-black, brass accent. */
export const brass = {
  background: "#17150f", foreground: "#e9e2d0", cursor: "#e0ac4c", cursorAccent: "#17150f",
  selectionBackground: "#3d3424",
  black: "#2a261d", red: "#e0715a", green: "#a7c07a", yellow: "#e0ac4c", blue: "#8eaed6", magenta: "#cf96c0", cyan: "#7fc4b8", white: "#cbc3b0",
  brightBlack: "#978d78", brightRed: "#f08a72", brightGreen: "#bfd690", brightYellow: "#f0c470", brightBlue: "#a8c3e6", brightMagenta: "#e0afd2", brightCyan: "#9ad6cb", brightWhite: "#f6f1e4",
} satisfies Theme

/** Dark: deep blue-green black, teal accent. */
export const tide = {
  background: "#0e1417", foreground: "#dbe5e7", cursor: "#63c1c9", cursorAccent: "#0e1417",
  selectionBackground: "#1f3a40",
  black: "#1c2529", red: "#e57a6e", green: "#8fc79a", yellow: "#dcc27a", blue: "#7fb0e0", magenta: "#c79be0", cyan: "#63c1c9", white: "#b9c6c9",
  brightBlack: "#7f9297", brightRed: "#f2968a", brightGreen: "#a9dab2", brightYellow: "#ead596", brightBlue: "#9cc4ec", brightMagenta: "#d8b3ec", brightCyan: "#86d4da", brightWhite: "#f0f6f7",
} satisfies Theme

/** Dark: violet-black, lavender accent. */
export const dusk = {
  background: "#15121b", foreground: "#e4dfec", cursor: "#b6a1e0", cursorAccent: "#15121b",
  selectionBackground: "#34294a",
  black: "#241f2d", red: "#e47b86", green: "#9cc79a", yellow: "#ddc07f", blue: "#8fa8e6", magenta: "#b6a1e0", cyan: "#7ec3c8", white: "#c4bdd0",
  brightBlack: "#8f86a0", brightRed: "#f094a0", brightGreen: "#b4d8b2", brightYellow: "#ead39c", brightBlue: "#a9bdf0", brightMagenta: "#cbbaee", brightCyan: "#9ad5d9", brightWhite: "#f4f0fa",
} satisfies Theme

/** Light: warm paper, ink-dark text, a dark brass cursor (brass's light sibling). */
export const paper = {
  background: "#f5eee3", foreground: "#33241d", cursor: "#8a5a00", cursorAccent: "#f5eee3",
  selectionBackground: "#e8d6b0",
  black: "#33241d", red: "#b3301c", green: "#2f6b3a", yellow: "#8a5a00", blue: "#2e4f8a", magenta: "#8a3a6e", cyan: "#1f6670", white: "#6b5c53",
  brightBlack: "#5a4a40", brightRed: "#b5371f", brightGreen: "#2c7339", brightYellow: "#875e00", brightBlue: "#3c63a8", brightMagenta: "#a3488a", brightCyan: "#22747f", brightWhite: "#6b5c53",
} satisfies Theme
