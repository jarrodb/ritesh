import { EXIT } from "../contracts.js"
import { defineCommand } from "../define.js"

export const trueCommand = defineCommand({
  name: "true",
  summary: "exit 0",
  usage: "true",
  run: () => Promise.resolve(EXIT.OK),
})
