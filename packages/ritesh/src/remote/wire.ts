// Transport types and the JSON-RPC error mapping for the rite.1 client.
import { ERRNOS, type Errno, RiteError } from "../contracts.js"

export const SUBPROTOCOL = "rite.1"

/** Sent as `version` in rite.hello. Bumped with the package version. */
export const CLIENT_VERSION = "0.0.0"

/** The part of a WebSocket the client uses. The DOM WebSocket satisfies it. */
export interface SocketLike {
  readonly protocol: string
  readonly bufferedAmount: number
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: "open", listener: () => void): void
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void
  addEventListener(type: "close", listener: (event: { code: number }) => void): void
}

export type SocketFactory = (url: string, protocols: string[]) => SocketLike

/** Time and timers, injected so tests never wait. */
export interface Clock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  // The handle is whatever setTimeout above returned.
  clearTimeout: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>) },
}

export const defaultSocket: SocketFactory = (url, protocols) => {
  // Looked up at call time: importing this module must work where WebSocket does not exist.
  if (typeof Reflect.get(globalThis, "WebSocket") !== "function") {
    throw new RiteError("ENOTSUP", undefined, "WebSocket is not available")
  }
  return new globalThis.WebSocket(url, protocols)
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function isErrno(value: unknown): value is Errno {
  return typeof value === "string" && (ERRNOS as readonly string[]).includes(value)
}

export function notConnected(message?: string): RiteError {
  return new RiteError("ENOTCONN", undefined, message)
}

export function canceled(): RiteError {
  return new RiteError("ECANCELED")
}

export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === "string" ? error : "unknown error"
}

/**
 * A JSON-RPC error object as a RiteError. Application errors (-32000 with
 * data.errno) keep their errno and path and take the message from the
 * contracts; protocol faults keep the server's message.
 */
export function errorFromResponse(error: unknown, fallbackPath?: string): RiteError {
  if (!isRecord(error)) return new RiteError("EIO", fallbackPath, "malformed error response")
  const data = error.data
  if (error.code === -32000 && isRecord(data) && isErrno(data.errno)) {
    return new RiteError(data.errno, typeof data.path === "string" ? data.path : fallbackPath)
  }
  const errno: Errno = error.code === -32601 ? "ENOTSUP" : error.code === -32602 ? "EINVAL" : "EIO"
  return new RiteError(errno, fallbackPath, typeof error.message === "string" ? error.message : undefined)
}
