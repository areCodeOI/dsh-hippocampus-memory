<template>
  <div class="hm-app" v-loading.fullscreen.lock="booting" element-loading-background="rgba(4,7,14,.72)">
    <div class="hm-ambient" aria-hidden="true"></div>

    <transition name="hm-fade">
      <button v-if="mobileOpen" class="hm-sidebar-backdrop" type="button" aria-label="关闭导航" @click="closeSidebar" />
    </transition>

    <aside id="hm-sidebar" class="hm-sidebar" :class="{ open: mobileOpen }">
      <div class="hm-brand">
        <div class="hm-brand-mark"><img :src="favicon" alt="" /></div>
        <div class="hm-brand-copy">
          <strong>海马体记忆</strong>
          <span>HIPPOCAMPUS</span>
        </div>
        <span class="hm-version">v0.4.0</span>
        <button class="hm-sidebar-close" type="button" aria-label="关闭导航" :tabindex="mobileOpen ? 0 : -1" @click="closeSidebar">
          <el-icon><Close /></el-icon>
        </button>
      </div>

      <el-menu :default-active="page" class="hm-menu" @select="navigate">
        <el-menu-item index="overview">
          <el-icon><DataLine /></el-icon><span>总览</span>
        </el-menu-item>
        <el-menu-item index="memories">
          <el-icon><Collection /></el-icon><span>记忆库</span>
        </el-menu-item>
        <el-menu-item index="star">
          <el-icon><Share /></el-icon><span>记忆星图</span>
        </el-menu-item>
        <el-menu-item index="tree">
          <el-icon><Connection /></el-icon><span>记忆树</span>
        </el-menu-item>
        <el-menu-item index="namespaces">
          <el-icon><Files /></el-icon><span>记忆空间</span>
        </el-menu-item>
        <el-menu-item index="jobs">
          <el-icon><Timer /></el-icon><span>异步任务</span>
        </el-menu-item>
        <el-menu-item index="audit">
          <el-icon><Tickets /></el-icon><span>审计日志</span>
        </el-menu-item>
        <el-menu-item index="settings">
          <el-icon><Setting /></el-icon><span>设置与权限</span>
        </el-menu-item>
      </el-menu>

      <div class="hm-sidebar-foot">
        <div class="hm-status-line">
          <span class="hm-status-dot" :class="connectionClass"></span>
          <span>{{ connectionText }}</span>
        </div>
        <div class="hm-sidebar-meta">{{ session.config?.dbPath?.split('/').pop() ?? 'memory.db' }} · WAL</div>
      </div>
    </aside>

    <main class="hm-main">
      <header class="hm-topbar">
        <button
          class="hm-menu-btn"
          type="button"
          :aria-label="mobileOpen ? '关闭导航' : '打开导航'"
          :aria-expanded="mobileOpen ? 'true' : 'false'"
          aria-controls="hm-sidebar"
          @click="mobileOpen = !mobileOpen"
        >
          <el-icon><component :is="mobileOpen ? 'Close' : 'Menu'" /></el-icon>
        </button>
        <div class="hm-heading">
          <h1>{{ meta.title }}</h1>
          <p>{{ meta.subtitle }}</p>
        </div>
        <div class="hm-top-actions">
          <el-select v-model="namespace" class="hm-namespace" size="small" aria-label="记忆空间" @change="changeNamespace">
            <el-option v-for="item in namespaces" :key="item" :label="item === '*' ? '全部空间' : item" :value="item" />
          </el-select>
          <el-tag class="hm-role" effect="plain" size="small">{{ roleLabel }}</el-tag>
          <el-button circle text :aria-label="session.theme === 'dark' ? '切换浅色' : '切换深色'" @click="toggleTheme">
            <el-icon><component :is="session.theme === 'dark' ? 'Sunny' : 'Moon'" /></el-icon>
          </el-button>
          <el-button v-if="session.token" text size="small" @click="logout">退出</el-button>
        </div>
      </header>

      <section class="hm-view">
        <OverviewView
          v-if="page === 'overview'"
          :refresh-key="refreshKey"
          :namespace="namespace"
          :auth="auth"
          @open-memory="openMemory"
          @navigate="navigate"
          @refresh="bumpRefresh"
        />
        <MemoriesView
          v-else-if="page === 'memories'"
          :refresh-key="refreshKey"
          :namespace="namespace"
          :auth="auth"
          @open-memory="openMemory"
          @create="openCreate"
          @refresh="bumpRefresh"
        />
        <StarView
          v-else-if="page === 'star'"
          :refresh-key="refreshKey"
          :namespace="namespace"
          @open-memory="openMemory"
        />
        <TreeView
          v-else-if="page === 'tree'"
          :refresh-key="refreshKey"
          :namespace="namespace"
          @open-memory="openMemory"
        />
        <NamespacesView
          v-else-if="page === 'namespaces'"
          :refresh-key="refreshKey"
          :auth="auth"
          :namespace="namespace"
          @refresh="bumpRefresh"
          @namespaces-changed="reloadNamespaces"
          @namespace-change="changeNamespaceFromView"
        />
        <JobsView
          v-else-if="page === 'jobs'"
          :refresh-key="refreshKey"
          :namespace="namespace"
          :auth="auth"
          @refresh="bumpRefresh"
        />
        <AuditView
          v-else-if="page === 'audit'"
          :refresh-key="refreshKey"
          :auth="auth"
        />
        <SettingsView
          v-else
          :refresh-key="refreshKey"
          :auth="auth"
          @refresh="bumpRefresh"
          @navigate="navigate"
        />
      </section>
    </main>

    <el-drawer v-model="drawer" class="hm-detail-drawer" :size="drawerSize" :with-header="false">
      <div v-if="detail" class="hm-detail">
        <div class="hm-detail-head">
          <div>
            <div class="hm-detail-tags">
              <el-tag :type="kindTagType(detail.memory.kind)" effect="dark" size="small">{{ detail.memory.kindLabel }}</el-tag>
              <el-tag :type="statusTagType(detail.memory.status)" effect="plain" size="small">{{ detail.memory.statusLabel }}</el-tag>
              <el-tag v-if="detail.memory.confirmed" effect="plain" size="small">已确认</el-tag>
            </div>
            <p class="hm-detail-id">{{ detail.memory.id }}</p>
          </div>
          <el-button circle text aria-label="关闭" @click="drawer = false"><el-icon><Close /></el-icon></el-button>
        </div>

        <p class="hm-detail-content">{{ detail.memory.content }}</p>

        <div class="hm-detail-tags">
          <el-tag v-for="tag in detail.memory.tags" :key="tag" size="small" effect="plain">{{ tag }}</el-tag>
          <span v-if="!detail.memory.tags?.length" class="hm-muted">无标签</span>
        </div>

        <el-descriptions :column="2" border class="hm-descriptions">
          <el-descriptions-item label="重要性">{{ detail.memory.importance }} / 10</el-descriptions-item>
          <el-descriptions-item label="当前权重">{{ detail.memory.weight }}</el-descriptions-item>
          <el-descriptions-item label="置信度">{{ Math.round(detail.memory.confidence * 100) }}%</el-descriptions-item>
          <el-descriptions-item label="访问次数">{{ detail.memory.accessCount }}</el-descriptions-item>
          <el-descriptions-item label="namespace">{{ detail.memory.namespace }}</el-descriptions-item>
          <el-descriptions-item label="来源">{{ detail.memory.source ?? '—' }}</el-descriptions-item>
          <el-descriptions-item label="创建">{{ fmtTime(detail.memory.createdAt) }}</el-descriptions-item>
          <el-descriptions-item label="最后访问">{{ fmtTime(detail.memory.lastAccessAt) }}</el-descriptions-item>
        </el-descriptions>

        <el-alert
          v-if="detail.conflicts?.length"
          class="hm-alert"
          type="error"
          :closable="false"
          show-icon
          title="存在待确认冲突"
          :description="detail.conflicts.map((item) => item.reason).join('；')"
        />

        <el-collapse v-if="detail.memory.metadata && Object.keys(detail.memory.metadata).length" class="hm-meta-collapse">
          <el-collapse-item title="metadata" name="metadata">
            <pre class="hm-json">{{ JSON.stringify(detail.memory.metadata, null, 2) }}</pre>
          </el-collapse-item>
        </el-collapse>

        <div class="hm-detail-actions">
          <el-button v-if="canWrite" type="primary" @click="openEdit(detail.memory)"><el-icon><Edit /></el-icon>编辑</el-button>
          <el-button v-if="canWrite" @click="archiveMemory(detail.memory)"><el-icon><FolderOpened /></el-icon>归档</el-button>
          <el-button v-if="canWrite" @click="restoreMemory(detail.memory)"><el-icon><RefreshLeft /></el-icon>恢复</el-button>
          <el-button v-if="canWrite" type="danger" plain @click="deleteMemory(detail.memory, false)"><el-icon><Delete /></el-icon>删除</el-button>
          <el-button v-if="isAdmin" type="danger" @click="deleteMemory(detail.memory, true)">永久删除</el-button>
          <el-button text @click="copy(detail.memory.id)"><el-icon><CopyDocument /></el-icon>复制 ID</el-button>
        </div>
      </div>
    </el-drawer>

    <el-dialog v-model="editorOpen" :title="editorMode === 'create' ? '写入新记忆' : '编辑记忆'" width="min(620px, 92vw)" destroy-on-close>
      <el-form label-position="top" class="hm-form">
        <el-form-item label="内容" required>
          <el-input v-model="form.content" type="textarea" :rows="4" placeholder="一条最小事实，例如：用户对花生过敏，严重时需立即就医。" />
        </el-form-item>
        <div class="hm-form-grid">
          <el-form-item label="记忆层">
            <el-select v-model="form.kind">
              <el-option v-for="kind in KIND_ORDER" :key="kind" :label="KIND_LABEL[kind]" :value="kind" />
            </el-select>
          </el-form-item>
          <el-form-item label="namespace">
            <el-input v-model="form.namespace" :disabled="editorMode === 'edit'" />
          </el-form-item>
          <el-form-item label="重要性 0.1–10">
            <el-input-number v-model="form.importance" :min="0.1" :max="10" :step="0.1" />
          </el-form-item>
          <el-form-item label="置信度 0–1">
            <el-input-number v-model="form.confidence" :min="0" :max="1" :step="0.05" />
          </el-form-item>
        </div>
        <el-form-item label="标签（逗号分隔）">
          <el-input v-model="form.tags" placeholder="健康, 过敏" />
        </el-form-item>
        <el-checkbox v-model="form.confirmed">已确认（写入 semantic/persona 或解决冲突时建议勾选）</el-checkbox>
      </el-form>
      <template #footer>
        <el-button @click="editorOpen = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveMemory">{{ editorMode === 'create' ? '写入' : '保存' }}</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="secretOpen" title="API key 已创建" width="min(560px, 92vw)">
      <el-alert type="warning" :closable="false" show-icon title="只显示一次，请立即保存" description="服务端只存 SHA-256 hash，关闭后无法再次查看完整 key。" />
      <div class="hm-secret">{{ secretKey }}</div>
      <template #footer>
        <el-button type="primary" @click="secretOpen = false">我已保存</el-button>
      </template>
    </el-dialog>

    <transition name="hm-fade">
      <div v-if="loginOpen" class="hm-login">
        <form class="hm-login-card" @submit.prevent="login">
          <img :src="favicon" alt="" width="52" height="52" />
          <h2>{{ setupMode ? '创建管理员' : '登录记忆观测站' }}</h2>
          <p v-if="setupMode">首次使用：创建管理员账号（邮箱 + 密码）。之后用它与 API key 访问。</p>
          <p v-else>使用管理员邮箱和密码登录。</p>
          <el-input v-model="loginEmail" placeholder="邮箱" autocomplete="username" />
          <el-input v-model="loginPassword" type="password" show-password placeholder="密码（至少 8 位）" autocomplete="current-password" />
          <el-input v-if="setupMode" v-model="loginConfirm" type="password" show-password placeholder="再输入一次密码" autocomplete="new-password" />
          <p v-if="loginError" class="hm-login-error">{{ loginError }}</p>
          <p v-else-if="setupMode" class="hm-login-hint">密码首尾空格会被自动忽略；创建后请立即用同一密码登录确认。</p>
          <p v-else class="hm-login-hint">
            忘记密码？见 <code>docs/FAQ.md#reset</code>，或在插件目录运行
            <code>node bin/hippocampus.mjs user reset-password --email 你的邮箱</code>。
          </p>
          <el-button type="primary" native-type="submit" :loading="loggingIn">{{ setupMode ? '创建并进入' : '登录' }}</el-button>
          <span class="hm-login-hint">登录会话保存在本机浏览器；API key 在「设置 → 权限」管理</span>
        </form>
      </div>
    </transition>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import favicon from './assets/favicon.svg'
import { ElMessage, ElMessageBox } from 'element-plus'
import OverviewView from './views/OverviewView.vue'
import MemoriesView from './views/MemoriesView.vue'
import StarView from './views/StarView.vue'
import TreeView from './views/TreeView.vue'
import JobsView from './views/JobsView.vue'
import NamespacesView from './views/NamespacesView.vue'
import AuditView from './views/AuditView.vue'
import SettingsView from './views/SettingsView.vue'
import {
  KIND_LABEL,
  KIND_ORDER,
  api,
  currentPage,
  fmtTime,
  kindTagType,
  roleAtLeast,
  saveTheme,
  saveToken,
  session,
  statusTagType,
} from './lib'

const PAGE_META = {
  overview: { title: '总览', subtitle: '观测记忆库的呼吸、冲突与回放节奏' },
  memories: { title: '记忆库', subtitle: '检索、审阅并维护最小事实单元' },
  star: { title: '记忆星图', subtitle: '把记忆、冲突与巩固关系看作一片星空' },
  tree: { title: '记忆树', subtitle: '按 namespace 与记忆层展开的结构视图' },
  namespaces: { title: '记忆空间', subtitle: '管理 namespace 分区：新建、重命名、合并与删除' },
  jobs: { title: '异步任务', subtitle: '回放、嵌入回填、备份与维护任务' },
  audit: { title: '审计日志', subtitle: '谁在何时以什么角色做了什么' },
  settings: { title: '设置与权限', subtitle: '服务、API key、嵌入与数据管理' },
}

const booting = ref(true)
const page = ref(currentPage())
const mobileOpen = ref(false)
const refreshKey = ref(0)
const auth = ref(null)
const namespaces = ref(['default'])
const namespace = ref(session.namespace)
const drawer = ref(false)
const detail = ref(null)
const editorOpen = ref(false)
const editorMode = ref('create')
const saving = ref(false)
const secretOpen = ref(false)
const secretKey = ref('')
const loginOpen = ref(false)
const setupMode = ref(false)
const loginEmail = ref('')
const loginPassword = ref('')
const loginConfirm = ref('')
const loginError = ref('')
const loggingIn = ref(false)
const editingId = ref(null)

const form = reactive({
  content: '',
  kind: 'episodic',
  namespace: 'default',
  importance: 5,
  confidence: 0.7,
  tags: '',
  confirmed: false,
})

const meta = computed(() => PAGE_META[page.value] ?? PAGE_META.overview)
const roleLabel = computed(() => (auth.value ? `${auth.value.role} · ${auth.value.actor}` : '未登录'))
const canWrite = computed(() => roleAtLeast(auth.value?.role, 'writer'))
const isAdmin = computed(() => auth.value?.role === 'admin')
const drawerSize = computed(() => (window.innerWidth < 720 ? '100%' : '540px'))
const connectionClass = computed(() => (booting.value ? '' : auth.value ? 'ok' : 'err'))
const connectionText = computed(() => (booting.value ? '连接中…' : auth.value ? `在线 · ${auth.value.role}` : '需要 token'))

function toggleTheme() {
  saveTheme(session.theme === 'dark' ? 'light' : 'dark')
}

function bumpRefresh() {
  refreshKey.value += 1
}

function closeSidebar() {
  mobileOpen.value = false
}

function onKeydown(event) {
  if (event.key === 'Escape' && mobileOpen.value) closeSidebar()
}

function navigate(index) {
  mobileOpen.value = false
  drawer.value = false
  if (location.hash === `#/${index}`) {
    page.value = index
    bumpRefresh()
  } else {
    location.hash = `#/${index}`
  }
}

function onHashChange() {
  page.value = currentPage()
  mobileOpen.value = false
  drawer.value = false
  bumpRefresh()
}

async function boot() {
  try {
    session.publicConfig = await (await fetch('/api/public-config')).json()
    session.config = session.publicConfig
    setupMode.value = Boolean(session.publicConfig.needsSetup)
    if (setupMode.value || (session.publicConfig.authRequired && !session.token)) {
      booting.value = false
      loginOpen.value = true
      return
    }
    await checkAuth()
  } catch (error) {
    booting.value = false
    loginOpen.value = true
    loginError.value = `无法连接服务：${error.message}`
  }
}

async function checkAuth() {
  try {
    const data = await api('/api/auth/check')
    auth.value = data.auth
    session.auth = data.auth
    session.config = data.config ?? session.config
    loginOpen.value = false
    await loadNamespaces()
    booting.value = false
    refreshKey.value += 1
  } catch (error) {
    booting.value = false
    loginOpen.value = true
    if (error.message === '登录已失效') {
      saveToken('')
      loginError.value = '登录已失效，请重新登录'
    } else {
      loginError.value = error.message
    }
  }
}

async function loadNamespaces() {
  let available = []
  let authoritative = false
  try {
    const data = await api('/api/namespaces', { silent: true })
    available = (data.namespaces ?? []).map((item) => item.name)
    authoritative = true
  } catch {
    try {
      const stats = await api('/api/stats', { silent: true })
      available = Object.keys(stats.byNamespace ?? {})
    } catch {
      // ignore; use permissions below
    }
  }
  if (!available.length) available = ['default']
  const allowed = auth.value?.namespaces ?? ['*']
  if (allowed.includes('*')) {
    // Do not re-add the current name when the server is authoritative: after a
    // hard delete it would otherwise keep showing a phantom empty namespace.
    const keep = authoritative ? [] : [namespace.value]
    namespaces.value = ['*', ...new Set(['default', ...keep, ...available])]
  } else {
    namespaces.value = allowed
  }
  if (!namespaces.value.includes(namespace.value)) namespace.value = namespaces.value[0]
  session.namespace = namespace.value
}

function changeNamespace(value) {
  namespace.value = value
  session.namespace = value
  localStorage.setItem('hippocampus.namespace', value)
  bumpRefresh()
}

async function reloadNamespaces() {
  await loadNamespaces()
  bumpRefresh()
}

function changeNamespaceFromView(name) {
  if (!name) return
  changeNamespace(name)
}

async function login() {
  if (!loginEmail.value.trim() || !loginPassword.value) {
    loginError.value = '请输入邮箱和密码'
    return
  }
  if (setupMode.value && loginPassword.value !== loginConfirm.value) {
    loginError.value = '两次输入的密码不一致'
    return
  }
  loggingIn.value = true
  loginError.value = ''
  try {
    const endpoint = setupMode.value ? '/api/auth/register' : '/api/auth/login'
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: loginEmail.value.trim(), password: loginPassword.value }),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.error?.message ?? `HTTP ${response.status}`)
    saveToken(data.token)
    setupMode.value = false
    loginOpen.value = false
    await checkAuth()
  } catch (error) {
    loginError.value = error.message
  } finally {
    loggingIn.value = false
  }
}

function logout() {
  const token = session.token
  saveToken('')
  auth.value = null
  session.auth = null
  loginEmail.value = ''
  loginPassword.value = ''
  loginConfirm.value = ''
  loginOpen.value = true
  if (token) {
    fetch('/api/auth/logout', { method: 'POST', headers: { authorization: `Bearer ${token}` } }).catch(() => {})
  }
}

async function openMemory(id) {
  try {
    const data = await api(`/api/memories/${encodeURIComponent(id)}`)
    detail.value = data
    drawer.value = true
  } catch (error) {
    ElMessage.error(error.message)
  }
}

function openCreate() {
  editorMode.value = 'create'
  editingId.value = null
  Object.assign(form, {
    content: '',
    kind: 'episodic',
    namespace: namespace.value === '*' ? 'default' : namespace.value,
    importance: 5,
    confidence: 0.7,
    tags: '',
    confirmed: false,
  })
  editorOpen.value = true
}

function openEdit(memory) {
  editorMode.value = 'edit'
  editingId.value = memory.id
  Object.assign(form, {
    content: memory.content,
    kind: memory.kind,
    namespace: memory.namespace,
    importance: memory.importance,
    confidence: memory.confidence,
    tags: (memory.tags ?? []).join(', '),
    confirmed: memory.confirmed,
  })
  editorOpen.value = true
}

async function saveMemory() {
  if (!form.content.trim()) {
    ElMessage.warning('内容不能为空')
    return
  }
  saving.value = true
  try {
    const payload = {
      content: form.content.trim(),
      kind: form.kind,
      importance: form.importance,
      confidence: form.confidence,
      tags: form.tags.split(',').map((tag) => tag.trim()).filter(Boolean),
      confirmed: form.confirmed,
      namespace: form.namespace || 'default',
    }
    if (editorMode.value === 'create') {
      const result = await api('/api/memories', { method: 'POST', body: payload })
      ElMessage.success(result.action === 'conflict' ? '检测到冲突，已进入待确认' : '已写入')
    } else {
      delete payload.namespace
      await api(`/api/memories/${editingId.value}`, { method: 'PATCH', body: payload })
      ElMessage.success('已更新')
    }
    editorOpen.value = false
    if (detail.value?.memory?.id === editingId.value) await openMemory(editingId.value)
    bumpRefresh()
  } catch (error) {
    ElMessage.error(error.message)
  } finally {
    saving.value = false
  }
}

async function archiveMemory(memory) {
  try {
    await api(`/api/memories/${memory.id}/archive`, { method: 'POST' })
    ElMessage.success('已归档')
    drawer.value = false
    bumpRefresh()
  } catch (error) {
    ElMessage.error(error.message)
  }
}

async function restoreMemory(memory) {
  try {
    await api(`/api/memories/${memory.id}/restore`, { method: 'POST' })
    ElMessage.success('已恢复')
    await openMemory(memory.id)
    bumpRefresh()
  } catch (error) {
    ElMessage.error(error.message)
  }
}

async function deleteMemory(memory, hard) {
  try {
    await ElMessageBox.confirm(
      hard ? '永久删除不可恢复，事件审计仍保留。' : '删除后进入 7 天冷静期，期间被访问会自动恢复。',
      hard ? '永久删除记忆？' : '删除记忆？',
      { type: 'warning', confirmButtonText: hard ? '永久删除' : '删除', cancelButtonText: '取消' },
    )
    const force = memory.kind === 'persona' ? '&force=true' : ''
    const query = hard ? `?hard=true&confirm=true${force}` : `?force=${memory.kind === 'persona' ? 'true' : 'false'}`
    await api(`/api/memories/${memory.id}${query}`, { method: 'DELETE' })
    ElMessage.success(hard ? '已永久删除' : '已进入冷静期')
    drawer.value = false
    bumpRefresh()
  } catch (error) {
    if (error !== 'cancel') ElMessage.error(error.message ?? '操作取消')
  }
}

async function copy(value) {
  try {
    await navigator.clipboard.writeText(value)
    ElMessage.success('已复制')
  } catch {
    ElMessage.warning('复制失败，请手动选择')
  }
}

function onUnauthorized() {
  auth.value = null
  loginOpen.value = true
}

onMounted(() => {
  saveTheme(session.theme)
  window.addEventListener('hashchange', onHashChange)
  window.addEventListener('hm:unauthorized', onUnauthorized)
  window.addEventListener('keydown', onKeydown)
  boot()
})

onUnmounted(() => {
  window.removeEventListener('hashchange', onHashChange)
  window.removeEventListener('hm:unauthorized', onUnauthorized)
  window.removeEventListener('keydown', onKeydown)
})
</script>
