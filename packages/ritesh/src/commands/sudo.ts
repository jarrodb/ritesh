import { EXIT } from "../contracts.js"
import { defineCommand } from "../define.js"
import { body, ROOT_UID, usageError } from "./util.js"

const USAGE = "sudo command [arg...]"
const TRIES = 3

// No flags are declared: everything after `sudo` belongs to the command it runs.
export const sudo = defineCommand({
  name: "sudo",
  summary: "run a command as root",
  usage: USAGE,
  manual: [
    "Runs the command with uid 0. The host decides who may:",
    "nobody (the default), everybody, or whoever knows the password.",
    "The password is read from the terminal without echo, three tries.",
  ].join("\n"),
  run: body("sudo", async (p) => {
    const argv = p.argv.slice(1)
    if (argv.length === 0) return usageError(p, "sudo", USAGE, "missing command")
    const { user } = p.sys.session
    const policy = p.sys.sudo
    if (policy === false) {
      await p.err(`sudo: ${user} is not in the sudoers file.\n`)
      return EXIT.FAILURE
    }
    if (policy !== true && p.uid !== ROOT_UID) {
      if (!p.tty) {
        await p.err("sudo: a terminal is required to read the password\n")
        return EXIT.FAILURE
      }
      for (let attempt = 1; ; attempt++) {
        const password = await p.tty.read({ echo: false, prompt: `[sudo] password for ${user}: `, signal: p.signal })
        // ^D at the prompt gives up without a verdict.
        if (password === null) return EXIT.FAILURE
        if (await policy(password)) break
        if (attempt === TRIES) {
          await p.err("sudo: incorrect password\n")
          return EXIT.FAILURE
        }
        await p.err("Sorry, try again.\n")
      }
    }
    return p.sys.spawn(argv, { uid: ROOT_UID })
  }),
})
