import { reactive } from 'vue'

export const KIND_LABEL = { persona: '人格', semantic: '语义', episodic: '情景', buffer: '缓冲' }
export const KIND_ORDER = ['persona', 'semantic', 'episodic', 'buffer']
export const STATUS_LABEL = {
  active: '有效',
  conflict: '待确认',
  archived: '已归档',
  pending_delete: '待删除',
  superseded: '已取代',
}

// A panel-launched link carries the token in the fragment. Fragments are not
// sent to the server or included in the Referer; store it for this tab and
// clear it from the address bar immediately.
const TOKEN_KEY = 'hippocampus.token'
function readStoredToken() {
  const saved = localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY) || ''
  if (saved) {
    localStorage.setItem(TOKEN_KEY, saved)
    sessionStorage.removeItem(TOKEN_KEY)
  }
  return saved
}
const hashParams = new URLSearchParams(String(location.hash || '').replace(/^#/, ''))
const hashToken = hashParams.get('token')
if (hashToken) {
  localStorage.setItem(TOKEN_KEY, hashToken)
  sessionStorage.removeItem(TOKEN_KEY)
  history.replaceState(null, '', `${location.pathname}${location.search}`)
}

export const session = reactive({
  token: readStoredToken(),
  auth: null,
  config: null,
  publicConfig: null,
  namespace: localStorage.getItem('hippocampus.namespace') ?? 'default',
  namespaces: ['default'],
  theme: localStorage.getItem('hippocampus.theme') ?? 'dark',
})

export async function api(path, { method = 'GET', body, headers = {}, silent = false } = {}) {
  const requestHeaders = { ...headers }
  if (body !== undefined) requestHeaders['content-type'] = 'application/json'
  if (session.token) requestHeaders.authorization = `Bearer ${session.token}`
  let response
  try {
    response = await fetch(path, {
      method,
      headers: requestHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (error) {
    if (!silent) throw new Error(`网络错误：${error.message}`)
    throw error
  }
  if (response.status === 401) {
    window.dispatchEvent(new CustomEvent('hm:unauthorized'))
    throw new Error('登录已失效')
  }
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(data.error?.message ?? `HTTP ${response.status}`)
    error.status = response.status
    throw error
  }
  return data
}

export function saveToken(token) {
  session.token = token
  if (token) localStorage.setItem(TOKEN_KEY, token)
  else localStorage.removeItem(TOKEN_KEY)
  sessionStorage.removeItem(TOKEN_KEY)
}

export function saveTheme(theme) {
  session.theme = theme
  localStorage.setItem('hippocampus.theme', theme)
  document.documentElement.classList.toggle('dark', theme === 'dark')
  document.documentElement.dataset.theme = theme
}

export function fmtBytes(bytes) {
  const value = Number(bytes) || 0
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MiB`
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GiB`
}

export function fmtTime(ms) {
  if (!ms) return '—'
  return new Date(ms).toLocaleString('zh-CN', { hour12: false })
}

export function ago(ms) {
  if (!ms) return '—'
  const seconds = Math.max(0, (Date.now() - ms) / 1000)
  if (seconds < 45) return '刚刚'
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟前`
  if (seconds < 86400) return `${Math.round(seconds / 3600)} 小时前`
  if (seconds < 86400 * 30) return `${Math.round(seconds / 86400)} 天前`
  if (seconds < 86400 * 365) return `${Math.round(seconds / 86400 / 30)} 个月前`
  return `${(seconds / 86400 / 365).toFixed(1)} 年前`
}

export function shortId(id) {
  return id ? `${id.slice(0, 10)}…${id.slice(-4)}` : '—'
}

export function kindTagType(kind) {
  return { persona: 'warning', semantic: 'success', episodic: 'primary', buffer: 'info' }[kind] ?? 'info'
}

export function statusTagType(status) {
  return { active: 'success', conflict: 'danger', archived: 'info', pending_delete: 'warning', superseded: 'info' }[status] ?? 'info'
}

export function roleAtLeast(role, required) {
  const order = { reader: 1, writer: 2, admin: 3 }
  return (order[role] ?? 0) >= (order[required] ?? 0)
}

export function currentPage() {
  const page = location.hash.replace(/^#\/?/, '')
  return page || 'overview'
}
