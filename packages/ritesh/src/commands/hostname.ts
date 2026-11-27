import { defineCommand } from "../define.js"

export const hostname = defineCommand({
  name: "hostname",
  summary: "print the host name",
  usage: "hostname",
  flags: {},
  run: async (p) => {
    await p.out(p.sys.session.hostname + "\n")
  },
})
