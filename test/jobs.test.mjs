import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import { MemoryStore } from '../lib/store.js'
import { JobQueue } from '../lib/jobs.js'

const dirs = []

function makeQueue(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-jobs-'))
  dirs.push(dir)
  const store = new MemoryStore({ dbPath: path.join(dir, 'memory.db') })
  let clock = Date.now()
  const queue = new JobQueue({ db: store.db, now: () => clock, ...options })
  return {
    queue,
    store,
    advance(ms) {
      clock += ms
    },
  }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

test('jobs: enqueue, claim, run and complete', async () => {
  const { queue, store } = makeQueue()
  const job = queue.enqueue('demo', { value: 7 }, { createdBy: 'tester' })
  assert.equal(job.status, 'queued')
  assert.equal(job.payload.value, 7)
  const claimed = queue.claim()
  assert.equal(claimed.id, job.id)
  assert.equal(claimed.status, 'running')
  queue.register({
    demo: async (current) => ({ doubled: current.payload.value * 2 }),
  })
  await queue.execute(claimed)
  const finished = queue.get(job.id)
  assert.equal(finished.status, 'succeeded')
  assert.equal(finished.result.doubled, 14)
  assert.equal(finished.progress, 1)
  assert.equal(queue.stats().byStatus.succeeded, 1)
  store.close()
})

test('jobs: failures retry until maxAttempts, then fail', async () => {
  const { queue, store, advance } = makeQueue()
  queue.enqueue('always-fails', {}, { maxAttempts: 2 })
  const first = await queue.runOnce({
    'always-fails': async () => {
      throw new Error('failure 0')
    },
  })
  assert.equal(first.status, 'queued')
  assert.match(first.error, /failure/)
  assert.equal(first.attempts, 1)
  // Retries back off instead of hammering the worker on every tick.
  assert.equal(queue.claim(), undefined, 'a failed job must not be reclaimed immediately')
  advance(2_000)
  const second = await queue.runOnce({
    'always-fails': async () => {
      throw new Error('failure 1')
    },
  })
  assert.equal(second.status, 'failed')
  assert.match(second.error, /failure/)
  assert.equal(second.attempts, 2)
  store.close()
})

test('jobs: queued jobs can be cancelled and leases are recovered', async () => {
  const { queue, store, advance } = makeQueue({ leaseMs: 1000 })
  const job = queue.enqueue('slow', {})
  assert.equal(queue.cancel(job.id), true)
  assert.equal(queue.get(job.id).status, 'cancelled')
  assert.equal(queue.cancel(job.id), false)

  const second = queue.enqueue('slow', {})
  queue.claim()
  advance(2000)
  assert.equal(queue.get(second.id).status, 'running')
  assert.equal(queue.recover(), 1)
  assert.equal(queue.get(second.id).status, 'queued')
  store.close()
})

test('jobs: list, stats and prune', async () => {
  const { queue, store, advance } = makeQueue()
  queue.enqueue('a', {}, { createdBy: 'x' })
  queue.enqueue('b', {}, { createdBy: 'y' })
  assert.equal(queue.list().total, 2)
  assert.equal(queue.stats().byType.a, 1)
  await queue.runOnce({ a: async () => ({ ok: true }) })
  await queue.runOnce({ b: async () => ({ ok: true }) })
  advance(31 * 86_400_000)
  assert.equal(queue.prune(30), 2)
  assert.equal(queue.list().total, 0)
  store.close()
})
