import { defineConfig } from "tsdown"
import { jqUntrim } from "./scripts/jq-untrim.mjs"

const XTERM = /^@xterm\//
const BUNDLED = [XTERM, "ipaddr.js"]
const banner = "/*! ritesh | MIT | Copyright (c) 2026 Jarrod Baumann | bundles xterm.js and ipaddr.js (MIT, see THIRD_PARTY_NOTICES) */"

export default defineConfig([
  {
    entry: { index: "src/index.ts", eggs: "src/eggs.ts", remote: "src/remote.ts", net: "src/net.ts", jq: "src/jq.ts" },
    format: "esm",
    platform: "browser",
    target: "es2023",
    dts: true,
    clean: true,
    sourcemap: true,
    deps: { alwaysBundle: BUNDLED },
    banner,
    outputOptions: {
      codeSplitting: {
        groups: [{ name: "vendor/xterm", test: /node_modules[\\/]@xterm[\\/]/ }],
      },
    },
  },
  {
    // The jq worker: its own module with jq-wasm inside; jq.wasm is copied beside it.
    entry: { "jq-worker": "src/jq/worker.ts" },
    format: "esm",
    platform: "browser",
    target: "es2023",
    dts: false,
    clean: false,
    sourcemap: false,
    deps: { alwaysBundle: ["jq-wasm"] },
    plugins: [jqUntrim()],
    banner: "/*! ritesh jq worker | MIT | bundles jq-wasm (MIT) and jq (MIT), see THIRD_PARTY_NOTICES */",
  },
  {
    entry: { "rite.bundle": "src/iife.ts" },
    format: "iife",
    platform: "browser",
    target: "es2023",
    globalName: "Rite",
    minify: true,
    dts: false,
    clean: false,
    deps: { alwaysBundle: BUNDLED },
    banner,
    outputOptions: { entryFileNames: "rite.bundle.min.js" },
  },
])
