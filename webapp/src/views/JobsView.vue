<template>
  <div class="hm-page">
    <div class="hm-toolbar">
      <el-button v-if="canWrite" type="primary" @click="createJob('replay')"><el-icon><Refresh /></el-icon>运行回放</el-button>
      <el-button v-if="canWrite" @click="createJob('embed_backfill')"><el-icon><Cpu /></el-icon>嵌入回填</el-button>
      <el-button v-if="isAdmin" @click="createJob('backup')"><el-icon><Download /></el-icon>创建备份</el-button>
      <el-button v-if="isAdmin" @click="createJob('maintenance')"><el-icon><Setting /></el-icon>维护</el-button>
      <el-button :loading="loading" text @click="load"><el-icon><Refresh /></el-icon>刷新</el-button>
      <span class="hm-toolbar-note">每 3 秒自动刷新 · {{ total }} 个任务</span>
    </div>

    <div class="hm-card hm-table-card">
      <el-table v-loading="loading" :data="items" class="hm-table">
        <el-table-column prop="id" label="ID" width="190"><template #default="{ row }"><span class="hm-mono">{{ row.id }}</span></template></el-table-column>
        <el-table-column prop="type" label="类型" width="130" />
        <el-table-column label="状态" width="110">
          <template #default="{ row }"><el-tag :type="jobType(row.status)" size="small" effect="plain">{{ row.status }}</el-tag></template>
        </el-table-column>
        <el-table-column label="进度" min-width="160">
          <template #default="{ row }"><el-progress :percentage="Math.round((row.progress ?? 0) * 100)" :stroke-width="8" :show-text="false" /></template>
        </el-table-column>
        <el-table-column label="重试" width="80"><template #default="{ row }"><span class="hm-mono">{{ row.attempts }}/{{ row.maxAttempts }}</span></template></el-table-column>
        <el-table-column label="创建" width="110"><template #default="{ row }"><span class="hm-mono">{{ ago(row.createdAt) }}</span></template></el-table-column>
        <el-table-column label="操作" width="120" align="right">
          <template #default="{ row }">
            <el-popover placement="left" :width="360" trigger="click">
              <template #reference><el-button text size="small">详情</el-button></template>
              <pre class="hm-json small">{{ JSON.stringify({ payload: row.payload, result: row.result, error: row.error }, null, 2) }}</pre>
              <el-button v-if="isAdmin && ['queued','running'].includes(row.status)" size="small" type="danger" plain @click="cancel(row)">取消任务</el-button>
            </el-popover>
          </template>
        </el-table-column>
        <template #empty><div class="hm-empty"><el-icon><Timer /></el-icon><p>暂无任务</p></div></template>
      </el-table>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { ago, api, roleAtLeast } from '../lib'

const props = defineProps({
  refreshKey: { type: Number, default: 0 },
  namespace: { type: String, default: 'default' },
  auth: { type: Object, default: null },
})
defineEmits(['refresh'])

const loading = ref(true)
const items = ref([])
const total = ref(0)
let timer = null
const canWrite = computed(() => roleAtLeast(props.auth?.role, 'writer'))
const isAdmin = computed(() => props.auth?.role === 'admin')

function jobType(status) {
  return { succeeded: 'success', failed: 'danger', running: 'primary', queued: 'warning', cancelled: 'info' }[status] ?? 'info'
}

async function load() {
  try {
    const data = await api('/api/jobs?limit=50')
    items.value = data.items ?? []
    total.value = data.total ?? 0
  } catch (error) {
    ElMessage.error(error.message)
  } finally {
    loading.value = false
  }
}

async function createJob(type) {
  const payload = {}
  if (type === 'replay' || type === 'embed_backfill') payload.namespace = props.namespace === '*' ? undefined : props.namespace
  if (type === 'embed_backfill') payload.limit = 500
  try {
    await api('/api/jobs', { method: 'POST', body: { type, payload } })
    ElMessage.success('任务已入队')
    await load()
  } catch (error) {
    ElMessage.error(error.message)
  }
}

async function cancel(job) {
  try {
    await ElMessageBox.confirm(`取消任务 ${job.id}？`, '取消任务', { type: 'warning' })
    await api(`/api/jobs/${job.id}/cancel`, { method: 'POST' })
    ElMessage.success('已取消')
    await load()
  } catch (error) {
    if (error !== 'cancel') ElMessage.error(error.message ?? '操作取消')
  }
}

onMounted(() => {
  load()
  timer = setInterval(load, 3000)
})
onUnmounted(() => clearInterval(timer))
watch(() => [props.refreshKey, props.namespace], load)
</script>
