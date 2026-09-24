import { defineConfig, devices } from '@playwright/test';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Browser tests for the lab console, against a real deployment.
 *
 * Deliberately serial with a single worker: every session is a real
 * container that costs money, and the API fences one live session per
 * address. The suite starts one session and every spec joins it, so a full
 * run costs one container rather than one per file.
 */

/**
 * The browsers live in a shared, pre-seeded directory whose folder carries a
 * build number that need not match what this Playwright release looks for,
 * so resolve what is actually on disk rather than trusting either the
 * default lookup or a hardcoded path.
 */
function findChromium(): string | undefined {
  if (process.env.PW_CHROME) return process.env.PW_CHROME;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  if (!existsSync(root)) return undefined;
  for (const dir of readdirSync(root).filter((d) => d.startsWith('chromium-')).sort().reverse()) {
    const candidate = join(root, dir, 'chrome-linux', 'chrome');
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export default defineConfig({
  testDir: './test/e2e',
  testMatch: '**/*.spec.ts',

  fullyParallel: false,
  workers: 1,
  retries: 0,
  // Container starts dominate: a cold one has been measured at up to 21s,
  // and a check run adds its own.
  timeout: 120_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],

  use: {
    baseURL: process.env.DASHBOARD_URL || 'https://opalix-dashboard.soubenz94.workers.dev',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    launchOptions: {
      executablePath: findChromium(),
      args: ['--no-sandbox'],
    },
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
