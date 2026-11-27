import { defineCommand } from "../define.js"
import { body, each, flag, usageError } from "./util.js"

const USAGE = "mkdir [-p] dir..."

export const mkdir = defineCommand({
  name: "mkdir",
  summary: "make directories",
  usage: USAGE,
  flags: {
    parents: { long: "parents", short: "p", type: "boolean", description: "make missing parents, and accept a directory that exists" },
  },
  run: body("mkdir", async (p) => {
    if (p.args.length === 0) return usageError(p, "mkdir", USAGE, "missing directory")
    const parents = flag(p, "parents")
    return each(p, "mkdir", p.args, (dir) => p.fs.mkdir(dir, p.cwd, { parents, signal: p.signal }))
  }),
})
