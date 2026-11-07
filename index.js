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

export const inject = ['tools']

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function resolveLanguage(config) {
  const language = config.promptLanguage ?? 'auto'
  if (language === 'zh' || language === 'en') return language
  const env = `${process.env.DSH_LANG ?? ''} ${process.env.LANG ?? ''} ${process.env.LC_ALL ?? ''}`
  return /zh|cn|hans/i.test(env) ? 'zh' : 'zh'
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
                vectorWeight: Number(process.env.HIPPOCAMPUS_VECTOR_WEIGHT) || 0.35,
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
        const result = store.search(text, {
          limit: Math.min(8, Math.max(1, Number(config.autoRecallLimit) || 4)),
          namespace: config.autoRecallNamespace || store.namespace,
          mode: 'relevance',
        })
        const minScore = Math.max(0, Number(config.autoRecallMinScore) || 0.18)
        const memories = (result.memories ?? []).filter((memory) => (memory.score ?? 0) >= minScore)
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

  if (config.httpEnabled) {
    const httpHost = String(config.httpHost ?? '127.0.0.1')
    const configuredPort = Number(config.httpPort ?? 7337)
    const httpPort = Number.isFinite(configuredPort) ? configuredPort : 7337
    const httpToken = config.httpToken || process.env.HIPPOCAMPUS_TOKEN || undefined
    let httpServer = null
    let httpClosed = false
    void (async () => {
      try {
        httpServer = createMemoryHttpServer({
          store,
          token: httpToken,
          host: httpHost,
          port: httpPort,
          storage,
          graphProvider: config.graphProvider,
        })
        const address = await listen(httpServer, { port: httpPort, host: httpHost })
        if (httpClosed) {
          httpServer.close()
          return
        }
        if (!httpToken && httpHost !== '127.0.0.1' && httpHost !== 'localhost') {
          console.warn('[hippocampus] HTTP UI is exposed without a token; set httpToken or HIPPOCAMPUS_TOKEN')
        }
        console.warn(`[hippocampus] Web UI + REST listening on http://${address.address}:${address.port} (${storageLabel(storage)})`)
      } catch (error) {
        try {
          httpServer?.close()
        } catch {
          // ignore
        }
        console.warn('[hippocampus] HTTP server failed:', error instanceof Error ? error.message : String(error))
      }
    })()
    ctx.effect(
      () => () => {
        httpClosed = true
        try {
          httpServer?.close()
        } catch {
          // ignore
        }
      },
      'hippocampus: HTTP server',
    )
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
