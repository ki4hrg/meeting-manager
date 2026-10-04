import { defineConfig, devices } from '@playwright/test'
import { E2E_PORT } from './e2e/world'

/*
 * Browser tests: the app as John uses it, against a seeded database of its own
 * (e2e/serve.ts). `pnpm e2e`. They walk the main journeys and check every main
 * page at phone width in light and dark; the domain rules stay in Vitest.
 */
export default defineConfig({
  testDir: 'e2e',
  // One server and one database: tests that change it run one at a time.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  // `next dev` compiles a page the first time it is asked for.
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: `http://localhost:${E2E_PORT}`,
    timezoneId: 'America/Chicago',
    trace: 'retain-on-failure',
    // Where Chromium is preinstalled (Claude Code on the web) rather than downloaded.
    ...(process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } }
      : {}),
  },
  projects: [
    { name: 'sign-in', testMatch: /auth\.setup\.ts/ },
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], storageState: 'e2e/.auth/john.json' },
      dependencies: ['sign-in'],
      testIgnore: /phone\.spec\.ts/,
    },
    {
      name: 'phone',
      use: { ...devices['Pixel 7'], storageState: 'e2e/.auth/john.json' },
      dependencies: ['sign-in'],
      testMatch: /phone\.spec\.ts/,
    },
  ],
  webServer: {
    command: 'pnpm tsx e2e/serve.ts',
    url: `http://localhost:${E2E_PORT}/login`,
    timeout: 240_000,
    reuseExistingServer: false,
    stdout: process.env.E2E_SERVER_LOG ? 'pipe' : 'ignore',
    stderr: 'pipe',
  },
})
