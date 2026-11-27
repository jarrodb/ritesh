// Generated from protocol/rite.1.schema.json by scripts/sync-protocol.mjs. Do not edit.

/**
 * This interface was referenced by `Rite1`'s JSON-Schema
 * via the `definition` "Message".
 */
export type Rite1Message =
  | {
      jsonrpc: "2.0"
      method: "rite.hello"
      params: HelloParams
      id: number
      [k: string]: unknown
    }
  | {
      jsonrpc: "2.0"
      method: "fs.stat"
      params: PathParams
      id: number
      [k: string]: unknown
    }
  | {
      jsonrpc: "2.0"
      method: "fs.list"
      params: PathParams
      id: number
      [k: string]: unknown
    }
  | {
      jsonrpc: "2.0"
      method: "fs.read"
      params: ReadParams
      id: number
      [k: string]: unknown
    }
  | {
      jsonrpc: "2.0"
      method: "proc.start"
      params: StartParams
      id: number
      [k: string]: unknown
    }
  | {
      jsonrpc: "2.0"
      method: "proc.complete"
      params: CompleteParams
      id: number
      [k: string]: unknown
    }
  | {
      jsonrpc: "2.0"
      method: "proc.stdin"
      params: StdinParams
      [k: string]: unknown
    }
  | {
      jsonrpc: "2.0"
      method: "proc.signal"
      params: SignalParams
      [k: string]: unknown
    }
  | {
      jsonrpc: "2.0"
      method: "tty.resize"
      params: ResizeParams
      [k: string]: unknown
    }
  | {
      jsonrpc: "2.0"
      method: "proc.stdout"
      params: OutputParams
      [k: string]: unknown
    }
  | {
      jsonrpc: "2.0"
      method: "proc.stderr"
      params: OutputParams
      [k: string]: unknown
    }
  | {
      jsonrpc: "2.0"
      method: "proc.exit"
      params: ExitParams
      [k: string]: unknown
    }
  | {
      jsonrpc: "2.0"
      method: "fs.changed"
      params: ChangedParams
      [k: string]: unknown
    }
  | {
      jsonrpc: "2.0"
      method: "term.notify"
      params: NotifyParams
      [k: string]: unknown
    }
  | Response
/**
 * This interface was referenced by `Rite1`'s JSON-Schema
 * via the `definition` "StdinParams".
 */
export type StdinParams =
  | {
      pid: number
      data: string
      [k: string]: unknown
    }
  | {
      pid: number
      eof: true
      [k: string]: unknown
    }
/**
 * This interface was referenced by `Rite1`'s JSON-Schema
 * via the `definition` "Response".
 */
export type Response =
  | {
      jsonrpc: "2.0"
      id: number
      result: unknown
      [k: string]: unknown
    }
  | {
      jsonrpc: "2.0"
      id: number | null
      error: {
        code: number
        message: string
        data?: AppErrorData
        [k: string]: unknown
      }
      [k: string]: unknown
    }
/**
 * This interface was referenced by `Rite1`'s JSON-Schema
 * via the `definition` "errno".
 */
export type Errno =
  | "ENOENT"
  | "ENOTDIR"
  | "EISDIR"
  | "EACCES"
  | "EPERM"
  | "EEXIST"
  | "ENOTEMPTY"
  | "EROFS"
  | "ELOOP"
  | "EINVAL"
  | "ENOTSUP"
  | "ENOSPC"
  | "EIO"
  | "EPIPE"
  | "ECANCELED"
  | "ETIMEDOUT"
  | "ENOTCONN"

export interface Rite1 {
  message?: Rite1Message
  errno?: Errno
  HelloParams?: HelloParams
  HelloResult?: HelloResult
  PathParams?: PathParams
  StatResult?: StatResult
  ListResult?: ListResult
  ReadParams?: ReadParams
  ReadResult?: ReadResult
  StartParams?: StartParams
  StartResult?: StartResult
  CompleteParams?: CompleteParams
  CompleteResult?: CompleteResult
  StdinParams?: StdinParams
  SignalParams?: SignalParams
  ResizeParams?: ResizeParams
  OutputParams?: OutputParams
  ExitParams?: ExitParams
  ChangedParams?: ChangedParams
  NotifyParams?: NotifyParams
  AppErrorData?: AppErrorData
  Response?: Response
}
/**
 * This interface was referenced by `Rite1`'s JSON-Schema
 * via the `definition` "HelloParams".
 */
export interface HelloParams {
  protocol: "rite.1"
  version: string
  token: string
  session?: string
  tty: {
    cols: number
    rows: number
    [k: string]: unknown
  }
  capabilities: string[]
  [k: string]: unknown
}
/**
 * This interface was referenced by `Rite1`'s JSON-Schema
 * via the `definition` "PathParams".
 */
export interface PathParams {
  path: string
  [k: string]: unknown
}
/**
 * This interface was referenced by `Rite1`'s JSON-Schema
 * via the `definition` "ReadParams".
 */
export interface ReadParams {
  path: string
  offset?: number
  length?: number
  [k: string]: unknown
}
/**
 * This interface was referenced by `Rite1`'s JSON-Schema
 * via the `definition` "StartParams".
 */
export interface StartParams {
  pid: number
  /**
   * @minItems 1
   */
  argv: [string, ...string[]]
  cwd: string
  env: {
    [k: string]: string
  }
  stdio: {
    stdin: "tty" | "pipe"
    stdout: "tty" | "pipe"
    stderr: "tty" | "pipe"
    [k: string]: unknown
  }
  [k: string]: unknown
}
/**
 * This interface was referenced by `Rite1`'s JSON-Schema
 * via the `definition` "CompleteParams".
 */
export interface CompleteParams {
  argv: string[]
  index: number
  [k: string]: unknown
}
/**
 * This interface was referenced by `Rite1`'s JSON-Schema
 * via the `definition` "SignalParams".
 */
export interface SignalParams {
  pid: number
  signal: "INT" | "KILL"
  [k: string]: unknown
}
/**
 * This interface was referenced by `Rite1`'s JSON-Schema
 * via the `definition` "ResizeParams".
 */
export interface ResizeParams {
  cols: number
  rows: number
  [k: string]: unknown
}
/**
 * This interface was referenced by `Rite1`'s JSON-Schema
 * via the `definition` "OutputParams".
 */
export interface OutputParams {
  pid: number
  data: string
  [k: string]: unknown
}
/**
 * This interface was referenced by `Rite1`'s JSON-Schema
 * via the `definition` "ExitParams".
 */
export interface ExitParams {
  pid: number
  code: number
  [k: string]: unknown
}
/**
 * This interface was referenced by `Rite1`'s JSON-Schema
 * via the `definition` "ChangedParams".
 */
export interface ChangedParams {
  path: string
  kind: "create" | "delete" | "modify"
  [k: string]: unknown
}
/**
 * This interface was referenced by `Rite1`'s JSON-Schema
 * via the `definition` "NotifyParams".
 */
export interface NotifyParams {
  text: string
  level: "info" | "warn" | "error"
  [k: string]: unknown
}
/**
 * This interface was referenced by `Rite1`'s JSON-Schema
 * via the `definition` "AppErrorData".
 */
export interface AppErrorData {
  errno: Errno
  path?: string
  [k: string]: unknown
}
/**
 * This interface was referenced by `Rite1`'s JSON-Schema
 * via the `definition` "HelloResult".
 */
export interface HelloResult {
  session: string
  resumed: boolean
  commands: {
    name: string
    summary: string
    usage: string
    flags?: {
      [k: string]: {
        long?: string
        short?: string
        type: "boolean" | "string" | "number"
        repeat?: boolean
        description?: string
        [k: string]: unknown
      }
    }
    subcommands?: {
      [k: string]: {
        summary: string
        usage: string
        [k: string]: unknown
      }
    }
    [k: string]: unknown
  }[]
  limits: {
    maxMessageBytes: number
    maxProcs: number
    maxOutputBytes: number
    idleSeconds: number
    [k: string]: unknown
  }
  capabilities: string[]
  motd?: string
  [k: string]: unknown
}
/**
 * This interface was referenced by `Rite1`'s JSON-Schema
 * via the `definition` "StatResult".
 */
export interface StatResult {
  type: "dir" | "file"
  size: number
  mode: number
  mtime: number
  [k: string]: unknown
}
/**
 * This interface was referenced by `Rite1`'s JSON-Schema
 * via the `definition` "ListResult".
 */
export interface ListResult {
  entries: {
    name: string
    type: "dir" | "file"
    [k: string]: unknown
  }[]
  truncated: boolean
  [k: string]: unknown
}
/**
 * This interface was referenced by `Rite1`'s JSON-Schema
 * via the `definition` "ReadResult".
 */
export interface ReadResult {
  data: string
  eof: boolean
  [k: string]: unknown
}
/**
 * This interface was referenced by `Rite1`'s JSON-Schema
 * via the `definition` "StartResult".
 */
export interface StartResult {
  [k: string]: unknown
}
/**
 * This interface was referenced by `Rite1`'s JSON-Schema
 * via the `definition` "CompleteResult".
 */
export interface CompleteResult {
  candidates: {
    value: string
    display?: string
    description?: string
    suffix?: string
    [k: string]: unknown
  }[]
  [k: string]: unknown
}
