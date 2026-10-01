import { defineConfig } from 'vitest/config'

const alias = { '@': new URL('./', import.meta.url).pathname }

export default defineConfig({
  resolve: { alias },
  test: {
    globalSetup: ['test/setup.ts'],
    include: ['test/**/*.test.ts'],
    env: {
      // Test fixtures; they match no deployment.
      SESSION_SECRET: 'test-only-session-secret-not-used-anywhere-real-0123456789',
      PUBLIC_BASE_URL: 'https://meetings.example.test',
    },
    // A cold image pull is slower than the defaults allow.
    testTimeout: 30_000,
    hookTimeout: 180_000,
  },
})
