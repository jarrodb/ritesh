import { defineCommand } from "../define.js"
import { body, chunks, each, emit, flag, inputs, source, splitLines } from "./util.js"

export const cat = defineCommand({
  name: "cat",
  summary: "print files or stdin",
  usage: "cat [-n] [file...]",
  flags: {
    number: { long: "number", short: "n", type: "boolean", description: "number the output lines" },
  },
  manual: [
    "Prints each file in order, or stdin when there is none. A file named - is stdin.",
    "An action inode runs its action instead: a print action's text is the output.",
  ].join("\n"),
  run: body("cat", (p) => {
    const numbered = flag(p, "number")
    let n = 0
    const number = (line: string): string => `${String(++n).padStart(6)}\t${line}`

    return each(p, "cat", inputs(p), async (operand) => {
      if (operand === "-") {
        if (numbered) for await (const line of source(p, operand)) await p.out(number(line) + "\n")
        else for await (const chunk of chunks(p)) await p.out(chunk)
        return
      }
      const acted = await p.fs.activate(operand, p.cwd, "cat")
      const text = acted ? acted.output ?? "" : await p.fs.read(operand, p.cwd, { signal: p.signal })
      if (numbered) await emit(p, splitLines(text).map(number))
      else if (text !== "") await p.out(acted && !text.endsWith("\n") ? text + "\n" : text)
    })
  }),
})
