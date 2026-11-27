import { EXIT } from "../contracts.js"
import { defineCommand } from "../define.js"
import { body, complain, usageError } from "./util.js"

const USAGE = "which name..."

export const which = defineCommand({
  name: "which",
  summary: "show where a command comes from",
  usage: USAGE,
  flags: {},
  manual: [
    "Prints the path of each command, `<name>: shell builtin` for a builtin,",
    "or `<name>: aliased to <body>` for an alias. Exits 1 if a name is none of these.",
  ].join("\n"),
  run: body("which", async (p) => {
    if (p.args.length === 0) return usageError(p, "which", USAGE, "missing name")
    let status: number = EXIT.OK
    for (const name of p.args) {
      const found = p.sys.resolve(name)
      if (found.kind === "command") await p.out(found.path + "\n")
      else if (found.kind === "builtin") await p.out(`${name}: shell builtin\n`)
      else if (found.kind === "alias") await p.out(`${name}: aliased to ${found.body}\n`)
      else {
        // An egg stays hidden: it answers like a name that is not there.
        await complain(p, "which", name, "not found")
        status = EXIT.FAILURE
      }
    }
    return status
  }),
})
