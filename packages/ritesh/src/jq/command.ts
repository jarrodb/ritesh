// The jq command: real jq (jq-wasm) in a Web Worker, with limits on input,
// output, and time. The worker sees only the input text and the filter.
// docs/specs/2026-11-27-ritesh-net-and-jq-design.md.
import type { CommandDef, Proc } from "../contracts.js"
import type { JqRequest, JqResponse } from "./protocol.js"

export interface JqResult {
  stdout: string
  stderr: string
  exitCode: number
  /** The runner cut the output at its limits. */
  cut?: boolean
}

/** Runs one filter. The default runs it in a worker; tests pass their own. */
export interface JqRunner {
  run(input: string, filter: string, flags: string[], signal: AbortSignal): Promise<JqResult>
}

/** The part of a Worker the runner uses. */
export interface WorkerLike {
  postMessage(message: JqRequest): void
  terminate(): void
  addEventListener(type: "message", listener: (e: MessageEvent<JqResponse>) => void): void
  addEventListener(type: "error", listener: (e: ErrorEvent) => void): void
}

export interface JqOptions {
  /** Makes the worker; by default jq-worker.js beside this module. */
  createWorker?: () => WorkerLike
  /** Where the worker loads jq.wasm; by default beside this module. */
  wasmURL?: string
  /** Seconds before a run is stopped and its worker replaced (default 5). */
  timeoutSeconds?: number
  /** Largest input, in characters (default 10 MB). */
  maxInput?: number
  /** Most output lines shown (default 10,000). */
  maxOutputLines?: number
  runner?: JqRunner
}

const EXIT_TIMEOUT = 124

// jq's output is shown as text: control characters, escape sequences among
// them, are written as \xNN. Newlines and tabs stay.
export function printable(s: string): string {
  let out = ""
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0
    const control = (c < 0x20 && c !== 0x09 && c !== 0x0a) || (c >= 0x7f && c <= 0x9f)
    out += control ? `\\x${c.toString(16).padStart(2, "0")}` : ch
  }
  return out
}


/**
 * A runner over one worker at a time. A run that passes its time limit, or is
 * stopped with ^C, terminates the worker, and every run waiting on it ends;
 * the next run starts a fresh worker.
 */
export function workerRunner(o: {
  createWorker: () => WorkerLike
  wasmURL: string
  timeoutMs: number
  maxLines?: number
  maxChars?: number
}): JqRunner {
  let worker: WorkerLike | undefined
  let next = 1
  const pending = new Map<number, (r: JqResult) => void>()
  const kill = (why: string): void => {
    worker?.terminate()
    worker = undefined
    for (const [id, done] of pending) {
      pending.delete(id)
      done({ stdout: "", stderr: why, exitCode: EXIT_TIMEOUT })
    }
  }
  const start = (): WorkerLike => {
    const w = o.createWorker()
    w.addEventListener("message", (e) => {
      const done = pending.get(e.data.id)
      if (!done) return
      pending.delete(e.data.id)
      done({ stdout: e.data.stdout, stderr: e.data.stderr, exitCode: e.data.exitCode, cut: e.data.cut === true })
    })
    w.addEventListener("error", (e) => {
      if (worker === w) kill(`jq: the worker failed${e.message ? `: ${e.message}` : ""}`)
    })
    return w
  }
  return {
    run(input, filter, flags, signal) {
      return new Promise((resolve) => {
        if (signal.aborted) {
          resolve({ stdout: "", stderr: "jq: stopped", exitCode: EXIT_TIMEOUT })
          return
        }
        worker ??= start()
        const id = next++
        const timer = setTimeout(() => {
          kill(`jq: stopped after ${o.timeoutMs / 1000} s`)
        }, o.timeoutMs)
        const onAbort = (): void => {
          kill("jq: stopped")
        }
        signal.addEventListener("abort", onAbort, { once: true })
        pending.set(id, (r) => {
          clearTimeout(timer)
          signal.removeEventListener("abort", onAbort)
          resolve(r)
        })
        worker.postMessage({
          id,
          input,
          filter,
          flags,
          wasmURL: o.wasmURL,
          maxLines: o.maxLines ?? 10_000,
          maxChars: o.maxChars ?? 16 * 1024 * 1024,
        })
      })
    },
  }
}

// The jq options this command takes, each to the form jq-wasm is given.
// Files, modules, and arguments that read the filesystem are not taken.
const FLAGS: Record<string, string> = {
  "-r": "-r", "--raw-output": "-r",
  "-j": "-j", "--join-output": "-j",
  "-c": "-c", "--compact-output": "-c",
  "-s": "-s", "--slurp": "-s",
  "-n": "-n", "--null-input": "-n",
  "-S": "-S", "--sort-keys": "-S",
  "-e": "-e", "--exit-status": "-e",
  "--tab": "--tab",
}

const USAGE = "jq [-r|-j|-c|-s|-n|-S|-e|--tab] [--] <filter>"

function parseWords(words: readonly string[]): { flags: string[]; filter: string } | string {
  const flags: string[] = []
  let i = 0
  for (; i < words.length; i++) {
    const w = words[i] ?? ""
    if (w === "--") {
      i++
      break
    }
    if (w.startsWith("--")) {
      const f = FLAGS[w]
      if (!f) return `jq: ${w} is not taken here`
      flags.push(f)
      continue
    }
    // Letters after one dash are options; anything else (-1, -.a) is the filter.
    if (!/^-[A-Za-z]+$/.test(w)) break
    for (const letter of w.slice(1)) {
      const f = FLAGS[`-${letter}`]
      if (!f) return `jq: -${letter} is not taken here`
      flags.push(f)
    }
  }
  const filter = words[i]
  if (filter === undefined) return `usage: ${USAGE}`
  if (i + 1 < words.length) return "jq: reads stdin only; files are not taken"
  return { flags: [...new Set(flags)], filter }
}

async function readAll(p: Proc, max: number): Promise<string | undefined> {
  const reader = p.stdin.getReader()
  // ^C ends the read; the command then stops with the shell.
  const stop = (): void => {
    void reader.cancel()
  }
  p.signal.addEventListener("abort", stop, { once: true })
  let text = ""
  try {
    for (;;) {
      if (p.signal.aborted) return undefined
      const { value, done } = await reader.read()
      if (done) return text
      text += value
      if (text.length > max) return undefined
    }
  } finally {
    p.signal.removeEventListener("abort", stop)
    reader.releaseLock()
  }
}

/** The jq command, for createRite's `commands`. */
export function command(options: JqOptions = {}): CommandDef {
  const maxInput = options.maxInput ?? 10 * 1024 * 1024
  const maxLines = options.maxOutputLines ?? 10_000
  let runner = options.runner
  const getRunner = (): JqRunner => {
    runner ??= workerRunner({
      createWorker:
        options.createWorker ?? (() => new Worker(new URL("./jq-worker.js", import.meta.url), { type: "module" })),
      wasmURL: options.wasmURL ?? new URL("./jq.wasm", import.meta.url).href,
      timeoutMs: (options.timeoutSeconds ?? 5) * 1000,
      maxLines,
    })
    return runner
  }
  return {
    name: "jq",
    summary: "filter JSON (jq 1.8)",
    usage: USAGE,
    manual: [
      "Real jq, run in a worker that sees only its input. Reads stdin:",
      "`mdm me | jq .account.id`. Takes -r -j -c -s -n -S -e --tab; files and",
      `modules are not taken. Input up to ${Math.round(maxInput / 1024 / 1024)} MB, output up to ${maxLines.toLocaleString("en-US")} lines,`,
      "and a run that takes too long is stopped. Control characters in the output are",
      "written as \\xNN.",
    ].join("\n"),
    run: async (p) => {
      const parsed = parseWords(p.args)
      if (typeof parsed === "string") {
        await p.err(`${parsed}\n`)
        return 2
      }
      let input = ""
      if (!parsed.flags.includes("-n")) {
        const read = await readAll(p, maxInput)
        if (p.signal.aborted) return 130
        if (read === undefined) {
          await p.err(`jq: the input is over ${Math.round(maxInput / 1024 / 1024)} MB\n`)
          return 2
        }
        input = read
      }
      // jq ends each output with a newline (none with -j); the worker's jq
      // keeps stdout as jq wrote it (scripts/jq-untrim.mjs).
      const r = await getRunner().run(input, parsed.filter, parsed.flags, p.signal)
      const text = printable(r.stdout)
      const lines = text.split("\n")
      if (text.endsWith("\n")) lines.pop()
      const over = lines.length > maxLines
      if (text !== "") await p.out(over ? lines.slice(0, maxLines).join("\n") + "\n" : text)
      if (over || r.cut === true) await p.err(`jq: output cut at ${maxLines.toLocaleString("en-US")} lines\n`)
      if (r.stderr !== "") await p.err(printable(r.stderr) + "\n")
      return r.exitCode
    },
  }
}
