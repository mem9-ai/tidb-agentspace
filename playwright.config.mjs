import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.mjs',
  fullyParallel: true,
  workers: 2,
  retries: process.env.CI ? 1 : 0,
  failOnFlakyTests: !!process.env.CI,
  forbidOnly: !!process.env.CI,
  timeout: 20000,
  expect: { timeout: 5000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:4389',
    browserName: 'chromium',
    serviceWorkers: 'block',
    trace: process.env.CI ? 'on-first-retry' : 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: ['light', 'dark'].flatMap((theme) =>
    [
      { name: 'desktop', viewport: { width: 1280, height: 800 } },
      { name: 'narrow', viewport: { width: 390, height: 844 } },
    ].map(({ name, viewport }) => ({
      name: `${name}-${theme}`,
      metadata: { theme },
      use: { viewport, colorScheme: theme },
      ...(process.env.BROWSER_FULL_MATRIX !== '1' &&
      ((name === 'desktop' && theme === 'dark') || (name === 'narrow' && theme === 'light'))
        ? { grep: /@visual/ }
        : {}),
    })),
  ),
  webServer: {
    command: 'node e2e/serve-console.mjs',
    url: 'http://127.0.0.1:4389/',
    reuseExistingServer: false,
    timeout: 15000,
  },
});
