<template>
  <div class="hm-page">
    <section class="hm-card">
      <div class="hm-card-head">
        <h2>捕获审阅</h2>
        <div class="hm-inline-actions">
          <el-select v-model="namespace" class="hm-filter" placeholder="全部空间" clearable @change="load">
            <el-option label="全部空间" value="*" />
            <el-option v-for="item in namespaces" :key="item.name" :label="item.name" :value="item.name" />
          </el-select>
          <el-button size="small" @click="load">刷新</el-button>
        </div>
      </div>
      <p class="hm-muted small">
        自动捕获的候选先进入待审阅队列，不会参与自动召回。批准后会成为正式记忆；忽略会归档，保留审计。
      </p>
      <el-table v-loading="loading" :data="items" row-key="id" class="hm-table">
        <el-table-column label="候选" min-width="360">
          <template #default="{ row }">
            <div class="hm-table-main">
              <strong>{{ row.content }}</strong>
              <span>
                {{ row.namespace }} · {{ roleLabel(row) }} · {{ ago(row.createdAt) }}
                <el-tag v-for="tag in row.tags ?? []" :key="tag" size="small" effect="plain" style="margin-left: 4px">{{ tag }}</el-tag>
              </span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="重要性" width="90" align="right">
          <template #default="{ row }"><span class="hm-mono">{{ row.importance?.toFixed?.(1) ?? row.importance }}</span></template>
        </el-table-column>
        <el-table-column label="" width="270" align="right">
          <template #default="{ row }">
            <el-dropdown trigger="click" @command="(kind) => approve(row, kind)">
              <el-button size="small" type="primary" plain>批准 <el-icon><ArrowDown /></el-icon></el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="semantic">批准为语义</el-dropdown-item>
                  <el-dropdown-item command="persona">批准为人格</el-dropdown-item>
                  <el-dropdown-item command="episodic">保留为情景</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
            <el-button size="small" text type="danger" @click="reject(row)">忽略</el-button>
          </template>
        </el-table-column>
        <template #empty><div class="hm-empty"><p>没有待审阅的捕获</p></div></template>
      </el-table>
    </section>
  </div>
</template>

<script setup>
import { onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { ago, api } from '../lib'

const props = defineProps({
  refreshKey: { type: Number, default: 0 },
  auth: { type: Object, default: null },
})
const emit = defineEmits(['refresh'])

const loading = ref(true)
const items = ref([])
const namespaces = ref([])
const namespace = ref('*')

function roleLabel(row) {
  const role = row.metadata?.autoCapture?.role
  return role === 'assistant' ? '助手结论' : role === 'tool' ? '工具结果' : '用户陈述'
}

async function load() {
  loading.value = true
  try {
    const query = namespace.value && namespace.value !== '*' ? '&namespace=' + encodeURIComponent(namespace.value) : ''
    const data = await api('/api/captures?limit=200' + query)
    items.value = data.items ?? []
    if (!namespaces.value.length) {
      const all = await api('/api/namespaces').catch(() => ({ namespaces: [] }))
      namespaces.value = (all.namespaces ?? []).filter((item) => !item.namespaceArchived)
    }
  } catch (error) {
    ElMessage.error(error.message)
  } finally {
    loading.value = false
  }
}

async function approve(row, kind) {
  try {
    await api('/api/captures/' + encodeURIComponent(row.id) + '/approve', { method: 'POST', body: { kind } })
    ElMessage.success('已批准')
    await load()
    emit('refresh')
  } catch (error) {
    ElMessage.error(error.message)
  }
}

async function reject(row) {
  try {
    await ElMessageBox.confirm('忽略这条自动捕获？会归档并保留审计。', '忽略捕获', { type: 'warning' })
    await api('/api/captures/' + encodeURIComponent(row.id) + '/reject', { method: 'POST', body: {} })
    ElMessage.success('已忽略')
    await load()
    emit('refresh')
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(error.message)
  }
}

onMounted(load)
watch(() => props.refreshKey, load)
</script>
