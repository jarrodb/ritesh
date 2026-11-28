import { defineConfig } from "tsdown"

const XTERM = /^@xterm\//
const BUNDLED = [XTERM, "ipaddr.js"]
const banner = "/*! ritesh | MIT | Copyright (c) 2026 Jarrod Baumann | bundles xterm.js and ipaddr.js (MIT, see THIRD_PARTY_NOTICES) */"

export default defineConfig([
  {
    entry: { index: "src/index.ts", eggs: "src/eggs.ts", remote: "src/remote.ts", net: "src/net.ts" },
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
