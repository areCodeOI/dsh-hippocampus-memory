import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { MemoryStore } from '../lib/store.js'
import { createWebUiService } from '../lib/webui.js'

async function post(base, route, body) {
  const response = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, data: await response.json().catch(() => ({})) }
}

test('webui: first run requires admin setup, then accepts the session token', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-webui-'))
  const store = new MemoryStore({ dbPath: path.join(dir, 'memory.db') })
  store.add({ content: 'WebUI 启动测试记忆。', kind: 'semantic', importance: 6 })
  const service = createWebUiService({ store, host: '127.0.0.1', port: 0, logger: { warn() {} } })
  try {
    const started = await service.start()
    assert.match(started.link, /^http:\/\/127\.0\.0\.1:\d+\/$/)
    const base = started.origin

    const page = await fetch(`${base}/`)
    assert.equal(page.status, 200)
    assert.match(await page.text(), /海马体记忆/)

    const publicConfig = await (await fetch(`${base}/api/public-config`)).json()
    assert.equal(publicConfig.needsSetup, true)
    assert.equal(publicConfig.authRequired, false)

    // Before setup loopback is local admin, so the setup page can load.
    assert.equal((await fetch(`${base}/api/stats`)).status, 200)

    const registered = await post(base, '/api/auth/register', {
      email: 'admin@example.com',
      password: 'correct horse battery',
    })
    assert.equal(registered.status, 201)
    assert.match(registered.data.token, /^hs_/)
    assert.equal(registered.data.user.email, 'admin@example.com')

    // Setup completed: loopback is no longer anonymous.
    assert.equal((await fetch(`${base}/api/stats`)).status, 401)
    const allowed = await fetch(`${base}/api/stats`, {
      headers: { authorization: `Bearer ${registered.data.token}` },
    })
    assert.equal(allowed.status, 200)
    assert.equal((await allowed.json()).totals.all, 1)

    const duplicate = await post(base, '/api/auth/register', {
      email: 'other@example.com',
      password: 'another password',
    })
    assert.equal(duplicate.status, 409)

    const wrong = await post(base, '/api/auth/login', { email: 'admin@example.com', password: 'wrong password' })
    assert.equal(wrong.status, 401)
    const login = await post(base, '/api/auth/login', { email: 'admin@example.com', password: 'correct horse battery' })
    assert.equal(login.status, 200)
    assert.match(login.data.token, /^hs_/)

    await fetch(`${base}/api/auth/logout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${registered.data.token}` },
    })
    assert.equal(
      (await fetch(`${base}/api/stats`, { headers: { authorization: `Bearer ${registered.data.token}` } })).status,
      401,
    )

    const again = await service.start()
    assert.equal(again.link, started.link, 'reuses the server')
  } finally {
    service.stop()
    store.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('webui: an occupied port reuses the healthy hippocampus service', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-webui-port-'))
  const store = new MemoryStore({ dbPath: path.join(dir, 'memory.db') })
  const logger = { warn() {} }
  const first = createWebUiService({ store, host: '127.0.0.1', port: 0, logger })
  const started = await first.start()
  const second = createWebUiService({ store, host: '127.0.0.1', port: started.port, logger })
  try {
    const reused = await second.start()
    assert.equal(reused.external, true)
    assert.equal(reused.origin, started.origin)
    assert.equal(reused.port, started.port)
    assert.equal(second.running, true)
    assert.equal(second.external, true)
    const health = await fetch(`${reused.origin}/health`).then((response) => response.json())
    assert.equal(health.service, 'hippocampus-memory')
  } finally {
    second.stop()
    first.stop()
    store.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
