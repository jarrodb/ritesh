// jq-wasm trims jq's captured stdout (raw(): stdoutSink.toString().trim()),
// which drops the leading and trailing whitespace of jq -r and -j output and
// an empty string's line. This removes that one trim, for stdout only. The
// build fails if a jq-wasm upgrade moves or duplicates it, so the change is
// never silently lost.
const TARGET = "stdoutSink.toString().trim()"

export function jqUntrim({ required = true } = {}) {
  let replaced = 0
  return {
    name: "jq-untrim",
    transform(code, id) {
      if (!id.includes("jq-wasm") || !code.includes(TARGET)) return null
      const count = code.split(TARGET).length - 1
      if (count !== 1) this.error(`jq-untrim: expected one stdout trim in ${id}, found ${count}`)
      replaced++
      return { code: code.replace(TARGET, "stdoutSink.toString()"), map: null }
    },
    buildEnd() {
      if (required && replaced === 0) this.error("jq-untrim: jq-wasm no longer trims stdout where expected; check jq -r whitespace")
    },
  }
}
