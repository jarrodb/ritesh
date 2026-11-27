import { defineCommand } from "../define.js"
import { stampLong } from "./util.js"

export const date = defineCommand({
  name: "date",
  summary: "print the date and time",
  usage: "date",
  flags: {},
  manual: "Prints the local date and time as YYYY-MM-DD HH:MM:SS and the UTC offset.",
  run: async (p) => {
    await p.out(stampLong(Date.now()) + "\n")
  },
})
