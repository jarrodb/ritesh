import type {
  ActionDef, CommandDef, CommandInfo, FileContent, Inode, InodeSpec, Stat,
} from "../contracts.js"

export const ROOT_UID = 0
export const HOST_UID = 1000

export type Want = "r" | "w" | "x"

interface Base {
  mode: number
  uid: number
  mtime: number
}

export interface DirNode extends Base {
  type: "dir"
  children: Map<string, Node>
}

export interface FileNode extends Base {
  type: "file"
  content: FileContent
  /** Bytes of string content as UTF-8; 0 while the content is a function. */
  size: number
  /** Bytes counted against the total cap. Content set by `put` is not counted. */
  charged: number
}

export interface CmdNode extends Base {
  type: "cmd"
  command: CommandDef
}

export interface LinkNode extends Base {
  type: "link"
  target: string
}

export interface ActionNode extends Base {
  type: "action"
  action: ActionDef
}

export interface DevNode extends Base {
  type: "dev"
  read: (() => string) | undefined
  write: ((data: string) => void) | undefined
}

export type Node = DirNode | FileNode | CmdNode | LinkNode | ActionNode | DevNode

const encoder = new TextEncoder()

export function byteLength(text: string): number {
  return encoder.encode(text).length
}

/**
 * The owner of a new inode. The contract's write, mkdir, and put carry no
 * uid, so the owner follows the directory: its owner, or the host user when
 * anyone may write there (/tmp).
 */
export function ownerIn(parent: DirNode): number {
  return (parent.mode & 0o002) !== 0 ? HOST_UID : parent.uid
}

export function newDir(owner: number, mtime: number, mode = 0o755): DirNode {
  return { type: "dir", mode, uid: owner, mtime, children: new Map() }
}

export function newFile(owner: number, mtime: number): FileNode {
  return { type: "file", mode: 0o644, uid: owner, mtime, content: "", size: 0, charged: 0 }
}

export function fromSpec(spec: InodeSpec, owner: number, mtime: number): Node {
  switch (spec.type) {
    case "dir":
      return newDir(spec.uid ?? owner, mtime, bits(spec.mode, 0o755))
    case "file":
      return {
        type: "file", mode: bits(spec.mode, 0o644), uid: spec.uid ?? owner, mtime,
        content: spec.content, size: typeof spec.content === "string" ? byteLength(spec.content) : 0, charged: 0,
      }
    case "cmd":
      return { type: "cmd", mode: bits(spec.mode, 0o755), uid: owner, mtime, command: spec.command }
    case "link":
      return { type: "link", mode: 0o777, uid: owner, mtime, target: spec.target }
    case "action":
      return { type: "action", mode: bits(spec.mode, 0o755), uid: owner, mtime, action: spec.action }
    case "dev":
      return { type: "dev", mode: bits(spec.mode, 0o666), uid: owner, mtime, read: spec.read, write: spec.write }
  }
}

function bits(mode: number | undefined, fallback: number): number {
  return (mode ?? fallback) & 0o777
}

export function statOf(node: Node): Stat {
  const size = node.type === "file" ? node.size : node.type === "link" ? byteLength(node.target) : 0
  return { type: node.type, mode: node.mode, uid: node.uid, gid: node.uid, size, mtime: node.mtime }
}

export function inodeOf(node: Node): Inode {
  const inode: Inode = { type: node.type, mode: node.mode, uid: node.uid }
  if (node.type === "cmd") inode.command = commandInfo(node.command)
  return inode
}

function commandInfo(def: CommandDef): CommandInfo {
  const info: CommandInfo = { name: def.name, summary: def.summary, usage: def.usage, builtin: false, remote: false }
  if (def.flags) info.flags = def.flags
  if (def.subcommands) {
    info.subcommands = Object.fromEntries(
      Object.entries(def.subcommands).map(([name, sub]) => [name, { summary: sub.summary, usage: sub.usage }]),
    )
  }
  return info
}

/**
 * Root passes. The owner is checked against the owner bits and anyone else
 * against the other bits. Group bits are never consulted.
 */
export function permits(mode: number, owner: number, uid: number, want: Want): boolean {
  if (uid === ROOT_UID) return true
  const bit = want === "r" ? 4 : want === "w" ? 2 : 1
  return ((mode >> (uid === owner ? 6 : 0)) & bit) !== 0
}
