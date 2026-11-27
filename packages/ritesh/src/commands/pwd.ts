import { defineCommand } from "../define.js"

export const pwd = defineCommand({
  name: "pwd",
  summary: "print the working directory",
  usage: "pwd",
  flags: {},
  run: async (p) => {
    await p.out(p.cwd + "\n")
  },
})
