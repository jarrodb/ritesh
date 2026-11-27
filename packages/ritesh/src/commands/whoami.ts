import { defineCommand } from "../define.js"
import { userName } from "./util.js"

export const whoami = defineCommand({
  name: "whoami",
  summary: "print the user name",
  usage: "whoami",
  flags: {},
  manual: "Prints the name for the uid the command runs as: root under sudo.",
  run: async (p) => {
    await p.out(userName(p, p.uid) + "\n")
  },
})
