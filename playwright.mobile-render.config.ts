/**
 * A STANDALONE Playwright project for the phone client.
 *
 * It is separate from `playwright.config.ts` on purpose: that config boots the
 * Docker E2E harness in globalSetup, and this test needs no dashboard at all —
 * it serves `public/mobile/` itself and replays recorded payloads. Folding it
 * in would make a two-second unit-of-rendering test pay a container boot.
 *
 *   pnpm test:mobile-render
 */
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/mobile-render",
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    // A phone viewport is the whole point: the defect was reported from one.
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    trace: "off",
  },
});
