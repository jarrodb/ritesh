// One rite.1 connection at a time: the handshake, request ids, reconnects with
// backoff, and the idle disconnect. Everything above it (files, processes)
// sends through request and notify and hears onUp, onDown, and onNotification.
import type { RiteError, TermSize } from "../contracts.js"
import { backoffDelay, NO_RETRY_CODES } from "./backoff.js"
import { type Hello, parseHello } from "./parse.js"
import type { HelloParams } from "./protocol.gen.js"
import {
  canceled, CLIENT_VERSION, type Clock, errorFromResponse, isRecord, messageOf, notConnected,
  type SocketFactory, type SocketLike, SUBPROTOCOL,
} from "./wire.js"

/** From opening the socket to the rite.hello result. */
export const HELLO_TIMEOUT_MS = 10_000

export interface LinkConfig {
  url: string
  /** Called on every connection attempt. */
  token: () => string | Promise<string>
  /** Stay connected: reconnect after a retryable close, never disconnect when idle. */
  eager: boolean
  socket: SocketFactory
  clock: Clock
  random: () => number
  /** True while something outside the link (a running process) needs the connection. */
  busy: () => boolean
  /** rite.hello succeeded on a new connection. */
  onUp: (hello: Hello) => void
  /** The connection that was up is gone, for any reason but dispose. */
  onDown: () => void
  onNotification: (method: string, params: unknown) => void
}

type State = "idle" | "waiting" | "connecting" | "ready" | "disposed"

interface Pending {
  path: string | undefined
  resolve: (value: unknown) => void
  reject: (error: RiteError) => void
}

/** One connection attempt, shared by everyone waiting for it. */
interface Attempt {
  promise: Promise<void>
  resolve: () => void
  reject: (error: RiteError) => void
}

function newAttempt(): Attempt {
  let resolve: () => void = () => undefined
  let reject: (error: RiteError) => void = () => undefined
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  // An attempt nobody waits on (an eager retry) must not be an unhandled rejection.
  promise.catch(() => undefined)
  return { promise, resolve, reject }
}

function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { reject(canceled()) }
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort)
        reject(error instanceof Error ? error : notConnected(messageOf(error)))
      },
    )
  })
}

export class Link {
  /** The terminal size sent in rite.hello. Whoever sends tty.resize updates it. */
  tty: TermSize = { cols: 80, rows: 24 }

  private readonly cfg: LinkConfig
  private state: State = "idle"
  private socket: SocketLike | undefined
  /** Bumped per attempt and on dispose, so a late token() result is dropped. */
  private generation = 0
  private nextId = 1
  private helloId = 0
  private readonly pending = new Map<number, Pending>()
  private attempt: Attempt | undefined
  /** Consecutive failures since the last successful hello. */
  private failures = 0
  /** No attempt starts before this time. */
  private notBefore = 0
  private retryTimer: unknown
  private helloTimer: unknown
  private idleTimer: unknown
  private lastActivity = 0
  private known: Hello | undefined
  private session: string | undefined

  constructor(cfg: LinkConfig) {
    this.cfg = cfg
  }

  get ready(): boolean {
    return this.state === "ready"
  }

  /** What the last successful rite.hello returned. Kept across disconnects. */
  get hello(): Hello | undefined {
    return this.known
  }

  get bufferedAmount(): number {
    return this.socket?.bufferedAmount ?? 0
  }

  /**
   * Resolves once rite.hello has succeeded. Starts an attempt when there is
   * none, after any backoff still owed. Waits for one attempt only: when it
   * fails the caller gets ENOTCONN and the next use tries again.
   */
  ensure(signal?: AbortSignal): Promise<void> {
    if (this.state === "disposed") return Promise.reject(notConnected("remote disposed"))
    if (this.state === "ready") return Promise.resolve()
    if (signal?.aborted) return Promise.reject(canceled())
    const attempt = this.attempt ?? this.schedule()
    return signal ? untilAborted(attempt.promise, signal) : attempt.promise
  }

  /** Sends a request, connecting first if needed. Not replayed when the connection drops. */
  request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.state === "ready") return this.exchange(method, params, signal)
    return this.ensure(signal).then(() => this.exchange(method, params, signal))
  }

  /** Sends a notification if the connection is up. Returns whether it was sent. */
  notify(method: string, params: unknown): boolean {
    if (this.state !== "ready") return false
    return this.transmit({ jsonrpc: "2.0", method, params })
  }

  /** Closes the socket for good. Pending requests and waiters fail ENOTCONN. */
  dispose(): void {
    if (this.state === "disposed") return
    this.state = "disposed"
    this.generation++
    this.cfg.clock.clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    this.release()?.close(1000, "disposed")
    const error = notConnected("remote disposed")
    this.failPending(error)
    const attempt = this.attempt
    this.attempt = undefined
    attempt?.reject(error)
  }

  // ------------------------------------------------------------ connecting

  private schedule(): Attempt {
    const attempt = newAttempt()
    this.attempt = attempt
    const delay = this.notBefore - this.cfg.clock.now()
    if (delay > 0) {
      this.state = "waiting"
      this.retryTimer = this.cfg.clock.setTimeout(() => {
        this.retryTimer = undefined
        this.start()
      }, delay)
    } else {
      this.start()
    }
    return attempt
  }

  private start(): void {
    this.state = "connecting"
    void this.open(++this.generation)
  }

  private async open(generation: number): Promise<void> {
    let token: string
    try {
      // Before the socket: the server allows 5 s from the upgrade to rite.hello.
      // Called from a then, so a callback that throws fails the attempt after start has returned.
      token = await Promise.resolve().then(() => this.cfg.token())
    } catch (error) {
      if (generation === this.generation) this.failed(notConnected(`token: ${messageOf(error)}`), true)
      return
    }
    if (generation !== this.generation) return
    let socket: SocketLike
    try {
      socket = this.cfg.socket(this.cfg.url, [SUBPROTOCOL])
    } catch (error) {
      this.failed(notConnected(messageOf(error)), false)
      return
    }
    this.socket = socket
    this.nextId = 1
    this.helloTimer = this.cfg.clock.setTimeout(() => {
      this.helloTimer = undefined
      this.hangUp("hello timeout")
      this.failed(notConnected("hello timed out"), true)
    }, HELLO_TIMEOUT_MS)
    socket.addEventListener("open", () => {
      if (this.socket === socket) this.sendHello(socket, token)
    })
    socket.addEventListener("message", (event) => {
      if (this.socket === socket) this.receive(event.data)
    })
    socket.addEventListener("close", (event) => {
      if (this.socket === socket) this.closed(event.code)
    })
  }

  private sendHello(socket: SocketLike, token: string): void {
    if (socket.protocol !== SUBPROTOCOL) {
      this.hangUp("subprotocol")
      this.failed(notConnected(`server did not select ${SUBPROTOCOL}`), false)
      return
    }
    const params: HelloParams = {
      protocol: "rite.1",
      version: CLIENT_VERSION,
      token,
      ...(this.session !== undefined ? { session: this.session } : {}),
      tty: { cols: this.tty.cols, rows: this.tty.rows },
      capabilities: [],
    }
    this.helloId = this.nextId++
    this.transmit({ jsonrpc: "2.0", id: this.helloId, method: "rite.hello", params })
  }

  private helloAnswered(msg: Record<string, unknown>): void {
    if ("error" in msg) {
      const error = errorFromResponse(msg.error)
      this.hangUp("hello rejected")
      this.failed(notConnected(`hello rejected: ${error.message}`), false)
      return
    }
    const hello = parseHello(msg.result)
    if (!hello) {
      this.hangUp("bad hello result")
      this.failed(notConnected("malformed rite.hello result"), false)
      return
    }
    this.cfg.clock.clearTimeout(this.helloTimer)
    this.helloTimer = undefined
    this.known = hello
    this.session = hello.session
    this.failures = 0
    this.notBefore = 0
    this.state = "ready"
    this.cfg.onUp(hello)
    this.armIdle(this.idleMs())
    const attempt = this.attempt
    this.attempt = undefined
    attempt?.resolve()
  }

  /** The attempt in progress did not reach ready. */
  private failed(error: RiteError, retry: boolean): void {
    this.release()
    this.state = "idle"
    const attempt = this.attempt
    this.attempt = undefined
    this.backOff()
    attempt?.reject(error)
    if (retry && this.cfg.eager) this.schedule()
  }

  /** The server or the network closed the current socket. */
  private closed(code: number): void {
    // Unauthorized covers a session bound to another principal: start a new one next time.
    if (code === 4001) this.session = undefined
    const retry = !NO_RETRY_CODES.has(code)
    const error = notConnected(`connection closed (${code})`)
    if (this.state !== "ready") {
      this.failed(error, retry)
      return
    }
    this.release()
    this.state = "idle"
    this.backOff()
    this.failPending(error)
    this.cfg.onDown()
    if (retry && this.cfg.eager) this.schedule()
  }

  private backOff(): void {
    this.notBefore = this.cfg.clock.now() + backoffDelay(this.failures, this.cfg.random)
    this.failures++
  }

  /** Detaches the current socket and its timers. Its later events are ignored. */
  private release(): SocketLike | undefined {
    const socket = this.socket
    this.socket = undefined
    this.cfg.clock.clearTimeout(this.helloTimer)
    this.cfg.clock.clearTimeout(this.idleTimer)
    this.helloTimer = undefined
    this.idleTimer = undefined
    return socket
  }

  private hangUp(reason: string): void {
    this.release()?.close(1000, reason)
  }

  private failPending(error: RiteError): void {
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const p of pending) p.reject(error)
  }

  // ------------------------------------------------------------ idle

  private idleMs(): number {
    return (this.known?.limits.idleSeconds ?? 0) * 1000
  }

  private armIdle(ms: number): void {
    if (this.cfg.eager || ms <= 0) return
    this.idleTimer = this.cfg.clock.setTimeout(() => {
      this.idleTimer = undefined
      this.idleCheck()
    }, ms)
  }

  private idleCheck(): void {
    if (this.state !== "ready") return
    const limit = this.idleMs()
    if (this.pending.size > 0 || this.cfg.busy()) {
      this.armIdle(limit)
      return
    }
    const quiet = this.cfg.clock.now() - this.lastActivity
    if (quiet < limit) {
      this.armIdle(limit - quiet)
      return
    }
    this.hangUp("idle")
    this.state = "idle"
    this.cfg.onDown()
  }

  // ------------------------------------------------------------ messages

  private exchange(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.state !== "ready") return Promise.reject(notConnected())
    if (signal?.aborted) return Promise.reject(canceled())
    const id = this.nextId++
    const path = isRecord(params) && typeof params.path === "string" ? params.path : undefined
    return new Promise<unknown>((resolve, reject) => {
      const onAbort = (): void => {
        // The request cannot be withdrawn; its response is dropped when it arrives.
        this.pending.delete(id)
        reject(canceled())
      }
      signal?.addEventListener("abort", onAbort, { once: true })
      this.pending.set(id, {
        path,
        resolve: (value) => {
          signal?.removeEventListener("abort", onAbort)
          resolve(value)
        },
        reject: (error) => {
          signal?.removeEventListener("abort", onAbort)
          reject(error)
        },
      })
      if (!this.transmit({ jsonrpc: "2.0", id, method, params })) {
        this.pending.delete(id)
        signal?.removeEventListener("abort", onAbort)
        reject(notConnected())
      }
    })
  }

  private transmit(message: Record<string, unknown>): boolean {
    const socket = this.socket
    if (!socket) return false
    this.lastActivity = this.cfg.clock.now()
    try {
      socket.send(JSON.stringify(message))
      return true
    } catch {
      return false
    }
  }

  private receive(data: unknown): void {
    if (typeof data !== "string") return
    let msg: unknown
    try {
      msg = JSON.parse(data)
    } catch {
      return
    }
    if (!isRecord(msg)) return
    this.lastActivity = this.cfg.clock.now()
    if (typeof msg.method === "string") {
      // Until hello succeeds the client sends nothing else and expects nothing else.
      if (this.state !== "ready") return
      if (!("id" in msg)) {
        this.cfg.onNotification(msg.method, msg.params)
      } else if (typeof msg.id === "number" || typeof msg.id === "string") {
        // rite.1 has no server-to-client requests.
        this.transmit({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } })
      }
      return
    }
    if (typeof msg.id !== "number") return
    if (this.state === "connecting") {
      if (msg.id === this.helloId) this.helloAnswered(msg)
      return
    }
    const pending = this.pending.get(msg.id)
    if (!pending) return
    this.pending.delete(msg.id)
    if ("error" in msg) pending.reject(errorFromResponse(msg.error, pending.path))
    else pending.resolve(msg.result)
  }
}
