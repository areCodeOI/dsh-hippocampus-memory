import { defineConfig } from '@playwright/test'
import os from 'node:os'
import path from 'node:path'

const dataDir = path.join(os.tmpdir(), 'hippo-e2e-' + process.pid)

export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  use: {
    baseURL: 'http://127.0.0.1:7490',
    headless: true,
    viewport: { width: 1280, height: 900 },
  },
  webServer: {
    command: 'node ../bin/hippocampus-http.mjs --port 7490 --data-dir "' + dataDir + '"',
    url: 'http://127.0.0.1:7490/health',
    reuseExistingServer: false,
    timeout: 30_000,
  },
})
