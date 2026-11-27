// Copies protocol/rite.1.schema.json into the Go module (for go:embed) and
// generates the TypeScript message types. CI runs this and fails on a diff.
import { copyFile, writeFile } from "node:fs/promises"
import { readFile } from "node:fs/promises"
import { compile } from "json-schema-to-typescript"

const root = new URL("..", import.meta.url)
const schema = new URL("protocol/rite.1.schema.json", root)
await copyFile(schema, new URL("server/rite.1.schema.json", root))
// The root schema is a oneOf over messages; result types are only reachable
// through x-methods. Compile a wrapper that names every definition so each
// one is emitted as an exported type.
const doc = JSON.parse(await readFile(schema, "utf8"))
const wrapper = {
  title: "Rite1",
  type: "object",
  additionalProperties: false,
  properties: {
    message: { $ref: "#/$defs/Message" },
    ...Object.fromEntries(Object.keys(doc.$defs).map((k) => [k, { $ref: `#/$defs/${k}` }])),
  },
  $defs: { ...doc.$defs, Message: { title: "Rite1Message", oneOf: doc.oneOf } },
}
const ts = await compile(wrapper, "Rite1", {
  bannerComment: "// Generated from protocol/rite.1.schema.json by scripts/sync-protocol.mjs. Do not edit.",
  additionalProperties: true,
  unreachableDefinitions: true,
  style: { semi: false },
})
await writeFile(new URL("packages/ritesh/src/remote/protocol.gen.ts", root), ts)
