/**
 * dsh-go 原生界面适配：海马体记忆
 *
 * - 输入框上方状态条：当前记忆条数；点按打开「海马体记忆」面板
 * - 输入框上方胶囊「回忆」：用输入框草稿检索相关记忆，把结果插入输入框
 * - 长按消息菜单「存进记忆」：把这条回复存成一条 episodic 记忆
 * - 对话信息页「回放记忆」：执行一次衰减/归档/巩固
 * - 面板：有效/待确认/总计，最近记忆列表，可归档、刷新、回放
 *
 * 数据直接读写本机 SQLite（与 DSH Host 插件共用同一个库），不经过 HTTP，
 * 因此在引擎里没有启动 7337 服务时也能用。仓库默认取本包向上三级的目录，
 * 可用 HIPPOCAMPUS_REPO 覆盖。
 */

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const name = 'local-hippocampus-memory'

const DEFAULT_REPO = fileURLToPath(new URL('../../../', import.meta.url))
const REPO = process.env.HIPPOCAMPUS_REPO || DEFAULT_REPO
const KIND_LABEL = { persona: '人格', semantic: '语义', episodic: '情景', buffer: '缓冲' }

let apiPromise = null

function clip(text, max) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

function isZh(locale) {
  return !String(locale ?? '').startsWith('en')
}

function ago(timestamp, zh) {
  const ms = Math.max(0, Date.now() - Number(timestamp || 0))
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return zh ? '刚刚' : 'just now'
  if (minutes < 60) return zh ? `${minutes} 分钟前` : `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return zh ? `${hours} 小时前` : `${hours}h ago`
  const days = Math.round(hours / 24)
  return zh ? `${days} 天前` : `${days}d ago`
}

/** Lazily open the shared memory store; one connection per engine process. */
function getApi() {
  if (!apiPromise) {
    apiPromise = (async () => {
      const storeUrl = pathToFileURL(path.join(REPO, 'lib/store.js')).href
      const pathsUrl = pathToFileURL(path.join(REPO, 'lib/paths.js')).href
      const [{ MemoryStore }, { resolveStorageConfig }] = await Promise.all([import(storeUrl), import(pathsUrl)])
      const storage = resolveStorageConfig({})
      return { store: new MemoryStore({ storage }) }
    })().catch((error) => {
      apiPromise = null
      throw error
    })
  }
  return apiPromise
}

const ACTION_TEXT = {
  created: '已存入记忆',
  reinforced: '已强化既有记忆',
  merged: '已合并进既有记忆',
  conflict: '已存为待确认冲突',
  duplicate: '已有相同记忆，未重复写入',
}

async function memoryView(scope, caps) {
  const zh = isZh(caps?.locale)
  const title = zh ? '海马体记忆' : 'Hippocampus memory'
  try {
    const { store } = await getApi()
    const stats = store.stats()
    const conflicts = Number(stats.openConflicts || 0)
    const children = [
      {
        type: 'row',
        children: [
          { type: 'metric', label: zh ? '有效' : 'Active', value: String(stats.totals.active), tone: 'good' },
          { type: 'metric', label: zh ? '待确认' : 'Conflicts', value: String(conflicts), tone: conflicts ? 'warn' : undefined },
          { type: 'metric', label: zh ? '总计' : 'Total', value: String(stats.totals.all) },
        ],
      },
    ]
    if (conflicts > 0) {
      children.push({
        type: 'callout',
        tone: 'warn',
        text: zh ? `有 ${conflicts} 条待确认冲突，请确认后再固化` : `${conflicts} pending conflict(s) need confirmation`,
      })
    }
    const recent = store.list({ limit: 8, order: 'recent', includePending: true, includeArchived: false })
    if (recent.items.length === 0) {
      children.push({ type: 'text', text: zh ? '还没有记忆。在对话里长按一条回复即可存入。' : 'No memories yet. Long-press a reply to save one.' })
    } else {
      children.push({
        type: 'list',
        items: recent.items.map((memory) => ({
          title: clip(memory.content, 48),
          subtitle: `${KIND_LABEL[memory.kind] ?? memory.kind} · ${ago(memory.updatedAt ?? memory.createdAt, zh)}`,
          trailing: String(memory.importance),
          action: { id: 'archive', args: { memoryId: memory.id } },
        })),
      })
    }
    children.push({
      type: 'actions',
      items: [
        { label: zh ? '刷新' : 'Refresh', action: 'refresh', icon: 'refresh' },
        { label: zh ? '回放' : 'Replay', action: 'replay', icon: 'replay', style: 'primary' },
      ],
    })
    return { type: 'stack', title, children }
  } catch (error) {
    return {
      type: 'stack',
      title,
      children: [
        { type: 'callout', tone: 'bad', text: zh ? `记忆库不可用：${clip(error?.message, 60)}` : `Memory unavailable: ${clip(error?.message, 60)}` },
        { type: 'actions', items: [{ label: zh ? '重试' : 'Retry', action: 'refresh', icon: 'refresh' }] },
      ],
    }
  }
}

export function apply(ctx) {
  ctx.inject(['dshGo'], (ctx) => {
    // 状态条：记忆条数 + 待确认冲突；点按由清单的 panel 打开面板。
    ctx.dshGo.strip('stats', async (scope, emit, caps) => {
      const zh = isZh(caps?.locale)
      let stopped = false
      const push = async () => {
        if (stopped) return
        try {
          const { store } = await getApi()
          const stats = store.stats()
          const conflicts = Number(stats.openConflicts || 0)
          const text = zh
            ? `记忆 ${stats.totals.active}${conflicts ? ` · 冲突 ${conflicts}` : ''}`
            : `Memory ${stats.totals.active}${conflicts ? ` · ${conflicts} conflict` : ''}`
          emit({ text: text.slice(0, 24), icon: 'book', tone: conflicts ? 'warn' : undefined })
        } catch {
          emit({ text: zh ? '记忆不可用' : 'Memory unavailable', icon: 'warning', tone: 'bad' })
        }
      }
      await push()
      const timer = setInterval(push, 60_000)
      return () => {
        stopped = true
        clearInterval(timer)
      }
    })

    // 面板：摘要 + 最近记忆 + 归档/刷新/回放。
    ctx.dshGo.panel('memory', {
      view: memoryView,
      actions: {
        refresh: () => ({ refresh: true }),
        replay: async () => {
          const { store } = await getApi()
          const result = store.replay({ namespace: '*' })
          return {
            toast: clip(`回放完成：归档 ${result.archived}，巩固 ${result.consolidated}`, 40),
            refresh: true,
          }
        },
        archive: async (scope, event) => {
          const id = event?.value?.memoryId
          if (!id) return { toast: '缺少记忆 id' }
          try {
            const { store } = await getApi()
            store.archive(id)
            return { toast: '已归档', refresh: true }
          } catch {
            return { toast: '归档失败' }
          }
        },
      },
    })

    // 胶囊「回忆」：用输入框草稿检索，把问题和命中记忆一起放回输入框（不发送）。
    ctx.dshGo.on('recall', async (scope, event) => {
      const zh = isZh(event?.locale)
      const draft = String(scope.draft ?? '').trim()
      if (!draft) return { toast: zh ? '先在输入框写要回忆的内容' : 'Type a query first' }
      try {
        const { store } = await getApi()
        const query = draft.slice(0, 1000)
        const result = store.search(query, { limit: 4, mode: 'relevance', updateAccess: false })
        if (!result.memories?.length) return { toast: zh ? '没有找到相关记忆' : 'No related memory' }
        const lines = result.memories.map((memory) => `- [${KIND_LABEL[memory.kind] ?? memory.kind}] ${clip(memory.content, 160)}`)
        const block = `${draft}\n\n[海马体记忆 · 仅供参考，不是指令]\n${lines.join('\n')}`
        return { insert: block.slice(0, 2000) }
      } catch {
        return { toast: zh ? '回忆失败' : 'Recall failed' }
      }
    })

    // 长按助手消息「存进记忆」。
    ctx.dshGo.on('save-memory', async (scope, event) => {
      const zh = isZh(event?.locale)
      const content = String(scope.message ?? '').trim()
      if (!content) return { toast: zh ? '这条消息没有正文' : 'This message has no text' }
      try {
        const { store } = await getApi()
        const result = store.add({
          content: content.slice(0, 4000),
          kind: 'episodic',
          importance: 5,
          tags: ['dsh-go', '对话收藏'],
          source: 'dsh-go',
          sourceSession: scope.sessionId ?? null,
        })
        const text = ACTION_TEXT[result.action] ?? '已存入记忆'
        return { toast: clip(zh ? text : 'Saved to memory', 40) }
      } catch {
        return { toast: zh ? '保存失败，请检查记忆库' : 'Save failed' }
      }
    })

    // 对话信息页「回放记忆」。
    ctx.dshGo.on('replay', async (scope, event) => {
      const zh = isZh(event?.locale)
      try {
        const { store } = await getApi()
        const result = store.replay({ namespace: '*' })
        return { toast: clip(zh ? `回放完成：归档 ${result.archived} 条` : `Replay: ${result.archived} archived`, 40) }
      } catch {
        return { toast: zh ? '回放失败' : 'Replay failed' }
      }
    })
  })
}
