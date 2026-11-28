---
"riteshjs": minor
---

`riteshjs/jq`: real jq (1.8.2, WebAssembly via jq-wasm) as an opt-in command, in a Web Worker that sees only its input. Input, output, and time limits; control characters in the output are written as text. `jq-worker.js` and `jq.wasm` ship beside it; a strict CSP adds `'wasm-unsafe-eval'` for the worker file alone.
