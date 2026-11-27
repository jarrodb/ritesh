import type { EggDef } from "../contracts.js"
import { rmrf } from "./rmrf.js"
import { sudoers } from "./sudoers.js"

export { rmrf } from "./rmrf.js"
export { sudoers } from "./sudoers.js"

/** The eggs shipped with ritesh, for `createRite({ eggs })`. */
export const eggs: EggDef[] = [sudoers, rmrf]
