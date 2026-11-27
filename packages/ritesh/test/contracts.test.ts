import { describe, expect, it } from "vitest"
import { type CommandDef, RiteError } from "../src/contracts.js"
import { cat, echo, echoPipeCat, FakeVfs, runPipeline } from "./support/fakes.js"

describe("phase 0 exit test", () => {
  it("runs echo hi | cat > /tmp/x through the fakes", async () => {
    const vfs = new FakeVfs()
    await vfs.mkdir("/tmp", "/")
    const commands = new Map<string, CommandDef>([["echo", echo], ["cat", cat]])
    const res = await runPipeline(echoPipeCat, vfs, commands)
    expect(res.code).toBe(0)
    expect(res.stdout).toBe("")
    expect(await vfs.read("/tmp/x", "/")).toBe("hi\n")
  })

  it("reports a missing redirect directory as ENOENT", async () => {
    const vfs = new FakeVfs()
    const commands = new Map<string, CommandDef>([["echo", echo], ["cat", cat]])
    await expect(runPipeline(echoPipeCat, vfs, commands)).rejects.toSatisfy((e) => e instanceof RiteError && e.errno === "ENOENT")
  })
})
