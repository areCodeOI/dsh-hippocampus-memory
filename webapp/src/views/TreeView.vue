<template>
  <div class="hm-page">
    <div class="hm-toolbar">
      <el-input v-model="filter" class="hm-search" placeholder="过滤记忆内容或标签…" clearable>
        <template #prefix><el-icon><Search /></el-icon></template>
      </el-input>
      <el-button :loading="loading" @click="load"><el-icon><Refresh /></el-icon>刷新</el-button>
      <span class="hm-toolbar-note">{{ total }} 条记忆 · {{ treeData.length }} 个空间</span>
    </div>

    <div class="hm-card hm-tree-card" v-loading="loading">
      <el-tree
        v-if="treeData.length"
        ref="treeRef"
        :data="treeData"
        node-key="key"
        :props="{ label: 'label', children: 'children' }"
        default-expand-all
        :filter-node-method="filterNode"
        @node-click="onNodeClick"
      >
        <template #default="{ data }">
          <div class="hm-tree-node" :class="{ leaf: data.memoryId }">
            <el-tag v-if="data.kind" :type="kindTagType(data.kind)" size="small" effect="plain">{{ KIND_LABEL[data.kind] }}</el-tag>
            <span class="hm-tree-label">{{ data.label }}</span>
            <span v-if="data.memoryId" class="hm-mono">{{ data.weight }}</span>
          </div>
        </template>
      </el-tree>
      <div v-else-if="!loading" class="hm-empty">
        <el-icon><Connection /></el-icon>
        <p>记忆树还是空的</p>
        <span>写入记忆后，这里会按 namespace 和记忆层展开。</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { nextTick, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { KIND_LABEL, api, kindTagType } from '../lib'

const props = defineProps({
  refreshKey: { type: Number, default: 0 },
  namespace: { type: String, default: 'default' },
})
const emit = defineEmits(['open-memory'])

const loading = ref(true)
const treeData = ref([])
const total = ref(0)
const filter = ref('')
const treeRef = ref(null)

function buildTree(data) {
  return (data.namespaces ?? []).map((namespace) => ({
    key: `ns:${namespace.name}`,
    label: `${namespace.name} · ${namespace.count} 条`,
    children: namespace.kinds.map((kind) => ({
      key: `kind:${namespace.name}:${kind.kind}`,
      label: `${KIND_LABEL[kind.kind] ?? kind.kind} · ${kind.count} 条`,
      children: kind.nodes.map((node) => ({
        key: `mem:${node.id}`,
        memoryId: node.id,
        kind: node.kind,
        label: node.label,
        weight: node.weight?.toFixed?.(2) ?? '',
      })),
    })),
  }))
}

async function load() {
  loading.value = true
  try {
    const data = await api(`/api/tree?namespace=${encodeURIComponent(props.namespace)}&limit=500&includeArchived=false`)
    treeData.value = buildTree(data)
    total.value = data.total ?? 0
    await nextTick()
    if (treeRef.value && filter.value) treeRef.value.filter(filter.value)
  } catch (error) {
    ElMessage.error(error.message)
  } finally {
    loading.value = false
  }
}

function onNodeClick(data) {
  if (data.memoryId) emit('open-memory', data.memoryId)
}

function filterNode(value, data) {
  if (!value) return true
  return String(data.label ?? '').toLowerCase().includes(value.toLowerCase())
}

watch(filter, (value) => treeRef.value?.filter(value))
watch(() => [props.refreshKey, props.namespace], load)
onMounted(load)
</script>
