import { ASSIGNMENT_PREFIX, RESERVED_WORDS } from "./lexer.js"

/** Characters a backslash makes literal in a bare word. Newline is quoted instead. */
const BARE_SPECIAL: ReadonlySet<string> = new Set([
  " ", "\t", "'", '"', "\\", "$", "`", "*", "[", "&", "|", ";", "<", ">", "(", ")", "{", "}",
])
/** Special only as the first character of a word. */
const BARE_LEADING: ReadonlySet<string> = new Set(["#", "~"])

function bare(value: string): string {
  if (value === "") return "''"
  // A reserved word is a literal anywhere once any of it is quoted.
  if (RESERVED_WORDS.has(value)) return "\\" + value
  // NAME=value would be read as an assignment in command position.
  const equals = (ASSIGNMENT_PREFIX.exec(value)?.[0].length ?? 0) - 1
  let out = ""
  for (let i = 0; i < value.length; i++) {
    const c = value.charAt(i)
    if (c === "\n") out += "'\n'"
    else if (BARE_SPECIAL.has(c) || i === equals || (i === 0 && BARE_LEADING.has(c))) out += "\\" + c
    else out += c
  }
  return out
}

function single(value: string): string {
  if (value === "") return "''"
  return value.split("'").map((s) => (s === "" ? "" : `'${s}'`)).join("\\'")
}

/** A backquote cannot be written inside double quotes, so it sits between them, escaped. */
function double(value: string): string {
  if (value === "") return '""'
  return value.split("`").map((s) => (s === "" ? "" : `"${s.replace(/["\\$]/g, "\\$&")}"`)).join("\\`")
}

/** Quote a value so it parses back as one literal word, in any position. */
export function quoteWord(value: string, context: "bare" | "double" | "single"): string {
  switch (context) {
    case "bare":
      return bare(value)
    case "double":
      return double(value)
    case "single":
      return single(value)
  }
}
