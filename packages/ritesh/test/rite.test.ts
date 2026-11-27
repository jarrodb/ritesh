// The whole shell over headless xterm: keys in, screen out.
import { describe, expect, it } from "vitest"
import { createRiteOn } from "../src/rite.js"
import { headlessTerm } from "./support/headless.js"

async function settle(h: ReturnType<typeof headlessTerm>, rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => { setImmediate(r) })
    await h.term.write("", "plain")
  }
}

function screen(h: ReturnType<typeof headlessTerm>): string {
  return h.screen().join("\n").trimEnd()
}

describe("rite end to end", () => {
  it("runs a pipeline into a file and reads it back", async () => {
    const h = headlessTerm(80, 24)
    const rite = createRiteOn(h.term, { hostname: "test", user: "guest", motd: "welcome", history: "memory" })
    await rite.ready
    await settle(h)
    h.type("echo hi | cat > /tmp/x\r")
    await settle(h)
    h.type("cat /tmp/x\r")
    await settle(h)
    const s = screen(h)
    expect(s).toContain("welcome")
    expect(s).toMatch(/guest@test ~ % echo hi \| cat > \/tmp\/x/)
    expect(s.split("\n").some((l) => l.trim() === "hi")).toBe(true)
    rite.dispose()
  })

  it("exec runs lines from the host and reports codes", async () => {
    const h = headlessTerm(80, 24)
    const rite = createRiteOn(h.term, { history: "memory", files: { "/home/guest/a.txt": "A\n" } })
    await rite.ready
    expect((await rite.exec("cat ~/a.txt")).code).toBe(0)
    expect((await rite.exec("cat /nope")).code).toBe(1)
    expect((await rite.exec("nosuchcommand")).code).toBe(127)
    rite.dispose()
  })

  it("ships the sudoers egg", async () => {
    const h = headlessTerm(80, 24)
    const rite = createRiteOn(h.term, { history: "memory" })
    await rite.ready
    await rite.exec("sudo ls")
    await settle(h)
    expect(screen(h)).toContain("guest is not in the sudoers file. This incident will be reported.")
    rite.dispose()
  })
})

describe("rite host integration", () => {
  const boot = async (o: Parameters<typeof createRiteOn>[1] = {}) => {
    const h = headlessTerm(80, 24)
    const rite = createRiteOn(h.term, { history: "memory", ...o })
    await rite.ready
    await settle(h)
    return { h, rite }
  }

  it("runs a host exec at the prompt, not onto a half-typed line", async () => {
    const { h, rite } = await boot()
    h.type("ech")
    await settle(h)
    const done = rite.exec("echo from-host")
    await settle(h)
    expect((await done).code).toBe(0)
    const lines = h.screen().map((l) => l.trimEnd())
    expect(lines).toContain("from-host")
    expect(lines.some((l) => l.endsWith("% echo from-host"))).toBe(true)
    rite.dispose()
  })

  it("runs a key egg's own code", async () => {
    let ran = 0
    const { h, rite } = await boot({ eggs: [{ id: "konami", trigger: { keys: "up up down down" }, run: () => { ran++; return Promise.resolve(0) } }] })
    h.type("\x1b[A\x1b[A\x1b[B\x1b[B")
    await settle(h)
    expect(ran).toBe(1)
    expect(h.screen().join("\n")).not.toContain("command not found")
    rite.dispose()
  })

  it("man shows a command's manual", async () => {
    const { h, rite } = await boot({ commands: [{ name: "hello", summary: "say hello", usage: "hello", manual: "A longer story about hello.", run: () => Promise.resolve(0) }] })
    await rite.exec("man hello")
    await settle(h)
    expect(h.screen().join("\n")).toContain("A longer story about hello.")
    rite.dispose()
  })

  it("keeps __proto__ as an ordinary variable", async () => {
    const { h, rite } = await boot()
    await rite.exec("__proto__=x; echo [$__proto__]")
    await settle(h)
    expect(h.screen().map((l) => l.trim())).toContain("[x]")
    rite.dispose()
  })

  it("refuses an action under a directory the user cannot enter", async () => {
    const { h, rite } = await boot({ inodes: { "/root/secret": { type: "action", action: { print: "nope" } } } })
    expect((await rite.exec("cat /root/secret")).code).toBe(1)
    await settle(h)
    expect(h.screen().join("\n")).not.toContain("nope")
    rite.dispose()
  })
})
