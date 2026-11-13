/**
 * DSH Host plugin: registers the hippocampus memory tools in the current
 * process and keeps the SQLite store open for the lifetime of the plugin.
 *
 * The same store file is also served by `hippocampus-mcp` (stdio MCP) and
 * `hippocampus-http` (REST/MCP-over-HTTP) for other models and languages.
 */

import { loadSchema } from './lib/schema.js'
import { MemoryStore } from './lib/store.js'
import { TOOL_DEFS, callTool, renderToolResult, memorySystemPrompt } from './lib/tools.js'
import { resolveStorageConfig } from './lib/paths.js'
import { VERSION } from './lib/constants.js'
import { EmbeddingService } from './lib/embeddings.js'
import { appendAutoRecall, extractUserText, shouldAutoRecall } from './lib/auto-recall.js'
import { captureFromMessages } from './lib/auto-capture.js'
import { hubSystemPrompt, HUB_DEFAULTS } from './lib/memory-hub.js'
import { runMemoryHub } from './lib/hub-runner.js'
import { registerDshGoUi } from './lib/dsh-go-ui.js'
import { createWebUiService } from './lib/webui.js'
import { vectorWeightFromEnv } from './lib/scoring.js'

// Loaded through lib/schema.js: a link install has no local node_modules, so a
// static bare import would abort plugin activation before apply() runs.
const Schema = await loadSchema()

export const Config = Schema
  ? Schema.object({
      httpEnabled: Schema.boolean().default(true).description('启动本机 HTTP/WebUI（127.0.0.1:7337）'),
      httpPort: Schema.natural().min(1).max(65535).default(7337).description('WebUI/REST 端口'),
      namespace: Schema.string().default('default').description('默认记忆空间，用于隔离不同项目/agent'),
      autoRecall: Schema.boolean().default(true).description('每轮对话前自动召回相关记忆'),
      memoryHub: Schema.boolean()
        .default(false)
        .description('记忆中枢：纯本地确定性决策「该记什么/怎么记/什么时候读」，不调用任何外置 LLM 或网络服务；开启后取代旧的自动召回/自动捕获路径'),
      hubReadThreshold: Schema.number().min(0).max(1).default(HUB_DEFAULTS.readThreshold).description('中枢读决策阈值：上下文信号分低于此值不检索'),
      hubWriteThreshold: Schema.number().min(0).max(1).default(HUB_DEFAULTS.writeThreshold).description('中枢写决策阈值：候选分低于此值不写入'),
      hubCapture: Schema.boolean().default(true).description('中枢是否自动写入候选记忆（仍进审阅队列）'),
      hubAutoApprove: Schema.boolean()
        .default(true)
        .description('高置信的用户事实（persona/semantic、confidence≥0.85）由中枢自主批准并立即生效；关闭后所有候选都进审阅队列'),
      hubCaptureMaxPerTurn: Schema.natural().min(1).max(5).default(HUB_DEFAULTS.captureMaxCandidates).description('中枢每轮最多写入几条候选记忆'),
      hubRecallLimit: Schema.natural().min(1).max(8).default(HUB_DEFAULTS.recallDefaultLimit).description('中枢每轮最多召回几条记忆'),
      hubRecallMaxChars: Schema.natural().min(400).max(4000).default(HUB_DEFAULTS.recallMaxChars).description('中枢注入上下文的最大字符数'),
      hubRecallMinScore: Schema.number().min(0).max(1).default(HUB_DEFAULTS.recallMinScore).description('中枢召回结果的最低相关分'),
      hubNamespace: Schema.string().default('').description('中枢写入/召回的空间；留空沿用 autoRecallNamespace/autoCaptureNamespace/default'),
      autoCapture: Schema.boolean()
        .default(false)
        .description('实验性：从用户消息中用本地规则自动捕获少量稳定事实（不调用模型、不存全文、默认关闭）'),
      autoCaptureNamespace: Schema.string()
        .default('')
        .description('自动捕获写入的空间；留空用默认 namespace，不支持 *'),
      autoCaptureMaxPerTurn: Schema.natural()
        .min(1)
        .max(5)
        .default(2)
        .description('每条用户消息最多自动捕获几条候选记忆'),
      autoCaptureAssistant: Schema.boolean()
        .default(true)
        .description('自动捕获时也提取助手消息中的明确决定/结论'),
      autoCaptureToolResults: Schema.boolean()
        .default(true)
        .description('自动捕获时也提取工具结果中的成功/失败结论'),
      autoCaptureLlm: Schema.boolean()
        .default(false)
        .description('自动捕获优先使用 OpenAI 兼容 LLM 抽取；失败回退本地规则'),
      autoCaptureLlmEndpoint: Schema.string()
        .default('')
        .description('LLM base URL，例如 http://127.0.0.1:11434/v1'),
      autoCaptureLlmModel: Schema.string()
        .default('')
        .description('LLM 模型名；留空则只用本地规则'),
      autoCaptureLlmApiKey: Schema.string()
        .default('')
        .description('LLM API key；建议改用 HIPPOCAMPUS_LLM_API_KEY 环境变量'),
      autoCaptureLlmTimeoutMs: Schema.natural()
        .min(1000)
        .max(30000)
        .default(8000)
        .description('LLM 抽取超时'),
      injectPrompt: Schema.boolean().default(true).description('向系统提示词注入记忆使用规范'),
      autoReplay: Schema.boolean().default(true).description('后台自动回放/衰减/巩固'),
      retrievalLimit: Schema.natural().min(1).max(50).default(5).description('memory_search 默认返回条数'),
      corsOrigins: Schema.array(Schema.string())
        .default([])
        .description('额外允许的浏览器 Origin（也可用逗号分隔字符串）；桌面壳协议 dsh-app:/dsh: 默认放行'),
    })
  : // No schema builder: cordis keeps the raw config and apply() supplies the
    // same defaults. Degrading is better than failing to activate the plugin.
    undefined

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
    corsOrigins: config.corsOrigins,
  })
  ctx.effect(() => () => webUi.stop(), 'hippocampus: WebUI server')
  console.warn(`[hippocampus] v${VERSION} loaded (WebUI button + memory_webui tool ready)`)
  // A link install keeps the database inside the source checkout by default.
  // Print the real path loudly so a reinstall/git clean cannot silently take it.
  console.warn(`[hippocampus] data: ${store.dbPath} (dataLocation=${config.dataLocation || 'plugin'})`)
  if (!config.dbPath && !config.dataDir && String(config.dataLocation || 'plugin').toLowerCase() !== 'dsh') {
    console.warn(
      '[hippocampus] hint: dataLocation=plugin keeps the SQLite file inside the plugin directory; ' +
        'for a git checkout/link install set dataLocation=dsh (or dbPath) so updates cannot move it.',
    )
  }

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

  // Host-only launcher: the dsh-go panel has its own WebUI button, but the
  // official DSH agent needs a tool to start the on-demand server and return a
  // fragment login link. Not exposed through MCP/HTTP (the HTTP API is itself
  // the server this tool starts).
  ctx.effect(
    () =>
        ctx.tools.register({
      name: 'memory_webui',
      description:
        '启动本机海马体 WebUI（127.0.0.1:7337）并返回带 token fragment 的登录链接。' +
        '用户说“打开 WebUI / 管理台”，或你需要让用户在浏览器里管理记忆时调用。' +
        '链接含访问 token，只发给当前用户，不要转发。',
      parameters: { type: 'object', properties: {} },
      output: {
        schema: {
          type: 'object',
          properties: { url: { type: 'string' }, origin: { type: 'string' } },
          required: ['url', 'origin'],
        },
        render: (_args, value) => renderToolResult(value),
      },
      timeoutMs: 15_000,
      execute: async () => {
        const started = await webUi.start()
        return { url: started.link, origin: started.origin }
      },
    }),
    'hippocampus: tool memory_webui',
  )

  const captureDefaults = {
    enabled: config.autoCapture === true,
    namespace: config.autoCaptureNamespace || '',
    maxPerTurn: Math.min(5, Math.max(1, Number(config.autoCaptureMaxPerTurn) || 2)),
    assistant: config.autoCaptureAssistant !== false,
    tools: config.autoCaptureToolResults !== false,
    llm: config.autoCaptureLlm === true,
  }
  // The HTTP/WebUI settings endpoint reads this so the live UI reflects the
  // plugin config defaults before the admin saves an override in the DB.
  store.autoCaptureDefaults = captureDefaults
  // Same idea for the memory hub: these are the startup fallback values. A
  // saved row in the DB (WebUI / DSH settings) takes precedence every turn.
  store.hubDefaults = {
    enabled: config.memoryHub === true,
    readThreshold: Number(config.hubReadThreshold ?? HUB_DEFAULTS.readThreshold),
    writeThreshold: Number(config.hubWriteThreshold ?? HUB_DEFAULTS.writeThreshold),
    capture: config.hubCapture !== false,
    autoApprove: config.hubAutoApprove !== false,
    captureMaxPerTurn: Number(config.hubCaptureMaxPerTurn ?? HUB_DEFAULTS.captureMaxCandidates),
    recallLimit: Number(config.hubRecallLimit ?? HUB_DEFAULTS.recallDefaultLimit),
    recallMaxChars: Number(config.hubRecallMaxChars ?? HUB_DEFAULTS.recallMaxChars),
    recallMinScore: Number(config.hubRecallMinScore ?? HUB_DEFAULTS.recallMinScore),
    namespace: config.hubNamespace || '',
  }
  if (config.autoRecall !== false || config.autoCapture === true || config.memoryHub === true || config.httpEnabled === true) {
    const captureSeen = new Map()
    ctx.on('agent/pre-step', async ({ messages, agent, step }, next) => {
      const decision = await next()
      if (decision.kind !== 'enter' || !Array.isArray(messages) || messages.length === 0) return decision
      // Live settings: the WebUI/DSH can enable or disable the hub in the DB
      // without editing the profile patch or restarting. When no override is
      // saved, the startup Config values remain in charge.
      let hubSettings
      try {
        hubSettings = store.hubSettings(store.hubDefaults)
      } catch {
        hubSettings = store.hubDefaults
      }
      // Memory hub: one offline decision (read + write) replaces both legacy
      // paths. It never calls an external LLM, an embedding API or the network.
      if (hubSettings?.enabled === true) {
        const logger = (message) => console.warn(message)
        const hubConfig = {
          ...config,
          memoryHub: true,
          hubReadThreshold: hubSettings.readThreshold,
          hubWriteThreshold: hubSettings.writeThreshold,
          hubCapture: hubSettings.capture,
          hubAutoApprove: hubSettings.autoApprove,
          hubCaptureMaxPerTurn: hubSettings.captureMaxPerTurn,
          hubRecallLimit: hubSettings.recallLimit,
          hubRecallMaxChars: hubSettings.recallMaxChars,
          hubRecallMinScore: hubSettings.recallMinScore,
          hubNamespace: hubSettings.namespace,
        }
        const result = runMemoryHub(store, messages, decision, hubConfig, {
          sourceSession: agent?.id ?? null,
          step,
          seen: captureSeen,
          logger,
        })
        if (result.capture.captured > 0) {
          // Count only; never log captured content.
          console.info(`[hippocampus] memory-hub stored ${result.capture.captured} candidate(s)`)
        }
        return result.decision
      }
      let finalDecision = decision
      const text = extractUserText(messages)
      if (config.autoRecall !== false && shouldAutoRecall(text)) {
        try {
          // store.search rejects queries over 1000 chars; long user messages must
          // still be recallable instead of silently failing the whole step.
          const query = text.length > 1000 ? text.slice(0, 1000) : text
          const recallNamespace = config.autoRecallNamespace || store.namespace
          let recallAllowed = true
          if (recallNamespace !== '*') {
            const policy = store.namespacePolicy(recallNamespace)
            recallAllowed = !policy.archived && policy.autoRecall !== false
          }
          if (recallAllowed) {
            const result = store.search(query, {
              limit: Math.min(8, Math.max(1, Number(config.autoRecallLimit) || 4)),
              namespace: recallNamespace,
              mode: 'relevance',
              // Injecting context is a background read, not a user access: it must
              // not refresh last_access_at and keep decaying memories alive.
              updateAccess: false,
            })
            const minScore = Math.max(0, Number(config.autoRecallMinScore) || 0.18)
            const memories = (result.memories ?? []).filter((memory) => {
              if ((memory.score ?? 0) < minScore) return false
              // Auto-captured candidates stay out of automatic recall until a
              // human approves them in the review queue.
              if (memory.metadata?.autoCapture?.review === 'pending') return false
              if (recallNamespace !== '*') return true
              const policy = store.namespacePolicy(memory.namespace)
              return !policy.archived && policy.autoRecall !== false
            })
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
            finalDecision = appendAutoRecall(decision, memories, {
              maxChars: Math.min(4000, Math.max(400, Number(config.autoRecallMaxChars) || 1200)),
            })
          }
        } catch (error) {
          console.warn('[hippocampus] auto recall failed:', error instanceof Error ? error.message : String(error))
        }
      }
      const captureSettings = store.autoCaptureSettings(captureDefaults)
      if (captureSettings.enabled) {
        try {
          const captured = await captureFromMessages(store, messages, {
            namespace: captureSettings.namespace,
            limit: captureSettings.maxPerTurn,
            sourceSession: agent?.id ?? null,
            step,
            seen: captureSeen,
            includeAssistant: captureSettings.assistant,
            includeTools: captureSettings.tools,
            llm: {
              enabled: captureSettings.llm,
              endpoint: config.autoCaptureLlmEndpoint || '',
              model: config.autoCaptureLlmModel || '',
              apiKey: config.autoCaptureLlmApiKey || process.env.HIPPOCAMPUS_LLM_API_KEY || '',
              timeoutMs: config.autoCaptureLlmTimeoutMs,
            },
          })
          if (captured.captured > 0) {
            // Count only; never print captured content or secrets.
            console.info(`[hippocampus] auto-captured ${captured.captured} candidate(s)`)
          }
        } catch (error) {
          console.warn('[hippocampus] auto capture failed:', error instanceof Error ? error.message : String(error))
        }
      }
      return finalDecision
    })
  }

  if (config.injectPrompt !== false) {
    ctx.inject(['systemPrompt'], (sctx) => {
      sctx.effect(
        () =>
          sctx.systemPrompt.section({
            name: 'hippocampus:memory-protocol',
            order: 515,
            text: (() => {
              const base = memorySystemPrompt(resolveLanguage(config))
              let live
              try {
                live = store.hubSettings(store.hubDefaults)?.enabled === true
              } catch {
                live = false
              }
              return config.memoryHub === true || live
                ? `${base}\n\n${hubSystemPrompt(resolveLanguage(config) === 'en' ? 'en' : 'zh')}`
                : base
            })(),
          }),
        'hippocampus: memory protocol prompt',
      )
    })
  }

  const httpEnabled = config.httpEnabled === true || process.env.HIPPOCAMPUS_HTTP_ENABLED === '1'
  if (httpEnabled) {
    void webUi
      .start()
      .then((started) => {
        if (started?.external) {
          console.warn(
            `[hippocampus] port ${started.port} is already served by another hippocampus instance; ` +
              `using ${started.origin} instead of starting a second server`,
          )
        }
      })
      .catch((error) => {
        console.warn(
          `[hippocampus] HTTP server failed: ${error instanceof Error ? error.message : String(error)}` +
            (error?.code === 'EADDRINUSE' ? ` (port ${httpPort} busy; set httpPort or close the other process)` : ''),
        )
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
