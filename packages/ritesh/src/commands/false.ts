import { EXIT } from "../contracts.js"
import { defineCommand } from "../define.js"

export const falseCommand = defineCommand({
  name: "false",
  summary: "exit 1",
  usage: "false",
  run: () => Promise.resolve(EXIT.FAILURE),
})
