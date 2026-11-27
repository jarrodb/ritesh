import { defineCommand } from "../define.js"
import { body, byCodePoint, emit } from "./util.js"

export const env = defineCommand({
  name: "env",
  summary: "print the environment",
  usage: "env",
  flags: {},
  manual: "Prints each exported variable as NAME=value, sorted by name.",
  run: body("env", async (p) => {
    const names = Object.keys(p.env).sort(byCodePoint)
    await emit(p, names.map((name) => `${name}=${p.env[name] ?? ""}`))
  }),
})
