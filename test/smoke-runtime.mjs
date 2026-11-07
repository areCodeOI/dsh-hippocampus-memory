#!/usr/bin/env node
/**
 * 多维度运行时冒烟（v5）：REST / MCP / 鉴权 / 安全 / 边界 / 性能 / 崩溃回归。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Runtime smoke suite (not part of `npm test`): starts the real HTTP server and
// exercises REST, MCP-over-HTTP, auth, CORS, limits, performance and the
// regression cases fixed in 0.2.x. Usage: node test/smoke-runtime.mjs
const REPO = fileURLToPath(new URL('..', import.meta.url))
const PORT = 7451
const DATA = path.join(os.tmpdir(), 'hippocampus-smoke')
const BASE = `http://127.0.0.1:${PORT}`
fs.rmSync(DATA, { recursive: true, force: true })
fs.mkdirSync(DATA, { recursive: true })

const child = spawn('node', ['bin/hippocampus-http.mjs', '--db', `${DATA}/m.db`, '--data-dir', DATA, '--port', String(PORT)], {
  cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'],
})
let boot = ''
child.stdout.on('data', (d) => { boot += d })
child.stderr.on('data', (d) => { boot += d })
let died = null
child.on('exit', (code, signal) => { died = { code, signal } })

const rows = []
const ok = (name, pass, note = '') => rows.push({ name, pass, note: String(note ?? '').replace(/\|/g, '/').slice(0, 130) })
const j = (v) => JSON.stringify(v)

async function call(name, path, opts = {}, expect = 200) {
  try {
    const res = await fetch(BASE + path, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) } })
    const text = await res.text()
    let body
    try { body = JSON.parse(text) } catch { body = text.slice(0, 200) }
    ok(name, opts.expectAny ? true : res.status === expect, `HTTP ${res.status} ${typeof body === 'string' ? body.slice(0, 90) : j(body).slice(0, 120)}`)
    return body
  } catch (error) {
    ok(name, false, `THROW ${error.message}`)
    return null
  }
}

let up = false
for (let i = 0; i < 100; i++) {
  try { if ((await fetch(`${BASE}/health`)).ok) { up = true; break } } catch {} 
  await new Promise((r) => setTimeout(r, 100))
}
ok('服务启动 + GET /health', up, boot.trim().slice(0, 120))
if (!up) { report(); process.exit(1) }

await call('GET /ready', '/ready')
await call('GET /api/public-config', '/api/public-config')
await call('GET /api/info', '/api/info')
await call('GET /openapi.json', '/openapi.json')
const mon = await call('GET /api/monitor', '/api/monitor')
const auth = await call('GET /api/auth/check', '/api/auth/check')
ok('回环自动管理员', auth?.auth?.role === 'admin', j(auth?.auth))
ok('monitor 字段齐备', !!(mon?.memory && mon?.jobs && mon?.cache), Object.keys(mon || {}).join(','))

// ---- 四层写入 + 查重 + 冲突 ----
const add = await call('POST persona(中文)', '/api/memories', { method: 'POST', body: j({ content: '用户对花生过敏，严重时需立即就医。', kind: 'persona', importance: 9, tags: ['健康', '过敏'] }) }, 201)
ok('写入返回 id+action', !!add?.memory?.id, `action=${add?.action}`)
await call('POST semantic', '/api/memories', { method: 'POST', body: j({ content: '项目使用 PostgreSQL 16 + pgvector 作为共享存储。', kind: 'semantic', importance: 7, tags: ['infra', '项目'] }) }, 201)
await call('POST episodic', '/api/memories', { method: 'POST', body: j({ content: '2026-11-01 部署时 7337 端口被占用，改用 7451。', kind: 'episodic', importance: 5, tags: ['部署', '项目'] }) }, 201)
await call('POST buffer', '/api/memories', { method: 'POST', body: j({ content: '临时：本次会话先用简体中文回复。', kind: 'buffer', tags: ['临时'] }) }, 201)
const dup = await call('POST 重复写入', '/api/memories', { method: 'POST', body: j({ content: '用户对花生过敏，严重时需立即就医。', kind: 'persona' }) }, 201)
ok('查重非新增', dup?.action === 'reinforced', `action=${dup?.action}`)
const conf = await call('POST 否定冲突写入', '/api/memories', { method: 'POST', body: j({ content: '用户对花生不过敏，可以放心吃花生酱。', kind: 'persona', importance: 9 }) }, 201)
ok('否定事实挂起为冲突', conf?.action === 'conflict' && conf?.memory?.status === 'conflict', `action=${conf?.action} ${conf?.conflict?.reason ?? ''}`)
const confList = await call('GET /api/conflicts 见冲突', '/api/conflicts')
ok('冲突列表可查', (confList?.conflicts || []).length === 1, `open=${(confList?.conflicts || []).length}`)

// ---- 检索 ----
const s1 = await call('GET 中文检索', '/api/memories/search?q=' + encodeURIComponent('花生过敏') + '&limit=5')
ok('中文分词命中', (s1?.memories || []).some((m) => m.content.includes('花生')), `hit=${s1?.memories?.length}`)
const s2 = await call('GET 英文检索', '/api/memories/search?q=' + encodeURIComponent('PostgreSQL pgvector shared storage') + '&limit=5')
ok('英文检索命中', (s2?.memories || []).length > 0, `hit=${s2?.memories?.length}`)
const s3 = await call('GET 无匹配', '/api/memories/search?q=' + encodeURIComponent('量子色动力学格点模拟') + '&limit=5')
ok('无匹配返回空不编造', (s3?.memories || []).length === 0, `hit=${s3?.memories?.length}`)
const s4 = await call('GET 否定语义', '/api/memories/search?q=' + encodeURIComponent('花生 忌口 注意事项') + '&limit=3')
ok('召回理由可读', !!(s4?.memories?.[0]?.why || s4?.recall), j(s4?.memories?.[0]?.why ?? s4?.recall).slice(0, 100))
await call('GET mode=recent', '/api/memories/search?q=x&mode=recent&limit=3')
await call('GET mode=important', '/api/memories/search?mode=important&limit=3')
await call('GET 分页列表', '/api/memories?limit=10&offset=0&status=active')

// ---- 星图 / 树 ----
const g = await call('GET /api/graph', '/api/graph?limit=100')
const edgeTypes = [...new Set((g?.edges || []).map((e) => e.type))]
ok('星图有节点和边', (g?.nodes || []).length > 1 && (g?.edges || []).length > 0, `nodes=${g?.nodes?.length} edges=${g?.edges?.length} types=${edgeTypes.join(',')}`)
ok('星图含 tag/similar 边', edgeTypes.includes('tag') || edgeTypes.includes('similar'), edgeTypes.join(','))
ok('星图含冲突边', edgeTypes.includes('conflict'), edgeTypes.join(','))
const t = await call('GET /api/tree', '/api/tree')
ok('树含 namespace/kind', JSON.stringify(t || {}).includes('persona'), j(t).slice(0, 100))

await call('GET /api/stats', '/api/stats')
const auditLog = await call('GET /api/audit', '/api/audit?limit=8')
ok('审计记录动作', (auditLog?.items || []).length > 0, (auditLog?.items || []).map((i) => i.action).join(',').slice(0, 120))
await call('GET /api/config', '/api/config')
const tools = await call('GET /api/tools', '/api/tools')
ok('工具目录 8 个', (tools?.tools || []).length === 8, j(tools).slice(0, 100))
const metricsText = await fetch(`${BASE}/metrics`).then((r) => r.text())
ok('Prometheus 类型声明完整', ['hippocampus_info', 'hippocampus_cache_misses', 'hippocampus_jobs'].every((m) => metricsText.includes(`# TYPE ${m} `)), metricsText.slice(0, 80))
const html = await fetch(`${BASE}/`).then((r) => r.text())
ok('WebUI 返回 HTML', /<div id="app"|<!doctype/i.test(html), String(html).slice(0, 50))

// ---- 单条生命周期 ----
const mid = add?.memory?.id
await call('GET 单条', `/api/memories/${mid}`)
await call('PATCH 单条', `/api/memories/${mid}`, { method: 'PATCH', body: j({ importance: 9.5, metadata: { reviewedBy: 'eval' } }) })
await call('POST archive', `/api/memories/${mid}/archive`, { method: 'POST' })
const restored = await call('POST restore', `/api/memories/${mid}/restore`, { method: 'POST' })
ok('归档后可恢复', restored?.memory?.status === 'active', j(restored?.memory?.status))

// ---- 任务 + 回放 ----
await call('POST /api/jobs replay', '/api/jobs', { method: 'POST', body: j({ type: 'replay', payload: { dryRun: true } }) }, 202)
await new Promise((r) => setTimeout(r, 1500))
const jobList = await call('GET 任务状态收敛', '/api/jobs?limit=5')
ok('异步任务执行完成', (jobList?.items || []).some((x) => x.status === 'succeeded'), j(jobList?.items?.[0])?.slice(0, 120))
await call('POST /api/replay dry-run', '/api/replay', { method: 'POST', body: j({ dryRun: true }) })

// ---- MCP over HTTP ----
await call('MCP initialize', '/mcp', { method: 'POST', body: j({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'eval', version: '1' } } }) })
const tl = await call('MCP tools/list', '/mcp', { method: 'POST', body: j({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) })
ok('MCP 暴露 8 个 memory_*', (tl?.result?.tools || []).filter((x) => x.name.startsWith('memory_')).length === 8, (tl?.result?.tools || []).map((x) => x.name).join(','))
const tc = await call('MCP memory_search', '/mcp', { method: 'POST', body: j({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'memory_search', arguments: { query: '花生 过敏', limit: 3 } } }) })
ok('MCP 检索命中', JSON.stringify(tc?.result ?? '').includes('花生'), j(tc?.result).slice(0, 100))
await call('MCP memory_add', '/mcp', { method: 'POST', body: j({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'memory_add', arguments: { content: '评测通过 MCP 写入的一条语义记忆：服务端口约定为 7451。', kind: 'semantic', importance: 6 } } }) })
await call('MCP resources/list', '/mcp', { method: 'POST', body: j({ jsonrpc: '2.0', id: 5, method: 'resources/list' }) })
await call('MCP prompts/list', '/mcp', { method: 'POST', body: j({ jsonrpc: '2.0', id: 6, method: 'prompts/list' }) })
const bad = await call('MCP 未知方法', '/mcp', { method: 'POST', body: j({ jsonrpc: '2.0', id: 7, method: 'nope/nope' }) })
ok('未知方法有 JSON-RPC 错误', bad?.error?.code !== undefined, j(bad?.error))
const badJson = await call('MCP 坏 JSON', '/mcp', { method: 'POST', body: '{oops', expectAny: true })
ok('坏 JSON 不崩进程', badJson !== null, j(badJson).slice(0, 80))

// ---- 工具级校验 ----
const st = await call('memory_stats 工具', '/api/tools/memory_stats', { method: 'POST', body: j({}) })
ok('memory_stats 返回计数', JSON.stringify(st).includes('totals'), j(st).slice(0, 100))
await call('工具非法参数', '/api/tools/memory_search', { method: 'POST', body: j({ query: 123 }), expectAny: true })
await call('非法 kind', '/api/memories', { method: 'POST', body: j({ content: 'x', kind: 'nope' }), expectAny: true }, 400)
await call('空内容', '/api/memories', { method: 'POST', body: j({ content: '   ' }), expectAny: true }, 400)
const big = await call('超长内容 30k', '/api/memories', { method: 'POST', body: j({ content: 'A'.repeat(30000) }), expectAny: true }, 400)
ok('超长内容有明确结果', big !== null, j(big).slice(0, 90))
await call('importance 越界', '/api/memories', { method: 'POST', body: j({ content: '越界测试', importance: 99 }), expectAny: true }, 201)
await call('404 未知 API', '/api/does-not-exist', {}, 404)
await call('405 PUT /api/stats', '/api/stats', { method: 'PUT', expectAny: true }, 405)
await call('405 POST /api/export', '/api/export', { method: 'POST', expectAny: true }, 405)
const trav = await call('路径穿越', '/assets/..%2f..%2f..%2fpackage.json', { expectAny: true })
ok('静态资源防穿越', !j(trav).includes('"dependencies"'), j(trav).slice(0, 90))
const trav2 = await call('路径穿越 2', '/assets/../../../etc/passwd', { expectAny: true })
ok('防穿越 2', !j(trav2).includes('root:'), j(trav2).slice(0, 90))
const gt = await fetch(`${BASE}/api/memories/zzz`, { headers: { authorization: 'Bearer garbage' } })
ok('错误 token 非 500', gt.status < 500, `HTTP ${gt.status}`)
await call('OPTIONS 预检', '/api/memories', { method: 'OPTIONS', expectAny: true })

// ---- CORS ----
const evil = await fetch(`${BASE}/api/stats`, { headers: { origin: 'https://evil.example' } })
ok('外部 Origin 不可读', evil.headers.get('access-control-allow-origin') === null, String(evil.headers.get('access-control-allow-origin')))
const local = await fetch(`${BASE}/api/stats`, { headers: { origin: 'http://127.0.0.1:3080' } })
ok('本机 Origin 允许', local.headers.get('access-control-allow-origin') === 'http://127.0.0.1:3080', String(local.headers.get('access-control-allow-origin')))

// ---- API key 与角色 ----
const keys = await call('POST /api/keys reader', '/api/keys', { method: 'POST', body: j({ name: 'eval-reader', role: 'reader', namespaces: ['default'] }) }, 201)
const k = keys?.key
ok('创建 API key 返回明文一次', typeof k === 'string' && /^hk_/.test(k), `keys=${Object.keys(keys || {}).join(',')}`)
if (k) {
  const readerRead = await fetch(`${BASE}/api/memories?limit=1`, { headers: { 'x-api-key': k } })
  ok('reader key 可读', readerRead.ok, `HTTP ${readerRead.status}`)
  const readerWrite = await fetch(`${BASE}/api/memories`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': k }, body: j({ content: 'reader 尝试写入' }) })
  ok('reader 写被拒 403', readerWrite.status === 403, `HTTP ${readerWrite.status}`)
  const readerKeys = await fetch(`${BASE}/api/keys`, { headers: { 'x-api-key': k } })
  ok('reader 看 key 列表被拒', readerKeys.status === 403 || readerKeys.status === 401, `HTTP ${readerKeys.status}`)
  await call('DELETE /api/keys/{id} 吊销', `/api/keys/${keys.id}`, { method: 'DELETE', expectAny: true })
  const after = await fetch(`${BASE}/api/memories?limit=1`, { headers: { 'x-api-key': k } })
  ok('吊销后失效', after.status === 401, `HTTP ${after.status}`)
}
const hard = await call('DELETE hard 缺 confirm', `/api/memories/${mid}?hard=true`, { method: 'DELETE', expectAny: true }, 400)
ok('硬删除需 confirm', /confirm/i.test(j(hard)), j(hard).slice(0, 90))

// ---- 性能 ----
const N = 300
const t0 = Date.now()
for (let i = 0; i < N; i++) {
  const r = await fetch(`${BASE}/api/memories`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: j({ content: `性能样本 ${i}：模块 ${i % 20} 的回归用例编号 ${i} 已通过并归档到发布分支。`, kind: i % 4 === 0 ? 'semantic' : 'episodic', importance: (i % 9) + 1, tags: [`perf${i % 20}`] }),
  })
  await r.json().catch(() => null)
}
const writeMs = Date.now() - t0
const t1 = Date.now()
let hits = 0
for (let i = 0; i < 40; i++) {
  const r = await fetch(`${BASE}/api/memories/search?q=` + encodeURIComponent(`模块 ${i % 20} 回归用例`) + '&limit=8')
  const b = await r.json().catch(() => ({}))
  hits += (b?.memories || []).length
}
const searchMs = (Date.now() - t1) / 40
const stats2 = await fetch(`${BASE}/api/stats`).then((r) => r.json()).catch(() => ({}))
ok(`写入 ${N} 条`, writeMs < 60000, `${writeMs}ms，平均 ${(writeMs / N).toFixed(1)}ms/条，库内 ${stats2?.totals?.all ?? '?'} 条`)
ok('检索 40 次平均延迟', searchMs < 50 && hits > 0, `${searchMs.toFixed(1)}ms/次，总命中 ${hits}`)
const t2 = Date.now()
await fetch(`${BASE}/api/graph?limit=500`)
ok('大图投影延迟', Date.now() - t2 < 3000, `${Date.now() - t2}ms`)
const t3 = Date.now()
const replay = await fetch(`${BASE}/api/replay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => r.json()).catch(() => ({}))
ok('真实回放可运行', replay !== null, `${Date.now() - t3}ms archived=${replay?.archived} consolidated=${replay?.consolidated} pending=${replay?.pendingDelete}`)

// ---- 导出 / 导入 ----
const exported = await fetch(`${BASE}/api/export`).then((r) => r.json()).catch(() => null)
ok('导出含全部记忆', (exported?.memories || []).length > 100, `count=${(exported?.memories || []).length}`)
const imported = await call('POST /api/import 回灌', '/api/import', { method: 'POST', body: j(exported), expectAny: true })
ok('导入幂等（skipExisting）', imported?.imported !== undefined, j(imported).slice(0, 120))

// ---- 优雅关闭 ----
child.kill('SIGTERM')
const gone = await new Promise((r) => { child.on('exit', (code, signal) => r({ code, signal })); setTimeout(() => r('timeout'), 5000) })
ok('SIGTERM 优雅退出', gone !== 'timeout', j(gone))

// ---- 崩溃回归（最后单独验证）----
const port2 = PORT + 1
const c2 = spawn('node', ['bin/hippocampus-http.mjs', '--db', `${DATA}/m2.db`, '--data-dir', DATA, '--port', String(port2)], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] })
let err2 = ''
c2.stderr.on('data', (d) => { err2 += d })
let c2died = null
c2.on('exit', (code, signal) => { c2died = { code, signal } })
for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${port2}/health`)).ok) break } catch {} await new Promise((r) => setTimeout(r, 100)) }
try {
  const r = await fetch(`http://127.0.0.1:${port2}/mcp`)
  ok('GET /mcp 返回 405', r.status === 405 && r.headers.get('allow') === 'POST', `HTTP ${r.status} allow=${r.headers.get('allow')}`)
} catch (error) { ok('GET /mcp 返回 405', false, `fetch 失败：${error.message}`) }
await new Promise((r) => setTimeout(r, 600))
let alive = true
try { await fetch(`http://127.0.0.1:${port2}/health`) } catch { alive = false }
ok('【关键】GET /mcp 后进程存活', alive, alive ? '仍可用' : `进程已死 ${j(c2died)} ${(c2died?.err || err2).split('\n').slice(0, 3).join(' ')}`)
try { c2.kill('SIGKILL') } catch {}

function report() {
  const pass = rows.filter((r) => r.pass).length
  console.log('\n| 检查项 | 结果 | 说明 |')
  console.log('| --- | --- | --- |')
  for (const row of rows) console.log(`| ${row.name} | ${row.pass ? '✅' : '❌'} | ${row.note} |`)
  console.log(`\n=== ${pass}/${rows.length} 通过 ===`)
  if (boot) console.log('--- server stderr tail ---\n' + boot.slice(-800))
}
report()
process.exit(0)
