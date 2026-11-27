import { describe, expect, it } from "vitest"
import type { Span } from "../../src/contracts.js"
import { outcome, parseError, parser, VERSION } from "./support.js"

const unsupported = (token: string): string => `'${token}' is not supported in rite ${VERSION}`

describe("reserved syntax", () => {
  it.each<[string, string, Span]>([
    ["echo `x`", "`", [5, 6]],
    ["echo a`x`", "`", [6, 7]],
    ["echo $(x)", "$(", [5, 7]],
    ["echo a$(x)", "$(", [6, 8]],
    ["echo $((1+2))", "$((", [5, 8]],
    ["echo $'a'", "$'", [5, 7]],
    ["echo $\"a\"", "$\"", [5, 7]],
    ["(echo)", "(", [0, 1]],
    ["echo a(b", "(", [6, 7]],
    ["echo )", ")", [5, 6]],
    ["echo {\"a\":1}", "{", [5, 6]],
    ["echo a{b,c}", "{", [6, 7]],
    ["{ echo; }", "{", [0, 1]],
    ["echo }", "}", [5, 6]],
    ["cat <<EOF", "<<", [4, 6]],
    ["cat << EOF", "<<", [4, 6]],
    ["cat <<<x", "<<<", [4, 7]],
    ["cat <(x)", "<(", [4, 6]],
    ["tee >(x)", ">(", [4, 6]],
    ["a |& b", "|&", [2, 4]],
    ["a &> f", "&>", [2, 4]],
    ["a &>> f", "&>", [2, 4]],
    ["a >| f", ">|", [2, 4]],
    ["a 2>| f", ">|", [3, 5]],
    ["a ;; b", ";;", [2, 4]],
    ["a;;", ";;", [1, 3]],
    ["[[ x ]]", "[[", [0, 2]],
    ["echo [[", "[[", [5, 7]],
    ["echo a[[b]]", "[[", [6, 8]],
    ["((1+2))", "((", [0, 2]],
    ["echo ((", "((", [5, 7]],
    ["echo $0", "$0", [5, 7]],
    ["echo $1", "$1", [5, 7]],
    ["echo $2", "$2", [5, 7]],
    ["echo $3", "$3", [5, 7]],
    ["echo $4", "$4", [5, 7]],
    ["echo $5", "$5", [5, 7]],
    ["echo $6", "$6", [5, 7]],
    ["echo $7", "$7", [5, 7]],
    ["echo $8", "$8", [5, 7]],
    ["echo $9", "$9", [5, 7]],
    ["echo $10", "$1", [5, 7]],
    ["echo a$1b", "$1", [6, 8]],
    ["echo $@", "$@", [5, 7]],
    ["echo $*", "$*", [5, 7]],
    ["echo $#", "$#", [5, 7]],
    ["echo $$", "$$", [5, 7]],
    ["echo $!", "$!", [5, 7]],
    ["echo ${", "${", [5, 7]],
    ["echo ${}", "${", [5, 7]],
    ["echo ${X", "${", [5, 7]],
    ["echo ${X:-y}", "${", [5, 7]],
    ["echo ${#X}", "${", [5, 7]],
    ["echo ${1}", "${", [5, 7]],
    ["echo ${?}", "${", [5, 7]],
    ["echo ${X }", "${", [5, 7]],
    ["echo ~root", "~root", [5, 10]],
    ["echo ~root/x", "~root", [5, 10]],
    ["~root/bin/x", "~root", [0, 5]],
    ["echo ~+", "~+", [5, 7]],
    ["echo ~~", "~~", [5, 7]],
    ["echo **", "**", [5, 7]],
    ["echo a/**/b", "**", [7, 9]],
    ["X=`x`", "`", [2, 3]],
    ["X=$(x)", "$(", [2, 4]],
    ["echo > $(x)", "$(", [7, 9]],
    ["echo a; echo $(x)", "$(", [13, 15]],
    // The `$` and backquote forms are errors inside double quotes too.
    ["echo \"$(x)\"", "$(", [6, 8]],
    ["echo \"a $(x) b\"", "$(", [8, 10]],
    ["echo \"$((1+2))\"", "$((", [6, 9]],
    ["echo \"a`b`\"", "`", [7, 8]],
    ["echo \"`\"", "`", [6, 7]],
    ["echo \"\\`\"", "`", [7, 8]],
    ["echo \"$0\"", "$0", [6, 8]],
    ["echo \"$1\"", "$1", [6, 8]],
    ["echo \"$9\"", "$9", [6, 8]],
    ["echo \"$@\"", "$@", [6, 8]],
    ["echo \"$*\"", "$*", [6, 8]],
    ["echo \"$#\"", "$#", [6, 8]],
    ["echo \"$$\"", "$$", [6, 8]],
    ["echo \"$!\"", "$!", [6, 8]],
    ["echo \"${X:-y}\"", "${", [6, 8]],
    ["echo \"${}\"", "${", [6, 8]],
    ["echo \"${X\"", "${", [6, 8]],
    ["echo \"$X$(x)\"", "$(", [8, 10]],
    ["echo a\"$(x)\"", "$(", [7, 9]],
    ["X=\"$(x)\"", "$(", [3, 5]],
    ["echo > \"$1\"", "$1", [8, 10]],
    // A continuation does not hide a reserved word.
    ["i\\\nf x", "if", [0, 4]],
  ])("%j: '%s'", (line, token, span) => {
    expect(parseError(line)).toEqual({ message: unsupported(token), span })
  })

  it.each<[string, Span]>([
    ["sleep 1 &", [8, 9]],
    ["echo https://x/?a=1&b=2", [19, 20]],
    ["a & b", [2, 3]],
    ["a &&& b", [4, 5]],
    ["a >& f", [3, 4]],
    ["a 2>&2", [4, 5]],
    ["a >&1", [3, 4]],
    ["a >&2x", [3, 4]],
    ["a 2>&1x", [4, 5]],
  ])("%j: '&' with the URL hint", (line, span) => {
    expect(parseError(line)).toEqual({
      message: `'&' is not supported in rite ${VERSION}; quote the argument if it is part of a URL`,
      span,
    })
  })

  const WORDS = [
    "!", "if", "then", "else", "elif", "fi", "for", "in", "do", "done", "while", "until", "case", "esac",
    "function", "return", "break", "continue", "local",
  ]

  it.each(WORDS)("'%s' in command position", (word) => {
    expect(parseError(`${word} x`)).toEqual({ message: unsupported(word), span: [0, word.length] })
    expect(parseError(word)).toEqual({ message: unsupported(word), span: [0, word.length] })
    expect(parseError(`a; ${word}`).message).toBe(unsupported(word))
    expect(parseError(`a | ${word} x`).message).toBe(unsupported(word))
    expect(parseError(`a && ${word}`).message).toBe(unsupported(word))
    expect(parseError(`a || ${word}`).message).toBe(unsupported(word))
    expect(parseError(`X=1 ${word}`).message).toBe(unsupported(word))
    expect(parseError(`> f ${word}`).message).toBe(unsupported(word))
  })

  it.each(WORDS)("'%s' is a word anywhere else, or quoted", (word) => {
    for (const line of [
      `echo ${word}`, `echo a ${word} b`, `'${word}' x`, `"${word}" x`, `\\${word} x`, `${word}x y`, `x${word} y`,
      `echo > ${word}`, `${word}=1`, `X=${word}`,
    ]) {
      expect(outcome(parser.parse(line)), line).toBe("ok")
    }
  })

  it.each([
    "echo '`' '$(x)' '(' ')' '{' '}' '<<' '<<<' '<(' '>(' '|&' '&>' '>|' ';;' '&' '[[' '((' '$1' '$@' '${x:-y}' '~root' '**'",
    "echo \"(\" \")\" \"{\" \"}\" \"<<\" \"<<<\" \"<(\" \">(\" \"|&\" \"&>\" \">|\" \";;\" \"&\" \"[[\" \"((\" \"~root\" \"**\"",
    "echo \"\\$(x)\" \"\\$1\" \"\\$@\" \"\\${x:-y}\" \"\\$'\" \"a\\$\" \"a$\" \"$\" \"$'x'\" \"$X\" \"${X}\" \"$?\" \"$ \" \"$-\"",
    "echo \\` \\$\\(x\\) \\( \\) \\{ \\} \\<\\< \\|\\& \\&\\> \\>\\| \\;\\; \\& \\[\\[ \\$1 \\~root \\*\\*",
    "echo a\\&b 'https://x/?a=1&b=2'",
  ])("quoted, none of it is reserved: %s", (line) => {
    expect(outcome(parser.parse(line))).toBe("ok")
  })

  it("uses the parser's version in the message", () => {
    expect(parser.version).toBe(VERSION)
  })
})

describe("incomplete", () => {
  it.each([
    "echo 'open",
    "echo \"open",
    "'",
    "\"",
    "echo \"a\\\"",
    "echo 'a' 'b",
    "echo a \\",
    "\\",
    "echo a\\",
    "echo a |",
    "echo a | ",
    "echo a &&",
    "echo a ||",
    "echo a || # why",
    "a; b &&",
    "a | b |",
    "a |\n",
    // The quote or backslash may still supply what is missing.
    "> 'open",
    "echo > 'open",
    "echo > \\",
    "a; 'open",
    "a | \"open",
    "X='open",
    "echo \"a\\\n",
    "echo a\\\n\\",
  ])("%j", (line) => {
    expect(outcome(parser.parse(line))).toBe("incomplete")
  })

  it.each([
    "echo a;",
    "echo a ; ",
    "echo 'a\nb'",
    "echo a\\\\",
    "echo a |\nb",
    "echo a &&\n b",
    "echo \\\n",
    "echo a\\\n",
    "echo a |\\\nb",
    "echo \"a\\\nb\"",
    "echo '\\'",
  ])("complete: %j", (line) => {
    expect(outcome(parser.parse(line))).toBe("ok")
  })

  it.each([
    "echo $(x 'open",
    "if 'open",
    "; 'open",
    "a | | 'open",
    "> f | 'open",
    "echo & \\",
    "echo ${ |",
    "echo \"$(x",
    "echo \"a`",
    "echo \"$1",
  ])("an error before the open end wins: %j", (line) => {
    expect(outcome(parser.parse(line))).toBe("syntax")
  })
})

describe("syntax errors", () => {
  it.each<[string, string, Span]>([
    ["> /tmp/x", "redirect with no command", [0, 8]],
    ["2>&1", "redirect with no command", [0, 4]],
    ["< in > out", "redirect with no command", [0, 10]],
    ["X=1 > f", "redirect with no command", [0, 7]],
    ["echo a | > f", "redirect with no command", [9, 12]],
    ["> f | cat", "redirect with no command", [0, 3]],
    ["echo a; > f; echo b", "redirect with no command", [8, 11]],
    ["echo >", "redirect with no target", [5, 6]],
    ["echo > ", "redirect with no target", [5, 6]],
    ["echo >> # c", "redirect with no target", [5, 7]],
    ["echo > > f", "redirect with no target", [5, 6]],
    ["echo 2> | cat", "redirect with no target", [5, 7]],
    ["echo < ; a", "redirect with no target", [5, 6]],
    ["echo > 2>&1", "redirect with no target", [5, 6]],
    [";", "unexpected ';'", [0, 1]],
    ["; a", "unexpected ';'", [0, 1]],
    ["a ; ; b", "unexpected ';'", [4, 5]],
    ["| a", "unexpected '|'", [0, 1]],
    ["a | | b", "unexpected '|'", [4, 5]],
    ["a ||| b", "unexpected '|'", [4, 5]],
    ["&& a", "unexpected '&&'", [0, 2]],
    ["a && || b", "unexpected '||'", [5, 7]],
    ["a | && b", "unexpected '&&'", [4, 6]],
    ["a && ; b", "unexpected ';'", [5, 6]],
    ["a | ;", "unexpected ';'", [4, 5]],
  ])("%j: %s", (line, message, span) => {
    expect(parseError(line)).toEqual({ message, span })
  })
})
