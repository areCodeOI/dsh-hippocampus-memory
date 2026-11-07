<template>
  <div class="hm-page hm-star-page">
    <div class="hm-toolbar">
      <el-select v-model="limit" class="hm-filter" @change="load">
        <el-option v-for="value in [100, 200, 300, 500]" :key="value" :label="`${value} 节点`" :value="value" />
      </el-select>
      <el-switch v-model="includeArchived" active-text="含归档" @change="load" />
      <el-switch v-model="similarity" active-text="相似边" @change="load" />
      <el-switch v-model="labels" active-text="标签" />
      <el-button @click="starMap?.reset()"><el-icon><RefreshLeft /></el-icon>重置视图</el-button>
      <el-button :loading="loading" @click="load"><el-icon><Refresh /></el-icon>刷新</el-button>
      <span class="hm-toolbar-note">{{ graph.total ?? 0 }} 条记忆 · {{ graph.truncated ? '已截断' : '完整投影' }}</span>
    </div>

    <div class="hm-graph-layout">
      <section class="hm-graph-card">
        <el-skeleton v-if="loading" :rows="8" animated />
        <StarMap v-else-if="graph.nodes?.length" ref="starMap" :graph="graph" :labels="labels" @select="$emit('open-memory', $event)" />
        <div v-else class="hm-empty">
          <el-icon><Share /></el-icon>
          <p>星图还是空的</p>
          <span>写入记忆后，节点会在这里亮起。</span>
        </div>
      </section>
      <aside class="hm-graph-side">
        <div class="hm-card">
          <div class="hm-card-head"><h2>星图概况</h2></div>
          <div class="hm-graph-stats">
            <div class="hm-graph-stat"><span>节点</span><strong>{{ graph.stats?.nodes ?? 0 }}</strong></div>
            <div class="hm-graph-stat"><span>边</span><strong>{{ graph.stats?.edges ?? 0 }}</strong></div>
            <div class="hm-graph-stat"><span>总记忆</span><strong>{{ graph.total ?? 0 }}</strong></div>
            <div class="hm-graph-stat"><span>截断</span><strong>{{ graph.truncated ? '是' : '否' }}</strong></div>
          </div>
        </div>
        <div class="hm-card">
          <div class="hm-card-head"><h2>图例</h2></div>
          <div class="hm-legend">
            <span v-for="kind in KIND_ORDER" :key="kind"><i :style="{ background: colorOf(kind) }" />{{ KIND_LABEL[kind] }}</span>
            <span><i class="line consolidation" />巩固链</span>
            <span><i class="line conflict" />冲突</span>
            <span><i class="line similar" />相似</span>
          </div>
        </div>
        <div class="hm-card hm-graph-note">
          <p>节点大小由重要性决定；金色/青色光晕代表人格与语义记忆；红色描边是未解决冲突。边来自巩固链、冲突、共享标签与词法相似度。</p>
        </div>
      </aside>
    </div>
  </div>
</template>

<script setup>
import { onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { KIND_LABEL, KIND_ORDER, api } from '../lib'
import StarMap from '../components/StarMap.vue'

const props = defineProps({
  refreshKey: { type: Number, default: 0 },
  namespace: { type: String, default: 'default' },
})
defineEmits(['open-memory'])

const loading = ref(true)
const graph = ref({ nodes: [], edges: [], stats: {}, total: 0 })
const limit = ref(200)
const includeArchived = ref(false)
const similarity = ref(true)
const labels = ref(true)
const starMap = ref(null)

function colorOf(kind) {
  return { persona: '#f5c86b', semantic: '#4de3e1', episodic: '#8aa8ff', buffer: '#8494b8' }[kind] ?? '#8494b8'
}

async function load() {
  loading.value = true
  try {
    const params = new URLSearchParams({
      namespace: props.namespace,
      limit: String(limit.value),
      includeArchived: String(includeArchived.value),
      similarity: String(similarity.value),
    })
    graph.value = await api(`/api/graph?${params}`)
  } catch (error) {
    ElMessage.error(error.message)
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(() => [props.refreshKey, props.namespace], load)
</script>
