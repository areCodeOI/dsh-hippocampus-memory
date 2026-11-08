<template>
  <div class="hm-page">
    <el-skeleton v-if="loading" :rows="6" animated />
    <template v-else>
      <section class="hm-card">
        <div class="hm-card-head">
          <h2>命名空间</h2>
          <div class="hm-inline-actions">
            <el-input v-model="newName" size="small" placeholder="新空间名称" style="width: 190px" maxlength="64" @keyup.enter="openCreate" />
            <el-button v-if="isAdmin" size="small" type="primary" @click="openCreate">新建</el-button>
            <el-button size="small" @click="load">刷新</el-button>
          </div>
        </div>
        <p class="hm-muted small">
          namespace 是同一数据库内的逻辑分区，不是加密边界。当前空间：<code>{{ namespace }}</code>。
          默认空间由插件配置决定；重命名/删除默认空间需要先改配置或使用 force。
        </p>
        <el-table :data="items" class="hm-table" row-key="name">
          <el-table-column label="名称" min-width="190">
            <template #default="{ row }">
              <div class="hm-table-main">
                <strong>{{ row.name }}</strong>
                <span>
                  <el-tag v-if="row.name === defaultNamespace" size="small" type="success" effect="plain">默认</el-tag>
                  <el-tag v-if="row.reserved" size="small" effect="plain">预留</el-tag>
                </span>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="记忆" width="78">
            <template #default="{ row }">{{ row.total }}</template>
          </el-table-column>
          <el-table-column label="分层" min-width="210">
            <template #default="{ row }"><span class="hm-mono">{{ kindText(row) }}</span></template>
          </el-table-column>
          <el-table-column label="状态" min-width="240">
            <template #default="{ row }">
              <span class="hm-mono">active {{ row.active }} · 冲突 {{ row.conflict }} · 待确认 {{ row.openConflicts }} · 归档 {{ row.archived }} · 待删 {{ row.pendingDelete }}</span>
            </template>
          </el-table-column>
          <el-table-column label="最近写入" width="120">
            <template #default="{ row }">{{ row.lastAt ? ago(row.lastAt) : '—' }}</template>
          </el-table-column>
          <el-table-column label="" width="270" align="right">
            <template #default="{ row }">
              <el-button size="small" text @click="useNamespace(row)">切换</el-button>
              <el-button v-if="isAdmin" size="small" text @click="openRename(row)">重命名</el-button>
              <el-button v-if="isAdmin" size="small" text @click="openMerge(row)">合并</el-button>
              <el-button v-if="isAdmin" size="small" text type="danger" @click="openDelete(row)">删除</el-button>
            </template>
          </el-table-column>
          <template #empty><div class="hm-empty"><p>还没有命名空间</p></div></template>
        </el-table>
        <p class="hm-muted small">
          命令行同样可用：<code>node bin/hippocampus.mjs namespace list|create|rename|merge|delete</code>。
        </p>
      </section>
    </template>

    <el-dialog v-model="createOpen" title="新建命名空间" width="min(420px, 92vw)">
      <el-input v-model="createName" placeholder="例如 project-kestrel" maxlength="64" show-word-limit />
      <template #footer>
        <el-button @click="createOpen = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="doCreate">创建</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="renameOpen" title="重命名命名空间" width="min(460px, 92vw)">
      <p class="hm-muted small">将 <code>{{ renameRow?.name }}</code> 重命名为：</p>
      <el-input v-model="renameTo" maxlength="64" show-word-limit />
      <p class="hm-muted small">API key 的空间白名单和排队任务会同步迁移；历史审计保留旧名称。</p>
      <template #footer>
        <el-button @click="renameOpen = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="doRename">重命名</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="mergeOpen" title="合并命名空间" width="min(480px, 92vw)">
      <p class="hm-muted small">把 <code>{{ mergeRow?.name }}</code> 的全部记忆移入：</p>
      <el-select v-model="mergeInto" placeholder="选择目标空间" style="width: 100%">
        <el-option v-for="item in mergeTargets" :key="item.name" :label="item.name" :value="item.name" />
      </el-select>
      <p class="hm-muted small">目标不存在时可先新建；内容完全相同的 active 记忆会去重合并，其余迁移。</p>
      <template #footer>
        <el-button @click="mergeOpen = false">取消</el-button>
        <el-button type="primary" :loading="saving" :disabled="!mergeInto" @click="doMerge">合并</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="deleteOpen" title="删除命名空间" width="min(520px, 92vw)">
      <p class="hm-muted small">目标：<code>{{ deleteRow?.name }}</code>（{{ deleteRow?.total ?? 0 }} 条记忆）</p>
      <el-radio-group v-model="deleteMode">
        <el-radio value="soft">软删除（7 天冷静期）</el-radio>
        <el-radio value="hard">永久删除</el-radio>
      </el-radio-group>
      <p v-if="deleteMode === 'hard'" class="hm-muted small">
        不可恢复。请输入 <code>{{ deleteRow?.name }}</code> 确认：
      </p>
      <el-input v-if="deleteMode === 'hard'" v-model="deleteTyped" :placeholder="deleteRow?.name" />
      <el-checkbox v-model="deleteForce">force（允许操作配置的默认空间或 persona 记忆）</el-checkbox>
      <template #footer>
        <el-button @click="deleteOpen = false">取消</el-button>
        <el-button
          type="danger"
          :loading="saving"
          :disabled="deleteMode === 'hard' && deleteTyped !== deleteRow?.name"
          @click="doDelete"
        >{{ deleteMode === 'hard' ? '永久删除' : '软删除' }}</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { ago, api } from '../lib'

const props = defineProps({
  refreshKey: { type: Number, default: 0 },
  auth: { type: Object, default: null },
  namespace: { type: String, default: 'default' },
})
const emit = defineEmits(['refresh', 'namespaces-changed', 'namespace-change'])

const loading = ref(true)
const saving = ref(false)
const items = ref([])
const defaultNamespace = ref('default')
const isAdmin = computed(() => props.auth?.role === 'admin')

const newName = ref('')
const createOpen = ref(false)
const createName = ref('')
const renameOpen = ref(false)
const renameRow = ref(null)
const renameTo = ref('')
const mergeOpen = ref(false)
const mergeRow = ref(null)
const mergeInto = ref('')
const mergeTargets = computed(() => items.value.filter((item) => item.name !== mergeRow.value?.name))
const deleteOpen = ref(false)
const deleteRow = ref(null)
const deleteMode = ref('soft')
const deleteTyped = ref('')
const deleteForce = ref(false)

function kindText(row) {
  const kinds = row.byKind ?? {}
  return '人格 ' + (kinds.persona ?? 0) + ' · 语义 ' + (kinds.semantic ?? 0) + ' · 情景 ' + (kinds.episodic ?? 0) + ' · 缓冲 ' + (kinds.buffer ?? 0)
}

async function load() {
  loading.value = true
  try {
    const data = await api('/api/namespaces')
    items.value = data.namespaces ?? []
    defaultNamespace.value = data.default ?? 'default'
  } catch (error) {
    ElMessage.error(error.message)
  } finally {
    loading.value = false
  }
}

function useNamespace(row) {
  emit('namespace-change', row.name)
  ElMessage.success('已切换到 ' + row.name)
}

function openCreate() {
  createName.value = newName.value.trim()
  createOpen.value = true
}

async function doCreate() {
  const name = createName.value.trim()
  if (!name) return ElMessage.warning('请输入名称')
  saving.value = true
  try {
    const result = await api('/api/namespaces', { method: 'POST', body: { name } })
    createOpen.value = false
    newName.value = ''
    ElMessage.success(result.created ? '已创建 ' + name : '空间已存在：' + name)
    await load()
    emit('namespaces-changed')
  } catch (error) {
    ElMessage.error(error.message)
  } finally {
    saving.value = false
  }
}

function openRename(row) {
  renameRow.value = row
  renameTo.value = row.name
  renameOpen.value = true
}

async function doRename() {
  const to = renameTo.value.trim()
  if (!to) return ElMessage.warning('请输入新名称')
  saving.value = true
  try {
    const result = await api('/api/namespaces/' + encodeURIComponent(renameRow.value.name), {
      method: 'PATCH',
      body: { to },
    })
    if (props.namespace === renameRow.value.name) emit('namespace-change', result.to)
    renameOpen.value = false
    ElMessage.success('已重命名：' + result.from + ' → ' + result.to)
    await load()
    emit('namespaces-changed')
  } catch (error) {
    ElMessage.error(error.message)
  } finally {
    saving.value = false
  }
}

function openMerge(row) {
  mergeRow.value = row
  mergeInto.value = ''
  mergeOpen.value = true
}

async function doMerge() {
  if (!mergeInto.value) return ElMessage.warning('请选择目标空间')
  saving.value = true
  try {
    const result = await api('/api/namespaces/' + encodeURIComponent(mergeRow.value.name) + '/merge', {
      method: 'POST',
      body: { into: mergeInto.value },
    })
    if (props.namespace === mergeRow.value.name) emit('namespace-change', result.into)
    mergeOpen.value = false
    ElMessage.success('已合并：迁移 ' + result.moved + ' 条，去重 ' + result.deduped + ' 条')
    await load()
    emit('namespaces-changed')
  } catch (error) {
    ElMessage.error(error.message)
  } finally {
    saving.value = false
  }
}

function openDelete(row) {
  deleteRow.value = row
  deleteMode.value = 'soft'
  deleteTyped.value = ''
  deleteForce.value = false
  deleteOpen.value = true
}

async function doDelete() {
  const row = deleteRow.value
  if (!row) return
  if (deleteMode.value === 'hard' && deleteTyped.value !== row.name) return ElMessage.warning('请输入完整名称确认')
  saving.value = true
  try {
    const hard = deleteMode.value === 'hard'
    const result = await api(
      '/api/namespaces/' + encodeURIComponent(row.name) + '?hard=' + hard + '&confirm=' + hard + '&force=' + deleteForce.value,
      { method: 'DELETE' },
    )
    deleteOpen.value = false
    ElMessage.success(
      result.hard ? '已永久删除 ' + result.deleted + ' 条记忆' : '已进入冷静期：' + result.pending + ' 条待清理',
    )
    await load()
    emit('namespaces-changed')
    if (props.namespace === row.name) emit('refresh')
  } catch (error) {
    ElMessage.error(error.message)
  } finally {
    saving.value = false
  }
}

onMounted(load)
watch(() => props.refreshKey, load)
</script>
