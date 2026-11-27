import { type ActionDef, type ActionEvent, type ActionResult, type ActionVia, RiteError } from "../contracts.js"

/**
 * True for http: and https: URLs. A relative reference passes, because it
 * resolves against the page. Parsing with a base applies the browser's own
 * rules, so "java\tscript:" is seen the way a browser would see it.
 */
function isWebUrl(url: string): boolean {
  if (url === "") return false
  try {
    const { protocol } = new URL(url, "http://rite.invalid/")
    return protocol === "http:" || protocol === "https:"
  } catch {
    return false
  }
}

/** EINVAL when a navigate or open action carries anything but an http(s) URL. */
export function checkAction(action: ActionDef, path: string): void {
  const url = "navigate" in action ? action.navigate : "open" in action ? action.open : undefined
  if (url !== undefined && !isWebUrl(url)) {
    throw new RiteError("EINVAL", path, `not an http or https URL: ${url}`)
  }
}

type EventFields = Omit<ActionEvent, "preventDefault" | "defaultPrevented">

function makeEvent(fields: EventFields): ActionEvent {
  let prevented = false
  return {
    ...fields,
    preventDefault: () => { prevented = true },
    get defaultPrevented() { return prevented },
  }
}

/** Builds the event for an action inode. `open` reports whether the browser opened the URL. */
export function runAction(action: ActionDef, path: string, via: ActionVia, open: (url: string) => boolean): ActionResult {
  checkAction(action, path)
  if ("navigate" in action) {
    return { event: makeEvent({ kind: "navigate", path, via, href: action.navigate }) }
  }
  if ("open" in action) {
    const event = makeEvent({ kind: "open", path, via, url: action.open })
    return open(action.open) ? { event } : { event, output: action.open }
  }
  if ("event" in action) {
    const fields: EventFields = { kind: "event", path, via, name: action.event }
    if ("detail" in action) fields.detail = action.detail
    return { event: makeEvent(fields) }
  }
  return { event: makeEvent({ kind: "print", path, via }), output: action.print }
}
