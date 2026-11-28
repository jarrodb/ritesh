import { defineConfig } from "vitest/config"
import { jqUntrim } from "./scripts/jq-untrim.mjs"

export default defineConfig({
  // The same jq-wasm change the jq worker is built with (scripts/jq-untrim.mjs).
  plugins: [jqUntrim({ required: false })],
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    server: { deps: { inline: ["jq-wasm"] } },
  },
})
