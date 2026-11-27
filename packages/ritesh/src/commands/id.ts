import { defineCommand } from "../define.js"
import { userName } from "./util.js"

export const id = defineCommand({
  name: "id",
  summary: "print the user and group ids",
  usage: "id",
  flags: {},
  manual: "Prints uid and gid with their names. The gid equals the uid and is for display only.",
  run: async (p) => {
    const who = `${p.uid}(${userName(p, p.uid)})`
    await p.out(`uid=${who} gid=${who}\n`)
  },
})
