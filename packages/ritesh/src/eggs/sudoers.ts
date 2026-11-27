import { EXIT, PASS } from "../contracts.js"
import { defineEgg } from "../define.js"

/** Answers `sudo <command>` when the host lets nobody use sudo, which is the default. */
export const sudoers = defineEgg({
  id: "sudoers",
  trigger: { command: "sudo" },
  run: async (p) => {
    // The policy is not part of what a trigger's predicate sees, so it is checked here.
    if (p.sys.sudo !== false || p.argv.length < 2) return PASS
    await p.err(`${p.sys.session.user} is not in the sudoers file. This incident will be reported.\n`)
    return EXIT.FAILURE
  },
})
