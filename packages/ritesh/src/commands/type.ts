import { EXIT } from "../contracts.js"
import { defineCommand } from "../define.js"
import { body, complain, usageError } from "./util.js"

const USAGE = "type name..."

export const type = defineCommand({
  name: "type",
  summary: "describe how a name would run",
  usage: USAGE,
  flags: {},
  run: body("type", async (p) => {
    if (p.args.length === 0) return usageError(p, "type", USAGE, "missing name")
    let status: number = EXIT.OK
    for (const name of p.args) {
      const found = p.sys.resolve(name)
      if (found.kind === "command") await p.out(`${name} is ${found.path}\n`)
      else if (found.kind === "builtin") await p.out(`${name} is a shell builtin\n`)
      else if (found.kind === "alias") await p.out(`${name} is an alias for ${found.body}\n`)
      else {
        await complain(p, "type", name, "not found")
        status = EXIT.FAILURE
      }
    }
    return status
  }),
})
