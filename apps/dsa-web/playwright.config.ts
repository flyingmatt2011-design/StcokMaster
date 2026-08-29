import { defineConfig, devices } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, '../..');
const shouldRunWebSmoke = !!process.env.DSA_WEB_SMOKE_PASSWORD;
const useExternalSmokeServers = process.env.DSA_WEB_SMOKE_EXTERNAL_SERVERS === '1';

function resolveBackendCommand() {
  if (process.env.DSA_WEB_SMOKE_BACKEND_CMD) {
    return process.env.DSA_WEB_SMOKE_BACKEND_CMD;
  }

  const unixVenvPython = path.join(repoRoot, '.venv', 'bin', 'python');
  if (fs.existsSync(unixVenvPython)) {
    return `${unixVenvPython} main.py --webui-only --host 127.0.0.1 --port 8000`;
  }

  const windowsVenvPython = path.join(repoRoot, '.venv', 'Scripts', 'python.exe');
  if (fs.existsSync(windowsVenvPython)) {
    return `"${windowsVenvPython}" main.py --webui-only --host 127.0.0.1 --port 8000`;
  }

  return 'python main.py --webui-only --host 127.0.0.1 --port 8000';
}

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    locale: 'zh-CN',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: process.env.DSA_WEB_SMOKE_DISABLE_VIDEO === '1' ? 'off' : 'retain-on-failure',
  },
  webServer: shouldRunWebSmoke && !useExternalSmokeServers
    ? [
        {
          command: resolveBackendCommand(),
          cwd: repoRoot,
          url: 'http://127.0.0.1:8000/api/v1/auth/status',
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
        },
        {
          // Invoke the locked local Vite binary directly. Some hardened npm setups
          // re-resolve dependencies on every nested `npm run` and can erase node_modules.
          command: 'node ./node_modules/vite/bin/vite.js --host 127.0.0.1 --port 4173',
          cwd: currentDir,
          url: 'http://127.0.0.1:4173',
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
        },
      ]
    : undefined,
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        channel: process.env.DSA_WEB_SMOKE_BROWSER_CHANNEL as 'chrome' | undefined,
      },
    },
  ],
});
