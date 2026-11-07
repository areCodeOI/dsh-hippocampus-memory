<template>
  <div class="hm-page">
    <div class="hm-toolbar">
      <el-input
        v-model="query"
        class="hm-search"
        placeholder="召回记忆：关键词、问题、人名、项目…"
        clearable
        @keyup.enter="search"
        @clear="search"
      >
        <template #prefix><el-icon><Search /></el-icon></template>
      </el-input>
      <el-select v-model="kind" class="hm-filter" placeholder="全部层" clearable @change="search">
        <el-option v-for="item in KIND_ORDER" :key="item" :label="KIND_LABEL[item]" :value="item" />
      </el-select>
      <el-select v-model="status" class="hm-filter" @change="search">
        <el-option label="有效" value="active" />
        <el-option label="已归档" value="archived" />
        <el-option label="待确认" value="conflict" />
        <el-option label="全部状态" value="all" />
      </el-select>
      <el-button v-if="canWrite" type="primary" @click="$emit('create')">
        <el-icon><Plus /></el-icon>写入记忆
      </el-button>
    </div>

    <div class="hm-card hm-table-card">
      <el-table v-loading="loading" :data="items" row-key="id" class="hm-table" @row-click="(row) => $emit('open-memory', row.id)">
        <el-table-column label="记忆" min-width="360">
          <template #default="{ row }">
            <div class="hm-table-main">
              <strong>{{ row.content }}</strong>
              <span>{{ shortId(row.id) }} · {{ row.namespace }} · {{ ago(row.lastAccessAt ?? row.createdAt) }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="层" width="92">
          <template #default="{ row }"><el-tag :type="kindTagType(row.kind)" size="small" effect="plain">{{ row.kindLabel }}</el-tag></template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }"><el-tag :type="statusTagType(row.status)" size="small" effect="plain">{{ row.statusLabel }}</el-tag></template>
        </el-table-column>
        <el-table-column label="重要性" width="90" align="right">
          <template #default="{ row }"><span class="hm-mono">{{ row.importance.toFixed(1) }}</span></template>
        </el-table-column>
        <el-table-column label="权重" width="80" align="right">
          <template #default="{ row }"><span class="hm-mono">{{ row.weight.toFixed(2) }}</span></template>
        </el-table-column>
        <el-table-column label="更新" width="120" align="right">
          <template #default="{ row }"><span class="hm-mono">{{ ago(row.updatedAt) }}</span></template>
        </el-table-column>
        <template #empty>
          <div class="hm-empty">
            <el-icon><Collection /></el-icon>
            <p>{{ query ? '没有匹配的记忆' : '还没有记忆' }}</p>
            <el-button v-if="canWrite" type="primary" size="small" @click="$emit('create')">写入第一条</el-button>
          </div>
        </template>
      </el-table>
      <div v-if="!query && total > limit" class="hm-pagination">
        <span>{{ total }} 条 · 第 {{ offset / limit + 1 }} / {{ Math.ceil(total / limit) }} 页</span>
        <el-pagination
          layout="prev, pager, next"
          :total="total"
          :page-size="limit"
          :current-page="offset / limit + 1"
          background
          @current-change="changePage"
        />
      </div>
      <div v-else-if="query" class="hm-pagination"><span>相关 {{ items.length }} 条</span></div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { KIND_LABEL, KIND_ORDER, ago, api, kindTagType, roleAtLeast, shortId, statusTagType } from '../lib'

const props = defineProps({
  refreshKey: { type: Number, default: 0 },
  namespace: { type: String, default: 'default' },
  auth: { type: Object, default: null },
})
const emit = defineEmits(['open-memory', 'create', 'refresh'])

const loading = ref(true)
const query = ref('')
const kind = ref('')
const status = ref('active')
const items = ref([])
const total = ref(0)
const offset = ref(0)
const limit = 25
const canWrite = computed(() => roleAtLeast(props.auth?.role, 'writer'))

async function load() {
  loading.value = true
  try {
    if (query.value.trim()) {
      const params = new URLSearchParams({ q: query.value.trim(), limit: '50', namespace: props.namespace })
      if (kind.value) params.set('kinds', kind.value)
      if (status.value === 'archived' || status.value === 'all') params.set('includeArchived', 'true')
      if (status.value === 'conflict' || status.value === 'all') params.set('includePending', 'true')
      const data = await api(`/api/memories/search?${params}`)
      const wanted = status.value
      items.value = wanted === 'all'
        ? data.memories
        : data.memories.filter((memory) => (wanted === 'archived' ? ['archived', 'superseded'].includes(memory.status) : memory.status === wanted))
      total.value = items.value.length
    } else {
      const params = new URLSearchParams({
        limit: String(limit),
        offset: String(offset.value),
        status: status.value,
        namespace: props.namespace,
      })
      if (kind.value) params.set('kinds', kind.value)
      const data = await api(`/api/memories?${params}`)
      items.value = data.items
      total.value = data.total
    }
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
watch(() => [props.refreshKey, props.namespace], load)
</script>
