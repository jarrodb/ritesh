import { defineCommand } from "../define.js"

// No flags are declared, so the kernel hands over the words as typed:
// `echo -x`, `echo -- a`, and `echo "-> done"` print what they say.
export const echo = defineCommand({
  name: "echo",
  summary: "print arguments",
  usage: "echo [-n] [arg...]",
  manual: [
    "Prints the arguments separated by one space, then a newline.",
    "A first argument of exactly -n leaves the newline off.",
    "Nothing else is an option and no backslash escapes are interpreted.",
  ].join("\n"),
  run: async (p) => {
    const words = p.argv.slice(1)
    const bare = words[0] === "-n"
    const text = (bare ? words.slice(1) : words).join(" ") + (bare ? "" : "\n")
    if (text !== "") await p.out(text)
  },
})
