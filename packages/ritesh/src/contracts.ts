// Cross-module contracts. Every module talks to every other through these
// types. They are frozen for each implementation wave: a unit that finds a
// gap reports it instead of editing this file.

// ---------------------------------------------------------------- errors

export const ERRNOS = [
  "ENOENT", "ENOTDIR", "EISDIR", "EACCES", "EPERM", "EEXIST", "ENOTEMPTY",
  "EROFS", "ELOOP", "EINVAL", "ENOTSUP", "ENOSPC", "EIO", "EPIPE",
  "ECANCELED", "ETIMEDOUT", "ENOTCONN",
] as const
export type Errno = (typeof ERRNOS)[number]

export const ERRNO_MESSAGES: Record<Errno, string> = {
  ENOENT: "no such file or directory",
  ENOTDIR: "not a directory",
  EISDIR: "is a directory",
  EACCES: "permission denied",
  EPERM: "operation not permitted",
  EEXIST: "file exists",
  ENOTEMPTY: "directory not empty",
  EROFS: "read-only file system",
  ELOOP: "too many levels of symbolic links",
  EINVAL: "invalid argument",
  ENOTSUP: "operation not supported",
  ENOSPC: "no space left on device",
  EIO: "input/output error",
  EPIPE: "broken pipe",
  ECANCELED: "operation canceled",
  ETIMEDOUT: "operation timed out",
  ENOTCONN: "transport endpoint is not connected",
}

/** The one error type that crosses module boundaries. */
export class RiteError extends Error {
  readonly errno: Errno
  readonly path: string | undefined
  constructor(errno: Errno, path?: string, message?: string) {
    super(message ?? ERRNO_MESSAGES[errno])
    this.name = "RiteError"
    this.errno = errno
    this.path = path
  }
}

/** Exit codes with fixed meanings (docs/language.md). Others are 0-255. */
export const EXIT = {
  OK: 0,
  FAILURE: 1,
  USAGE: 2,
  NOT_EXECUTABLE: 126,
  NOT_FOUND: 127,
  INTERRUPTED: 130,
  CONNECTION_LOST: 255,
} as const

// ---------------------------------------------------------------- parser

export type TokenKind =
  | "word" | "operator" | "redirect" | "comment" | "whitespace" | "reserved"

/** [start, end) offsets into the source line, in UTF-16 code units. */
export type Span = readonly [start: number, end: number]

export interface Token {
  kind: TokenKind
  text: string
  span: Span
}

/** One piece of a word, before expansion. */
export type WordPart =
  | { kind: "literal"; text: string; quoted: boolean }
  | { kind: "param"; name: string; quoted: boolean }
  | { kind: "tilde"; text: string }
  | { kind: "glob"; text: string }

export interface Word {
  parts: WordPart[]
  span: Span
}

export type RedirectOp = ">" | ">>" | "<" | "2>" | "2>>" | "2>&1" | ">&2"

export interface Redirect {
  op: RedirectOp
  /** Absent for the duplication forms 2>&1 and >&2. */
  target?: Word
  span: Span
}

export interface Assignment {
  name: string
  value: Word
  span: Span
}

export interface SimpleCommand {
  type: "command"
  assignments: Assignment[]
  words: Word[]
  redirects: Redirect[]
  span: Span
}

export interface Pipeline {
  type: "pipeline"
  commands: SimpleCommand[]
  span: Span
}

export interface List {
  type: "list"
  /** First pipeline, then (operator, pipeline) pairs, left-associative. */
  first: Pipeline
  rest: Array<{ op: ";" | "&&" | "||"; pipeline: Pipeline }>
  span: Span
}

export type ParseResult =
  | { ok: true; ast: List | null; tokens: Token[] }
  | { ok: false; incomplete: true; tokens: Token[] }
  | { ok: false; incomplete: false; error: SyntaxErrorInfo; tokens: Token[] }

export interface SyntaxErrorInfo {
  message: string
  span: Span
}

export interface ParseOptions {
  /** Returns an alias body for a name in command position, if defined. */
  alias?: (name: string) => string | undefined
}

export interface Parser {
  parse(line: string, options?: ParseOptions): ParseResult
  /** Tokens only, for highlighting. Never throws. */
  tokenize(line: string): Token[]
  /** Quote a value so it parses back as one literal word. */
  quoteWord(value: string, context: "bare" | "double" | "single"): string
  /** The version string printed in "not supported in rite <version>". */
  readonly version: string
}

// ---------------------------------------------------------------- vfs

export type InodeType = "dir" | "file" | "cmd" | "link" | "action" | "dev"

export interface Stat {
  type: InodeType
  /** Permission bits, e.g. 0o755. */
  mode: number
  uid: number
  gid: number
  size: number
  /** Milliseconds since the epoch. */
  mtime: number
  /** Set when the path is inside a mount. */
  mount?: string
}

export interface Entry {
  name: string
  type: InodeType
}

export type ActionDef =
  | { navigate: string }
  | { open: string }
  | { event: string; detail?: unknown }
  | { print: string }

export type ActionVia = "cd" | "open" | "cat"

export interface ActionEvent {
  kind: "navigate" | "open" | "event" | "print"
  path: string
  via: ActionVia
  href?: string
  url?: string
  name?: string
  detail?: unknown
  /** The host calls this to stop rite's default handling. */
  preventDefault(): void
  readonly defaultPrevented: boolean
}

export interface ActionResult {
  event: ActionEvent
  /** Text the command prints (print actions, or the URL when a popup is blocked). */
  output?: string
}

export type FileContent = string | (() => string | Promise<string>)

export type InodeSpec =
  | { type: "dir"; mode?: number; uid?: number }
  | { type: "file"; content: FileContent; mode?: number; uid?: number }
  | { type: "cmd"; command: CommandDef; mode?: number }
  | { type: "link"; target: string }
  | { type: "action"; action: ActionDef; mode?: number }
  | { type: "dev"; read?: () => string; write?: (data: string) => void; mode?: number }

/** What the editor may read synchronously from the vfs cache. */
export interface Inode {
  type: InodeType
  mode: number
  uid: number
  /** Present for cmd inodes. */
  command?: CommandInfo
}

export interface CallOptions {
  signal?: AbortSignal
}

export interface WriteOptions extends CallOptions {
  mode: "truncate" | "append"
}

/**
 * Paths given to the vfs are absolute or relative to `cwd`. Tilde is a
 * kernel expansion and never reaches the vfs. `..` resolves lexically.
 */
export interface Vfs {
  stat(path: string, cwd: string, o?: CallOptions): Promise<Stat>
  list(path: string, cwd: string, o?: CallOptions): Promise<Entry[]>
  read(path: string, cwd: string, o?: CallOptions): Promise<string>
  write(path: string, cwd: string, data: string, o: WriteOptions): Promise<void>
  mkdir(path: string, cwd: string, o?: CallOptions & { parents?: boolean }): Promise<void>
  remove(path: string, cwd: string, o?: CallOptions & { recursive?: boolean }): Promise<void>
  /** Only cd, open, and cat call this. stat and list never trigger actions. */
  activate(path: string, cwd: string, via: ActionVia): Promise<ActionResult | null>
  /** Absolute, normalized path. Does not check existence. */
  resolve(path: string, cwd: string): string
  /** Cache only, synchronous, never does I/O. The editor uses only this. */
  peek(path: string, cwd: string): Inode | undefined
  /** Create or replace an inode (host setup and kernel use). */
  put(path: string, spec: InodeSpec): void
  mount(path: string, provider: MountProvider): void
  unmount(path: string): void
  /** Permission check for the given uid: r, w, or x. Root bypasses. */
  access(path: string, cwd: string, uid: number, want: "r" | "w" | "x"): Promise<boolean>
}

/** A subtree served by a host object or a remote server. Paths are relative to the mount root, "" is the root. */
export interface MountProvider {
  readonly readonly: boolean
  stat(rel: string, o: CallOptions): Promise<Stat>
  list(rel: string, o: CallOptions): Promise<Entry[]>
  read(rel: string, o: CallOptions): Promise<string>
  write?(rel: string, data: string, o: WriteOptions): Promise<void>
  mkdir?(rel: string, o: CallOptions): Promise<void>
  remove?(rel: string, o: CallOptions): Promise<void>
  /** Called with a relative path when something under the mount changes. Returns an unsubscribe. */
  watch?(onChange: (rel: string) => void): () => void
}

// ---------------------------------------------------------------- processes

export type Env = Record<string, string>

export interface Tty {
  readonly cols: number
  readonly rows: number
  /** Read one line from the terminal. echo:false for passwords. Never recorded in history. */
  read(options?: { echo?: boolean; prompt?: string; signal?: AbortSignal }): Promise<string | null>
  /** Unfiltered output. Local commands only (clear, egg animations). */
  raw(data: string): Promise<void>
}

export type StdioKind = "tty" | "pipe" | "file" | "null"

export interface Stdio {
  stdin: StdioKind
  stdout: StdioKind
  stderr: StdioKind
}

export type FlagValue = boolean | string | number | Array<string | number>
export type Flags = Record<string, FlagValue | undefined>

export interface Proc {
  /** argv[0] is the name the command was invoked by. */
  readonly argv: readonly string[]
  /** Parsed flags, keyed by the long name when one exists, else the short name. */
  readonly flags: Flags
  /** Operands after flag parsing; argv.slice(1) when the command declares no flags. */
  readonly args: readonly string[]
  /** The resolved subcommand path, e.g. ["devices", "ls"]. Empty when none. */
  readonly subcommand: readonly string[]
  readonly stdin: ReadableStream<string>
  readonly stdout: WritableStream<string>
  readonly stderr: WritableStream<string>
  /** Write to stdout or stderr; resolves when the sink accepted the chunk. Commands write "\n". */
  out(text: string): Promise<void>
  err(text: string): Promise<void>
  /** stdin split into lines, without terminators. */
  lines(): AsyncIterable<string>
  readonly env: Readonly<Env>
  readonly cwd: string
  readonly uid: number
  readonly fs: Vfs
  /** Aborted on ^C (reason "INT") or when a downstream reader exits (reason "EPIPE"). */
  readonly signal: AbortSignal
  /** Null when stdout is not the terminal. */
  readonly tty: Tty | null
  readonly stdio: Stdio
  readonly sys: Sys
}

/** A command's body. void means exit 0. A throw is exit 1 with one stderr line. */
export type Run = (p: Proc) => Promise<number | void>

export type Resolution =
  | { kind: "alias"; name: string; body: string }
  | { kind: "builtin"; name: string; info: CommandInfo }
  | { kind: "command"; name: string; path: string; info: CommandInfo }
  | { kind: "egg"; name: string; id: string }
  | { kind: "not-found"; name: string }

export interface SessionView {
  readonly user: string
  readonly uid: number
  readonly cwd: string
  readonly hostname: string
  readonly home: string
  readonly lastStatus: number
}

/** The kernel facade a command may use. */
export interface Sys {
  resolve(name: string): Resolution
  commands(): CommandInfo[]
  /** Run argv as a child. stdio defaults to the caller's. */
  spawn(argv: readonly string[], options?: { uid?: number; env?: Env; stdio?: Partial<StdioStreams> }): Promise<number>
  /** Run a full line (rite -c, source). */
  run(line: string, options?: { env?: Env }): Promise<number>
  readonly session: SessionView
  /** Host configuration for sudo. */
  readonly sudo: SudoPolicy
  history(): readonly string[]
}

export interface StdioStreams {
  stdin: ReadableStream<string>
  stdout: WritableStream<string>
  stderr: WritableStream<string>
}

export type SudoPolicy = boolean | ((password: string) => boolean | Promise<boolean>)

/** Builtins also receive the mutable session. In a pipeline the changes do not persist. */
export interface Session {
  user: string
  uid: number
  cwd: string
  oldCwd: string
  hostname: string
  home: string
  env: Env
  /** Names exported to child processes. */
  exported: Set<string>
  aliases: Map<string, string>
  lastStatus: number
  /** Set by the exit builtin. */
  exitRequested: number | null
}

export type BuiltinRun = (p: Proc, session: Session) => Promise<number | void>

// ---------------------------------------------------------------- commands

export interface FlagDef {
  long?: string
  short?: string
  type: "boolean" | "string" | "number"
  /** Repeatable flags collect into an array. */
  repeat?: boolean
  default?: FlagValue
  description?: string
}

export interface Candidate {
  value: string
  display?: string
  description?: string
  /** Appended after insertion: " " by default, "/" for directories, "" to keep typing. */
  suffix?: string
}

export interface CompleteContext {
  argv: readonly string[]
  /** Index into argv of the word being completed. */
  index: number
  prefix: string
  env: Readonly<Env>
  cwd: string
  fs: Vfs
  signal: AbortSignal
}

export type Completer = (ctx: CompleteContext) => Promise<Candidate[]>

export interface CommandDef {
  name: string
  summary: string
  usage: string
  /** Keyed by the canonical name (long when present). Omit to receive raw argv. */
  flags?: Record<string, FlagDef>
  subcommands?: Record<string, Omit<CommandDef, "name">>
  complete?: Completer
  run?: Run
  /** Longer text for man. */
  manual?: string
}

export interface CommandInfo {
  name: string
  summary: string
  usage: string
  /** Longer text for man, when the definition has one. */
  manual?: string
  flags?: Record<string, FlagDef>
  subcommands?: Record<string, { summary: string; usage: string }>
  builtin: boolean
  remote: boolean
}

/** Supplies commands from outside the vfs tree (the remote client). */
export interface CommandSource {
  /** Names known before connecting, so completion and which work early. */
  names(): string[]
  info(name: string): CommandInfo | undefined
  run(name: string, p: Proc): Promise<number>
  complete?(argv: readonly string[], index: number, signal: AbortSignal): Promise<Candidate[]>
}

// ---------------------------------------------------------------- eggs

export const PASS: unique symbol = Symbol("rite.pass")
export type EggResult = number | void | typeof PASS

export type EggTrigger =
  | { command: string; when?: (argv: readonly string[], session: SessionView) => boolean }
  | { input: RegExp }
  | { keys: string }

export interface EggDef {
  id: string
  trigger: EggTrigger
  run: (p: Proc) => Promise<EggResult>
}

// ---------------------------------------------------------------- completion

export interface Completion {
  /** The span of the line the candidates replace. */
  span: Span
  candidates: Candidate[]
}

// ---------------------------------------------------------------- terminal

export type OutputPolicy = "plain" | "sgr" | "raw"

export interface TermSize {
  cols: number
  rows: number
}

/** The only boundary to xterm. The editor renders through it; tests back it with @xterm/headless. */
export interface Term {
  /**
   * Write complete text with a policy; resolves once xterm has parsed it.
   * "\n" becomes "\r\n". Each call is filtered on its own: an escape
   * sequence cut off at the end of the data is dropped.
   */
  write(data: string, policy: OutputPolicy): Promise<void>
  /**
   * A writer for one stream (a process's stdout): its filter keeps an escape
   * sequence split across chunks until it completes, apart from every other
   * writer.
   */
  writer(policy: OutputPolicy): (chunk: string) => Promise<void>
  /** Key input, already decoded into strings, terminal replies discarded. Returns an unsubscribe. */
  onInput(listener: (data: string) => void): () => void
  onResize(listener: (size: TermSize) => void): () => void
  readonly size: TermSize
  /** Replace the terminal's colors (xterm ITheme keys). */
  setTheme(theme: Theme): void
  /** Display width of one code point: 0, 1, or 2. */
  width(codePoint: number): 0 | 1 | 2
  focus(): void
  fit(): void
  dispose(): void
}

// ---------------------------------------------------------------- kernel

export interface Kernel {
  readonly session: SessionView
  /** Run one line as if typed. Queued behind any running job. */
  exec(line: string, stdio?: Partial<StdioStreams>): Promise<number>
  /** Run one egg directly (a key trigger), queued like a line. */
  runEgg(egg: EggDef): Promise<number>
  complete(line: string, cursor: number, o: { signal: AbortSignal }): Promise<Completion>
  /** Abort the foreground job (^C). */
  interrupt(): void
  readonly running: boolean
  register(def: CommandDef, at?: string): void
  registerEgg(def: EggDef): void
  /** Eggs with key triggers, for the editor. */
  keyEggs(): readonly EggDef[]
  addCommandSource(at: string, source: CommandSource): void
  readonly vfs: Vfs
  readonly parser: Parser
}

// ---------------------------------------------------------------- host

export type HistoryMode = "local" | "memory" | false

/** Terminal colors: xterm's ITheme keys (strings, and extendedAnsi as a list). */
export interface Theme {
  [key: string]: string | readonly string[] | undefined
  extendedAnsi?: readonly string[]
}

export interface HostOptions {
  element: HTMLElement
  hostname?: string
  user?: string
  /** Printed before the first prompt; SGR colors are kept, every other escape sequence is dropped. */
  motd?: string
  files?: Record<string, FileContent>
  inodes?: Record<string, InodeSpec>
  mounts?: Array<{ path: string; provider: MountProvider }>
  commands?: CommandDef[]
  eggs?: EggDef[] | false
  remote?: RemoteHandle
  sudo?: SudoPolicy
  history?: HistoryMode
  /** xterm ITheme keys; `themes` has brass, tide, dusk (dark) and paper (light) ready-made. */
  theme?: Theme
  /** The terminal's font. Load web fonts before createRite so the cell size is measured right. */
  font?: { family?: string; size?: number }
  screenReaderMode?: boolean
  onAction?: (e: ActionEvent) => void
}

/** What rite/remote hands to createRite. Core never imports the remote module. */
export interface RemoteHandle {
  readonly at: string
  readonly bin: string
  readonly provider: MountProvider
  readonly commands: CommandSource
  connect(): Promise<void>
  /** The terminal's size changed: tell the server (tty.resize) if connected. */
  resize(cols: number, rows: number): void
  dispose(): void
  onNotify(listener: (text: string, level: "info" | "warn" | "error") => void): () => void
}

export interface Rite {
  readonly ready: Promise<void>
  exec(line: string): Promise<{ code: number }>
  print(text: string): void
  focus(): void
  fit(): void
  /** The terminal's size in cells. */
  readonly size: TermSize
  /** Called after the terminal changes size (a fit, a resize). Returns an unsubscribe. */
  onResize(listener: (size: TermSize) => void): () => void
  /** Replace the terminal's colors, such as `themes.paper`. */
  setTheme(theme: Theme): void
  dispose(): void
}
