import { EXIT, RiteError } from "../contracts.js"

/** A failure of the shell itself (expansion, redirect, read-only variable), printed as `rite: <message>`. */
export class ShellError extends Error {
  readonly status: number
  constructor(message: string, status: number = EXIT.FAILURE) {
    super(message)
    this.name = "ShellError"
    this.status = status
  }
}

/** The one formatter for what follows the command name: `<path>: <message>`, or the message alone. */
export function describe(e: unknown): string {
  if (e instanceof RiteError) return e.path === undefined || e.path === "" ? e.message : `${e.path}: ${e.message}`
  return e instanceof Error ? e.message : String(e)
}

/** What a command returned, as an exit code: nothing is 0, and codes outside 0 to 255 are clamped. */
export function clampStatus(code: number | void): number {
  if (typeof code !== "number") return EXIT.OK
  if (Number.isNaN(code)) return EXIT.FAILURE
  return Math.min(255, Math.max(0, Math.trunc(code)))
}

export const noop = (): undefined => undefined
