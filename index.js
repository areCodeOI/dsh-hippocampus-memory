/**
 * DSH Host plugin: registers the hippocampus memory tools in the current
 * process and keeps the SQLite store open for the lifetime of the plugin.
 *
 * The same store file is also served by `hippocampus-mcp` (stdio MCP) and
 * `hippocampus-http` (REST/MCP-over-HTTP) for other models and languages.
 */

import { MemoryStore } from './lib/store.js'
import { TOOL_DEFS, callTool, renderToolResult, memorySystemPrompt } from './lib/tools.js'
import { resolveStorageConfig, storageLabel } from './lib/paths.js'
import { createMemoryHttpServer, listen } from './lib/http.js'
import { EmbeddingService } from './lib/embeddings.js'
import { appendAutoRecall, extractUserText, shouldAutoRecall } from './lib/auto-recall.js'
import { registerDshGoUi } from './lib/dsh-go-ui.js'
import { createWebUiService } from './lib/webui.js'
import { vectorWeightFromEnv } from './lib/scoring.js'

export const inject = ['tools']

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

export function resolveLanguage(config, env = process.env) {
  const language = config?.promptLanguage ?? 'auto'
  if (language === 'zh' || language === 'en') return language
  const value = `${env?.DSH_LANG ?? ''} ${env?.LANG ?? ''} ${env?.LC_ALL ?? ''}`
  if (/zh|cn|hans/i.test(value)) return 'zh'
  if (/(?:^|[^a-z])en(?![a-z])|english/i.test(value)) return 'en'
  // Unknown/empty locale keeps the product default (Simplified Chinese).
  return 'zh'
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} config
 */
export function apply(ctx, config = {}) {
  const storage = resolveStorageConfig({
    storage: config.storage,
    dbPath: config.dbPath,
    dataDir: config.dataDir,
    dataLocation: config.dataLocation,
    pgUrl: config.pgUrl,
    pgSchema: config.pgSchema,
    pgvector: config.pgvector,
    pgPoolMax: config.pgPoolMax,
    pgStatementTimeoutMs: config.pgStatementTimeoutMs,
  })
  const store = new MemoryStore({
    storage,
    namespace: config.namespace || 'default',
    retrievalLimit: clamp(Number(config.retrievalLimit) || 5, 1, 50),
  })

  ctx.effect(() => () => store.close(), 'hippocampus: close database')

  const httpHost = String(config.httpHost ?? '127.0.0.1')
  const configuredPort = Number(config.httpPort ?? 7337)
  const httpPort = Number.isFinite(configuredPort) ? configuredPort : 7337
  const webUi = createWebUiService({
    store,
    host: httpHost,
    port: httpPort,
    token: config.httpToken || process.env.HIPPOCAMPUS_TOKEN || undefined,
    dshHome: process.env.DSH_HOME,
    storage,
    graphProvider: config.graphProvider,
  })
  ctx.effect(() => () => webUi.stop(), 'hippocampus: WebUI server')

  // dsh-go 手机 App 的原生界面（与 Host 工具共用同一个 store）。没有 dsh-go
  // 桥接时这里保持 pending，不影响 Web/桌面端。
  ctx.inject(['dshGo'], (dctx) => {
    if (dctx?.dshGo) registerDshGoUi(dctx, store, webUi)
  })

  let embeddings = null
  try {
    embeddings = EmbeddingService.fromEnv()
  } catch (error) {
    console.warn('[hippocampus] embeddings disabled:', error instanceof Error ? error.message : String(error))
  }

  for (const def of TOOL_DEFS) {
    ctx.effect(
      () =>
        ctx.tools.register({
          name: def.name,
          description: def.description,
          parameters: def.parameters,
          output: {
            schema: { type: 'object', additionalProperties: true },
            render: (_args, value) => renderToolResult(value),
          },
          timeoutMs: def.name === 'memory_replay' ? 120_000 : 30_000,
          execute: async (args, exec) => {
            let callArgs = args
            let vectorInfo = null
            if (def.name === 'memory_search' && embeddings?.enabled && args?.query && (args.mode ?? 'relevance') === 'relevance') {
              const namespace = args.namespace ?? store.namespace
              const vector = await embeddings.search(store, args.query, { namespace })
              vectorInfo = { providers: vector.providers, errors: vector.errors, candidates: vector.scores.size }
              callArgs = {
                ...args,
                extraIds: [...vector.scores.keys()],
                vectorScores: vector.scores,
                vectorWeight: vectorWeightFromEnv(),
              }
            }
            const result = await callTool(store, def.name, callArgs, {
              source: 'dsh',
              sourceSession: exec?.agent?.id ?? null,
            })
            if (embeddings?.enabled && (def.name === 'memory_add' || def.name === 'memory_update') && result?.memory?.id) {
              void embeddings.indexMemory(store, result.memory.id).catch((error) => {
                console.warn('[hippocampus] embedding index failed:', error instanceof Error ? error.message : String(error))
              })
            }
            return vectorInfo && result && typeof result === 'object' ? { ...result, embedding: vectorInfo } : result
          },
        }),
      `hippocampus: tool ${def.name}`,
    )
  }

  if (config.autoRecall !== false) {
    ctx.on('agent/pre-step', async ({ messages }, next) => {
      const decision = await next()
      if (decision.kind !== 'enter' || !Array.isArray(messages) || messages.length === 0) return decision
      const text = extractUserText(messages)
      if (!shouldAutoRecall(text)) return decision
      try {
        // store.search rejects queries over 1000 chars; long user messages must
        // still be recallable instead of silently failing the whole step.
        const query = text.length > 1000 ? text.slice(0, 1000) : text
        const result = store.search(query, {
          limit: Math.min(8, Math.max(1, Number(config.autoRecallLimit) || 4)),
          namespace: config.autoRecallNamespace || store.namespace,
          mode: 'relevance',
          // Injecting context is a background read, not a user access: it must
          // not refresh last_access_at and keep decaying memories alive.
          updateAccess: false,
        })
        const minScore = Math.max(0, Number(config.autoRecallMinScore) || 0.18)
        const memories = (result.memories ?? []).filter((memory) => (memory.score ?? 0) >= minScore)
        if (memories.length > 0) {
          // Visible usage record for the panel / memory_stats. Only count an
          // actual injection, so idle turns do not write to the database.
          try {
            store.recordAutoRecall({
              count: memories.length,
              chars: memories.reduce((total, memory) => total + String(memory.content ?? '').length, 0),
            })
          } catch {
            // usage counters must never break recall
          }
        }
        return appendAutoRecall(decision, memories, {
          maxChars: Math.min(4000, Math.max(400, Number(config.autoRecallMaxChars) || 1200)),
        })
      } catch (error) {
        console.warn('[hippocampus] auto recall failed:', error instanceof Error ? error.message : String(error))
        return decision
      }
    })
  }

  if (config.injectPrompt !== false) {
    ctx.inject(['systemPrompt'], (sctx) => {
      sctx.effect(
        () =>
          sctx.systemPrompt.section({
            name: 'hippocampus:memory-protocol',
            order: 515,
            text: memorySystemPrompt(resolveLanguage(config)),
          }),
        'hippocampus: memory protocol prompt',
      )
    })
  }

  const httpEnabled = config.httpEnabled === true || process.env.HIPPOCAMPUS_HTTP_ENABLED === '1'
  if (httpEnabled) {
    void webUi.start().catch((error) => {
      console.warn('[hippocampus] HTTP server failed:', error instanceof Error ? error.message : String(error))
    })
  }
  if (config.autoReplay !== false) {
    const hours = clamp(Number(config.replayIntervalHours) || 24, 1, 24 * 30)
    // setTimeout/setInterval overflow above 2^31-1 ms and fire immediately.
    const intervalMs = Math.min(hours * 3_600_000, 2_147_483_647)
    const runReplay = () => {
      try {
        const result = store.replay({ namespace: '*' })
        if (result.archived || result.purged || result.consolidated) {
          console.warn(
            `[hippocampus] replay: archived=${result.archived} pending=${result.pendingDelete} purged=${result.purged} consolidated=${result.consolidated}`,
          )
        }
      } catch (error) {
        console.warn('[hippocampus] replay failed:', error instanceof Error ? error.message : String(error))
      }
    }

    // Catch up after downtime without delaying plugin activation.
    let lastReplayAt = 0
    try {
      lastReplayAt = Number(store.stats().lastReplayAt ?? 0)
    } catch {
      lastReplayAt = 0
    }
    const due = !lastReplayAt || Date.now() - lastReplayAt >= intervalMs
    const startupTimer = setTimeout(runReplay, due ? 5_000 : intervalMs)
    startupTimer.unref?.()
    const interval = setInterval(runReplay, intervalMs)
    interval.unref?.()

    ctx.effect(
      () => () => {
        clearTimeout(startupTimer)
        clearInterval(interval)
      },
      'hippocampus: replay schedule',
    )
  }
}
