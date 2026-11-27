import type { Parser } from "../contracts.js"
import { lex } from "./lexer.js"
import { parse } from "./parse.js"
import { quoteWord } from "./quote.js"

/** The rite parser. `version` is the one printed in "not supported in rite <version>". */
export function createParser(version: string): Parser {
  return {
    version,
    parse: (line, options) => parse(line, version, options),
    tokenize: (line) => lex(line).tokens,
    quoteWord,
  }
}
