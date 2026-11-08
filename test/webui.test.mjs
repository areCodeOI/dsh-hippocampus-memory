import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { MemoryStore } from '../lib/store.js'
import { createWebUiService } from '../lib/webui.js'

test('webui: first run creates a private token and starts an authenticated server', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-webui-'))
  const home = path.join(dir, 'dsh-home')
  const store = new MemoryStore({ dbPath: path.join(dir, 'memory.db') })
  store.add({ content: 'WebUI 启动测试记忆。', kind: 'semantic', importance: 6 })
  const service = createWebUiService({
    store,
    host: '127.0.0.1',
    port: 0,
    dshHome: home,
    logger: { warn() {} },
  })
  try {
    const started = await service.start()
    assert.match(started.link, /^http:\/\/127\.0\.0\.1:\d+\/#token=/)
    const tokenFile = path.join(home, 'hippocampus', 'webui-token')
    const token = fs.readFileSync(tokenFile, 'utf8').trim()
    assert.equal(token.length, 64)
    assert.ok(started.link.includes(encodeURIComponent(token)))
    if (process.platform !== 'win32') {
      assert.equal((fs.statSync(tokenFile).mode & 0o777).toString(8), '600')
    }

    const base = started.origin
    const page = await fetch(`${base}/`)
    assert.equal(page.status, 200)
    assert.match(await page.text(), /海马体记忆/)
    const denied = await fetch(`${base}/api/stats`)
    assert.equal(denied.status, 401)
    const allowed = await fetch(`${base}/api/stats`, { headers: { authorization: `Bearer ${token}` } })
    assert.equal(allowed.status, 200)
    assert.equal((await allowed.json()).totals.all, 1)

    const again = await service.start()
    assert.equal(again.link, started.link, 'reuses the token/server')
  } finally {
    service.stop()
    store.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
