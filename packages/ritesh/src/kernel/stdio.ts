// Where a process reads and writes. A sink is one destination (the terminal,
// a pipe, a file); an Fd counts the holders of a sink, so `2>&1` shares one
// and the sink closes when the last holder lets go.
import { RiteError, type StdioKind, type Vfs, type WriteOptions } from "../contracts.js"
import { noop } from "./errors.js"

export interface Sink {
  readonly kind: StdioKind
  write(chunk: string): Promise<void>
  close(): Promise<void>
}

export class Fd {
  readonly sink: Sink
  private holders = 1

  constructor(sink: Sink) {
    this.sink = sink
  }

  retain(): this {
    this.holders++
    return this
  }

  async release(): Promise<void> {
    if (--this.holders === 0) await this.sink.close()
  }
}

export interface Source {
  readonly kind: StdioKind
  /** The stream, the same one on every call. */
  readonly open: () => ReadableStream<string>
  /** The reader is finished with it. */
  readonly done: () => void
}

/** A stream someone else owns. The kernel takes its writer and never closes it. */
export function streamSink(stream: WritableStream<string>, kind: StdioKind): { sink: Sink; detach: () => void } {
  const writer = stream.getWriter()
  writer.closed.catch(noop)
  return {
    sink: { kind, write: (chunk) => writer.write(chunk), close: () => Promise.resolve() },
    detach: () => { writer.releaseLock() },
  }
}

export interface Pipe {
  readonly sink: Sink
  readonly readable: ReadableStream<string>
  /** Errors both ends, whoever holds them. */
  readonly break: (reason: RiteError) => void
}

export function pipe(): Pipe {
  let controller: TransformStreamDefaultController<string> | undefined
  const stream = new TransformStream<string, string>({ start: (c) => { controller = c } })
  const writer = stream.writable.getWriter()
  writer.closed.catch(noop)
  return {
    readable: stream.readable,
    sink: {
      kind: "pipe",
      write: (chunk) => writer.write(chunk),
      // Resolves once the reader took everything, or the pipe broke.
      close: () => writer.close().catch(noop),
    },
    break: (reason) => { controller?.error(reason) },
  }
}

/** A redirect target: collected in memory and written when the last holder closes it. */
export function fileSink(fs: Vfs, path: string, cwd: string, mode: WriteOptions["mode"]): Sink {
  let data = ""
  return {
    kind: "file",
    write: (chunk) => {
      data += chunk
      return Promise.resolve()
    },
    close: () => (data === "" ? Promise.resolve() : fs.write(path, cwd, data, { mode })),
  }
}

export function streamSource(stream: ReadableStream<string>, kind: StdioKind): Source {
  return { kind, open: () => stream, done: noop }
}

export function textSource(text: string, kind: StdioKind): Source {
  let stream: ReadableStream<string> | undefined
  const open = (): ReadableStream<string> => stream ??= new ReadableStream<string>({
    start: (controller) => {
      if (text !== "") controller.enqueue(text)
      controller.close()
    },
  })
  return { kind, open, done: noop }
}

/** A source another process owns: reading is shared, ending it is the owner's call. */
export function borrow(source: Source): Source {
  return { kind: source.kind, open: () => source.open(), done: noop }
}

/**
 * The terminal's input for one process. Nothing is asked of the terminal
 * until the process reads, and `done` ends the read when the process is gone.
 */
export function lazySource(open: () => ReadableStream<string>, kind: StdioKind): Source {
  let reader: ReadableStreamDefaultReader<string> | undefined
  let ended = false
  const stream = new ReadableStream<string>({
    pull: async (controller) => {
      if (!ended) {
        reader ??= open().getReader()
        const next = await reader.read()
        if (!next.done) {
          controller.enqueue(next.value)
          return
        }
      }
      controller.close()
    },
    cancel: (reason) => reader?.cancel(reason),
  }, { highWaterMark: 0 })
  return {
    kind,
    open: () => stream,
    done: () => {
      ended = true
      reader?.cancel().catch(noop)
    },
  }
}

/** A process's hold on an Fd. Closed when its run settles; writes after that are EPIPE. */
export class Out {
  readonly fd: Fd
  private readonly dead: () => boolean
  private closed = false
  private facade: WritableStream<string> | undefined

  constructor(fd: Fd, dead: () => boolean) {
    this.fd = fd
    this.dead = dead
  }

  write(text: string): Promise<void> {
    if (this.closed || this.dead()) return Promise.reject(new RiteError("EPIPE"))
    return text === "" ? Promise.resolve() : this.fd.sink.write(text)
  }

  get stream(): WritableStream<string> {
    return this.facade ??= new WritableStream<string>({ write: (chunk) => this.write(chunk) })
  }

  close(): void {
    this.closed = true
  }
}

/** A stream split into lines, without terminators. Leaving the loop early releases the stream. */
export function linesOf(stream: ReadableStream<string>): AsyncIterable<string> {
  return {
    async *[Symbol.asyncIterator]() {
      const reader = stream.getReader()
      try {
        let buffer = ""
        for (;;) {
          const next = await reader.read()
          if (next.done) break
          buffer += next.value
          let at = buffer.indexOf("\n")
          while (at >= 0) {
            yield buffer.slice(0, at)
            buffer = buffer.slice(at + 1)
            at = buffer.indexOf("\n")
          }
        }
        if (buffer !== "") yield buffer
      } finally {
        reader.releaseLock()
      }
    },
  }
}
