// The /bin commands. The kernel installs `binCommands` under /bin.
import type { CommandDef } from "../contracts.js"
import { cat } from "./cat.js"
import { clear } from "./clear.js"
import { date } from "./date.js"
import { echo } from "./echo.js"
import { env } from "./env.js"
import { falseCommand } from "./false.js"
import { grep } from "./grep.js"
import { head } from "./head.js"
import { help } from "./help.js"
import { hostname } from "./hostname.js"
import { id } from "./id.js"
import { ls } from "./ls.js"
import { man } from "./man.js"
import { mkdir } from "./mkdir.js"
import { open } from "./open.js"
import { pwd } from "./pwd.js"
import { rm } from "./rm.js"
import { sort } from "./sort.js"
import { sudo } from "./sudo.js"
import { tail } from "./tail.js"
import { tee } from "./tee.js"
import { touch } from "./touch.js"
import { trueCommand } from "./true.js"
import { type } from "./type.js"
import { uname } from "./uname.js"
import { uniq } from "./uniq.js"
import { wc } from "./wc.js"
import { which } from "./which.js"
import { whoami } from "./whoami.js"

export {
  cat, clear, date, echo, env, falseCommand, grep, head, help, hostname, id, ls, man, mkdir, open,
  pwd, rm, sort, sudo, tail, tee, touch, trueCommand, type, uname, uniq, wc, which, whoami,
}
export { type ManualSource, renderManual } from "./man.js"

export const binCommands: CommandDef[] = [
  cat, clear, date, echo, env, falseCommand, grep, head, help, hostname, id, ls, man, mkdir, open,
  pwd, rm, sort, sudo, tail, tee, touch, trueCommand, type, uname, uniq, wc, which, whoami,
]
