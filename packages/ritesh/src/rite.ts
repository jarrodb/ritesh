import { binCommands } from "./commands/index.js"
import type { CommandDef, HostOptions, Rite, Term, Tty } from "./contracts.js"
import { createEditor } from "./editor/index.js"
import { eggs as defaultEggs } from "./eggs/index.js"
import { createKernel } from "./kernel/index.js"
import { createParser } from "./parser/index.js"
import { createVfs } from "./vfs/index.js"

/** The rite version: RITE_VERSION, `rite --version`, and the parser's messages. */
export const VERSION = "0.1.0"

const DEFAULT_PROMPT = "%F{green}%n@%m%f %F{blue}%~%f %# "

/**
 * Wires a shell over a Term. createRite is this with the browser's xterm;
 * tests pass a headless Term.
 */
export function createRiteOn(term: Term, options: Omit<HostOptions, "element">): Rite {
  const hostname = options.hostname ?? "rite"
  const user = options.user ?? "guest"
  const home = `/home/${user}`
  const parser = createParser(VERSION)
  // The kernel opens an action's URL after the host's onAction, so the vfs is given no opener.
  const vfs = createVfs()
  defaultTree(vfs, hostname, user, home, options.motd)
  for (const [path, content] of Object.entries(options.files ?? {})) vfs.put(path, { type: "file", content })
  const hostCommands: Array<{ def: CommandDef; at: string }> = (options.commands ?? []).map((def) => ({ def, at: "/bin" }))
  for (const [path, spec] of Object.entries(options.inodes ?? {})) {
    // A command inode is registered through the kernel, which keeps its
    // definition, in the directory its path names (its mode is the kernel's 0755).
    if (spec.type === "cmd") hostCommands.push({ def: spec.command, at: path.replace(/\/[^/]*$/, "") || "/" })
    else vfs.put(path, spec)
  }
  for (const m of options.mounts ?? []) vfs.mount(m.path, m.provider)

  // The editor is created after the kernel; both refer to each other through this.
  const ref: { editor?: ReturnType<typeof createEditor> } = {}
  const tty: Tty = {
    get cols() { return term.size.cols },
    get rows() { return term.size.rows },
    read: async (o = {}) => {
      if (!ref.editor) return null
      return o.echo === false ? ref.editor.readSecret(o.prompt ?? "") : ref.editor.readText(o.prompt)
    },
    raw: (data) => term.write(data, "raw"),
  }
  const out = term.writer("sgr")
  const err = term.writer("sgr")
  let ended = false
  const kernel = createKernel({
    parser, vfs, hostname, user, home, version: VERSION,
    sudo: options.sudo ?? false,
    openUrl,
    ...(options.onAction ? { onAction: options.onAction } : {}),
    tty: () => tty,
    stdout: new WritableStream({ write: (chunk) => out(chunk) }),
    stderr: new WritableStream({ write: (chunk) => err(chunk) }),
    stdin: () => new ReadableStream<string>({
      pull: async (c) => {
        const line = ref.editor ? await ref.editor.readText() : null
        if (line === null) c.close()
        else c.enqueue(line + "\n")
      },
    }),
    history: () => ref.editor?.history() ?? [],
    onExit: () => { ended = true },
  })
  for (const def of binCommands) kernel.register(def)
  for (const { def, at } of hostCommands) kernel.register(def, at)
  if (options.eggs !== false) for (const egg of [...defaultEggs, ...(options.eggs ?? [])]) kernel.registerEgg(egg)
  const remote = options.remote
  if (remote) {
    vfs.mount(remote.at, remote.provider)
    kernel.addCommandSource(remote.bin, remote.commands)
  }

  const editor = createEditor({
    term, parser,
    complete: (line, cursor, o) => kernel.complete(line, cursor, o),
    prompt: () => renderPrompt(kernel.getenv("PROMPT") ?? DEFAULT_PROMPT, kernel.session),
    history: options.history ?? "local",
    historyKey: `rite:${hostname}:${user}:history`,
    keyEggs: () => kernel.keyEggs(),
    onKeyEgg: (egg) => { void kernel.runEgg(egg) },
    highlight: {
      isCommand: (name) => kernel.vfs.peek(`/bin/${name}`, "/") !== undefined || ["cd", "export", "unset", "alias", "unalias", "exit", "history", "source", "rite"].includes(name),
      pathExists: (word) => kernel.vfs.peek(word, kernel.session.cwd) !== undefined,
    },
    onInterrupt: () => { kernel.interrupt() },
  })
  ref.editor = editor
  // A notice that arrives while a job writes to the terminal waits for the job to end.
  const pendingNotices: string[] = []
  const flushNotices = (): void => {
    while (pendingNotices.length > 0 && !kernel.running) editor.notify(pendingNotices.shift() ?? "")
  }
  const unsubscribe = remote?.onNotify((text) => {
    pendingNotices.push(text)
    flushNotices()
  })
  const offResize = term.onResize(({ cols, rows }) => { remote?.resize(cols, rows) })

  // Host lines (Rite.exec) are submitted at the prompt as if typed, so their
  // output never lands on a line being edited; each resolves with its status.
  const hostRuns: Array<{ line: string; resolve: (code: number) => void }> = []

  const state = { disposed: false }
  // A function, so the check is read again after each await.
  const isDisposed = (): boolean => state.disposed
  const loop = async (): Promise<void> => {
    await kernel.init()
    for (;;) {
      if (isDisposed()) return
      const line = await editor.readLine()
      if (isDisposed()) return
      if (line === null) ended = true
      else {
        const code = await kernel.exec(line)
        if (hostRuns[0]?.line === line) hostRuns.shift()?.resolve(code)
      }
      flushNotices()
      if (ended) {
        await term.write("[session ended]\n", "plain")
        if ((await editor.readText("press Enter to restart ")) === null && isDisposed()) return
        ended = false
      }
    }
  }

  const ready = (async () => {
    const motd = await vfs.read("/etc/motd", "/").catch(() => "")
    // Only the host's own motd keeps its colors; one a mount serves is
    // plain, so it cannot restyle or hide the prompt.
    const policy = options.motd !== undefined && motd === options.motd ? "sgr" : "plain"
    if (motd) await term.write(motd.endsWith("\n") ? motd : motd + "\n", policy)
    // A color the motd left on must not reach the prompt.
    if (policy === "sgr") await term.write("\x1b[0m", "sgr")
  })()
  void ready.then(loop)

  return {
    ready,
    exec: (line) => new Promise((resolve) => {
      hostRuns.push({ line, resolve: (code) => { resolve({ code }) } })
      editor.run(line)
    }),
    print: (text) => { editor.notify(text) },
    focus: () => { term.focus() },
    fit: () => { term.fit() },
    get size() { return term.size },
    onResize: (listener) => term.onResize(listener),
    setTheme: (theme) => { term.setTheme(theme) },
    dispose: () => {
      if (state.disposed) return
      state.disposed = true
      unsubscribe?.()
      offResize()
      for (const run of hostRuns.splice(0)) run.resolve(1)
      remote?.dispose()
      kernel.interrupt()
      editor.dispose()
      term.dispose()
    },
  }
}

function openUrl(url: string): boolean {
  if (typeof window === "undefined") return false
  return window.open(url, "_blank", "noopener,noreferrer") !== null
}

function defaultTree(vfs: ReturnType<typeof createVfs>, hostname: string, user: string, home: string, motd?: string): void {
  vfs.put("/bin", { type: "dir", uid: 0 })
  vfs.put("/usr/share/man", { type: "dir", uid: 0 })
  vfs.put("/etc", { type: "dir", uid: 0 })
  vfs.put("/etc/hostname", { type: "file", content: hostname + "\n", uid: 0 })
  vfs.put("/etc/motd", { type: "file", content: motd ?? "", uid: 0 })
  vfs.put("/root", { type: "dir", uid: 0, mode: 0o700 })
  vfs.put("/tmp", { type: "dir", uid: 0, mode: 0o1777 })
  vfs.put("/dev/null", { type: "dev" })
  vfs.put(home, { type: "dir", uid: 1000 })
  vfs.put(`${home}/.riterc`, { type: "file", uid: 1000, content: `# ${user}'s rite configuration\n` })
}

const COLORS: Record<string, number> = { black: 30, red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, white: 37 }

/** PROMPT escapes: %n user, %m host, %~ cwd, %# (# for root, else %), %? last status, %F{color}...%f, %% a percent. */
export function renderPrompt(prompt: string, s: { user: string; hostname: string; cwd: string; home: string; uid: number; lastStatus: number }): string {
  return prompt.replace(/%(F\{(\w+)\}|[nm~#?f%])/g, (_m, code: string, color: string | undefined) => {
    switch (code[0]) {
      case "n": return s.user
      case "m": return s.hostname
      case "~": return s.cwd === s.home ? "~" : s.cwd.startsWith(s.home + "/") ? "~" + s.cwd.slice(s.home.length) : s.cwd
      case "#": return s.uid === 0 ? "#" : "%"
      case "?": return String(s.lastStatus)
      case "f": return "\x1b[39m"
      case "F": return `\x1b[${String(COLORS[color ?? ""] ?? 39)}m`
      default: return "%"
    }
  })
}
