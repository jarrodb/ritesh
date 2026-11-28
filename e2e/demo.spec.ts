import AxeBuilder from "@axe-core/playwright"
import { expect, type Page, test } from "@playwright/test"

// The terminal's rows, as text (xterm renders rows as DOM in its default renderer).
const screen = (page: Page) => page.locator(".xterm-rows").innerText()

async function ready(page: Page): Promise<void> {
  await page.goto("/")
  await expect.poll(() => screen(page)).toContain("guest@rite.sh")
  await page.locator(".xterm-helper-textarea").focus()
}

test("runs a pipeline into a file and reads it back", async ({ page }) => {
  await ready(page)
  await page.keyboard.type("echo hello | tee /tmp/x\n")
  await page.keyboard.type("cat /tmp/x\n")
  await expect.poll(() => screen(page)).toMatch(/hello[\s\S]*hello/)
})

test("tab completes a command", async ({ page }) => {
  await ready(page)
  await page.keyboard.type("ech")
  await page.keyboard.press("Tab")
  await page.keyboard.type("done\n")
  await expect.poll(() => screen(page)).toContain("done")
})

test("^C abandons the line", async ({ page }) => {
  await ready(page)
  await page.keyboard.type("echo never")
  await page.keyboard.press("Control+c")
  await page.keyboard.type("echo after\n")
  const text = await screen(page)
  await expect.poll(() => screen(page)).toContain("after")
  expect(text).not.toMatch(/^never$/m)
})

test("cd into an action opens the link", async ({ page, context }) => {
  await ready(page)
  const popup = context.waitForEvent("page")
  await page.keyboard.type("cd code\n")
  expect((await popup).url()).toContain("github.com/jarrodb/ritesh")
})

test("fits the terminal on resize", async ({ page }) => {
  await ready(page)
  const before = await page.locator(".xterm-screen").boundingBox()
  await page.setViewportSize({ width: 700, height: 600 })
  await expect.poll(async () => (await page.locator(".xterm-screen").boundingBox())?.width).toBeLessThan(before?.width ?? 0)
})

test("Esc then Tab leaves the terminal", async ({ page }) => {
  await ready(page)
  await page.keyboard.press("Escape")
  await page.keyboard.press("Tab")
  await expect(page.locator(".xterm-helper-textarea")).not.toBeFocused()
})

test("has no serious accessibility violations outside the terminal", async ({ page }) => {
  await ready(page)
  const results = await new AxeBuilder({ page }).exclude(".xterm").analyze()
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical")
  expect(serious.map((v) => v.id)).toEqual([])
})

test("theme switches the terminal and the page, and is remembered", async ({ page }) => {
  await ready(page)
  await expect(page.locator("html")).toHaveAttribute("data-theme", "brass")
  await page.keyboard.type("theme paper\n")
  await expect(page.locator("html")).toHaveAttribute("data-theme", "paper")
  await expect.poll(() => page.locator("#term .xterm").evaluate((e) => getComputedStyle(e).backgroundColor)).toBe("rgb(245, 238, 227)")
  await page.reload()
  await expect(page.locator("html")).toHaveAttribute("data-theme", "paper")
  await page.getByRole("button", { name: /switch to brass/ }).click()
  await expect(page.locator("html")).toHaveAttribute("data-theme", "brass")
})

test("the status line runs its commands in the shell", async ({ page }) => {
  await ready(page)
  await page.getByRole("button", { name: "cdn" }).click()
  const version = await page.evaluate(() => (window as unknown as { Rite: { VERSION: string } }).Rite.VERSION)
  await expect.poll(() => screen(page)).toContain(`riteshjs@${version}/dist/rite.bundle.min.js`)
})

test("the focused terminal marks the title bar's edge", async ({ page }) => {
  await ready(page)
  const edge = () => page.locator(".title").evaluate((e) => getComputedStyle(e).borderBottomColor)
  const focused = await edge()
  await page.keyboard.press("Escape")
  await page.keyboard.press("Tab")
  await expect.poll(edge).not.toBe(focused)
})

test("fits a phone without scrolling sideways", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await ready(page)
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBe(0)
  await expect.poll(() => screen(page)).toContain("type help. more than one way in.")
})

test("jq runs in its worker, and ipcalc does address math", async ({ page }) => {
  await ready(page)
  await page.keyboard.type(`echo '{"name":"Ada","tags":["a","b"]}' | jq -c '{n: .name, count: (.tags | length)}'\n`)
  await expect.poll(() => screen(page), { timeout: 15_000 }).toContain('{"n":"Ada","count":2}')
  await page.keyboard.type("ipcalc 10.0.0.17/22\n")
  await expect.poll(() => screen(page)).toContain("10.0.0.1 - 10.0.3.254 (1,022)")
})
