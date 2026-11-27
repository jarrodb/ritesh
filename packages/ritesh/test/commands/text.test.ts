import { describe, expect, it } from "vitest"
import { RiteError } from "../../src/contracts.js"
import { cat, echo, grep, head, sort, tail, tee, uniq, wc } from "../../src/commands/index.js"
import { endless, HOME, run, world } from "./support.js"

describe("echo", () => {
  it.each([
    [["a", "b"], "a b\n"],
    [[], "\n"],
    [["-n", "a", "b"], "a b"],
    [["-n"], ""],
    [["a", "-n"], "a -n\n"],
    [["-e", "a\\nb"], "-e a\\nb\n"],
    [["--", "x"], "-- x\n"],
    [["--help"], "--help\n"],
    [["-> done"], "-> done\n"],
  ])("echo %j", async (words, stdout) => {
    expect(await run(echo, words)).toEqual({ code: 0, stdout, stderr: "" })
  })
})

describe("cat", () => {
  it("prints files in order", async () => {
    expect(await run(cat, ["notes.txt", "docs/a.txt"])).toEqual({ code: 0, stdout: "alpha\nbeta\ngamma\none two\nthree\n", stderr: "" })
  })

  it("copies stdin unchanged, with or without a final newline", async () => {
    expect(await run(cat, [], { stdin: ["he", "llo"] })).toEqual({ code: 0, stdout: "hello", stderr: "" })
    expect((await run(cat, ["-"], { stdin: "a\nb\n" })).stdout).toBe("a\nb\n")
  })

  it("prints nothing for a closed stdin", async () => {
    expect(await run(cat)).toEqual({ code: 0, stdout: "", stderr: "" })
  })

  it("numbers lines across files with -n", async () => {
    const r = await run(cat, ["-n", "notes.txt", "docs/a.txt"])
    expect(r.stdout).toBe("     1\talpha\n     2\tbeta\n     3\tgamma\n     4\tone two\n     5\tthree\n")
  })

  it("numbers stdin lines with --number", async () => {
    expect((await run(cat, ["--number"], { stdin: ["x\ny", "\nz"] })).stdout).toBe("     1\tx\n     2\ty\n     3\tz\n")
  })

  it("reports a missing file and still prints the rest", async () => {
    expect(await run(cat, ["nope", "notes.txt"])).toEqual({
      code: 1, stdout: "alpha\nbeta\ngamma\n", stderr: "cat: nope: no such file or directory\n",
    })
  })

  it("refuses a directory", async () => {
    expect(await run(cat, ["docs"])).toEqual({ code: 1, stdout: "", stderr: "cat: docs: is a directory\n" })
  })

  it("reports a refused read with the errno's message", async () => {
    const fs = world()
    const denied = { ...fs, read: () => Promise.reject(new RiteError("EACCES", "/root/x", "custom text")) }
    expect(await run(cat, ["/root/x"], { fs: denied })).toEqual({ code: 1, stdout: "", stderr: "cat: /root/x: permission denied\n" })
  })

  it("runs an action through the vfs with via cat and prints its text", async () => {
    const fs = world()
    const seen: string[] = []
    const spy = { ...fs, activate: (...a: Parameters<typeof fs.activate>) => { seen.push(a[2]); return fs.activate(...a) } }
    expect(await run(cat, ["hello"], { fs: spy })).toEqual({ code: 0, stdout: "hello from an action\n", stderr: "" })
    expect(seen).toEqual(["cat"])
  })

  it("prints nothing for an action with no text", async () => {
    expect(await run(cat, ["go"])).toEqual({ code: 0, stdout: "", stderr: "" })
  })

  it("stops with 130 when interrupted while reading stdin", async () => {
    const stop = new AbortController()
    let pulled = 0
    const stdin = endless((n) => { pulled = n; if (n === 50) stop.abort("INT") })
    const r = await run(cat, [], { stdin, signal: stop.signal })
    expect(r.code).toBe(130)
    expect(pulled).toBeLessThan(60)
  })
})

describe("head", () => {
  it("prints ten lines by default", async () => {
    const stdin = Array.from({ length: 12 }, (_, i) => `${i + 1}\n`).join("")
    expect((await run(head, [], { stdin })).stdout).toBe("1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n")
  })

  it.each([
    [["-n", "2", "notes.txt"], "alpha\nbeta\n"],
    [["-n2", "notes.txt"], "alpha\nbeta\n"],
    [["--lines=1", "notes.txt"], "alpha\n"],
    [["--lines", "0", "notes.txt"], ""],
    [["-n", "99", "notes.txt"], "alpha\nbeta\ngamma\n"],
    [["-2", "notes.txt"], "alpha\nbeta\n"],
    [["-0", "notes.txt"], ""],
  ])("head %j", async (words, stdout) => {
    expect(await run(head, words)).toEqual({ code: 0, stdout, stderr: "" })
  })

  it("takes the older -N count on stdin", async () => {
    const stdin = Array.from({ length: 12 }, (_, i) => `${i + 1}\n`).join("")
    expect((await run(head, ["-3"], { stdin })).stdout).toBe("1\n2\n3\n")
    expect((await run(tail, ["-2"], { stdin })).stdout).toBe("11\n12\n")
  })

  it("tail takes the older -N count on a file", async () => {
    expect(await run(tail, ["-1", "notes.txt"])).toEqual({ code: 0, stdout: "gamma\n", stderr: "" })
  })

  it("heads each of several files", async () => {
    expect((await run(head, ["-n", "1", "notes.txt", "docs/a.txt"])).stdout).toBe("==> notes.txt <==\nalpha\n\n==> docs/a.txt <==\none two\n")
  })

  it("stops reading stdin once the lines are printed", async () => {
    let pulled = 0
    const r = await run(head, ["-n", "3"], { stdin: endless((n) => { pulled = n }) })
    expect(r).toEqual({ code: 0, stdout: "line 1\nline 2\nline 3\n", stderr: "" })
    expect(pulled).toBeLessThan(10)
  })

  it("reads nothing for zero lines", async () => {
    let pulled = 0
    expect((await run(head, ["-n", "0"], { stdin: endless((n) => { pulled = n }) })).stdout).toBe("")
    expect(pulled).toBe(0)
  })

  it.each([[["-n", "-1"]], [["-n", "1.5"]]])("rejects the count in %j", async (words) => {
    const r = await run(head, [...words, "notes.txt"])
    expect(r).toEqual({ code: 2, stdout: "", stderr: "head: invalid number of lines\nusage: head [-n lines] [file...]\n" })
  })

  it("reports a missing file with no header and goes on", async () => {
    expect(await run(head, ["-n", "1", "nope", "notes.txt"])).toEqual({
      code: 1, stdout: "==> notes.txt <==\nalpha\n", stderr: "head: nope: no such file or directory\n",
    })
  })
})

describe("tail", () => {
  it("prints the last ten lines by default", async () => {
    const stdin = Array.from({ length: 12 }, (_, i) => `${i + 1}\n`).join("")
    expect((await run(tail, [], { stdin })).stdout).toBe("3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n")
  })

  it.each([
    [["-n", "2", "notes.txt"], "beta\ngamma\n"],
    [["--lines=1", "notes.txt"], "gamma\n"],
    [["-n", "0", "notes.txt"], ""],
    [["-n", "99", "notes.txt"], "alpha\nbeta\ngamma\n"],
  ])("tail %j", async (words, stdout) => {
    expect(await run(tail, words)).toEqual({ code: 0, stdout, stderr: "" })
  })

  it("tails stdin", async () => {
    expect((await run(tail, ["-n", "2"], { stdin: ["a\nb\n", "c\nd"] })).stdout).toBe("c\nd\n")
    expect((await run(tail, ["-n", "0"], { stdin: "a\nb\n" })).stdout).toBe("")
  })

  it("heads each of several files", async () => {
    expect((await run(tail, ["-n", "1", "notes.txt", "docs/a.txt"])).stdout).toBe("==> notes.txt <==\ngamma\n\n==> docs/a.txt <==\nthree\n")
  })

  it("rejects a negative count", async () => {
    expect((await run(tail, ["-n", "-3", "notes.txt"])).code).toBe(2)
  })

  it("reports a missing file", async () => {
    expect(await run(tail, ["nope"])).toEqual({ code: 1, stdout: "", stderr: "tail: nope: no such file or directory\n" })
  })
})

describe("wc", () => {
  it("counts lines, words, and bytes of a file", async () => {
    expect(await run(wc, ["notes.txt"])).toEqual({ code: 0, stdout: " 3  3 17 notes.txt\n", stderr: "" })
  })

  it("counts stdin with no name", async () => {
    expect((await run(wc, [], { stdin: ["a b\n", "c\n"] })).stdout).toBe("2 3 6\n")
  })

  it.each([
    [["-l"], "3\n"],
    [["-w"], "5\n"],
    [["-c"], "14\n"],
    [["-lw"], "3 5\n"],
    [["-c", "-l"], " 3 14\n"],
    [["--lines", "--words", "--bytes"], " 3  5 14\n"],
  ])("wc %j", async (words, stdout) => {
    expect((await run(wc, words, { stdin: "a b\né d\nlast" + "\n" })).stdout).toBe(stdout)
  })

  it("counts a last line without a newline as words and bytes only", async () => {
    expect((await run(wc, [], { stdin: "no newline" })).stdout).toBe(" 0  2 10\n")
  })

  it("totals several files", async () => {
    expect((await run(wc, ["notes.txt", "docs/a.txt"])).stdout).toBe(" 3  3 17 notes.txt\n 2  3 14 docs/a.txt\n 5  6 31 total\n")
  })

  it("reports a missing file and totals the rest", async () => {
    expect(await run(wc, ["-l", "nope", "notes.txt"])).toEqual({
      code: 1, stdout: "3 notes.txt\n3 total\n", stderr: "wc: nope: no such file or directory\n",
    })
  })
})

describe("sort", () => {
  it.each([
    [[], "b\na\nc\n", "a\nb\nc\n"],
    [[], "b\nB\né\nz\n", "B\nb\nz\né\n"],
    [["-r"], "b\na\nc\n", "c\nb\na\n"],
    [[], "10\n9\n2\n", "10\n2\n9\n"],
    [["-n"], "10\n9\n2\n", "2\n9\n10\n"],
    [["-n"], "3 pears\n-1\nnone\n2.5\n", "-1\nnone\n2.5\n3 pears\n"],
    [["-rn"], "10\n9\n2\n", "10\n9\n2\n"],
    [["-u"], "b\na\nb\na\n", "a\nb\n"],
    [["-nu"], "2\n1\n1.0\n", "1\n2\n"],
    [["-ru"], "a\nb\na\n", "b\na\n"],
    [["--reverse", "--numeric-sort", "--unique"], "1\n3\n3\n2\n", "3\n2\n1\n"],
    [[], "last\nfirst", "first\nlast\n"],
    [[], "", ""],
  ])("sort %j of %j", async (words, stdin, stdout) => {
    expect(await run(sort, words, { stdin })).toEqual({ code: 0, stdout, stderr: "" })
  })

  it("sorts several files together", async () => {
    expect((await run(sort, ["notes.txt", "docs/a.txt"])).stdout).toBe("alpha\nbeta\ngamma\none two\nthree\n")
  })

  it("prints nothing when a file cannot be read", async () => {
    expect(await run(sort, ["notes.txt", "nope"])).toEqual({ code: 1, stdout: "", stderr: "sort: nope: no such file or directory\n" })
  })
})

describe("uniq", () => {
  it("drops repeated adjacent lines", async () => {
    expect(await run(uniq, [], { stdin: "a\na\nb\na\n" })).toEqual({ code: 0, stdout: "a\nb\na\n", stderr: "" })
  })

  it("counts with -c", async () => {
    expect((await run(uniq, ["-c"], { stdin: "a\na\nb\na\n" })).stdout).toBe("      2 a\n      1 b\n      1 a\n")
    expect((await run(uniq, ["--count"], { stdin: "" })).stdout).toBe("")
  })

  it("keeps empty lines as lines", async () => {
    expect((await run(uniq, [], { stdin: "\n\na\n" })).stdout).toBe("\na\n")
  })

  it("reads a file", async () => {
    const fs = world()
    fs.put("/tmp/dup", { type: "file", content: "x\nx\ny\n" })
    expect((await run(uniq, ["/tmp/dup"], { fs })).stdout).toBe("x\ny\n")
  })

  it("reports a missing file", async () => {
    expect(await run(uniq, ["nope"])).toEqual({ code: 1, stdout: "", stderr: "uniq: nope: no such file or directory\n" })
  })

  it("takes one file", async () => {
    expect(await run(uniq, ["a", "b"])).toEqual({ code: 2, stdout: "", stderr: "uniq: too many files\nusage: uniq [-c] [file]\n" })
  })
})

describe("tee", () => {
  it("copies stdin to stdout and to each file", async () => {
    const fs = world()
    const r = await run(tee, ["/tmp/a", "b"], { fs, stdin: ["x\n", "y"], cwd: "/tmp" })
    expect(r).toEqual({ code: 0, stdout: "x\ny", stderr: "" })
    expect(await fs.read("/tmp/a", "/")).toBe("x\ny")
    expect(await fs.read("/tmp/b", "/")).toBe("x\ny")
  })

  it("replaces a file, or appends with -a", async () => {
    const fs = world()
    fs.put("/tmp/log", { type: "file", content: "old\n" })
    await run(tee, ["/tmp/log"], { fs, stdin: "new\n" })
    expect(await fs.read("/tmp/log", "/")).toBe("new\n")
    await run(tee, ["-a", "/tmp/log"], { fs, stdin: "more\n" })
    expect(await fs.read("/tmp/log", "/")).toBe("new\nmore\n")
    await run(tee, ["--append", "/tmp/log"], { fs })
    expect(await fs.read("/tmp/log", "/")).toBe("new\nmore\n")
  })

  it("makes an empty file when stdin is empty", async () => {
    const fs = world()
    expect(await run(tee, ["/tmp/empty"], { fs })).toEqual({ code: 0, stdout: "", stderr: "" })
    expect(await fs.read("/tmp/empty", "/")).toBe("")
  })

  it("passes stdin through with no file", async () => {
    expect((await run(tee, [], { stdin: "x\n" })).stdout).toBe("x\n")
  })

  it("reports a file it cannot write and still copies", async () => {
    const fs = world()
    const r = await run(tee, ["docs", "/tmp/ok"], { fs, stdin: "x\n" })
    expect(r).toEqual({ code: 1, stdout: "x\n", stderr: "tee: docs: is a directory\n" })
    expect(await fs.read("/tmp/ok", "/")).toBe("x\n")
  })

  it("drops a file that fails part way and reports it once", async () => {
    const fs = world()
    let writes = 0
    const full = {
      ...fs,
      write: (...a: Parameters<typeof fs.write>) => (++writes > 2 ? Promise.reject(new RiteError("ENOSPC", a[0])) : fs.write(...a)),
    }
    const r = await run(tee, ["/tmp/f"], { fs: full, stdin: ["1", "2", "3"] })
    expect(r).toEqual({ code: 1, stdout: "123", stderr: "tee: /tmp/f: no space left on device\n" })
    expect(await fs.read("/tmp/f", "/")).toBe("1")
  })
})

describe("grep", () => {
  const stdin = "Alpha\nbeta\na.b\naxb\n"

  it.each([
    [["al"], "", 1],
    [["-i", "al"], "Alpha\n", 0],
    [["--ignore-case", "ALPHA"], "Alpha\n", 0],
    [["b"], "beta\na.b\naxb\n", 0],
    [["-v", "b"], "Alpha\n", 0],
    [["--invert-match", "a"], "", 1],
    [["-n", "a.b"], "3:a.b\n4:axb\n", 0],
    [["--line-number", "-F", "a.b"], "3:a.b\n", 0],
    [["--fixed-strings", "a.b"], "a.b\n", 0],
    [["-iF", "A.B"], "a.b\n", 0],
    [["-F", "(["], "", 1],
    [["-c", "b"], "3\n", 0],
    [["--count", "zzz"], "0\n", 1],
    [["-vc", "b"], "1\n", 0],
    [["^(Al|be)"], "Alpha\nbeta\n", 0],
    [["-E", "a.?b|ta$"], "beta\na.b\naxb\n", 0],
    [["--extended-regexp", "\\d"], "", 1],
    [["-in", "ALPHA|BETA"], "1:Alpha\n2:beta\n", 0],
    [["--", "-x"], "", 1],
  ])("grep %j", async (words, stdout, code) => {
    expect(await run(grep, words, { stdin })).toEqual({ code, stdout, stderr: "" })
  })

  it("matches a last line with no newline", async () => {
    expect((await run(grep, ["end"], { stdin: "start\nend" })).stdout).toBe("end\n")
  })

  it("searches a file", async () => {
    expect(await run(grep, ["mm", "notes.txt"])).toEqual({ code: 0, stdout: "gamma\n", stderr: "" })
  })

  it("prefixes lines and counts with the file name for several files", async () => {
    expect((await run(grep, ["t", "notes.txt", "docs/a.txt"])).stdout).toBe("notes.txt:beta\ndocs/a.txt:one two\ndocs/a.txt:three\n")
    expect((await run(grep, ["-n", "t", "notes.txt", "docs/a.txt"])).stdout).toBe("notes.txt:2:beta\ndocs/a.txt:1:one two\ndocs/a.txt:2:three\n")
    expect((await run(grep, ["-c", "t", "notes.txt", "docs/a.txt"])).stdout).toBe("notes.txt:1\ndocs/a.txt:2\n")
  })

  it("exits 2 for a missing pattern", async () => {
    expect(await run(grep)).toEqual({ code: 2, stdout: "", stderr: "grep: missing pattern\nusage: grep [-ivncEF] pattern [file...]\n" })
  })

  it("exits 2 for a pattern that does not compile", async () => {
    expect(await run(grep, ["("], { stdin })).toEqual({ code: 2, stdout: "", stderr: "grep: (: invalid pattern\n" })
  })

  it("exits 2 when a file cannot be read, even with matches elsewhere", async () => {
    expect(await run(grep, ["mm", "nope", "notes.txt", "docs"])).toEqual({
      code: 2, stdout: "notes.txt:gamma\n", stderr: "grep: nope: no such file or directory\ngrep: docs: is a directory\n",
    })
  })

  it("stops with 130 when interrupted over a large stdin", async () => {
    const stop = new AbortController()
    let pulled = 0
    const input = endless((n) => { pulled = n; if (n === 500) stop.abort("INT") })
    const r = await run(grep, ["line"], { stdin: input, signal: stop.signal })
    expect(r.code).toBe(130)
    expect(r.stderr).toBe("")
    expect(r.stdout.startsWith("line 1\nline 2\n")).toBe(true)
    expect(r.stdout.split("\n").length).toBeLessThan(510)
    expect(pulled).toBeLessThan(510)
  })

  it("stops without a count when interrupted with -c", async () => {
    const stop = new AbortController()
    const input = endless((n) => { if (n === 100) stop.abort("INT") })
    expect(await run(grep, ["-c", "line"], { stdin: input, signal: stop.signal })).toEqual({ code: 130, stdout: "", stderr: "" })
  })

  it("fails quietly when its reader has gone", async () => {
    const stop = new AbortController()
    const input = endless((n) => { if (n === 100) stop.abort("EPIPE") })
    const r = await run(grep, ["line"], { stdin: input, signal: stop.signal })
    expect(r.code).toBe(1)
    expect(r.stderr).toBe("")
  })

  it("ends quietly when a call fails after the abort", async () => {
    const stop = new AbortController()
    const fs = world()
    const failing = { ...fs, read: () => { stop.abort("INT"); return Promise.reject(new Error("stream errored")) } }
    expect(await run(grep, ["x", "f"], { fs: failing, signal: stop.signal, cwd: HOME })).toEqual({ code: 130, stdout: "", stderr: "" })
  })
})
