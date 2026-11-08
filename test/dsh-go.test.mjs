import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { MemoryStore } from '../lib/store.js'
import { registerDshGoUi } from '../lib/dsh-go-ui.js'

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

function fakeDshGo() {
  const regs = { strips: new Map(), panels: new Map(), handlers: new Map() }
  return {
    regs,
    strip(id, def) { regs.strips.set(id, def); return () => regs.strips.delete(id) },
    panel(id, def) { regs.panels.set(id, def); return () => regs.panels.delete(id) },
    on(id, fn) { regs.handlers.set(id, fn); return () => regs.handlers.delete(id) },
  }
}

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-dshgo-'))
  const store = new MemoryStore({ dbPath: path.join(dir, 'memory.db') })
  return { store, dir }
}

test('dsh-go: every declared contribution is registered by the host plugin', () => {
  const { store, dir } = makeStore()
  const dshGo = fakeDshGo()
  registerDshGoUi({ dshGo }, store)
  const contributes = pkg.dshGo.contributes
  for (const item of contributes['composer.strip']) assert.ok(dshGo.regs.strips.has(item.id), `strip ${item.id}`)
  for (const item of contributes.panels) assert.ok(dshGo.regs.panels.has(item.id), `panel ${item.id}`)
  for (const item of [...contributes['composer.actions'], ...contributes['message.actions'], ...contributes['session.actions']]) {
    assert.ok(dshGo.regs.handlers.has(item.id), `handler ${item.id}`)
  }
  store.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('dsh-go: save-memory, recall and panel use the shared store', async () => {
  const { store, dir } = makeStore()
  const dshGo = fakeDshGo()
  registerDshGoUi({ dshGo }, store)
  store.add({ content: '用户对花生过敏。', kind: 'persona', importance: 10 })

  const view = await dshGo.regs.panels.get('memory').view({ sessionId: 's1' }, { locale: 'zh-CN' })
  assert.equal(view.type, 'stack')
  assert.ok(view.children.length >= 3)

  const saved = await dshGo.regs.handlers.get('save-memory')(
    { sessionId: 's1', message: '这条回复需要记住：发布窗口是周三。' },
    { locale: 'zh-CN' },
  )
  assert.equal(saved.toast, '已存入记忆')
  assert.equal(store.stats().totals.all, 2)

  const recalled = await dshGo.regs.handlers.get('recall')({ draft: '花生过敏' }, { locale: 'zh-CN' })
  assert.match(recalled.insert, /花生过敏/)
  assert.match(recalled.insert, /用户对花生过敏/)

  store.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('dsh-go: the WebUI panel action copies a fragment token link', async () => {
  const { store, dir } = makeStore()
  const dshGo = fakeDshGo()
  const webUi = { start: async () => ({ link: 'http://127.0.0.1:7337/#token=secret' }) }
  registerDshGoUi({ dshGo }, store, webUi)
  const panel = dshGo.regs.panels.get('memory')
  const result = await panel.actions.webui({}, { locale: 'zh-CN' })
  assert.equal(result[1].copy, 'http://127.0.0.1:7337/#token=secret')
  assert.match(result[0].toast, /WebUI/)
  store.close()
  fs.rmSync(dir, { recursive: true, force: true })
})
