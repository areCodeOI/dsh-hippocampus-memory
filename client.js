/**
 * DSH Web client entry.
 *
 * Adds a "记忆" icon next to Plugins in the sidebar and a DSH-styled memory
 * management panel in the main column. The panel talks to the standalone
 * hippocampus HTTP service (default http://<current-host>:7337), which can be
 * started by the host plugin (`httpEnabled: true`) or by hand.
 */
window.__ModuleLoader__.load({
  id: 'dsh-hippocampus-memory',
  factory: (require) => {
    const React = require('react')
    const { useCallback, useEffect, useMemo, useRef, useState } = React
    const h = React.createElement
    const PANEL_ID = 'hippocampus-memory'

    const CSS = `
.hmr-root{height:100%;min-height:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base,#080d18);color:var(--dsw-alias-label-primary,#e8f0ff);font-family:system-ui,-apple-system,"Segoe UI","Noto Sans SC",sans-serif;font-size:13px;overflow:hidden}
.hmr-head{display:flex;align-items:center;gap:12px;padding:18px 22px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(124,157,255,.14));background:var(--dsw-alias-bg-layer-1,#0e172b);background:color-mix(in srgb,var(--dsw-alias-bg-base,#080d18) 72%,transparent);backdrop-filter:blur(12px);flex:none}
.hmr-head h1{margin:0;font-size:18px;font-weight:600;letter-spacing:-.01em}.hmr-head p{margin:3px 0 0;font-size:11px;color:var(--dsw-alias-label-secondary,#8ea3c8)}
.hmr-head-actions{margin-left:auto;display:flex;align-items:center;gap:8px}
.hmr-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-warn-primary,#f6c76a);box-shadow:0 0 10px currentColor}.hmr-dot.ok{background:var(--dsw-alias-state-success-primary,#62e2a4)}.hmr-dot.err{background:var(--dsw-alias-state-error-primary,#ff718c)}
.hmr-btn{border:1px solid var(--dsw-alias-border-l1,rgba(124,157,255,.2));background:var(--dsw-alias-bg-layer-1,#0e172b);color:var(--dsw-alias-label-primary,#e8f0ff);border-radius:9px;padding:6px 10px;font-size:12px;cursor:pointer;transition:border-color .15s,background .15s}
.hmr-btn:hover{border-color:var(--dsw-alias-brand-primary,#7c9dff)}.hmr-btn.primary{border-color:transparent;background:linear-gradient(120deg,#6ee7d8,#7c9dff);color:#06101d;font-weight:600}.hmr-btn.danger{color:#ff718c;border-color:rgba(255,113,140,.35);background:rgba(255,113,140,.06)}
.hmr-btn[disabled]{opacity:.45;cursor:not-allowed}
.hmr-tabs{display:flex;gap:3px;padding:10px 22px 0;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(124,157,255,.12));flex:none}
.hmr-tab{border:0;background:transparent;color:var(--dsw-alias-label-secondary,#8ea3c8);padding:8px 12px 10px;font-size:12.5px;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px}
.hmr-tab:hover{color:var(--dsw-alias-label-primary,#e8f0ff)}.hmr-tab.active{color:var(--dsw-alias-label-primary,#e8f0ff);border-bottom-color:#6ee7d8}
.hmr-content{flex:1;min-height:0;overflow:auto;padding:18px 22px 30px}
.hmr-content::-webkit-scrollbar{width:10px}.hmr-content::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l1,#223250);border-radius:10px;border:3px solid transparent;background-clip:content-box}
.hmr-grid{display:grid;gap:12px}.hmr-stats{grid-template-columns:repeat(4,minmax(0,1fr))}
.hmr-card{border:1px solid var(--dsw-alias-border-l1,rgba(124,157,255,.14));border-radius:14px;background:linear-gradient(180deg,var(--dsw-alias-bg-layer-1,#0e172b),var(--dsw-alias-bg-base,#080d18));padding:14px;min-width:0}
.hmr-card h2{margin:0 0 10px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#8ea3c8);letter-spacing:.02em}
.hmr-stat .k{display:block;font-size:10.5px;color:var(--dsw-alias-label-secondary,#8ea3c8)}.hmr-stat strong{display:block;font-size:25px;font-weight:650;letter-spacing:-.03em;margin-top:6px}.hmr-stat small{display:block;font-size:10px;color:var(--dsw-alias-label-secondary,#8ea3c8);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hmr-stat.good strong{color:#6ee7d8}.hmr-stat.warn strong{color:#f6c76a}
.hmr-two{grid-template-columns:minmax(0,1.5fr) minmax(260px,1fr)}
.hmr-bars{display:flex;flex-direction:column;gap:9px}.hmr-bar-row{display:grid;grid-template-columns:52px minmax(0,1fr) 30px;align-items:center;gap:8px;font-size:11px;color:var(--dsw-alias-label-secondary,#8ea3c8)}
.hmr-bar{height:6px;border-radius:99px;background:var(--dsw-alias-bg-layer-2,#111d36);overflow:hidden}.hmr-bar i{display:block;height:100%;background:linear-gradient(90deg,#6ee7d8,#7c9dff)}
.hmr-bar i.persona{background:linear-gradient(90deg,#f5c86b,#ff9b74)}.hmr-bar i.semantic{background:linear-gradient(90deg,#4de3e1,#5b9dff)}.hmr-bar i.episodic{background:linear-gradient(90deg,#8aa8ff,#a78bfa)}.hmr-bar i.buffer{background:linear-gradient(90deg,#64779c,#8aa8ff)}
.hmr-row{display:flex;align-items:center;gap:9px;padding:9px 7px;border-radius:8px;cursor:pointer}.hmr-row:hover{background:rgba(124,157,255,.07)}
.hmr-row .txt{min-width:0;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px}.hmr-row .time{font-family:ui-monospace,monospace;font-size:9.5px;color:var(--dsw-alias-label-secondary,#8ea3c8)}
.hmr-tag{display:inline-flex;align-items:center;border:1px solid var(--dsw-alias-border-l1,rgba(124,157,255,.2));border-radius:99px;padding:2px 7px;font-size:9.5px;color:var(--dsw-alias-label-secondary,#8ea3c8);white-space:nowrap;background:var(--dsw-alias-bg-layer-2,#111d36)}
.hmr-tag.persona{color:#f5c86b;border-color:rgba(245,200,107,.3)}.hmr-tag.semantic{color:#6ee7d8;border-color:rgba(110,231,216,.3)}.hmr-tag.episodic{color:#8aa8ff;border-color:rgba(138,168,255,.3)}.hmr-tag.active{color:#62e2a4;border-color:rgba(98,226,164,.3)}.hmr-tag.conflict{color:#ff718c;border-color:rgba(255,113,140,.3)}
.hmr-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px}.hmr-input{flex:1;min-width:180px;border:1px solid var(--dsw-alias-border-l1,rgba(124,157,255,.2));background:var(--dsw-alias-bg-layer-1,#0e172b);color:inherit;border-radius:9px;padding:7px 10px;font-size:12px;outline:none}.hmr-input:focus{border-color:#6ee7d8}
.hmr-split{display:grid;grid-template-columns:minmax(0,1fr) minmax(300px,.72fr);gap:12px;align-items:start}
.hmr-list{display:flex;flex-direction:column;gap:2px;max-height:calc(100vh - 260px);overflow:auto}
.hmr-item{padding:10px;border-radius:9px;border:1px solid transparent;cursor:pointer}.hmr-item:hover{background:rgba(124,157,255,.06)}.hmr-item.sel{border-color:rgba(110,231,216,.35);background:rgba(110,231,216,.06)}
.hmr-item .line{display:flex;gap:6px;align-items:center}.hmr-item .body{margin:6px 0 0;font-size:12px;line-height:1.5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.hmr-item .meta{display:flex;gap:8px;font-size:9.5px;color:var(--dsw-alias-label-secondary,#8ea3c8);margin-top:4px;font-family:ui-monospace,monospace}
.hmr-detail{position:sticky;top:0}.hmr-detail .content{font-size:13px;line-height:1.7;white-space:pre-wrap;word-break:break-word;margin:0 0 12px}
.hmr-kv{display:grid;grid-template-columns:1fr 1fr;gap:7px}.hmr-kv div{padding:7px;border-radius:7px;background:var(--dsw-alias-bg-layer-2,#111d36)}.hmr-kv span{display:block;font-size:9px;color:var(--dsw-alias-label-secondary,#8ea3c8)}.hmr-kv b{display:block;font-size:11px;font-weight:500;margin-top:2px;word-break:break-all}
.hmr-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:12px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1,rgba(124,157,255,.12))}
.hmr-form{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px}.hmr-form label{display:flex;flex-direction:column;gap:4px;font-size:10px;color:var(--dsw-alias-label-secondary,#8ea3c8)}.hmr-form label.full{grid-column:1/-1}
.hmr-form input,.hmr-form textarea,.hmr-form select{border:1px solid var(--dsw-alias-border-l1,rgba(124,157,255,.2));background:var(--dsw-alias-bg-layer-1,#0e172b);color:inherit;border-radius:7px;padding:6px 8px;font-size:12px;font-family:inherit}.hmr-form textarea{min-height:70px;resize:vertical}
.hmr-empty{padding:34px 14px;text-align:center;color:var(--dsw-alias-label-secondary,#8ea3c8);font-size:12px}.hmr-empty strong{display:block;color:var(--dsw-alias-label-primary,#e8f0ff);font-weight:500;margin-bottom:5px}
.hmr-notice{padding:12px;border:1px solid rgba(255,113,140,.3);border-radius:9px;background:rgba(255,113,140,.06);color:#ff9caf;font-size:11.5px;line-height:1.6;margin-bottom:12px}
.hmr-code{font-family:ui-monospace,monospace;font-size:10px;color:var(--dsw-alias-label-secondary,#8ea3c8);word-break:break-all}
.hmr-progress{height:6px;border-radius:99px;background:var(--dsw-alias-bg-layer-2,#111d36);overflow:hidden;width:100px}.hmr-progress i{display:block;height:100%;background:linear-gradient(90deg,#6ee7d8,#7c9dff)}
.hmr-settings-grid{grid-template-columns:1.15fr 1fr}
.hmr-check{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-secondary,#8ea3c8)}
.hmr-settings-section{padding:18px 0;max-width:720px}
.hmr-settings-section h2{margin:0 0 8px;font-size:15px}.hmr-settings-section p{margin:0 0 14px;color:var(--dsw-alias-label-secondary,#8ea3c8);font-size:12px;line-height:1.7}
.hmr-kicker{font-family:ui-monospace,monospace;font-size:10px;color:#6ee7d8;letter-spacing:.12em;text-transform:uppercase;margin-bottom:6px}
@media (max-width:1000px){.hmr-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.hmr-two,.hmr-split,.hmr-settings-grid{grid-template-columns:minmax(0,1fr)}.hmr-detail{position:static}}
`

    const KIND_LABEL = { persona: '人格', semantic: '语义', episodic: '情景', buffer: '缓冲' }
    const KIND_ORDER = ['persona', 'semantic', 'episodic', 'buffer']
    const STATUS_LABEL = { active: '有效', conflict: '待确认', archived: '已归档', pending_delete: '待删除', superseded: '已取代' }

    function defaultBase() {
      const saved = localStorage.getItem('hippocampus.apiBase')
      if (saved) return saved.replace(/\/+$/, '')
      const host = location.hostname || '127.0.0.1'
      return `${location.protocol === 'https:' ? 'https' : 'http'}://${host}:7337`
    }
    function savedToken() {
      return localStorage.getItem('hippocampus.token') || sessionStorage.getItem('hippocampus.token') || ''
    }
    function ago(ms) {
      if (!ms) return '—'
      const seconds = Math.max(0, (Date.now() - ms) / 1000)
      if (seconds < 45) return '刚刚'
      if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟前`
      if (seconds < 86400) return `${Math.round(seconds / 3600)} 小时前`
      return `${Math.round(seconds / 86400)} 天前`
    }
    function fmtBytes(value) {
      const n = Number(value) || 0
      if (n < 1024) return `${n} B`
      if (n < 1048576) return `${(n / 1024).toFixed(1)} KiB`
      if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MiB`
      return `${(n / 1073741824).toFixed(2)} GiB`
    }
    function shortId(id) {
      return id ? `${id.slice(0, 9)}…${id.slice(-4)}` : '—'
    }
    async function request(base, token, path, options = {}) {
      const headers = { ...(options.headers || {}) }
      if (options.body !== undefined) headers['content-type'] = 'application/json'
      if (token) headers.authorization = `Bearer ${token}`
      let response
      try {
        response = await fetch(`${base}${path}`, {
          method: options.method || 'GET',
          headers,
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
        })
      } catch (error) {
        throw new Error(`无法连接 ${base}：${error.message}`)
      }
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error?.message || `HTTP ${response.status}`)
      return data
    }

    function MemoryIcon({ size = 18, active }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 20 20',
          fill: 'none',
          'aria-hidden': 'true',
          style: { color: active ? 'var(--dsw-alias-brand-primary)' : 'currentColor' },
        },
        h('path', {
          d: 'M10 2.8c3.2 0 5.4 2 5.4 4.7 0 1.7-1 2.8-1.8 3.6-.7.7-1.1 1.2-1.1 2 0 .8.5 1.3 1.2 1.8 2 1.4 3.2 3 3.2 5 0 2.8-2.4 5-5.8 5-3 0-5.4-1.7-6.1-4.2',
          stroke: 'currentColor',
          strokeWidth: '1.5',
          strokeLinecap: 'round',
        }),
        h('path', {
          d: 'M5.3 17.3c-1.3.6-2.7.2-3.4-.8-.8-1-.4-2.4.8-3 1.1-.6 2.3-.2 3.1.7',
          stroke: 'currentColor',
          strokeWidth: '1.2',
          strokeLinecap: 'round',
        }),
        h('circle', { cx: '12.4', cy: '6.9', r: '.95', fill: 'currentColor' }),
        h('path', { d: 'M9 8.7c.4 2.6.1 4.4-1 6.2', stroke: 'currentColor', strokeWidth: '.9', strokeLinecap: 'round', opacity: '.7' }),
      )
    }

    function Tag({ kind, children }) {
      return h('span', { className: `hmr-tag ${kind || ''}` }, children)
    }

    function StatCard({ label, value, note, tone }) {
      return h('div', { className: `hmr-card hmr-stat ${tone || ''}` }, [
        h('span', { className: 'k', key: 'k' }, label),
        h('strong', { key: 'v' }, String(value)),
        h('small', { key: 'n', title: note }, note),
      ])
    }

    function MemoryPanel() {
      const [tab, setTab] = useState('overview')
      const [base, setBase] = useState(defaultBase())
      const [token, setToken] = useState(savedToken())
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState('')
      const [monitor, setMonitor] = useState(null)
      const [stats, setStats] = useState({})
      const [recent, setRecent] = useState([])
      const [memories, setMemories] = useState([])
      const [jobs, setJobs] = useState([])
      const [config, setConfig] = useState(null)
      const [query, setQuery] = useState('')
      const [searchTick, setSearchTick] = useState(0)
      const [selected, setSelected] = useState(null)
      const [selectedDetail, setSelectedDetail] = useState(null)
      const [editor, setEditor] = useState(null)
      const [refresh, setRefresh] = useState(0)
      const [baseDraft, setBaseDraft] = useState(base)
      const [tokenDraft, setTokenDraft] = useState(token)

      const load = useCallback(async () => {
        setLoading(true)
        setError('')
        try {
          if (tab === 'overview') {
            const [mon, list] = await Promise.all([
              request(base, token, '/api/monitor'),
              request(base, token, '/api/memories?limit=8'),
            ])
            setMonitor(mon)
            setStats(mon.memory || {})
            setRecent(list.items || [])
          } else if (tab === 'memories') {
            const path = query.trim()
              ? `/api/memories/search?q=${encodeURIComponent(query.trim())}&limit=50`
              : '/api/memories?limit=50'
            const data = await request(base, token, path)
            setMemories(data.memories || data.items || [])
          } else if (tab === 'jobs') {
            const data = await request(base, token, '/api/jobs?limit=30')
            setJobs(data.items || [])
          } else if (tab === 'settings') {
            const data = await request(base, token, '/api/config').catch(() => request(base, token, '/api/public-config'))
            setConfig(data)
          }
        } catch (err) {
          setError(err.message)
        } finally {
          setLoading(false)
        }
      }, [tab, base, token, searchTick])

      useEffect(() => { load() }, [load, refresh])
      useEffect(() => {
        if (tab !== 'jobs') return undefined
        const timer = setInterval(load, 3000)
        return () => clearInterval(timer)
      }, [tab, load])

      const openDetail = async (id) => {
        setSelected(id)
        try {
          const data = await request(base, token, `/api/memories/${encodeURIComponent(id)}`)
          setSelectedDetail(data)
          setEditor(null)
        } catch (err) {
          setError(err.message)
        }
      }

      const saveDraftConnection = () => {
        localStorage.setItem('hippocampus.apiBase', baseDraft.replace(/\/+$/, ''))
        localStorage.setItem('hippocampus.token', tokenDraft)
        setBase(baseDraft.replace(/\/+$/, ''))
        setToken(tokenDraft)
        setRefresh((value) => value + 1)
      }

      const saveMemory = async () => {
        if (!editor?.content?.trim()) return
        try {
          const payload = {
            content: editor.content.trim(),
            kind: editor.kind,
            importance: Number(editor.importance) || 5,
            confidence: Number(editor.confidence) || 0.7,
            tags: String(editor.tags || '').split(',').map((item) => item.trim()).filter(Boolean),
            confirmed: Boolean(editor.confirmed),
            namespace: editor.namespace || 'default',
          }
          if (editor.id) {
            delete payload.namespace
            await request(base, token, `/api/memories/${editor.id}`, { method: 'PATCH', body: payload })
          } else {
            await request(base, token, '/api/memories', { method: 'POST', body: payload })
          }
          setEditor(null)
          setRefresh((value) => value + 1)
          if (editor.id) await openDetail(editor.id)
        } catch (err) {
          setError(err.message)
        }
      }

      const removeMemory = async (memory, hard) => {
        if (!window.confirm(hard ? '永久删除不可恢复。' : '删除后 7 天内可恢复。')) return
        try {
          const force = memory.kind === 'persona' ? '&force=true' : ''
          const queryString = hard ? `?hard=true&confirm=true${force}` : `?force=${memory.kind === 'persona'}`
          await request(base, token, `/api/memories/${memory.id}${queryString}`, { method: 'DELETE' })
          setSelectedDetail(null)
          setSelected(null)
          setRefresh((value) => value + 1)
        } catch (err) {
          setError(err.message)
        }
      }

      const createJob = async (type) => {
        try {
          await request(base, token, '/api/jobs', { method: 'POST', body: { type, payload: type === 'embed_backfill' ? { limit: 500 } : {} } })
          setRefresh((value) => value + 1)
        } catch (err) {
          setError(err.message)
        }
      }

      const tabs = [
        ['overview', '总览'],
        ['memories', '记忆库'],
        ['jobs', '任务'],
        ['settings', '设置'],
      ]

      const latestMemory = selectedDetail?.memory ?? null
      const maxKind = Math.max(1, ...KIND_ORDER.map((kind) => stats.byKind?.[kind] ?? 0))

      return h('div', { className: 'hmr-root' }, [
        h('style', { key: 'style' }, CSS),
        h('header', { className: 'hmr-head', key: 'head' }, [
          h('div', { key: 'title' }, [
            h('h1', { key: 'h' }, '海马体记忆'),
            h('p', { key: 'p' }, '长期记忆管理 · 星图与树、审计、任务、权限'),
          ]),
          h('div', { className: 'hmr-head-actions', key: 'actions' }, [
            h('span', { key: 'dot', className: `hmr-dot ${error ? 'err' : 'ok'}` }),
            h('span', { key: 'base', className: 'hmr-code', style: { maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, base),
            h('button', { key: 'refresh', className: 'hmr-btn', onClick: () => setRefresh((value) => value + 1) }, '刷新'),
            h('button', { key: 'star', className: 'hmr-btn', onClick: () => window.open(`${base}/#/star`, '_blank', 'noopener') }, '星图'),
            h('button', { key: 'tree', className: 'hmr-btn', onClick: () => window.open(`${base}/#/tree`, '_blank', 'noopener') }, '树'),
            h('button', { key: 'full', className: 'hmr-btn primary', onClick: () => window.open(`${base}/`, '_blank', 'noopener') }, '打开完整管理台'),
          ]),
        ]),
        h('div', { className: 'hmr-tabs', key: 'tabs' }, tabs.map(([id, label]) => h('button', {
          key: id,
          className: `hmr-tab ${tab === id ? 'active' : ''}`,
          onClick: () => { setTab(id); setSelectedDetail(null); setSelected(null); setEditor(null) },
        }, label))),
        h('div', { className: 'hmr-content', key: 'content' }, [
          error ? h('div', { className: 'hmr-notice', key: 'err' }, [
            h('div', { key: 'msg' }, error),
            h('div', { className: 'hmr-code', style: { marginTop: 6 }, key: 'code' }, '确认独立 HTTP 服务已启动（默认 7337），或在「设置」里修改 API 地址 / token。'),
          ]) : null,
          loading ? h('div', { className: 'hmr-empty', key: 'loading' }, '加载中…') : null,
          !loading && tab === 'overview' ? h('div', { key: 'overview', className: 'hmr-grid hmr-stats' }, [
            h(StatCard, { key: 'total', label: '记忆总量', value: stats.totals?.all ?? 0, note: `${stats.totals?.active ?? 0} 条有效 · ${stats.byKind?.persona ?? 0} 条人格`, tone: 'good' }),
            h(StatCard, { key: 'pending', label: '待处理', value: stats.totals?.conflict ?? 0, note: `${monitor?.jobs?.active ?? 0} 个任务运行中`, tone: 'warn' }),
            h(StatCard, { key: 'db', label: '数据库', value: fmtBytes(stats.dbSizeBytes), note: stats.dbPath ? stats.dbPath.split('/').pop() : 'memory.db' }),
            h(StatCard, { key: 'cache', label: '缓存命中', value: `${Math.round((monitor?.cache?.search?.hitRate ?? 0) * 100)}%`, note: `${monitor?.cache?.search?.entries ?? 0} 条搜索缓存` }),
          ]) : null,
          !loading && tab === 'overview' ? h('div', { className: 'hmr-grid hmr-two', style: { marginTop: 12 } }, [
            h('div', { className: 'hmr-card', key: 'bars' }, [
              h('h2', {}, '四层记忆'),
              h('div', { className: 'hmr-bars' }, KIND_ORDER.map((kind) => h('div', { className: 'hmr-bar-row', key: kind }, [
                h('span', {}, KIND_LABEL[kind]),
                h('div', { className: 'hmr-bar' }, h('i', { className: kind, style: { width: `${(stats.byKind?.[kind] ?? 0) / maxKind * 100}%` } })),
                h('span', { className: 'hmr-code' }, String(stats.byKind?.[kind] ?? 0)),
              ]))),
            ]),
            h('div', { className: 'hmr-card', key: 'run' }, [
              h('h2', {}, '运行状态'),
              h('div', { className: 'hmr-kv' }, [
                ['搜索缓存', `${monitor?.cache?.search?.hits ?? 0} hit / ${monitor?.cache?.search?.misses ?? 0} miss`],
                ['嵌入', monitor?.embeddings?.enabled ? `${monitor.embeddings.providers.length} providers` : '未启用'],
                ['队列', `${monitor?.jobs?.byStatus?.queued ?? 0} queued / ${monitor?.jobs?.running ?? 0} running`],
                ['上次回放', stats.lastReplayAt ? ago(stats.lastReplayAt) : '从未'],
              ].map(([key, value]) => h('div', { key }, [h('span', { key: 'k' }, key), h('b', { key: 'v' }, value)]))),
            ]),
          ]) : null,
          !loading && tab === 'overview' ? h('div', { className: 'hmr-card', style: { marginTop: 12 }, key: 'recent' }, [
            h('h2', {}, '最近记忆'),
            recent.length
              ? recent.map((memory) => h('div', { className: 'hmr-row', key: memory.id, onClick: () => { setTab('memories'); openDetail(memory.id) } }, [
                  h(Tag, { kind: memory.kind }, memory.kindLabel),
                  h('span', { className: 'txt' }, memory.content),
                  h('span', { className: 'time' }, ago(memory.lastAccessAt ?? memory.createdAt)),
                ]))
              : h('div', { className: 'hmr-empty' }, '还没有记忆'),
          ]) : null,
          !loading && tab === 'memories' ? h('div', { key: 'memories' }, [
            h('div', { className: 'hmr-toolbar' }, [
              h('input', { className: 'hmr-input', value: query, placeholder: '搜索记忆…', onChange: (event) => setQuery(event.target.value), onKeyDown: (event) => { if (event.key === 'Enter') setRefresh((value) => value + 1) } }),
              h('button', { className: 'hmr-btn', onClick: () => setSearchTick((value) => value + 1) }, '搜索'),
              h('button', { className: 'hmr-btn primary', onClick: () => setEditor({ content: '', kind: 'episodic', importance: 5, confidence: 0.7, tags: '', confirmed: false, namespace: 'default' }) }, '写入记忆'),
            ]),
            h('div', { className: 'hmr-split' }, [
              h('div', { className: 'hmr-list', key: 'list' }, memories.length
                ? memories.map((memory) => h('div', { key: memory.id, className: `hmr-item ${selected === memory.id ? 'sel' : ''}`, onClick: () => openDetail(memory.id) }, [
                    h('div', { className: 'line' }, [h(Tag, { kind: memory.kind }, memory.kindLabel), h(Tag, { kind: memory.status }, memory.statusLabel)]),
                    h('p', { className: 'body' }, memory.content),
                    h('div', { className: 'meta' }, [h('span', {}, shortId(memory.id)), h('span', {}, ago(memory.lastAccessAt ?? memory.createdAt))]),
                  ]))
                : h('div', { className: 'hmr-empty' }, query ? '没有匹配的记忆' : '还没有记忆')),
              h('div', { className: 'hmr-card hmr-detail', key: 'detail' }, latestMemory ? [
                h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 } }, [h(Tag, { kind: latestMemory.kind }, latestMemory.kindLabel), h(Tag, { kind: latestMemory.status }, latestMemory.statusLabel)]),
                h('p', { className: 'content' }, latestMemory.content),
                h('div', { className: 'hmr-kv' }, [
                  ['重要性', `${latestMemory.importance}/10`], ['权重', latestMemory.weight],
                  ['置信度', `${Math.round(latestMemory.confidence * 100)}%`], ['namespace', latestMemory.namespace],
                  ['访问次数', latestMemory.accessCount], ['创建', ago(latestMemory.createdAt)],
                ].map(([key, value]) => h('div', { key }, [h('span', {}, key), h('b', {}, String(value))]))),
                h('div', { className: 'hmr-code', style: { marginTop: 8 } }, latestMemory.id),
                h('div', { className: 'hmr-actions' }, [
                  h('button', { key: 'edit', className: 'hmr-btn', onClick: () => setEditor({ ...latestMemory, tags: (latestMemory.tags || []).join(', ') }) }, '编辑'),
                  h('button', { key: 'archive', className: 'hmr-btn', onClick: async () => { await request(base, token, `/api/memories/${latestMemory.id}/archive`, { method: 'POST' }); setRefresh((v) => v + 1) } }, '归档'),
                  h('button', { key: 'delete', className: 'hmr-btn danger', onClick: () => removeMemory(latestMemory, false) }, '删除'),
                  h('button', { key: 'hard', className: 'hmr-btn danger', onClick: () => removeMemory(latestMemory, true) }, '永久删除'),
                ]),
              ] : h('div', { className: 'hmr-empty' }, '选择一条记忆查看详情')),
            ]),
            editor ? h('div', { className: 'hmr-card', style: { marginTop: 12 } }, [
              h('h2', {}, editor.id ? '编辑记忆' : '写入记忆'),
              h('div', { className: 'hmr-form' }, [
                h('label', { className: 'full', key: 'content' }, [h('span', {}, '内容'), h('textarea', { value: editor.content || '', onChange: (event) => setEditor({ ...editor, content: event.target.value }) })]),
                h('label', { key: 'kind' }, [h('span', {}, '记忆层'), h('select', { value: editor.kind, onChange: (event) => setEditor({ ...editor, kind: event.target.value }) }, KIND_ORDER.map((kind) => h('option', { key: kind, value: kind }, KIND_LABEL[kind])))]),
                h('label', { key: 'importance' }, [h('span', {}, '重要性'), h('input', { type: 'number', min: 0.1, max: 10, step: 0.1, value: editor.importance, onChange: (event) => setEditor({ ...editor, importance: event.target.value }) })]),
                h('label', { key: 'confidence' }, [h('span', {}, '置信度'), h('input', { type: 'number', min: 0, max: 1, step: 0.05, value: editor.confidence, onChange: (event) => setEditor({ ...editor, confidence: event.target.value }) })]),
                h('label', { key: 'tags' }, [h('span', {}, '标签'), h('input', { value: editor.tags || '', onChange: (event) => setEditor({ ...editor, tags: event.target.value }) })]),
                h('label', { className: 'full', key: 'confirm' }, [h('span', {}, '确认'), h('input', { type: 'checkbox', checked: Boolean(editor.confirmed), onChange: (event) => setEditor({ ...editor, confirmed: event.target.checked }) })]),
              ]),
              h('div', { className: 'hmr-actions' }, [
                h('button', { key: 'save', className: 'hmr-btn primary', onClick: saveMemory }, '保存'),
                h('button', { key: 'cancel', className: 'hmr-btn', onClick: () => setEditor(null) }, '取消'),
              ]),
            ]) : null,
          ]) : null,
          !loading && tab === 'jobs' ? h('div', { key: 'jobs' }, [
            h('div', { className: 'hmr-toolbar' }, [
              h('button', { key: 'replay', className: 'hmr-btn primary', onClick: () => createJob('replay') }, '运行回放'),
              h('button', { key: 'backfill', className: 'hmr-btn', onClick: () => createJob('embed_backfill') }, '嵌入回填'),
              h('button', { key: 'backup', className: 'hmr-btn', onClick: () => createJob('backup') }, '备份'),
            ]),
            h('div', { className: 'hmr-card' }, jobs.length
              ? jobs.map((job) => h('div', { className: 'hmr-row', key: job.id }, [
                  h(Tag, { kind: job.status === 'failed' ? 'conflict' : job.status === 'succeeded' ? 'active' : '' }, job.status),
                  h('span', { className: 'txt' }, `${job.type} · ${job.id}`),
                  h('div', { className: 'hmr-progress' }, h('i', { style: { width: `${Math.round((job.progress || 0) * 100)}%` } })),
                  h('span', { className: 'time' }, ago(job.createdAt)),
                ]))
              : h('div', { className: 'hmr-empty' }, '暂无任务')),
          ]) : null,
          !loading && tab === 'settings' ? h('div', { key: 'settings', className: 'hmr-grid hmr-settings-grid' }, [
            h('div', { className: 'hmr-card' }, [
              h('h2', {}, '连接'),
              h('div', { className: 'hmr-form' }, [
                h('label', { className: 'full' }, [h('span', {}, 'API 地址'), h('input', { value: baseDraft, onChange: (event) => setBaseDraft(event.target.value) })]),
                h('label', { className: 'full' }, [h('span', {}, 'Bearer token / API key（可留空，本机回环自动 admin）'), h('input', { type: 'password', value: tokenDraft, onChange: (event) => setTokenDraft(event.target.value) })]),
              ]),
              h('div', { className: 'hmr-actions' }, [
                h('button', { key: 'save', className: 'hmr-btn primary', onClick: saveDraftConnection }, '保存并重连'),
                h('button', { key: 'full', className: 'hmr-btn', onClick: () => window.open(`${base}/`, '_blank', 'noopener') }, '打开完整管理台'),
              ]),
              h('p', { className: 'hmr-code', style: { marginTop: 10 } }, '独立 HTTP 服务默认监听 127.0.0.1:7337；可在设置或启动参数中改端口/监听地址。'),
            ]),
            h('div', { className: 'hmr-card' }, [
              h('h2', {}, '服务信息'),
              config ? h('div', { className: 'hmr-kv' }, [
                ['版本', config.version], ['数据库', config.dbPath], ['认证', config.authRequired ? '需要 token' : '本机管理员'],
                ['存储', config.storage?.driver === 'postgres' ? `PostgreSQL${config.storage.pgvector ? '+pgvector' : ''}` : 'SQLite'],
                ['图', config.graphProvider ?? 'projection'],
                ['嵌入', config.embeddings?.enabled ? 'hybrid' : 'off'], ['缓存', `${config.cache?.search?.entries ?? 0} 搜索`],
              ].map(([key, value]) => h('div', { key }, [h('span', { key: 'k' }, key), h('b', { key: 'v', title: String(value) }, String(value ?? '—'))]))) : h('div', { className: 'hmr-empty' }, '加载中'),
            ]),
          ]) : null,
        ]),
      ])
    }

    function MemorySettingsSection({ close, openPanel }) {
      return h('section', { className: 'hmr-settings-section' }, [
        h('div', { key: 'kicker', className: 'hmr-kicker' }, 'HIPPOCAMPUS'),
        h('h2', { key: 'title' }, '海马体长期记忆'),
        h('p', { key: 'desc' }, '四层记忆、回放巩固、星图/树、审计与 API key 管理。管理面板已添加到侧边栏「记忆」。'),
        h('div', { key: 'actions', style: { display: 'flex', gap: 8, flexWrap: 'wrap' } }, [
          h('button', { key: 'panel', className: 'hmr-btn primary', onClick: () => { close?.(); openPanel?.() } }, '打开记忆管理'),
          h('button', { key: 'ui', className: 'hmr-btn', onClick: () => window.open(`${defaultBase()}/`, '_blank', 'noopener') }, '打开独立 WebUI'),
        ]),
      ])
    }

    const inject = ['slots', 'layout']

    function apply(ctx) {
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 5,
        label: () => '记忆',
      }, MemoryIcon))

      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
      }, MemoryPanel))

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'hippocampus',
        order: 17,
        label: () => '记忆',
        inject: () => ({ openPanel: () => ctx.layout.selectPanel(PANEL_ID) }),
      }, MemorySettingsSection))
    }

    return { apply, inject }
  },
})
