import { type CommandInfo, EXIT } from "../contracts.js"
import { defineCommand } from "../define.js"
import { body, byCodePoint, complain, emit, table } from "./util.js"

function section(title: string, commands: readonly CommandInfo[]): string[] {
  if (commands.length === 0) return []
  return [title, ...table(commands.map((c) => [c.name, c.summary] as const), "  "), ""]
}

export const help = defineCommand({
  name: "help",
  summary: "list commands",
  usage: "help [command...]",
  flags: {},
  manual: [
    "With no argument, lists the shell builtins and the commands with a line each.",
    "With names, prints each command's summary and usage.",
  ].join("\n"),
  run: body("help", async (p) => {
    const all = [...p.sys.commands()].sort((a, b) => byCodePoint(a.name, b.name))
    if (p.args.length === 0) {
      await emit(p, [
        ...section("builtins", all.filter((c) => c.builtin)),
        ...section("commands", all.filter((c) => !c.builtin)),
        "man <command> shows a command's manual.",
      ])
      return EXIT.OK
    }
    let status: number = EXIT.OK
    for (const name of p.args) {
      const info = all.find((c) => c.name === name)
      if (info) await p.out(`${info.name}: ${info.summary}\nusage: ${info.usage}\n`)
      else {
        await complain(p, "help", name, "no such command")
        status = EXIT.FAILURE
      }
    }
    return status
  }),
})
