import { defineConfig, devices } from "@playwright/test"

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  use: { baseURL: "http://127.0.0.1:4178" },
  webServer: { command: "node e2e/serve.mjs", url: "http://127.0.0.1:4178/", reuseExistingServer: !process.env.CI },
  projects: [
    {
      name: "chromium",
      // CHROMIUM_PATH runs a system Chromium where Playwright's own cannot (NixOS).
      use: { ...devices["Desktop Chrome"], ...(process.env.CHROMIUM_PATH ? { launchOptions: { executablePath: process.env.CHROMIUM_PATH } } : {}) },
    },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
})
