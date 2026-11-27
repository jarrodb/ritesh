import { EXIT, RiteError } from "../contracts.js"

/** One exec: everything ^C has to reach. */
export class Job {
  private aborted = false
  /** One per running stage. */
  readonly controls = new Set<AbortController>()
  /** Error the job's pipes and terminal reads. */
  readonly breakers = new Set<(reason: RiteError) => void>()
  /** Resolves 130 when the job is interrupted, so exec need not wait for commands that ignore the abort. */
  readonly interrupted: Promise<number>
  private settle: (code: number) => void = () => undefined

  constructor() {
    this.interrupted = new Promise((resolve) => { this.settle = resolve })
  }

  /** A call, not a field: the answer changes across an await, and a field read would be narrowed. */
  isAborted(): boolean {
    return this.aborted
  }

  interrupt(): void {
    if (this.aborted) return
    this.aborted = true
    for (const control of this.controls) control.abort("INT")
    for (const breaker of this.breakers) breaker(new RiteError("ECANCELED", undefined, "interrupted"))
    this.settle(EXIT.INTERRUPTED)
  }
}
