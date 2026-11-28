// riteshjs/jq: real jq in a Web Worker. Opt-in:
// createRite({ commands: [jq.command()] }). jq-worker.js and jq.wasm are
// served beside this module; a strict CSP adds 'wasm-unsafe-eval' for the
// worker file alone.
export { command, type JqOptions, type JqResult, type JqRunner, type WorkerLike, workerRunner } from "./jq/command.js"
export type { JqRequest, JqResponse } from "./jq/protocol.js"
