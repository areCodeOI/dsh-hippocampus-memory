#!/usr/bin/env node
/**
 * Hippocampus Memory — command line interface.
 *
 * A thin wrapper over the same store used by the DSH plugin and the MCP/HTTP
 * servers. Useful for scripting, backups and quick inspection.
 */

import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { MemoryStore } from '../lib/store.js'
import { TOOL_DEFS, callTool } from '../lib/tools.js'
import { resolveStorageConfig, storageLabel } from '../lib/paths.js'
import { createMemoryHttpServer, listen } from '../lib/http.js'
import { AuthService } from '../lib/auth.js'
import { listNamespaces, createNamespace, renameNamespace, mergeNamespaces, deleteNamespace } from '../lib/namespaces.js'
import { nodeExecutable } from '../lib/exec.js'

const { values, positionals } = parseArgs({
  options: {
    db: { type: 'string' },
    storage: { type: 'string' },
    'pg-url': { type: 'string' },
    'pg-schema': { type: 'string' },
    'data-dir': { type: 'string' },
    'data-location': { type: 'string' },
    'pgvector': { type: 'boolean' },
    'graph-provider': { type: 'string' },
    'from-db': { type: 'string' },
    'from-storage': { type: 'string' },
    'from-pg-url': { type: 'string' },
    'from-pg-schema': { type: 'string' },
    'from-data-dir': { type: 'string' },
    'to-db': { type: 'string' },
    'to-storage': { type: 'string' },
    'to-pg-url': { type: 'string' },
    'to-pg-schema': { type: 'string' },
    'to-data-dir': { type: 'string' },
    namespace: { type: 'string' },
    kind: { type: 'string' },
    importance: { type: 'string' },
    confidence: { type: 'string' },
    tags: { type: 'string' },
    entities: { type: 'string' },
    confirmed: { type: 'boolean' },
    supersedes: { type: 'string' },
    supersede: { type: 'string' },
    dedupe: { type: 'string' },
    content: { type: 'string' },
    summary: { type: 'string' },
    limit: { type: 'string' },
    mode: { type: 'string' },
    'min-importance': { type: 'string' },
    'all-namespaces': { type: 'boolean' },
    'include-archived': { type: 'boolean' },
    'include-pending': { type: 'boolean' },
    json: { type: 'boolean' },
    hard: { type: 'boolean' },
    confirm: { type: 'boolean' },
    force: { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    port: { type: 'string', short: 'p' },
    host: { type: 'string' },
    token: { type: 'string' },
    email: { type: 'string' },
    password: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
  allowPositionals: true,
})

const command = positionals[0]
const rest = positionals.slice(1)

function usage() {
  process.stdout.write(`hippocampus <command> [args] [--db path | --storage postgres --pg-url URL] [--json]

commands:
  add <fact>                   写入一条最小事实（--kind buffer|episodic|semantic|persona,
                               --importance 0.1-10, --tags a,b, --confirmed, --supersedes id）
  search [query]               召回记忆（--limit 5, --mode relevance|recent|important,
                               --kind, --all-namespaces, --include-archived）
  get <id>                     读取一条记忆
  update <id>                  更新（--content, --importance, --confirm, --supersede oldId）
  archive <id>                 归档
  delete <id>                  软删除（--hard --confirm 永久删除）
  replay                       回放：衰减、归档、清理、巩固（--dry-run）
  stats                        记忆库统计
  conflicts                    列出待确认冲突
  export [file]                导出 JSON（默认 stdout）
  import <file>                导入 JSON
  tool <name> [json]           调用任意 memory_* 工具
  user list                    列出管理员账号（不显示密码哈希）
  user reset-password          重置密码并吊销该用户全部会话：
                               --email x@y.com [--password 新密码]
                               省略 --password 时会生成一次性强密码（只显示一次）
  namespace list               列出记忆空间（总数/分层/最近写入）
  namespace create <name>      预留空空间（写入首条记忆也会自动创建）
  namespace rename <from> <to> 重命名；同步 API key 白名单与排队任务
  namespace merge <from> <into> 合并；精确重复的 active 记忆会去重
  namespace delete <name>      默认 7 天软删除；--hard --confirm 永久删除
                               --force 允许操作配置的默认空间或 persona
  migrate                      复制到一个新存储（--from-db/--from-pg-url → --to-pg-url/--to-db）
  serve-http                   启动 HTTP/MCP 服务（--port 7337）
  serve-mcp                    启动 stdio MCP 服务

storage:
  --storage sqlite|postgres    默认 sqlite；postgres 需要 --pg-url 或 HIPPOCAMPUS_PG_URL
  --data-dir <dir>             SQLite 数据目录（默认 <plugin>/.data/hippocampus）
  --pg-schema <name>           PostgreSQL schema（默认 public）
  --pgvector                   启用 pgvector 精确向量检索（默认 auto）
  --graph-provider <name>      projection | postgres
`)
}

function fail(message) {
  process.stderr.write(`error: ${message}\n`)
  process.exit(1)
}

function parseMaybeJson(value) {
  if (value === undefined) return undefined
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

function print(value) {
  if (values.json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
    return
  }
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function formatSearch(result) {
  if (!result.count) {
    process.stdout.write(`无匹配记忆（query=${JSON.stringify(result.query)}）\n`)
    return
  }
  process.stdout.write(`# ${result.count} 条相关记忆（${result.mode}）\n`)
  result.memories.forEach((memory, index) => {
    process.stdout.write(
      `${index + 1}. [${memory.kindLabel}] ${memory.content}\n` +
        `   id=${memory.id} 重要性=${memory.importance} 权重=${memory.weight} 状态=${memory.statusLabel}\n` +
        (memory.why ? `   召回原因：${memory.why}\n` : ''),
    )
  })
}

function formatStats(stats) {
  process.stdout.write(`记忆库：${stats.dbPath}\n`)
  process.stdout.write(
    `总量 ${stats.totals.all}（有效 ${stats.totals.active} / 归档 ${stats.totals.archived} / 待删除 ${stats.totals.pendingDelete} / 冲突 ${stats.totals.conflict} / 被取代 ${stats.totals.superseded}）\n`,
  )
  process.stdout.write(`分层：${Object.entries(stats.byKind).map(([k, v]) => `${k}=${v}`).join('  ') || '空'}\n`)
  process.stdout.write(`待确认冲突：${stats.openConflicts}；上次回放：${stats.lastReplayAt ? new Date(stats.lastReplayAt).toISOString() : '从未'}\n`)
  process.stdout.write(`数据库大小：${(stats.dbSizeBytes / 1024).toFixed(1)} KiB\n`)
}

async function main() {
  if (values.help || !command || command === 'help') return usage()

  if (command === 'serve-mcp') {
    const childArgs = [fileURLToPath(new URL('./hippocampus-mcp.mjs', import.meta.url))]
    if (values.db) childArgs.push('--db', values.db)
    if (values.storage) childArgs.push('--storage', values.storage)
    if (values['pg-url']) childArgs.push('--pg-url', values['pg-url'])
    if (values['pg-schema']) childArgs.push('--pg-schema', values['pg-schema'])
    if (values['data-dir']) childArgs.push('--data-dir', values['data-dir'])
    if (values['pgvector']) childArgs.push('--pgvector')
    if (values.namespace) childArgs.push('--namespace', values.namespace)
    const child = spawn(nodeExecutable(), childArgs, { stdio: 'inherit' })
    child.on('exit', (code) => process.exit(code ?? 0))
    return
  }

  if (command === 'migrate') {
    const sourceStorage = resolveStorageConfig({
      storage: values['from-storage'],
      dbPath: values['from-db'],
      dataDir: values['from-data-dir'],
      pgUrl: values['from-pg-url'],
      pgSchema: values['from-pg-schema'],
    })
    const targetStorage = resolveStorageConfig({
      storage: values['to-storage'],
      dbPath: values['to-db'],
      dataDir: values['to-data-dir'],
      pgUrl: values['to-pg-url'],
      pgSchema: values['to-pg-schema'],
    })
    const source = new MemoryStore({ storage: sourceStorage })
    const target = new MemoryStore({ storage: targetStorage })
    try {
      const snapshot = source.exportAll('*')
      const result = target.importAll(snapshot, { skipExisting: true })
      print({ ok: true, from: sourceStorage.driver, to: targetStorage.driver, memories: snapshot.memories.length, imported: result.imported, skipped: result.skipped })
    } finally {
      source.close()
      target.close()
    }
    return
  }

  const storage = resolveStorageConfig({
    storage: values.storage,
    dbPath: values.db,
    dataDir: values['data-dir'],
    dataLocation: values['data-location'],
    pgUrl: values['pg-url'],
    pgSchema: values['pg-schema'],
    pgvector: values.pgvector,
  })
  const store = new MemoryStore({
    storage,
    namespace: values.namespace ?? 'default',
  })

  try {
    switch (command) {
      case 'add': {
        let content = values.content ?? rest.join(' ')
        if (!content) content = (await readStdin()).trim()
        if (!content) fail('add needs a fact: hippocampus add "用户喜欢..."')
        const result = store.add({
          content,
          kind: values.kind,
          importance: values.importance === undefined ? undefined : Number(values.importance),
          confidence: values.confidence === undefined ? undefined : Number(values.confidence),
          tags: values.tags?.split(',').map((tag) => tag.trim()).filter(Boolean),
          entities: values.entities?.split(',').map((entry) => entry.trim()).filter(Boolean),
          confirmed: values.confirmed,
          supersedes: values.supersedes,
          dedupe: values.dedupe,
          summary: values.summary,
          source: 'cli',
        })
        if (values.json) print(result)
        else {
          process.stdout.write(`✔ ${result.action} [${result.memory.kindLabel}] ${result.memory.content}\n`)
          process.stdout.write(`  id=${result.memory.id} 重要性=${result.memory.importance} 状态=${result.memory.statusLabel}\n  ${result.message}\n`)
        }
        break
      }
      case 'search': {
        const query = rest.join(' ')
        const result = store.search(query, {
          limit: values.limit ? Number(values.limit) : undefined,
          mode: values.mode ?? (query ? 'relevance' : 'recent'),
          kinds: values.kind ? values.kind.split(',') : undefined,
          minImportance: values['min-importance'] ? Number(values['min-importance']) : undefined,
          namespace: values['all-namespaces'] ? '*' : undefined,
          includeArchived: values['include-archived'],
          includePending: values['include-pending'],
        })
        if (values.json) print(result)
        else formatSearch(result)
        break
      }
      case 'get': {
        if (!rest[0]) fail('get needs an id')
        print(store.get(rest[0]))
        break
      }
      case 'update': {
        if (!rest[0]) fail('update needs an id')
        const patch = {}
        if (values.content !== undefined) patch.content = values.content
        if (values.kind) patch.kind = values.kind
        if (values.importance !== undefined) patch.importance = Number(values.importance)
        if (values.confidence !== undefined) patch.confidence = Number(values.confidence)
        if (values.tags !== undefined) patch.tags = values.tags.split(',').map((tag) => tag.trim()).filter(Boolean)
        if (values.confirmed) patch.confirmed = true
        if (values.supersede) patch.supersede = values.supersede
        print(store.update(rest[0], patch))
        break
      }
      case 'archive': {
        if (!rest[0]) fail('archive needs an id')
        print(store.archive(rest[0]))
        break
      }
      case 'delete': {
        if (!rest[0]) fail('delete needs an id')
        print(store.remove(rest[0], { hard: values.hard, confirm: values.confirm, force: values.force }))
        break
      }
      case 'replay': {
        const result = store.replay({ dryRun: values['dry-run'] })
        if (values.json) print(result)
        else {
          process.stdout.write(
            `回放完成：归档 ${result.archived}，待删除 ${result.pendingDelete}，永久清理 ${result.purged}，巩固 ${result.consolidated}，未解决冲突 ${result.conflictsOpen}\n`,
          )
        }
        break
      }
      case 'stats': {
        const stats = store.stats()
        if (values.json) print(stats)
        else formatStats(stats)
        break
      }
      case 'conflicts': {
        print({ conflicts: store.listConflicts('open') })
        break
      }
      case 'export': {
        const snapshot = store.exportAll(values['all-namespaces'] ? '*' : values.namespace)
        const target = rest[0]
        if (target) {
          fs.writeFileSync(target, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 })
          try {
            fs.chmodSync(target, 0o600)
          } catch {
            // best effort on filesystems without POSIX permissions
          }
          process.stderr.write(`exported ${snapshot.memories.length} memories -> ${target}\n`)
        } else {
          process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`)
        }
        break
      }
      case 'import': {
        if (!rest[0]) fail('import needs a file')
        const snapshot = JSON.parse(fs.readFileSync(rest[0], 'utf8'))
        print(store.importAll(snapshot))
        break
      }
      case 'namespace': {
        const sub = rest[0] ?? 'list'
        if (sub === 'list') {
          print(listNamespaces(store))
          break
        }
        if (!rest[1]) fail('namespace needs a name: namespace <create|rename|merge|delete> <name>')
        if (sub === 'create') {
          print(createNamespace(store, rest[1]))
          break
        }
        if (sub === 'rename') {
          if (!rest[2]) fail('namespace rename needs <from> <to>')
          print(renameNamespace(store, rest[1], rest[2], { force: values.force }))
          break
        }
        if (sub === 'merge') {
          if (!rest[2]) fail('namespace merge needs <from> <into>')
          print(mergeNamespaces(store, rest[1], rest[2], { force: values.force }))
          break
        }
        if (sub === 'delete') {
          print(deleteNamespace(store, rest[1], { hard: values.hard, confirm: values.confirm, force: values.force }))
          break
        }
        fail(`unknown namespace command: ${sub}`)
      }

      case 'user': {
        const sub = rest[0] ?? 'list'
        const auth = new AuthService({ db: store.db })
        if (sub === 'list') {
          print({ users: auth.listUsers() })
          break
        }
        if (sub !== 'reset-password') fail('user <list|reset-password> --email <email> [--password <new>]')
        const email = values.email ?? rest[1]
        if (!email) fail('user reset-password needs --email <email>')
        let password = values.password
        let generated = false
        if (!password && !process.stdin.isTTY) {
          const input = (await readStdin()).trim()
          if (input) password = input.split(/\r?\n/)[0]
        }
        if (!password) {
          // ponytail: 20 base64url chars, shown once; never written to a log.
          password = randomBytes(15).toString('base64url')
          generated = true
        }
        const result = auth.resetPassword({ email, password })
        if (values.json) {
          print({ ...result, email })
          break
        }
        process.stdout.write(`✔ 已重置 ${email} 的密码；吊销会话 ${result.revokedSessions} 个\n`)
        if (generated) {
          process.stdout.write(`  新密码（只显示这一次）：${password}\n  请立即登录，并在 WebUI「设置与权限」里改成自己的密码。\n`)
        } else {
          process.stdout.write('  旧密码与所有旧会话已失效，请用新密码重新登录。\n')
        }
        break
      }

      case 'tool': {
        if (!rest[0]) fail(`tool needs a name (${TOOL_DEFS.map((def) => def.name).join(', ')})`)
        const args = rest[1] !== undefined ? parseMaybeJson(rest[1]) : JSON.parse((await readStdin()) || '{}')
        print(await callTool(store, rest[0], args, { source: 'cli' }))
        break
      }
      case 'serve-http': {
        const server = createMemoryHttpServer({
          store,
          token: values.token ?? process.env.HIPPOCAMPUS_TOKEN,
          port: Number(values.port ?? 7337),
          host: values.host ?? '127.0.0.1',
          storage,
          graphProvider: values['graph-provider'],
        })
        const address = await listen(server, {
          port: Number(values.port ?? 7337),
          host: values.host ?? '127.0.0.1',
        })
        const displayHost = String(address.address).includes(':') ? `[${address.address}]` : address.address
        process.stdout.write(`hippocampus HTTP listening on http://${displayHost}:${address.port} (${storageLabel(storage)}; db=${store.dbPath})\n`)
        break
      }
      default:
        fail(`unknown command: ${command}`)
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  } finally {
    if (command !== 'serve-http') store.close()
  }
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)))
