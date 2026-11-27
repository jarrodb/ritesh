import { EXIT, RiteError } from "../contracts.js"
import { defineCommand } from "../define.js"
import { body, complain, flag, halted, inputs, reason, source, usageError } from "./util.js"

const USAGE = "grep [-ivncEF] pattern [file...]"

function compile(pattern: string, fixed: boolean, ignoreCase: boolean): RegExp {
  return new RegExp(fixed ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : pattern, ignoreCase ? "i" : "")
}

export const grep = defineCommand({
  name: "grep",
  summary: "print lines that match a pattern",
  usage: USAGE,
  flags: {
    "ignore-case": { long: "ignore-case", short: "i", type: "boolean", description: "match without regard to case" },
    "invert-match": { long: "invert-match", short: "v", type: "boolean", description: "print the lines that do not match" },
    "line-number": { long: "line-number", short: "n", type: "boolean", description: "prefix each line with its number" },
    count: { long: "count", short: "c", type: "boolean", description: "print the number of matching lines instead" },
    "extended-regexp": { long: "extended-regexp", short: "E", type: "boolean", description: "accepted; patterns are always this dialect" },
    "fixed-strings": { long: "fixed-strings", short: "F", type: "boolean", description: "match the pattern as plain text" },
  },
  manual: [
    "Searches each file, or stdin, line by line. The pattern is a JavaScript",
    "regular expression, so +, ?, |, (), and \\d work without -E.",
    "With several files each line is prefixed with its file name.",
    "Exits 0 if a line matched, 1 if none did, 2 on an error.",
  ].join("\n"),
  run: body("grep", async (p) => {
    const [pattern, ...files] = p.args
    if (pattern === undefined) return usageError(p, "grep", USAGE, "missing pattern")
    let re: RegExp
    try {
      re = compile(pattern, flag(p, "fixed-strings"), flag(p, "ignore-case"))
    } catch {
      await complain(p, "grep", pattern, "invalid pattern")
      return EXIT.USAGE
    }
    const invert = flag(p, "invert-match")
    const numbered = flag(p, "line-number")
    const count = flag(p, "count")
    let matched = 0
    let failed = false
    for (const operand of inputs(p, files)) {
      const prefix = files.length > 1 ? `${operand}:` : ""
      let n = 0
      let hits = 0
      try {
        for await (const line of source(p, operand)) {
          if (halted(p)) return
          n++
          if (re.test(line) === invert) continue
          hits++
          if (!count) await p.out(`${prefix}${numbered ? `${n}:` : ""}${line}\n`)
        }
      } catch (e) {
        if (halted(p)) return
        if (!(e instanceof RiteError)) throw e
        await complain(p, "grep", operand, reason(e))
        failed = true
        continue
      }
      if (halted(p)) return
      if (count) await p.out(`${prefix}${hits}\n`)
      matched += hits
    }
    if (failed) return EXIT.USAGE
    return matched > 0 ? EXIT.OK : EXIT.FAILURE
  }),
})
