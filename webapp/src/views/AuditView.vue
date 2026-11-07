<template>
  <div class="hm-page">
    <div v-if="auth?.role !== 'admin'" class="hm-card hm-permission">
      <el-icon><Lock /></el-icon>
      <div><h2>需要管理员权限</h2><p>审计日志只对 admin role 的 key 开放。</p></div>
    </div>
    <template v-else>
      <div class="hm-toolbar">
        <el-input v-model="action" class="hm-search" placeholder="action 过滤，如 memory.add" clearable @keyup.enter="search" />
        <el-input v-model="actor" class="hm-filter wide" placeholder="actor 过滤" clearable @keyup.enter="search" />
        <el-button type="primary" @click="search"><el-icon><Search /></el-icon>筛选</el-button>
        <el-button :loading="loading" text @click="load"><el-icon><Refresh /></el-icon>刷新</el-button>
        <span class="hm-toolbar-note">{{ total }} 条 · 保留 180 天</span>
      </div>

      <div class="hm-card hm-table-card">
        <el-table v-loading="loading" :data="items" class="hm-table">
          <el-table-column label="时间" width="170"><template #default="{ row }"><span class="hm-mono">{{ fmtTime(row.at) }}</span></template></el-table-column>
          <el-table-column label="操作者" width="150">
            <template #default="{ row }">
              <div class="hm-table-main"><strong>{{ row.actor ?? '—' }}</strong><span>{{ row.role ?? '' }}</span></div>
            </template>
          </el-table-column>
          <el-table-column prop="action" label="动作" width="160"><template #default="{ row }"><span class="hm-mono">{{ row.action }}</span></template></el-table-column>
          <el-table-column label="请求" min-width="220"><template #default="{ row }"><span class="hm-mono">{{ row.method }} {{ row.path }}</span></template></el-table-column>
          <el-table-column prop="status" label="状态" width="80" />
          <el-table-column prop="ip" label="IP" width="120"><template #default="{ row }"><span class="hm-mono">{{ row.ip ?? '—' }}</span></template></el-table-column>
          <el-table-column label="详情" width="90" align="right">
            <template #default="{ row }">
              <el-popover placement="left" :width="420" trigger="click">
                <template #reference><el-button text size="small">detail</el-button></template>
                <pre class="hm-json small">{{ JSON.stringify(row.detail, null, 2) }}</pre>
              </el-popover>
            </template>
          </el-table-column>
          <template #empty><div class="hm-empty"><el-icon><Tickets /></el-icon><p>暂无审计记录</p></div></template>
        </el-table>
        <div class="hm-pagination">
          <span>{{ total }} 条 · 第 {{ offset / limit + 1 }} / {{ Math.max(1, Math.ceil(total / limit)) }} 页</span>
          <el-pagination layout="prev, pager, next" :total="total" :page-size="limit" :current-page="offset / limit + 1" background @current-change="changePage" />
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { api, fmtTime } from '../lib'

const props = defineProps({
  refreshKey: { type: Number, default: 0 },
  auth: { type: Object, default: null },
})
const loading = ref(true)
const items = ref([])
const total = ref(0)
const offset = ref(0)
const limit = 40
const action = ref('')
const actor = ref('')

async function load() {
  if (props.auth?.role !== 'admin') return
  loading.value = true
  try {
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset.value) })
    if (action.value.trim()) params.set('action', action.value.trim())
    if (actor.value.trim()) params.set('actor', actor.value.trim())
    const data = await api(`/api/audit?${params}`)
    items.value = data.items
    total.value = data.total
  } catch (error) {
    ElMessage.error(error.message)
  } finally {
    loading.value = false
  }
}

function search() {
  offset.value = 0
  load()
}

function changePage(page) {
  offset.value = (page - 1) * limit
  load()
}

onMounted(load)
watch(() => [props.refreshKey, props.auth?.role], load)
</script>
