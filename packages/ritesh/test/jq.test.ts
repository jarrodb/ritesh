import { type Jq, loadJq } from "jq-wasm"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { command, type JqRequest, type JqResponse, type JqRunner, workerRunner, type WorkerLike } from "../src/jq.js"
import { bound } from "../src/jq/bound.js"
import { run } from "./commands/support.js"

// Real jq in this process: what the worker does, without the worker.
let jq: Jq
beforeAll(async () => {
  jq = await loadJq()
})
const inProcess: JqRunner = {
  run: (input, filter, flags) => Promise.resolve(jq.raw(input, filter, flags)),
}
const jqCmd = (o: Parameters<typeof command>[0] = {}) => command({ runner: inProcess, ...o })

describe("jq", () => {
  it("filters stdin", async () => {
    const r = await run(jqCmd(), [".a[]"], { stdin: '{"a":[1,2,3]}' })
    expect(r).toEqual({ code: 0, stdout: "1\n2\n3\n", stderr: "" })
  })

  it.each([
    [["-r", ".name"], '{"name":"Ada"}', "Ada\n"],
    [["-c", "."], '{"a": [1, 2]}', '{"a":[1,2]}\n'],
    [["-rc", ".[]"], '["x","y"]', "x\ny\n"],
    [["-s", "length"], "1 2 3", "3\n"],
    [["-n", "[1,2] | add"], "", "3\n"],
    [["-S", "-c", "."], '{"b":1,"a":2}', '{"a":2,"b":1}\n'],
  ])("jq %j", async (words, stdin, stdout) => {
    expect((await run(jqCmd(), words, { stdin })).stdout).toBe(stdout)
  })

  it("keeps the whitespace of raw output, and joins -j output with no newline", async () => {
    expect((await run(jqCmd(), ["-r", ".a"], { stdin: '{"a":"  x  "}' })).stdout).toBe("  x  \n")
    expect((await run(jqCmd(), ["-r", ".a[]"], { stdin: '{"a":[" p "," q "]}' })).stdout).toBe(" p \n q \n")
    expect((await run(jqCmd(), ["-jn", '" a", "b "'])).stdout).toBe(" ab ")
    expect((await run(jqCmd(), ["-r", ".a # a comment"], { stdin: '{"a":"x"}' })).stdout).toBe("x\n")
    expect((await run(jqCmd(), ["-rn", 'def f: " y"; f'])).stdout).toBe(" y\n")
    expect((await run(jqCmd(), ["-rn", "empty"])).stdout).toBe("")
  })

  it("keeps -e's exit status and raw whitespace together", async () => {
    expect((await run(jqCmd(), ["-re", ".a"], { stdin: '{"a":false}' })).code).toBe(1)
    const r = await run(jqCmd(), ["-re", "."], { stdin: '"  x  "' })
    expect(r).toEqual({ code: 0, stdout: "  x  \n", stderr: "" })
  })

  it("keeps every input's raw output, and an empty string's line", async () => {
    expect((await run(jqCmd(), ["-r", "."], { stdin: '"a" " b "' })).stdout).toBe("a\n b \n")
    expect((await run(jqCmd(), ["-r", "."], { stdin: '""' })).stdout).toBe("\n")
  })

  it("reads a filter that starts with a dash", async () => {
    expect((await run(jqCmd(), ["-n", "-1"])).stdout).toBe("-1\n")
    expect((await run(jqCmd(), ["-n", "--", "-2"])).stdout).toBe("-2\n")
  })

  it("writes control characters in the output as text", async () => {
    const r = await run(jqCmd(), ["-r", ".a"], { stdin: '{"a":"x\\u001b]52;c;Zm9v\\u0007y"}' })
    expect(r.stdout).toBe("x\\x1b]52;c;Zm9v\\x07y\n")
    expect(r.stdout).not.toContain("\x1b")
  })

  it("reports jq's errors with its exit code", async () => {
    const bad = await run(jqCmd(), ["."], { stdin: "not json" })
    expect(bad.code).toBe(5)
    expect(bad.stderr).toContain("parse error")
    const syntax = await run(jqCmd(), [".["], { stdin: "{}" })
    expect(syntax.code).toBe(3)
    expect(syntax.stderr).toContain("syntax error")
  })

  it.each([
    [["-f", "x.jq"], "-f is not taken"],
    [["--arg", "a", "b", "."], "--arg is not taken"],
    [["-L", "/", "."], "-L is not taken"],
    [[".", "file.json"], "reads stdin only"],
    [[], "usage: jq"],
  ])("refuses %j", async (words, why) => {
    const r = await run(jqCmd(), words, { stdin: "{}" })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain(why)
  })

  it("refuses input over the limit before running jq", async () => {
    const runner = { run: vi.fn() }
    const r = await run(command({ runner, maxInput: 10 }), ["."], { stdin: '"0123456789abc"' })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain("the input is over")
    expect(runner.run).not.toHaveBeenCalled()
  })

  it("cuts output at the line limit", async () => {
    const r = await run(jqCmd({ maxOutputLines: 3 }), ["-n", "range(10)"])
    expect(r.stdout).toBe("0\n1\n2\n")
    expect(r.stderr).toContain("output cut at 3 lines")
  })
})

describe("the worker's output bound", () => {
  it("keeps whole lines up to the limits and says when it cut", () => {
    expect(bound("a\nb\nc\n", 2, 100)).toEqual({ text: "a\nb\n", cut: true })
    expect(bound("a\nb\n", 5, 100)).toEqual({ text: "a\nb\n", cut: false })
    expect(bound("abcdef", 5, 3)).toEqual({ text: "abc", cut: true })
    expect(bound("", 5, 3)).toEqual({ text: "", cut: false })
  })
})

describe("stopping", () => {
  it("stops reading stdin on ^C", async () => {
    const ac = new AbortController()
    let pulls = 0
    const stdin = new ReadableStream<string>({
      pull: (c) => {
        pulls++
        if (pulls === 2) ac.abort()
        c.enqueue("x")
      },
    }, { highWaterMark: 0 })
    const runner = { run: vi.fn() }
    const r = await run(command({ runner }), ["."], { stdin, signal: ac.signal })
    expect(r.code).toBe(130)
    expect(runner.run).not.toHaveBeenCalled()
    expect(pulls).toBeLessThan(5)
  })

  it("reports a cut the worker made", async () => {
    const runner: JqRunner = { run: () => Promise.resolve({ stdout: "1\n2\n", stderr: "", exitCode: 0, cut: true }) }
    const r = await run(command({ runner }), ["."], { stdin: "{}" })
    expect(r.stdout).toBe("1\n2\n")
    expect(r.stderr).toContain("output cut")
  })
})

// A worker that answers, or does not, as a test tells it.
class FakeWorker implements WorkerLike {
  terminated = false
  sent: JqRequest[] = []
  private onMessage: ((e: MessageEvent<JqResponse>) => void) | undefined
  private onError: ((e: ErrorEvent) => void) | undefined
  constructor(private readonly answer: (r: JqRequest) => JqResponse | undefined) {}
  postMessage(m: JqRequest): void {
    this.sent.push(m)
    const reply = this.answer(m)
    if (reply) queueMicrotask(() => this.onMessage?.({ data: reply } as MessageEvent<JqResponse>))
  }
  terminate(): void {
    this.terminated = true
  }
  addEventListener(type: "message" | "error", listener: (e: never) => void): void {
    if (type === "message") this.onMessage = listener as (e: MessageEvent<JqResponse>) => void
    else this.onError = listener as (e: ErrorEvent) => void
  }
  fail(message: string): void {
    this.onError?.({ message } as ErrorEvent)
  }
}

describe("the worker runner", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("sends the input, filter, flags, and wasm URL, and returns the reply", async () => {
    const w = new FakeWorker((m) => ({ id: m.id, stdout: "ok", stderr: "", exitCode: 0 }))
    const runner = workerRunner({ createWorker: () => w, wasmURL: "https://x.test/jq.wasm", timeoutMs: 5000 })
    const r = await runner.run("{}", ".", ["-c"], new AbortController().signal)
    expect(r).toEqual({ stdout: "ok", stderr: "", exitCode: 0, cut: false })
    expect(w.sent[0]).toMatchObject({ input: "{}", filter: ".", flags: ["-c"], wasmURL: "https://x.test/jq.wasm", maxLines: 10_000 })
  })

  it("stops a run past its time, and starts a fresh worker next", async () => {
    vi.useFakeTimers()
    const workers: FakeWorker[] = []
    const runner = workerRunner({
      createWorker: () => {
        const w = new FakeWorker((m) => (workers.length > 1 ? { id: m.id, stdout: "again", stderr: "", exitCode: 0 } : undefined))
        workers.push(w)
        return w
      },
      wasmURL: "x",
      timeoutMs: 5000,
    })
    const stuck = runner.run("{}", "repeat(.)", [], new AbortController().signal)
    await vi.advanceTimersByTimeAsync(5000)
    expect(await stuck).toEqual({ stdout: "", stderr: "jq: stopped after 5 s", exitCode: 124 })
    expect(workers[0]?.terminated).toBe(true)
    vi.useRealTimers()
    expect((await runner.run("{}", ".", [], new AbortController().signal)).stdout).toBe("again")
    expect(workers).toHaveLength(2)
  })

  it("stops a run on ^C", async () => {
    const w = new FakeWorker(() => undefined)
    const runner = workerRunner({ createWorker: () => w, wasmURL: "x", timeoutMs: 5000 })
    const ac = new AbortController()
    const r = runner.run("{}", ".", [], ac.signal)
    ac.abort()
    expect((await r).stderr).toBe("jq: stopped")
    expect(w.terminated).toBe(true)
  })

  it("never starts a run that was already stopped", async () => {
    const w = new FakeWorker(() => undefined)
    const runner = workerRunner({ createWorker: () => w, wasmURL: "x", timeoutMs: 5000 })
    const ac = new AbortController()
    ac.abort()
    expect((await runner.run("{}", ".", [], ac.signal)).stderr).toBe("jq: stopped")
    expect(w.sent).toHaveLength(0)
  })

  it("ends every waiting run when the worker fails", async () => {
    const w = new FakeWorker(() => undefined)
    const runner = workerRunner({ createWorker: () => w, wasmURL: "x", timeoutMs: 5000 })
    const a = runner.run("1", ".", [], new AbortController().signal)
    const b = runner.run("2", ".", [], new AbortController().signal)
    w.fail("out of memory")
    expect((await a).stderr).toContain("the worker failed: out of memory")
    expect((await b).stderr).toContain("the worker failed")
  })
})
