import { describe, expect, it } from "vitest"
import { PASS, type SudoPolicy } from "../../src/contracts.js"
import { eggs, sudoers } from "../../src/eggs.js"
import { exec, fakeSys, fakeTty } from "../commands/support.js"

const fire = (argv: string[], sudo: SudoPolicy) =>
  exec(sudoers.run, argv, { flags: {}, args: argv.slice(1) }, { sys: fakeSys({ sudo, session: { user: "ada" } }), tty: fakeTty() })

describe("sudoers", () => {
  it("is shipped, and triggers on every sudo command", () => {
    expect(eggs).toContain(sudoers)
    expect(sudoers.id).toBe("sudoers")
    expect(sudoers.trigger).toEqual({ command: "sudo" })
  })

  it("reports the incident when the host lets nobody use sudo", async () => {
    expect(await fire(["sudo", "rm", "-rf", "/"], false)).toEqual({
      value: 1, stdout: "", stderr: "ada is not in the sudoers file. This incident will be reported.\n",
    })
  })

  it.each([
    ["everybody may", true],
    ["a password decides", () => true],
  ] as const)("passes when %s", async (_, policy) => {
    expect(await fire(["sudo", "whoami"], policy)).toEqual({ value: PASS, stdout: "", stderr: "" })
  })

  it("passes a bare sudo on to the command, which prints its usage", async () => {
    expect(await fire(["sudo"], false)).toEqual({ value: PASS, stdout: "", stderr: "" })
  })
})
