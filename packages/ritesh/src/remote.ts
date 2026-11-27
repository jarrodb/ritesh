// The rite.1 client. Implemented in wave A against protocol/ traces.
import type { RemoteHandle } from "./contracts.js"

export interface RemoteOptions {
  url: string
  at: string
  bin?: string
  env?: string[]
  token: () => string | Promise<string>
  connect?: "lazy" | "eager"
  commands?: string[]
}

export function remote(options: RemoteOptions): RemoteHandle {
  throw new Error(`ritesh: the rite.1 client is not implemented yet (${options.url})`)
}
