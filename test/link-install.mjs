#!/usr/bin/env node
/**
 * Regression for issue 1: a link: install must activate without running
 * pnpm install inside the plugin checkout.
 *
 * It builds a throwaway profile the way pnpm does for a link dependency:
 *   profile/node_modules/dsh-hippocampus-memory -> checkout (symlink, no node_modules)
 *   profile/node_modules/@deepseek-ai/schemastery -> host copy
 * Then it imports the package through the symlink. Node resolves the realpath
 * (the checkout), so only lib/schema.js's host-lookup fallback can find
 * schemastery. Missing it used to abort activation with ERR_MODULE_NOT_FOUND.
 *
 * Run with: node test/link-install.mjs
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-link-install-'))

function findSchemaSource() {
  const candidates = [
    path.join(REPO, 'node_modules', '@deepseek-ai', 'schemastery'),
    path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', '@deepseek-ai', 'schemastery'),
  ]
  if (process.env.DSH_HOME) {
    candidates.unshift(path.join(process.env.DSH_HOME, 'profiles', 'desktop', 'node_modules', '@deepseek-ai', 'schemastery'))
  }
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate
  }
  return null
}

const source = findSchemaSource()
assert.ok(source, 'test needs a local @deepseek-ai/schemastery copy to act as the host-provided package')

const checkout = path.join(root, 'checkout')
const profileModules = path.join(root, 'dsh-home', 'profiles', 'desktop', 'node_modules')
const memoryDb = path.join(root, 'memory.db')
fs.mkdirSync(checkout, { recursive: true })
fs.mkdirSync(path.join(profileModules, '@deepseek-ai'), { recursive: true })

// Copy only what the host plugin imports; crucially no node_modules.
for (const entry of ['index.js', 'package.json', 'lib']) {
  fs.cpSync(path.join(REPO, entry), path.join(checkout, entry), { recursive: true })
}
assert.equal(fs.existsSync(path.join(checkout, 'node_modules')), false, 'checkout must look like a git link install')

const linkType = process.platform === 'win32' ? 'junction' : 'dir'
fs.symlinkSync(source, path.join(profileModules, '@deepseek-ai', 'schemastery'), linkType)
fs.symlinkSync(checkout, path.join(profileModules, 'dsh-hippocampus-memory'), linkType)

const lines = [
  "import assert from 'node:assert/strict'",
  'const entry = ' + JSON.stringify(pathToFileURL(checkout).href) + " + '/index.js'",
  'const mod = await import(entry)',
  "assert.ok(mod.Config, 'Config must still be exported')",
  "assert.equal(typeof mod.Config['~standard'].validate, 'function')",
  'const validated = mod.Config[\'~standard\'].validate({ httpPort: 7555 })',
  'assert.equal(validated.issues, undefined)',
  'assert.equal(validated.value.httpPort, 7555)',
  'assert.equal(validated.value.httpEnabled, true)',
  'const tools = new Map()',
  'const ctx = {',
  '  effect(fn) { fn(); return () => {} },',
  '  on() { return () => {} },',
  "  tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },",
  "  inject(_names, callback) { callback({ systemPrompt: { section() { return () => {} } }, effect(fn) { fn(); return () => {} } }) },",
  '}',
  'mod.apply(ctx, { dbPath: ' + JSON.stringify(memoryDb) + ', autoReplay: false, injectPrompt: false, httpEnabled: false })',
  "assert.equal(tools.size, 10, 'all memory tools must register')",
  "const added = await tools.get('memory_add').execute({ content: '链接安装验收：激活成功。', kind: 'buffer' }, {})",
  "assert.equal(added.action, 'created')",
  "const stats = await tools.get('memory_stats').execute({}, {})",
  'assert.equal(stats.totals.all, 1)',
  'console.log(JSON.stringify({ ok: true, tools: tools.size, memories: stats.totals.all }))',
]

const child = spawnSync(process.execPath, ['--input-type=module', '-e', lines.join('\n')], {
  cwd: root,
  env: { ...process.env, DSH_HOME: path.join(root, 'dsh-home') },
  encoding: 'utf8',
  timeout: 60_000,
})
fs.rmSync(root, { recursive: true, force: true })

if (child.status !== 0) {
  console.error(child.stdout)
  console.error(child.stderr)
  console.error('link install simulation failed')
  process.exit(1)
}
const result = JSON.parse(child.stdout.trim().split('\n').pop())
assert.equal(result.ok, true)
console.log('✔ link install activates without local node_modules (tools=' + result.tools + ', memories=' + result.memories + ')')
