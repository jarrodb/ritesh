import { RiteError } from "../contracts.js"
import { defineCommand } from "../define.js"
import { body, each, usageError } from "./util.js"

const USAGE = "touch file..."

export const touch = defineCommand({
  name: "touch",
  summary: "create empty files",
  usage: USAGE,
  flags: {},
  manual: "Creates each file that does not exist. A file that exists keeps its content and its modified time.",
  run: body("touch", async (p) => {
    if (p.args.length === 0) return usageError(p, "touch", USAGE, "missing file")
    return each(p, "touch", p.args, async (file) => {
      try {
        // Existing paths are left alone: a write, even of nothing, would turn a
        // file the host computes into a stored one.
        await p.fs.stat(file, p.cwd, { signal: p.signal })
      } catch (e) {
        if (!(e instanceof RiteError) || e.errno !== "ENOENT") throw e
        await p.fs.write(file, p.cwd, "", { mode: "truncate", signal: p.signal })
      }
    })
  }),
})
