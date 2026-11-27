// The rite.1 client (riteshjs/remote). Core never imports this module.
import type { RemoteHandle } from "./contracts.js"
import { createRemote } from "./remote/client.js"
import type { RemoteOptions } from "./remote/options.js"

export type { RemoteOptions } from "./remote/options.js"
export type { Clock, SocketFactory, SocketLike } from "./remote/wire.js"

/**
 * A remote server as a mount and a command source for createRite. Nothing is
 * sent until the first use unless `connect` is "eager".
 */
export function remote(options: RemoteOptions): RemoteHandle {
  return createRemote(options)
}
