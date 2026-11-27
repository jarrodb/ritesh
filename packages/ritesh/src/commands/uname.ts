import { defineCommand } from "../define.js"
import { flag } from "./util.js"

export const uname = defineCommand({
  name: "uname",
  summary: "print the system name",
  usage: "uname [-a]",
  flags: {
    all: { long: "all", short: "a", type: "boolean", description: "also print the hostname, the rite version, and the machine" },
  },
  run: async (p) => {
    const parts = flag(p, "all")
      ? ["rite", p.sys.session.hostname, p.env["RITE_VERSION"] ?? "unknown", "browser"]
      : ["rite"]
    await p.out(parts.join(" ") + "\n")
  },
})
