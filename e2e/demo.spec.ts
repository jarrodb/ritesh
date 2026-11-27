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
