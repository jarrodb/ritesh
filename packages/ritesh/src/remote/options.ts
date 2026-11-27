import type { Clock, SocketFactory } from "./wire.js"

export interface RemoteOptions {
  /** The server's WebSocket URL (wss://...). */
  url: string
  /** Where the remote filesystem is mounted. Absolute. */
  at: string
  /** Where remote commands land. Defaults to `<at>/bin`. */
  bin?: string
  /** Names of the variables sent with proc.start. Default: none. */
  env?: string[]
  /** Called on every connection attempt. */
  token: () => string | Promise<string>
  /** "lazy" (default) connects on first use and disconnects when idle. "eager" connects at once and stays. */
  connect?: "lazy" | "eager"
  /** Command names known before the first connection. */
  commands?: string[]
  /** Opens the socket. Defaults to globalThis.WebSocket. */
  socket?: SocketFactory
  /** Time and timers. Defaults to Date.now and the global timers. */
  clock?: Clock
  /** Jitter source in [0, 1). Defaults to Math.random. */
  random?: () => number
}
