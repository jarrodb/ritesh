// The vfs as one uid sees it. The vfs takes no uid on reads and writes, so
// the kernel checks `access` first; and it is the kernel, not the vfs, that
// tells the host about an action and opens an `open` action's URL.
import {
  type ActionEvent, type ActionResult, type CallOptions, RiteError, type Vfs, type WriteOptions,
} from "../contracts.js"

export interface ActionHooks {
  onAction: ((event: ActionEvent) => void) | undefined
  /** False when the browser refused, and the URL is printed instead. */
  openUrl: (url: string) => boolean
}

const ROOT_UID = 0

export function fsFor(vfs: Vfs, uid: number, hooks: ActionHooks): Vfs {
  const activate: Vfs["activate"] = async (path, cwd, via): Promise<ActionResult | null> => {
    // The path must be reachable (x on every directory) and the action executable for this uid.
    const node = vfs.peek(path, cwd)
    if (node?.type === "action" && uid !== ROOT_UID) {
      const abs = vfs.resolve(path, cwd)
      const parts = abs.split("/").filter(Boolean)
      for (let i = 0; i < parts.length; i++) {
        const dir = "/" + parts.slice(0, i).join("/")
        if (!(await vfs.access(dir, "/", uid, "x"))) throw new RiteError("EACCES", path)
      }
      if (!(await vfs.access(abs, "/", uid, "x"))) throw new RiteError("EACCES", path)
    }
    const result = await vfs.activate(path, cwd, via)
    if (result === null) return null
    const { event } = result
    hooks.onAction?.(event)
    if (event.defaultPrevented) return { event }
    if (event.kind === "open") {
      // The vfs's own answer about opening is not used: the host hears of the action first.
      return event.url === undefined || hooks.openUrl(event.url) ? { event } : { event, output: event.url }
    }
    return event.kind === "print" ? result : { event }
  }
  // Spelled out, not spread: a vfs may keep its methods on a prototype.
  const base: Vfs = {
    stat: (path, cwd, o) => vfs.stat(path, cwd, o),
    list: (path, cwd, o) => vfs.list(path, cwd, o),
    read: (path, cwd, o) => vfs.read(path, cwd, o),
    write: (path, cwd, data, o) => vfs.write(path, cwd, data, o),
    mkdir: (path, cwd, o) => vfs.mkdir(path, cwd, o),
    remove: (path, cwd, o) => vfs.remove(path, cwd, o),
    activate,
    resolve: (path, cwd) => vfs.resolve(path, cwd),
    peek: (path, cwd) => vfs.peek(path, cwd),
    put: (path, spec) => { vfs.put(path, spec) },
    mount: (path, provider) => { vfs.mount(path, provider) },
    unmount: (path) => { vfs.unmount(path) },
    access: (path, cwd, who, want) => vfs.access(path, cwd, who, want),
  }
  if (uid === ROOT_UID) return base

  const parentOf = (path: string, cwd: string): string => {
    const abs = vfs.resolve(path, cwd)
    return abs.slice(0, abs.lastIndexOf("/")) || "/"
  }
  const missing = (e: unknown): boolean => e instanceof RiteError && e.errno === "ENOENT"

  const need = async (path: string, cwd: string, want: "r" | "w" | "x"): Promise<void> => {
    if (!(await vfs.access(path, cwd, uid, want))) throw new RiteError("EACCES", path)
  }

  /**
   * Entering, and for "w" changing, the directory that holds `path`. A
   * missing directory is the vfs's to report; with `climb` (mkdir -p makes
   * it) the nearest one that exists is checked instead.
   */
  const needParent = async (path: string, cwd: string, want: "w" | "x", climb = false): Promise<void> => {
    let dir = parentOf(path, cwd)
    for (;;) {
      let ok: boolean
      try {
        ok = await vfs.access(dir, "/", uid, "x") && (want === "x" || await vfs.access(dir, "/", uid, "w"))
      } catch (e) {
        if (!(e instanceof RiteError)) throw e
        if (e.errno !== "ENOENT") throw new RiteError(e.errno, path, e.message)
        if (!climb || dir === "/") return
        dir = parentOf(dir, "/")
        continue
      }
      // Something that is not a directory cannot be entered; which error that is, the vfs says.
      if (!ok && vfs.peek(dir, "/")?.type === "dir") throw new RiteError("EACCES", path)
      return
    }
  }

  return {
    ...base,
    stat: async (path, cwd, o?: CallOptions) => {
      if (path !== "") await needParent(path, cwd, "x")
      return vfs.stat(path, cwd, o)
    },
    list: async (path, cwd, o?: CallOptions) => {
      await need(path, cwd, "r")
      return vfs.list(path, cwd, o)
    },
    read: async (path, cwd, o?: CallOptions) => {
      await need(path, cwd, "r")
      return vfs.read(path, cwd, o)
    },
    write: async (path, cwd, data, o: WriteOptions) => {
      try {
        await need(path, cwd, "w")
      } catch (e) {
        if (!missing(e)) throw e
        await needParent(path, cwd, "w")
      }
      return vfs.write(path, cwd, data, o)
    },
    mkdir: async (path, cwd, o) => {
      await needParent(path, cwd, "w", o?.parents === true)
      return vfs.mkdir(path, cwd, o)
    },
    remove: async (path, cwd, o) => {
      await needParent(path, cwd, "w")
      return vfs.remove(path, cwd, o)
    },
  }
}
