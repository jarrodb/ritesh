import { type InodeType, type Proc, RiteError } from "../contracts.js"
import { defineCommand } from "../define.js"
import { body, each, flag, usageError } from "./util.js"

const USAGE = "rm [-rf] path..."

/** The path's own type, read from its parent's listing: stat follows links. */
async function ownType(p: Proc, abs: string): Promise<InodeType | undefined> {
  const cut = abs.lastIndexOf("/")
  const entries = await p.fs.list(cut === 0 ? "/" : abs.slice(0, cut), "/", { signal: p.signal })
  return entries.find((entry) => entry.name === abs.slice(cut + 1))?.type
}

export const rm = defineCommand({
  name: "rm",
  summary: "remove files and directories",
  usage: USAGE,
  flags: {
    recursive: { long: "recursive", short: "r", type: "boolean", description: "remove directories and what they hold" },
    R: { short: "R", type: "boolean", description: "the same as -r" },
    force: { long: "force", short: "f", type: "boolean", description: "say nothing about paths that do not exist" },
  },
  manual: [
    "Removes each path. A directory needs -r. A link is removed, not what it points at.",
    "The root directory is never removed, with any options.",
  ].join("\n"),
  run: body("rm", async (p) => {
    const recursive = flag(p, "recursive") || flag(p, "R")
    const force = flag(p, "force")
    if (p.args.length === 0) return force ? 0 : usageError(p, "rm", USAGE, "missing path")
    return each(p, "rm", p.args, async (path) => {
      const abs = p.fs.resolve(path, p.cwd)
      if (abs === "/") throw new RiteError("EPERM", path)
      try {
        if (!recursive) {
          const stat = await p.fs.stat(path, p.cwd, { signal: p.signal }).catch((e: unknown) => {
            // A dangling link has no stat and is still there to remove.
            if (e instanceof RiteError && e.errno === "ENOENT") return undefined
            throw e
          })
          if (stat?.type === "dir" && await ownType(p, abs) !== "link") throw new RiteError("EISDIR", path)
        }
        await p.fs.remove(path, p.cwd, { recursive, signal: p.signal })
      } catch (e) {
        if (!force || !(e instanceof RiteError) || e.errno !== "ENOENT") throw e
      }
    })
  }),
})
