import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Ajv2020 } from "ajv/dist/2020.js"
import { describe, expect, it } from "vitest"
import { ERRNOS } from "../src/contracts.js"
import { loadTraces, matches, PROTOCOL_DIR } from "./support/trace.js"

interface Schema {
  $id: string
  $defs: { errno: { enum: string[] } }
  "x-methods": Record<string, { kind: string; result: string | null }>
}
const schema = JSON.parse(readFileSync(join(PROTOCOL_DIR, "rite.1.schema.json"), "utf8")) as Schema
const ajv = new Ajv2020({ strict: false, allErrors: true })
const validate = ajv.compile(schema)
const resultValidator = (def: string) => ajv.compile({ $ref: `${schema.$id}#/$defs/${def}` })

describe("rite.1 schema and traces", () => {
  it("shares the errno set with the contracts", () => {
    expect(schema.$defs.errno.enum).toEqual([...ERRNOS])
  })

  for (const [name, lines] of loadTraces()) {
    it(`trace ${name}: every message is valid rite.1, and every result matches its request`, () => {
      const methodById = new Map<unknown, string>()
      for (const line of lines) {
        if (!("msg" in line)) continue
        const msg = line.msg
        if (msg.method === "fs.write" || msg.method === "fs.nothing") continue
        const ok = validate(msg)
        expect(ok, `${name}: ${JSON.stringify(msg)}\n${ajv.errorsText(validate.errors)}`).toBe(true)
        if (line.dir === "c2s" && typeof msg.method === "string" && "id" in msg) methodById.set(msg.id, msg.method)
        if (line.dir === "s2c" && "result" in msg) {
          const method = methodById.get(msg.id)
          expect(method, `${name}: result for unknown id ${String(msg.id)}`).toBeDefined()
          const def = schema["x-methods"][method ?? ""]?.result
          expect(def, `${name}: ${String(method)} has no result schema`).toBeTruthy()
          const check = resultValidator(def ?? "")
          expect(check(msg.result), `${name}: ${String(method)} result ${JSON.stringify(msg.result)}\n${ajv.errorsText(check.errors)}`).toBe(true)
        }
      }
    })
  }

  it("rejects a result that does not match its method", () => {
    expect(resultValidator("HelloResult")("nonsense")).toBe(false)
    expect(resultValidator("StatResult")({ type: "dir" })).toBe(false)
  })

  it("matcher: shape ignores session and data strings", () => {
    expect(matches({ session: "a", n: 1 }, { session: "b", n: 2 }, "shape")).toBe(true)
    expect(matches({ code: 0 }, { code: 1 }, "shape")).toBe(false)
    expect(matches({ a: 1 }, { a: 1, b: 2 }, "exact")).toBe(false)
  })
})
