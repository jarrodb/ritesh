// Packs the package, installs the tarball in a temp project, and imports every
// export the way a consumer would. publint and attw do not catch a package
// that fails at import time.
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const pkgDir = resolve(import.meta.dirname, "..")
const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"))
const work = mkdtempSync(join(tmpdir(), "ritesh-pack-"))
try {
  const out = execFileSync("npm", ["pack", "--json", "--pack-destination", work], { cwd: pkgDir, encoding: "utf8" })
  const [{ filename, files }] = JSON.parse(out)
  const paths = new Set(files.map((f) => f.path))
  for (const want of ["dist/index.js", "dist/index.d.ts", "dist/eggs.js", "dist/remote.js", "dist/rite.bundle.min.js", "dist/rite.css", "THIRD_PARTY_NOTICES", "LICENSE", "README.md"]) {
    if (!paths.has(want)) throw new Error(`tarball is missing ${want}`)
  }
  writeFileSync(join(work, "package.json"), JSON.stringify({ name: "consumer", private: true, type: "module" }))
  execFileSync("npm", ["install", "--no-audit", "--no-fund", "--silent", join(work, filename)], { cwd: work, stdio: "inherit" })
  const probe = `
    const core = await import("${pkg.name}")
    for (const name of ["createRite", "defineCommand", "defineEgg", "RiteError", "PASS"]) {
      if (!(name in core)) throw new Error("missing export " + name)
    }
    await import("${pkg.name}/eggs")
    await import("${pkg.name}/remote")
    const { createRequire } = await import("node:module")
    const require = createRequire(import.meta.url)
    require.resolve("${pkg.name}/rite.css")
    console.log("pack smoke ok: " + ${JSON.stringify(filename)})
  `
  execFileSync("node", ["--input-type=module", "-e", probe], { cwd: work, stdio: "inherit" })
} finally {
  rmSync(work, { recursive: true, force: true })
}
