// The jq worker: holds jq (WebAssembly) and runs one filter per message. It
// sees only the input text and the filter: nothing of the page. Its host may
// serve this file with a CSP that adds 'wasm-unsafe-eval' for it alone.
import { type Jq, loadJq } from "jq-wasm"
import { bound } from "./bound.js"
import type { JqRequest, JqResponse } from "./protocol.js"

let jq: Promise<Jq> | undefined

self.onmessage = async (e: MessageEvent<JqRequest>) => {
  const { id, input, filter, flags, wasmURL, maxLines, maxChars } = e.data
  let reply: JqResponse
  try {
    jq ??= loadJq({ wasmURL })
    const r = (await jq).raw(input, filter, flags)
    const out = bound(r.stdout, maxLines, maxChars)
    reply = { id, stdout: out.text, stderr: r.stderr, exitCode: r.exitCode, cut: out.cut }
  } catch (err) {
    // A failed load is not kept: the next run tries again.
    jq = undefined
    reply = { id, stdout: "", stderr: err instanceof Error ? err.message : String(err), exitCode: 2 }
  }
  self.postMessage(reply)
}
