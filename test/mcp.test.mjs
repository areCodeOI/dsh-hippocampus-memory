import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { afterEach, test } from 'node:test'
import { nodeExecutable } from '../lib/exec.js'

const dirs = []
const clients = []

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-mcp-'))
  dirs.push(dir)
  return path.join(dir, 'memory.db')
}

const BIN = path.resolve(import.meta.dirname, '../bin/hippocampus-mcp.mjs')

class McpClient {
  constructor(dbPath) {
    this.proc = spawn(nodeExecutable(), [BIN, '--db', dbPath], { stdio: ['pipe', 'pipe', 'pipe'] })
    clients.push(this)
    this.stderr = ''
    this.proc.stderr.setEncoding('utf8')
    this.proc.stderr.on('data', (chunk) => {
      this.stderr += chunk
    })
    this.pending = new Map()
    this.nextId = 1
    this.closed = false
    this.rl = readline.createInterface({ input: this.proc.stdout })
    this.rl.on('line', (line) => {
      let message
      try {
        message = JSON.parse(line)
      } catch {
        return
      }
      if (message.id !== undefined && this.pending.has(message.id)) {
        const { resolve } = this.pending.get(message.id)
        this.pending.delete(message.id)
        resolve(message)
      }
    })
  }

  request(method, params = {}) {
    const id = this.nextId++
    const payload = { jsonrpc: '2.0', id, method, params }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`timeout waiting for ${method}; stderr=${this.stderr}`))
      }, 10_000)
      this.pending.set(id, {
        resolve: (message) => {
          clearTimeout(timer)
          resolve(message)
        },
      })
      this.proc.stdin.write(`${JSON.stringify(payload)}\n`)
    })
  }

  notify(method, params = {}) {
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }

  raw(line) {
    this.proc.stdin.write(`${line}\n`)
  }

  async close() {
    if (this.closed) return
    this.closed = true
    this.proc.stdin.end()
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.proc.kill('SIGKILL')
        resolve()
      }, 5_000)
      this.proc.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    this.rl.close()
  }
}

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {})
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

test('MCP: initialize, tools/list and the full memory tool set', async () => {
  const client = new McpClient(tempDb())
  const init = await client.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'node-test', version: '1.0.0' },
  })
  assert.equal(init.result.protocolVersion, '2025-06-18')
  assert.equal(init.result.serverInfo.name, 'hippocampus-memory')
  assert.match(init.result.instructions, /memory_search/)
  assert.ok(init.result.capabilities.tools)

  client.notify('notifications/initialized')
  const list = await client.request('tools/list')
  const names = list.result.tools.map((tool) => tool.name)
  assert.deepEqual(names, [
    'memory_add',
    'memory_search',
    'memory_get',
    'memory_update',
    'memory_archive',
    'memory_delete',
    'memory_replay',
    'memory_stats',
  ])
  const add = list.result.tools.find((tool) => tool.name === 'memory_add')
  assert.equal(add.inputSchema.required[0], 'content')
  await client.close()
})

test('MCP: add, search, get, stats and error handling', async () => {
  const client = new McpClient(tempDb())
  await client.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } })
  client.notify('notifications/initialized')

  const added = await client.request('tools/call', {
    name: 'memory_add',
    arguments: {
      content: '用户偏好使用 TypeScript 而不是 JavaScript。',
      kind: 'persona',
      importance: 9,
      tags: ['技术偏好'],
      confirmed: true,
    },
  })
  assert.equal(added.result.isError, false)
  assert.equal(added.result.structuredContent.action, 'created')
  const id = added.result.structuredContent.memory.id

  const found = await client.request('tools/call', {
    name: 'memory_search',
    arguments: { query: 'TypeScript 偏好' },
  })
  assert.equal(found.result.structuredContent.count, 1)
  assert.equal(found.result.structuredContent.memories[0].id, id)
  assert.match(found.result.structuredContent.memories[0].why, /重要性/)

  const got = await client.request('tools/call', { name: 'memory_get', arguments: { id } })
  assert.equal(got.result.structuredContent.memory.content, '用户偏好使用 TypeScript 而不是 JavaScript。')

  const stats = await client.request('tools/call', { name: 'memory_stats', arguments: { includeConflicts: true } })
  assert.equal(stats.result.structuredContent.totals.all, 1)
  assert.equal(stats.result.structuredContent.byKind.persona, 1)

  const bad = await client.request('tools/call', { name: 'memory_add', arguments: { content: '' } })
  assert.equal(bad.result.isError, true)
  assert.match(bad.result.content[0].text, /content is required/)

  const unknown = await client.request('tools/call', { name: 'memory_nope', arguments: {} })
  assert.equal(unknown.result.isError, true)
  assert.match(unknown.result.content[0].text, /unknown memory tool/)

  const missing = await client.request('tools/call', { name: 'memory_get', arguments: { id: 'mem_missing' } })
  assert.equal(missing.result.structuredContent.found, false)
  await client.close()
})

test('MCP: resources, prompts and notifications', async () => {
  const client = new McpClient(tempDb())
  await client.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } })
  client.notify('notifications/initialized')

  const resources = await client.request('resources/list')
  const uris = resources.result.resources.map((resource) => resource.uri)
  assert.deepEqual(uris, ['memory://stats', 'memory://recent', 'memory://conflicts'])

  const stats = await client.request('resources/read', { uri: 'memory://stats' })
  const parsed = JSON.parse(stats.result.contents[0].text)
  assert.equal(parsed.ok, true)

  const prompts = await client.request('prompts/list')
  assert.equal(prompts.result.prompts[0].name, 'hippocampus_memory_protocol')
  const prompt = await client.request('prompts/get', { name: 'hippocampus_memory_protocol' })
  assert.match(prompt.result.messages[0].content.text, /海马体长期记忆/)

  const ping = await client.request('ping')
  assert.deepEqual(ping.result, {})
  await client.close()
})

test('MCP: parse errors and unknown methods are JSON-RPC errors', async () => {
  const client = new McpClient(tempDb())
  await client.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } })

  const responses = []
  const collect = new Promise((resolve) => {
    let count = 0
    const onLine = (line) => {
      try {
        const message = JSON.parse(line)
        if (message.id === 77) {
          responses.push(message)
          count += 1
          if (count >= 1) {
            client.rl.off('line', onLine)
            resolve()
          }
        }
      } catch {
        // ignore
      }
    }
    client.rl.on('line', onLine)
  })
  client.raw('{"jsonrpc":"2.0","id":77,"method":"tools/nope"}')
  await collect
  assert.equal(responses[0].error.code, -32601)

  const parseResponse = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), 3000)
    const onLine = (line) => {
      try {
        const message = JSON.parse(line)
        if (message.id === null && message.error) {
          clearTimeout(timer)
          client.rl.off('line', onLine)
          resolve(message)
        }
      } catch {
        // ignore
      }
    }
    client.rl.on('line', onLine)
  })
  client.raw('{not json')
  const parsed = await parseResponse
  assert.equal(parsed.error.code, -32700)
  await client.close()
})

test('MCP: memories persist across server restarts', async () => {
  const dbPath = tempDb()
  const first = new McpClient(dbPath)
  await first.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })
  first.notify('notifications/initialized')
  await first.request('tools/call', {
    name: 'memory_add',
    arguments: { content: '用户的猫叫 Mochi。', kind: 'semantic', importance: 5, confirmed: true },
  })
  await first.close()

  const second = new McpClient(dbPath)
  await second.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })
  second.notify('notifications/initialized')
  const search = await second.request('tools/call', {
    name: 'memory_search',
    arguments: { query: '猫 Mochi' },
  })
  assert.equal(search.result.structuredContent.count, 1)
  assert.equal(search.result.structuredContent.memories[0].content, '用户的猫叫 Mochi。')
  await second.close()
})
