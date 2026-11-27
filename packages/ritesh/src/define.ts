import type { CommandDef, EggDef } from "./contracts.js"

/** Identity helpers that give a command or egg definition its type. */
export function defineCommand(def: CommandDef): CommandDef {
  return def
}

export function defineEgg(def: EggDef): EggDef {
  return def
}
