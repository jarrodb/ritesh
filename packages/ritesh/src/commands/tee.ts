import { EXIT, RiteError } from "../contracts.js"
import { defineCommand } from "../define.js"
import { body, chunks, complain, flag, halted, reason } from "./util.js"

export const tee = defineCommand({
  name: "tee",
  summary: "copy stdin to stdout and to files",
  usage: "tee [-a] [file...]",
  flags: {
    append: { long: "append", short: "a", type: "boolean", description: "append to the files instead of replacing them" },
  },
  manual: "Writes what it reads to stdout and to each file. A file that cannot be written is reported and skipped.",
  run: body("tee", async (p) => {
    let status: number = EXIT.OK
    const open = new Set<string>()
    const write = async (file: string, data: string, mode: "truncate" | "append"): Promise<void> => {
      try {
        await p.fs.write(file, p.cwd, data, { mode, signal: p.signal })
        open.add(file)
      } catch (e) {
        if (halted(p) || !(e instanceof RiteError)) throw e
        await complain(p, "tee", file, reason(e))
        open.delete(file)
        status = EXIT.FAILURE
      }
    }
    // Opened before any input arrives, as a redirect target is.
    for (const file of p.args) await write(file, "", flag(p, "append") ? "append" : "truncate")
    for await (const chunk of chunks(p)) {
      await p.out(chunk)
      for (const file of [...open]) await write(file, chunk, "append")
    }
    return status
  }),
})
