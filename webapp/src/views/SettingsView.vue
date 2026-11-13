<template>
  <div class="hm-page">
    <el-skeleton v-if="loading" :rows="6" animated />
    <template v-else>
      <div class="hm-settings-grid">
        <section class="hm-card">
          <div class="hm-card-head"><h2>服务</h2><el-tag size="small" effect="plain">v{{ config.version }}</el-tag></div>
          <el-descriptions :column="1" border class="hm-descriptions">
            <el-descriptions-item label="数据库">{{ config.dbPath }}</el-descriptions-item>
            <el-descriptions-item label="存储">
              <el-tag size="small" effect="plain" :type="config.storage?.driver === 'postgres' ? 'success' : 'info'">
                {{ config.storage?.driver === 'postgres' ? `PostgreSQL${config.storage.pgvector ? ' + pgvector' : ''}` : 'SQLite' }}
              </el-tag>
              <span v-if="config.storage?.schema" class="hm-mono" style="margin-left: 6px">{{ config.storage.schema }}</span>
            </el-descriptions-item>
            <el-descriptions-item label="图提供方">{{ config.graphProvider ?? 'projection' }}</el-descriptions-item>
            <el-descriptions-item label="监听">{{ config.host ?? '127.0.0.1' }}:{{ config.port ?? 7337 }}</el-descriptions-item>
            <el-descriptions-item label="认证">{{ config.authRequired ? '需要 token' : '本机自动管理员' }}</el-descriptions-item>
            <el-descriptions-item label="任务 worker">{{ config.worker ? '运行中' : '未启动' }}</el-descriptions-item>
            <el-descriptions-item label="缓存">{{ config.cache?.search?.entries ?? 0 }} 搜索 / {{ config.cache?.graph?.entries ?? 0 }} 图</el-descriptions-item>
            <el-descriptions-item label="速率限制">{{ config.rateLimiter?.limit ?? '—' }} / {{ Math.round((config.rateLimiter?.windowMs ?? 60000) / 1000) }}s</el-descriptions-item>
          </el-descriptions>
        </section>

        <section class="hm-card">
          <div class="hm-card-head"><h2>嵌入模型</h2><el-tag size="small" :type="config.embeddings?.enabled ? 'success' : 'info'" effect="plain">{{ config.embeddings?.enabled ? 'hybrid' : 'off' }}</el-tag></div>
          <div v-if="config.embeddings?.enabled" class="hm-provider-list">
            <div v-for="provider in config.embeddings.providers" :key="provider.id" class="hm-provider">
              <div><strong>{{ provider.id }}</strong><span>{{ provider.kind }} · {{ provider.model }}</span></div>
              <span class="hm-mono">{{ provider.dim ?? 'auto' }} dim</span>
            </div>
          </div>
          <el-empty v-else description="未配置 embedding provider，当前完全离线" :image-size="56">
            <template #description>
              <p class="hm-muted">设置 <code>HIPPOCAMPUS_EMBEDDING_*</code> 或 <code>HIPPOCAMPUS_EMBEDDINGS</code> 后重启服务。</p>
            </template>
          </el-empty>
          <el-button class="hm-mt" @click="emit('navigate', 'jobs')">去异步任务回填</el-button>
        </section>
      </div>

      <section v-if="isAdmin" class="hm-card">
        <div class="hm-card-head">
          <h2>记忆中枢</h2>
          <el-tag size="small" :type="hubSettings.enabled ? 'success' : 'info'" effect="plain">
            {{ hubSettings.enabled ? '本地确定性 · 已启用' : '关闭' }}
          </el-tag>
          <el-button type="primary" size="small" :loading="hubSaving" @click="saveHubSettings">保存</el-button>
        </div>
        <p class="hm-muted small">
          纯本地决策「该记什么 / 怎么记 / 什么时候读」，不调用外置 LLM、不发网络请求。
          开启后取代旧的自动召回与自动捕获路径；保存后立即生效，无需重启或修改配置文件。
        </p>
        <el-form label-position="top" class="hm-form">
          <el-form-item label="启用记忆中枢"><el-switch v-model="hubSettings.enabled" /></el-form-item>
          <el-form-item label="自动写入候选"><el-switch v-model="hubSettings.capture" /></el-form-item>
          <el-form-item label="高置信用户事实自主生效"><el-switch v-model="hubSettings.autoApprove" /></el-form-item>
          <el-form-item label="读阈值（0-1，越高越保守）">
            <el-input-number v-model="hubSettings.readThreshold" :min="0" :max="1" :step="0.05" :precision="2" />
          </el-form-item>
          <el-form-item label="写阈值（0-1，越高越保守）">
            <el-input-number v-model="hubSettings.writeThreshold" :min="0" :max="1" :step="0.05" :precision="2" />
          </el-form-item>
          <el-form-item label="每轮最多写入"><el-input-number v-model="hubSettings.captureMaxPerTurn" :min="1" :max="5" /></el-form-item>
          <el-form-item label="每轮最多召回"><el-input-number v-model="hubSettings.recallLimit" :min="1" :max="8" /></el-form-item>
          <el-form-item label="注入上下文最大字符数"><el-input-number v-model="hubSettings.recallMaxChars" :min="400" :max="4000" :step="100" /></el-form-item>
          <el-form-item label="召回最低相关分">
            <el-input-number v-model="hubSettings.recallMinScore" :min="0" :max="1" :step="0.02" :precision="2" />
          </el-form-item>
          <el-form-item label="写入/召回空间（空 = 默认）"><el-input v-model="hubSettings.namespace" maxlength="64" placeholder="例如 project-a" /></el-form-item>
        </el-form>
        <p class="hm-muted small">
          关闭后回到旧的「自动召回 / 自动捕获」路径。DSH 设置页的 <code>memoryHub</code> 是启动默认值；
          此处保存到数据库后优先级更高。详见 <code>docs/MEMORY-HUB.md</code>。
        </p>
      </section>

      <section v-if="isAdmin" class="hm-card">
        <div class="hm-card-head">
          <h2>自动捕获</h2>
          <el-button type="primary" size="small" :loading="captureSaving" @click="saveCaptureSettings">保存</el-button>
        </div>
        <p class="hm-muted small">
          默认关闭。开启后只从真实用户/助手/工具消息抽取少量候选，写入待审阅队列，不参与自动召回；可在「捕获审阅」批准或忽略。
        </p>
        <el-form label-position="top" class="hm-form">
          <el-form-item label="启用自动捕获"><el-switch v-model="captureSettings.enabled" /></el-form-item>
          <el-form-item label="写入空间（空 = 默认）"><el-input v-model="captureSettings.namespace" maxlength="64" placeholder="例如 project-a" /></el-form-item>
          <el-form-item label="每条消息最多捕获"><el-input-number v-model="captureSettings.maxPerTurn" :min="1" :max="5" /></el-form-item>
          <el-form-item label="助手结论"><el-switch v-model="captureSettings.assistant" /></el-form-item>
          <el-form-item label="工具结果"><el-switch v-model="captureSettings.tools" /></el-form-item>
        </el-form>
        <p class="hm-muted small">LLM 抽取由 DSH 插件配置 <code>autoCaptureLlm</code> 控制；本页只控制本地规则开关。</p>
      </section>

      <section class="hm-card hm-keys-card">
        <div class="hm-card-head">
          <h2>API keys</h2>
          <el-button v-if="isAdmin" type="primary" size="small" @click="openKeyDialog"><el-icon><Plus /></el-icon>新建 key</el-button>
        </div>
        <el-alert v-if="!isAdmin" type="info" :closable="false" show-icon title="当前 key 不是 admin" description="使用 HIPPOCAMPUS_TOKEN 登录可创建 reader / writer / admin key。" />
        <el-table v-else :data="keys" class="hm-table">
          <el-table-column label="名称 / ID" min-width="200">
            <template #default="{ row }"><div class="hm-table-main"><strong>{{ row.name }}</strong><span>{{ row.id }}</span></div></template>
          </el-table-column>
          <el-table-column prop="role" label="角色" width="100" />
          <el-table-column label="namespace" width="160"><template #default="{ row }"><span class="hm-mono">{{ row.namespaces.join(', ') }}</span></template></el-table-column>
          <el-table-column label="最近使用" width="120"><template #default="{ row }"><span class="hm-mono">{{ row.lastUsedAt ? ago(row.lastUsedAt) : 'never' }}</span></template></el-table-column>
          <el-table-column prop="revoked" label="状态" width="90">
            <template #default="{ row }"><el-tag :type="row.revoked ? 'info' : 'success'" size="small" effect="plain">{{ row.revoked ? 'revoked' : 'active' }}</el-tag></template>
          </el-table-column>
          <el-table-column label="" width="90" align="right">
            <template #default="{ row }"><el-button v-if="!row.revoked" size="small" type="danger" text @click="revoke(row)">吊销</el-button></template>
          </el-table-column>
          <template #empty><div class="hm-empty"><el-icon><Key /></el-icon><p>还没有 API key</p></div></template>
        </el-table>
      </section>

      <section v-if="canBackup" class="hm-card">
        <div class="hm-card-head">
          <h2>备份</h2>
          <el-button type="primary" size="small" @click="createBackup">立即备份</el-button>
        </div>
        <p class="hm-muted small">危险空间操作会自动备份；恢复只替换记忆/空间数据，执行前会再自动备份当前状态。</p>
        <el-table :data="backups" class="hm-table" row-key="name">
          <el-table-column label="文件 / 时间" min-width="240">
            <template #default="{ row }">
              <div class="hm-table-main"><strong>{{ row.name }}</strong><span>{{ fmtBytes(row.size) }} · {{ ago(row.createdAt) }}</span></div>
            </template>
          </el-table-column>
          <el-table-column label="" width="180" align="right">
            <template #default="{ row }">
              <el-button size="small" text type="primary" @click="restore(row)">恢复</el-button>
              <el-button size="small" text type="danger" @click="removeBackup(row)">删除</el-button>
            </template>
          </el-table-column>
          <template #empty><div class="hm-empty"><p>还没有备份</p></div></template>
        </el-table>
      </section>

      <section class="hm-card">
        <div class="hm-card-head"><h2>账号安全</h2><el-tag size="small" effect="plain">{{ auth?.role ?? '未登录' }}</el-tag></div>
        <el-form label-position="top" class="hm-password-form">
          <el-form-item label="当前密码"><el-input v-model="passwordForm.current" type="password" show-password autocomplete="current-password" /></el-form-item>
          <el-form-item label="新密码（至少 8 位；首尾空格会被忽略）"><el-input v-model="passwordForm.next" type="password" show-password autocomplete="new-password" /></el-form-item>
          <el-form-item label="再输入一次"><el-input v-model="passwordForm.confirm" type="password" show-password autocomplete="new-password" /></el-form-item>
          <el-button type="primary" :loading="passwordSaving" @click="changePassword">修改我的密码</el-button>
        </el-form>
        <template v-if="isAdmin">
          <el-divider />
          <p class="hm-muted small">管理员重置：吊销该账号的全部会话，旧密码立即失效。</p>
          <div class="hm-inline-actions">
            <el-select v-model="resetForm.userId" placeholder="选择账号" style="width: 260px">
              <el-option v-for="user in users" :key="user.id" :label="`${user.email} · ${user.role}`" :value="user.id" />
            </el-select>
            <el-input v-model="resetForm.password" type="password" show-password placeholder="该账号的新密码" style="width: 220px" />
            <el-button type="danger" plain :loading="resetSaving" @click="resetPassword">重置并吊销会话</el-button>
          </div>
        </template>
        <p class="hm-muted small">忘记密码：在插件目录运行 <code>node bin/hippocampus.mjs user reset-password --email 你@example.com</code>（见 <code>docs/FAQ.md#reset</code>）。</p>
      </section>

      <section class="hm-card hm-danger-zone">
        <div class="hm-card-head"><h2>数据</h2></div>
        <div class="hm-inline-actions">
          <el-button @click="exportSnapshot"><el-icon><Download /></el-icon>导出 JSON</el-button>
          <el-button v-if="isAdmin" @click="triggerImport"><el-icon><Upload /></el-icon>导入 JSON</el-button>
          <el-button v-if="isAdmin" @click="backup"><el-icon><FolderOpened /></el-icon>备份数据库</el-button>
          <input ref="fileInput" type="file" accept="application/json" hidden @change="importSnapshot" />
        </div>
        <p class="hm-muted small">导出当前 namespace 的 JSON 快照；导入为 admin，skipExisting 默认开启；SQLite 备份用 <code>VACUUM INTO</code>，PostgreSQL 备份写 JSON 逻辑快照。</p>
      </section>
    </template>

    <el-dialog v-model="keyDialog" title="新建 API key" width="min(520px, 92vw)">
      <el-form label-position="top">
        <el-form-item label="名称"><el-input v-model="keyForm.name" placeholder="例如 claude-desktop" /></el-form-item>
        <el-form-item label="角色">
          <el-select v-model="keyForm.role"><el-option v-for="role in ['reader','writer','admin']" :key="role" :label="role" :value="role" /></el-select>
        </el-form-item>
        <el-form-item label="namespace（逗号分隔）"><el-input v-model="keyForm.namespaces" placeholder="default, project-a 或 *" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="keyDialog = false">取消</el-button>
        <el-button type="primary" :loading="keySaving" @click="createKey">创建</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="secretDialog" title="API key 已创建" width="min(560px, 92vw)">
      <el-alert type="warning" :closable="false" show-icon title="只显示一次，请立即保存" description="服务端只存 SHA-256 hash。" />
      <div class="hm-secret">{{ secret }}</div>
      <template #footer><el-button type="primary" @click="secretDialog = false">我已保存</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { ago, api, fmtBytes } from '../lib'

const props = defineProps({
  refreshKey: { type: Number, default: 0 },
  auth: { type: Object, default: null },
})
const emit = defineEmits(['navigate', 'refresh'])

const loading = ref(true)
const config = ref({})
const keys = ref([])
const keyDialog = ref(false)
const secretDialog = ref(false)
const keySaving = ref(false)
const secret = ref('')
const fileInput = ref(null)
const keyForm = reactive({ name: '', role: 'reader', namespaces: '*' })
const backups = ref([])
const captureSettings = ref({ enabled: false, namespace: '', maxPerTurn: 2, assistant: true, tools: true })
const captureSaving = ref(false)
const hubSettings = ref({
  enabled: false,
  readThreshold: 0.34,
  writeThreshold: 0.55,
  capture: true,
  autoApprove: true,
  captureMaxPerTurn: 2,
  recallLimit: 4,
  recallMaxChars: 1200,
  recallMinScore: 0.18,
  namespace: '',
})
const hubSaving = ref(false)
const users = ref([])
const passwordForm = reactive({ current: '', next: '', confirm: '' })
const resetForm = reactive({ userId: '', password: '' })
const passwordSaving = ref(false)
const resetSaving = ref(false)
const isAdmin = computed(() => props.auth?.role === 'admin')
const canBackup = computed(() => {
  const scopes = props.auth?.namespaces
  return isAdmin.value && (!scopes || (Array.isArray(scopes) && scopes.includes('*')))
})
const defaultKeyNamespaces = computed(() => {
  const allowed = props.auth?.namespaces ?? ['*']
  return allowed.includes('*') ? '*' : allowed.join(', ')
})

async function load() {
  loading.value = true
  try {
    config.value = isAdmin.value ? await api('/api/config') : (await api('/api/public-config'))
    if (isAdmin.value) {
      const data = await api('/api/keys')
      keys.value = data.keys
      users.value = (await api('/api/users')).users
      backups.value = canBackup.value ? (await api('/api/backups').catch(() => ({ backups: [] }))).backups : []
      captureSettings.value = (await api('/api/capture/settings').catch(() => ({ settings: captureSettings.value }))).settings
      hubSettings.value = (await api('/api/hub/settings').catch(() => ({ settings: hubSettings.value }))).settings
    }
  } catch (error) {
    ElMessage.error(error.message)
  } finally {
    loading.value = false
  }
}

async function saveCaptureSettings() {
  captureSaving.value = true
  try {
    const data = await api('/api/capture/settings', {
      method: 'PATCH',
      body: {
        enabled: captureSettings.value.enabled,
        namespace: captureSettings.value.namespace,
        maxPerTurn: captureSettings.value.maxPerTurn,
        assistant: captureSettings.value.assistant,
        tools: captureSettings.value.tools,
      },
    })
    captureSettings.value = data.settings
    ElMessage.success('自动捕获设置已保存')
  } catch (error) {
    ElMessage.error(error.message)
  } finally {
    captureSaving.value = false
  }
}

async function saveHubSettings() {
  hubSaving.value = true
  try {
    const data = await api('/api/hub/settings', {
      method: 'PATCH',
      body: {
        enabled: hubSettings.value.enabled,
        readThreshold: hubSettings.value.readThreshold,
        writeThreshold: hubSettings.value.writeThreshold,
        capture: hubSettings.value.capture,
        autoApprove: hubSettings.value.autoApprove,
        captureMaxPerTurn: hubSettings.value.captureMaxPerTurn,
        recallLimit: hubSettings.value.recallLimit,
        recallMaxChars: hubSettings.value.recallMaxChars,
        recallMinScore: hubSettings.value.recallMinScore,
        namespace: hubSettings.value.namespace,
      },
    })
    hubSettings.value = data.settings
    ElMessage.success('记忆中枢设置已保存，立即生效')
  } catch (error) {
    ElMessage.error(error.message)
  } finally {
    hubSaving.value = false
  }
}

async function createBackup() {
  try {
    const result = await api('/api/backups', { method: 'POST', body: { label: 'webui' } })
    ElMessage.success('已备份：' + result.name)
    backups.value = (await api('/api/backups')).backups
  } catch (error) {
    ElMessage.error(error.message)
  }
}

async function restore(row) {
  try {
    const dry = await api('/api/backups/' + encodeURIComponent(row.name) + '/restore', {
      method: 'POST',
      body: {},
    })
    await ElMessageBox.confirm(
      '将恢复 ' + dry.snapshot.memories + ' 条记忆 / ' + dry.snapshot.namespaces + ' 个空间（当前 ' + dry.current.memories + ' 条）。执行前会自动备份当前状态。',
      '恢复备份',
      { type: 'warning' },
    )
    await api('/api/backups/' + encodeURIComponent(row.name) + '/restore', {
      method: 'POST',
      body: { dryRun: false, confirm: true },
    })
    ElMessage.success('恢复完成')
    await load()
    emit('refresh')
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(error.message)
  }
}

async function removeBackup(row) {
  try {
    await ElMessageBox.confirm('删除备份 ' + row.name + '？', '删除备份', { type: 'warning' })
    await api('/api/backups/' + encodeURIComponent(row.name), { method: 'DELETE' })
    ElMessage.success('已删除')
    backups.value = (await api('/api/backups')).backups
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(error.message)
  }
}

async function changePassword() {
  if (!passwordForm.current || !passwordForm.next) return ElMessage.warning('请输入当前密码和新密码')
  if (passwordForm.next.trim().length < 8) return ElMessage.warning('新密码至少 8 个字符')
  if (passwordForm.next !== passwordForm.confirm) return ElMessage.warning('两次输入的新密码不一致')
  passwordSaving.value = true
  try {
    const data = await api('/api/auth/password', {
      method: 'POST',
      body: { currentPassword: passwordForm.current, newPassword: passwordForm.next },
    })
    Object.assign(passwordForm, { current: '', next: '', confirm: '' })
    ElMessage.success(`密码已更新；吊销了 ${data.revokedSessions ?? 0} 个其他会话`)
  } catch (error) {
    ElMessage.error(error.message)
  } finally {
    passwordSaving.value = false
  }
}

async function resetPassword() {
  if (!resetForm.userId) return ElMessage.warning('先选择账号')
  if (resetForm.password.trim().length < 8) return ElMessage.warning('新密码至少 8 个字符')
  resetSaving.value = true
  try {
    const data = await api(`/api/users/${encodeURIComponent(resetForm.userId)}/password`, {
      method: 'PATCH',
      body: { password: resetForm.password },
    })
    resetForm.password = ''
    ElMessage.success(`已重置密码；吊销了 ${data.revokedSessions ?? 0} 个会话`)
  } catch (error) {
    ElMessage.error(error.message)
  } finally {
    resetSaving.value = false
  }
}

function openKeyDialog() {
  Object.assign(keyForm, { name: '', role: 'reader', namespaces: defaultKeyNamespaces.value })
  keyDialog.value = true
}

async function createKey() {
  if (!keyForm.name.trim()) return ElMessage.warning('名称不能为空')
  keySaving.value = true
  try {
    const data = await api('/api/keys', {
      method: 'POST',
      body: {
        name: keyForm.name.trim(),
        role: keyForm.role,
        namespaces: keyForm.namespaces.split(',').map((item) => item.trim()).filter(Boolean),
      },
    })
    keyDialog.value = false
    secret.value = data.key
    secretDialog.value = true
    await load()
  } catch (error) {
    ElMessage.error(error.message)
  } finally {
    keySaving.value = false
  }
}

async function revoke(row) {
  try {
    await ElMessageBox.confirm(`吊销 key「${row.name}」？`, '吊销 API key', { type: 'warning' })
    await api(`/api/keys/${row.id}`, { method: 'DELETE' })
    ElMessage.success('已吊销')
    await load()
  } catch (error) {
    if (error !== 'cancel') ElMessage.error(error.message ?? '操作取消')
  }
}

async function exportSnapshot() {
  try {
    const storedToken = localStorage.getItem('hippocampus.token') || sessionStorage.getItem('hippocampus.token')
    const headers = storedToken ? { authorization: `Bearer ${storedToken}` } : {}
    const response = await fetch(`/api/export?namespace=${encodeURIComponent(localStorage.getItem('hippocampus.namespace') || 'default')}`, { headers })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const blob = await response.blob()
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `hippocampus-export-${new Date().toISOString().slice(0, 10)}.json`
    document.body.append(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
    ElMessage.success('导出已开始')
  } catch (error) {
    ElMessage.error(error.message)
  }
}

function triggerImport() {
  fileInput.value?.click()
}

async function importSnapshot(event) {
  const file = event.target.files?.[0]
  if (!file) return
  try {
    const snapshot = JSON.parse(await file.text())
    const result = await api('/api/import', { method: 'POST', body: snapshot })
    ElMessage.success(`导入完成：${result.imported} 条，跳过 ${result.skipped} 条`)
    await load()
  } catch (error) {
    ElMessage.error(error.message)
  } finally {
    event.target.value = ''
  }
}

async function backup() {
  try {
    await api('/api/jobs', { method: 'POST', body: { type: 'backup', payload: {} } })
    ElMessage.success('备份任务已入队')
  } catch (error) {
    ElMessage.error(error.message)
  }
}

onMounted(load)
watch(() => [props.refreshKey, props.auth?.role], load)
</script>
