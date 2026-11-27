import { describe, expect, it } from "vitest"
import { shell, VERSION } from "./support.js"

describe("variables", () => {
  it.each([
    // Shell variables are the session's; only exported ones reach a process.
    ["X=1; echo $X; env | grep '^X='", 1, "1\n"],
    ["X=1 Y=2; echo $X$Y", 0, "12\n"],
    ["A=1 B=$A; echo $B", 0, "1\n"],
    ["X=a${UNSET}b\"c d\"'$e'; echo $X", 0, "abc d$e\n"],
    ["X=*; echo \"$X\" $X", 0, "* *\n"],
    ["X=1; X=; echo \"[$X]\"", 0, "[]\n"],
    ["echo \"[$constructor]\" \"[$toString]\" \"[$__proto__]\"", 0, "[] [] []\n"],
    // A command word that expands to nothing leaves the assignments to the session.
    ["X=1 $UNSET; echo $X", 0, "1\n"],
    ["$UNSET; echo $?", 0, "0\n"],
  ])("%s", async (line, code, stdout) => {
    expect(await shell().run(line)).toEqual({ code, stdout, stderr: "" })
  })

  it.each([
    // Scoped to the command: in its environment, and nowhere after it.
    ["X=1 env | grep '^X='; echo \"[$X]\"", 0, "X=1\n[]\n"],
    ["X=1; X=2 env | grep '^X='; echo $X", 0, "X=2\n1\n"],
    ["export X=1; X=2 env | grep '^X='; env | grep '^X='", 0, "X=2\nX=1\n"],
    ["A=1 B=$A env | grep '^[AB]='", 0, "A=1\nB=1\n"],
    ["X=5 true; env | grep '^X='", 1, ""],
    // The command's own words are expanded before its assignments apply.
    ["X=1; X=2 echo $X", 0, "1\n"],
    ["X=1 echo \"[$X]\"", 0, "[]\n"],
    // A builtin sees them in its environment and the session does not keep them.
    ["HOME=/tmp cd; pwd; echo $HOME", 0, "/home/guest\n/home/guest\n"],
    ["X=1 alias a=b; echo \"[$X]\"; alias", 0, "[]\na='b'\n"],
    ["X=1 nosuch 2> /dev/null; echo \"[$X]\"", 0, "[]\n"],
    // PATH scoped to a command is the PATH it is looked up on.
    ["PATH=/nowhere echo hi 2> /dev/null; echo $?; echo back", 0, "127\nback\n"],
  ])("scoped: %s", async (line, code, stdout) => {
    expect(await shell().run(line)).toEqual({ code, stdout, stderr: "" })
  })

  it("sets the kernel variables", async () => {
    const sh = shell()
    expect((await sh.run("echo $UID $SHELL $RITE_VERSION $USER $HOME $HOSTNAME $PATH $PWD $OLDPWD")).stdout)
      .toBe(`1000 /bin/rite ${VERSION} guest /home/guest enroll /bin:/usr/bin /home/guest /home/guest\n`)
    expect(sh.kernel.session).toMatchObject({
      user: "guest", uid: 1000, cwd: "/home/guest", hostname: "enroll", home: "/home/guest", lastStatus: 0,
    })
  })

  it("lets the writable ones change without changing who the user is", async () => {
    const sh = shell()
    expect((await sh.run("USER=root; HOSTNAME=x; whoami; echo $USER $HOSTNAME; env | grep '^USER='")).stdout)
      .toBe("guest\nroot x\nUSER=root\n")
    expect(sh.kernel.session).toMatchObject({ user: "guest", uid: 1000, hostname: "enroll" })
    expect((await sh.run("HOME=/tmp; echo ~ ~/x; cd; pwd")).stdout).toBe("/tmp /tmp/x\n/tmp\n")
    expect((await sh.run("PATH=/nowhere; echo hi")).stderr).toBe("rite: command not found: echo\n")
    expect((await sh.run("PATH=/usr/bin:/bin; unset HOME; echo ~")).stdout).toBe("/home/guest\n")
  })

  it("takes an initial environment, exported, below the read-only variables", async () => {
    const sh = shell({ kernel: { env: { EDITOR: "vi", UID: "0", PATH: "/bin" } } })
    expect((await sh.run("env | grep '^EDITOR='; echo $UID $PATH")).stdout).toBe("EDITOR=vi\n1000 /bin\n")
  })

  it("holds the last pipeline's status in $?", async () => {
    const sh = shell()
    expect((await sh.run("false; echo $?; echo $?")).stdout).toBe("1\n0\n")
    expect((await sh.run("nosuch 2> /dev/null; echo $?")).stdout).toBe("127\n")
    expect((await sh.run("echo ( ")).code).toBe(2)
    expect((await sh.run("echo \"$?\" $?")).stdout).toBe("2 2\n")
    await sh.run("false")
    // An empty line and a comment leave it alone.
    expect((await sh.run("")).code).toBe(1)
    expect((await sh.run("# nothing")).code).toBe(1)
    expect((await sh.run("echo $?")).stdout).toBe("1\n")
    expect((await sh.run("false || echo $?; true && echo $?")).stdout).toBe("1\n0\n")
  })
})

describe("globs", () => {
  const files = {
    "/home/guest/a.txt": "", "/home/guest/b.txt": "", "/home/guest/B.txt": "", "/home/guest/.hidden.txt": "",
    "/home/guest/dir/c.txt": "", "/home/guest/dir/.d": "", "/home/guest/dir2/c.txt": "", "/home/guest/\u00e9.txt": "",
    "/home/guest/\u{1f600}.txt": "", "/home/guest/\uffee.txt": "", "/home/guest/it's": "",
    "/home/guest/x-1.(a)+{b}^$|?": "", "/home/guest/x-2": "",
  }

  it.each([
    // Code point order: the emoji (U+1F600) sorts after U+FFEE, which UTF-16 order gets wrong.
    ["echo *.txt", "B.txt a.txt b.txt \u00e9.txt \uffee.txt \u{1f600}.txt\n"],
    ["echo [ab].txt", "a.txt b.txt\n"],
    ["echo [a-c].txt [!a-zA-Z]*", "a.txt b.txt \u00e9.txt \uffee.txt \u{1f600}.txt\n"],
    ["echo .*", ".hidden.txt\n"],
    ["echo d*/*", "dir/c.txt dir2/c.txt\n"],
    ["echo */c.txt", "dir/c.txt dir2/c.txt\n"],
    ["echo dir/.*", "dir/.d\n"],
    ["echo ~/d*", "/home/guest/dir /home/guest/dir2\n"],
    ["echo $HOME/dir/*", "/home/guest/dir/c.txt\n"],
    ["echo ./dir/* dir//*", "./dir/c.txt dir//c.txt\n"],
    ["echo /t*", "/tmp\n"],
    ["echo \"*\".txt '['ab] a\\*", "*.txt [ab] a*\n"],
    ["echo it*", "it's\n"],
    // Everything but `*` and a class is literal, whatever it means to a regular expression.
    ["echo x-*", "x-1.(a)+{b}^$|? x-2\n"],
    ["echo x-1.'(a)+{b}'^\\$'|'?*", "x-1.(a)+{b}^$|?\n"],
    ["echo x[-]*", "x-1.(a)+{b}^$|? x-2\n"],
    // Only `!` negates: `^` in a class is a member of it.
    ["echo x-[^2] x-[!^2]*", "x-2 x-1.(a)+{b}^$|?\n"],
    ["X='*'; echo $X.txt", "*.txt\n"],
    ["cd dir; echo *", "c.txt\n"],
  ])("%s", async (line, stdout) => {
    expect(await shell({ files }).run(line)).toEqual({ code: 0, stdout, stderr: "" })
  })

  it.each([
    ["echo *.none", "rite: no matches found: *.none\n"],
    ["echo a.txt *.none", "rite: no matches found: *.none\n"],
    ["echo */none", "rite: no matches found: */none\n"],
    ["echo ~/*.none", "rite: no matches found: /home/guest/*.none\n"],
    ["echo /none/*", "rite: no matches found: /none/*\n"],
    ["echo /root/*", "rite: no matches found: /root/*\n"],
    ["echo [z-a]", "rite: no matches found: [z-a]\n"],
    ["echo a.txt/*", "rite: no matches found: a.txt/*\n"],
  ])("%s", async (line, stderr) => {
    const sh = shell({ files })
    expect(await sh.run(line)).toEqual({ code: 1, stdout: "", stderr })
    expect(sh.calls).toEqual([])
  })

  it("fails one pipeline and lets the list go on", async () => {
    expect(await shell().run("echo *.none || echo recovered; echo $?")).toEqual({
      code: 0, stdout: "recovered\n0\n", stderr: "rite: no matches found: *.none\n",
    })
  })
})
