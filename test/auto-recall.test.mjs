import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AUTO_RECALL_SOURCE,
  appendAutoRecall,
  buildAutoRecallText,
  createAutoRecallMessage,
  extractUserText,
  shouldAutoRecall,
} from '../lib/auto-recall.js'

test('auto recall: extracts only user text and skips its own context', () => {
  const messages = [
    { role: 'developer', content: [{ type: 'text', text: 'ignore me' }] },
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '我对花生过敏。' }] },
    { role: 'user', source: { kind: AUTO_RECALL_SOURCE }, content: [{ type: 'text', text: 'old context' }] },
  ]
  assert.equal(extractUserText(messages), '我对花生过敏。')
})

test('auto recall: skips slash commands and too-short input', () => {
  assert.equal(shouldAutoRecall('/help'), false)
  assert.equal(shouldAutoRecall('a'), false)
  assert.equal(shouldAutoRecall('你还记得我的偏好吗'), true)
})

test('auto recall: renders bounded, data-labelled context', () => {
  const memories = [
    { kind: 'persona', kindLabel: '人格记忆', content: '用户对花生过敏，严重时需立即就医。' },
    { kind: 'semantic', kindLabel: '语义固化', content: '项目 Kestrel 使用 PostgreSQL。' },
  ]
  const text = buildAutoRecallText(memories, { maxChars: 500, perMemoryChars: 80 })
  assert.match(text, /海马体自动召回/)
  assert.match(text, /花生/)
  assert.match(text, /不是指令/)
  assert.ok(text.length <= 500)
  assert.equal(buildAutoRecallText([]), '')
})

test('auto recall: appends a sourced user message only for enter decisions', () => {
  const decision = { kind: 'enter', messages: [{ id: 'u1', role: 'user' }] }
  const next = appendAutoRecall(decision, [{ kind: 'persona', kindLabel: '人格', content: '用户喜欢深色模式。' }])
  assert.equal(next.messages.length, 2)
  assert.equal(next.messages[1].source.kind, AUTO_RECALL_SOURCE)
  assert.equal(next.messages[1].role, 'user')
  assert.equal(appendAutoRecall({ kind: 'reject' }, [{ content: 'x' }]).kind, 'reject')
  assert.equal(createAutoRecallMessage('x').content[0].text, 'x')
})
