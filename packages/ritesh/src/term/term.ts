import type { OutputPolicy, Term, TermSize } from "../contracts.js"
import { createOutputFilter, filterOutput, isTerminalReply } from "./filter.js"

interface Disposable {
  dispose(): void
}

interface UnicodeProvider {
  wcwidth(codePoint: number): 0 | 1 | 2
}

/** The part of xterm's Terminal (browser or headless) that rite uses. */
export interface XtermLike {
  readonly cols: number
  readonly rows: number
  write(data: string, callback?: () => void): void
  onData(listener: (data: string) => void): Disposable
  onResize(listener: (size: { cols: number; rows: number }) => void): Disposable
  readonly unicode: { register(provider: UnicodeProvider): void; activeVersion: string }
  dispose(): void
  focus?(): void
}

export interface UnicodeAddonLike {
  activate(terminal: { unicode: { register(provider: UnicodeProvider): void } }): void
}

/**
 * Builds the Term contract over an xterm instance. The unicode11 addon is
 * activated against a capture object first so rite keeps the provider for
 * its own width calculations, then the provider is registered on the real
 * terminal.
 */
export function createTerm(xterm: XtermLike, unicode: UnicodeAddonLike, hooks: { fit?: () => void } = {}): Term {
  let provider: UnicodeProvider | undefined
  unicode.activate({ unicode: { register: (p) => { provider = p } } })
  if (provider) {
    xterm.unicode.register(provider)
    xterm.unicode.activeVersion = "11"
  }
  const disposables: Disposable[] = []
  const send = (text: string): Promise<void> => new Promise((resolve) => { xterm.write(text, resolve) })
  return {
    write(data: string, policy: OutputPolicy): Promise<void> {
      return send(filterOutput(data, policy))
    },
    writer(policy: OutputPolicy): (chunk: string) => Promise<void> {
      const filter = createOutputFilter(policy)
      return (chunk) => send(filter(chunk))
    },
    onInput(listener: (data: string) => void): () => void {
      const d = xterm.onData((data) => {
        if (!isTerminalReply(data)) listener(data)
      })
      disposables.push(d)
      return () => { d.dispose() }
    },
    onResize(listener: (size: TermSize) => void): () => void {
      const d = xterm.onResize(({ cols, rows }) => { listener({ cols, rows }) })
      disposables.push(d)
      return () => { d.dispose() }
    },
    get size(): TermSize {
      return { cols: xterm.cols, rows: xterm.rows }
    },
    width(codePoint: number): 0 | 1 | 2 {
      if (provider) return provider.wcwidth(codePoint)
      return codePoint < 0x20 ? 0 : 1
    },
    focus(): void {
      xterm.focus?.()
    },
    fit(): void {
      hooks.fit?.()
    },
    dispose(): void {
      for (const d of disposables) d.dispose()
      xterm.dispose()
    },
  }
}
