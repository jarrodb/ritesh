import type { Env, Session, SessionView } from "../contracts.js"

/** Kernel variables an assignment, export, or unset may not touch. */
export const READ_ONLY: ReadonlySet<string> = new Set(["UID", "RITE_VERSION", "SHELL"])

export const NAME: RegExp = /^[A-Za-z_][A-Za-z0-9_]*$/

/** A variable's value. Env objects are plain, so a name like `constructor` must not reach the prototype. */
/** An environment with no prototype: `__proto__` is an ordinary variable name. */
export function envOf(...sources: Array<Readonly<Env> | undefined>): Env {
  const env = Object.create(null) as Env
  for (const src of sources) {
    if (src === undefined) continue
    for (const name of Object.keys(src)) env[name] = src[name] as string
  }
  return env
}

export function getVar(env: Readonly<Env>, name: string): string | undefined {
  return Object.hasOwn(env, name) ? env[name] : undefined
}

export interface SessionSeed {
  user: string
  uid: number
  home: string
  hostname: string
  version: string
  env: Env | undefined
}

export function createSession(seed: SessionSeed): Session {
  const env = envOf(
    { USER: seed.user, HOME: seed.home, HOSTNAME: seed.hostname, PATH: "/bin:/usr/bin" },
    seed.env,
    { PWD: seed.home, OLDPWD: seed.home, UID: String(seed.uid), RITE_VERSION: seed.version, SHELL: "/bin/rite" },
  )
  return {
    user: seed.user, uid: seed.uid, cwd: seed.home, oldCwd: seed.home, hostname: seed.hostname, home: seed.home,
    env, exported: new Set(Object.keys(env)), aliases: new Map(), lastStatus: 0, exitRequested: null,
  }
}

export function cloneSession(session: Session): Session {
  return {
    ...session,
    env: envOf(session.env),
    exported: new Set(session.exported),
    aliases: new Map(session.aliases),
  }
}

/** Makes `target` what `from` became. The status stays: the executor sets it after the pipeline. */
export function commitSession(target: Session, from: Session): void {
  const { lastStatus } = target
  Object.assign(target, from)
  target.lastStatus = lastStatus
}

export function viewOf(session: Session): SessionView {
  return {
    get user() { return session.user },
    get uid() { return session.uid },
    get cwd() { return session.cwd },
    get hostname() { return session.hostname },
    get home() { return session.home },
    get lastStatus() { return session.lastStatus },
  }
}

/** What a process sees: the exported variables, then the assignments scoped to its command. */
export function procEnv(session: Session, scoped: Readonly<Env>): Readonly<Env> {
  const env: Env = envOf()
  for (const name of session.exported) {
    const value = getVar(session.env, name)
    if (value !== undefined) env[name] = value
  }
  return Object.freeze(envOf(env, scoped))
}
