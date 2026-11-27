import { RiteError } from "../contracts.js"
import { defineCommand } from "../define.js"
import { body, each, usageError, withNewline } from "./util.js"

const USAGE = "open path|url..."
const WEB_URL = /^https?:\/\//i

export const open = defineCommand({
  name: "open",
  summary: "open an action or a URL",
  usage: USAGE,
  flags: {},
  manual: [
    "Runs the action at each path: a navigation, a new tab, a page event, or text to print.",
    "An http or https URL is opened by the page. When the browser blocks the new tab,",
    "the URL is printed instead. Other paths cannot be opened.",
  ].join("\n"),
  run: body("open", async (p) => {
    if (p.args.length === 0) return usageError(p, "open", USAGE, "missing path or URL")
    return each(p, "open", p.args, async (target) => {
      if (WEB_URL.test(target)) {
        // The kernel owns opening URLs; the contract gives a command no call for it yet.
        await p.out(`open: ${target}\n`)
        return
      }
      const acted = await p.fs.activate(target, p.cwd, "open")
      if (acted) {
        if (acted.output !== undefined) await p.out(withNewline(acted.output))
        return
      }
      // Not an action: stat reports a missing path, and anything else has nothing to open.
      await p.fs.stat(target, p.cwd, { signal: p.signal })
      throw new RiteError("ENOTSUP", target)
    })
  }),
})
