<template>
  <div class="hm-page">
    <el-skeleton v-if="loading" :rows="6" animated />
    <template v-else>
      <div class="hm-stat-grid">
        <div class="hm-stat-card accent">
          <div class="hm-stat-icon"><el-icon><Collection /></el-icon></div>
          <span class="hm-stat-label">记忆总量</span>
          <strong>{{ stats.totals?.all ?? 0 }}</strong>
          <small>{{ stats.totals?.active ?? 0 }} 条有效 · {{ stats.byKind?.persona ?? 0 }} 条人格</small>
        </div>
        <div class="hm-stat-card" :class="{ warn: stats.totals?.conflict }">
          <div class="hm-stat-icon"><el-icon><Warning /></el-icon></div>
          <span class="hm-stat-label">待处理</span>
          <strong>{{ stats.totals?.conflict ?? 0 }}</strong>
          <small>{{ monitor.jobs?.active ?? 0 }} 个异步任务运行中</small>
        </div>
        <div class="hm-stat-card">
          <div class="hm-stat-icon"><el-icon><Coin /></el-icon></div>
          <span class="hm-stat-label">数据库</span>
          <strong>{{ fmtBytes(stats.dbSizeBytes) }}</strong>
          <small>{{ stats.dbPath?.split('/').pop() }} · schema v{{ stats.schemaVersion }}</small>
        </div>
        <div class="hm-stat-card">
          <div class="hm-stat-icon"><el-icon><Cpu /></el-icon></div>
          <span class="hm-stat-label">缓存命中率</span>
          <strong>{{ Math.round((monitor.cache?.search?.hitRate ?? 0) * 100) }}%</strong>
          <small>{{ monitor.cache?.search?.entries ?? 0 }} 条搜索缓存 · RSS {{ fmtBytes(monitor.process?.rssBytes) }}</small>
        </div>
      </div>

      <div class="hm-two-col">
        <section class="hm-card">
          <div class="hm-card-head">
            <h2>四层记忆结构</h2>
            <span class="hm-mono">active {{ stats.totals?.active ?? 0 }}</span>
          </div>
          <div class="hm-kind-bars">
            <div v-for="kind in KIND_ORDER" :key="kind" class="hm-kind-row">
              <span>{{ KIND_LABEL[kind] }}</span>
              <div class="hm-bar"><i :class="`kind-${kind}`" :style="{ width: `${(stats.byKind?.[kind] ?? 0) / maxKind * 100}%` }" /></div>
              <b>{{ stats.byKind?.[kind] ?? 0 }}</b>
            </div>
          </div>
        </section>
        <section class="hm-card">
          <div class="hm-card-head">
            <h2>运行状态</h2>
            <span class="hm-mono">up {{ Math.round((monitor.uptimeSeconds ?? 0) / 60) }}m</span>
          </div>
          <div class="hm-kv">
            <div><span>搜索缓存</span><b>{{ monitor.cache?.search?.hits ?? 0 }} hit / {{ monitor.cache?.search?.misses ?? 0 }} miss</b></div>
            <div><span>图谱缓存</span><b>{{ monitor.cache?.graph?.entries ?? 0 }} 条</b></div>
            <div><span>嵌入</span><b>{{ monitor.embeddings?.enabled ? `${monitor.embeddings.providers.length} providers` : '未启用' }}</b></div>
            <div><span>队列</span><b>{{ monitor.jobs?.byStatus?.queued ?? 0 }} queued · {{ monitor.jobs?.running ?? 0 }} running</b></div>
            <div><span>速率限制</span><b>{{ monitor.rateLimiter?.limit ?? '—' }} / {{ Math.round((monitor.rateLimiter?.windowMs ?? 60000) / 1000) }}s</b></div>
            <div><span>上次回放</span><b>{{ stats.lastReplayAt ? ago(stats.lastReplayAt) : '从未' }}</b></div>
          </div>
        </section>
      </div>

      <div class="hm-two-col">
        <section class="hm-card">
          <div class="hm-card-head">
            <h2>最近记忆</h2>
            <el-button text type="primary" @click="$emit('navigate', 'memories')">全部</el-button>
          </div>
          <div v-if="!recent.length" class="hm-empty">
            <el-icon><Collection /></el-icon>
            <p>还没有记忆</p>
            <el-button type="primary" size="small" @click="$emit('navigate', 'memories')">写入第一条</el-button>
          </div>
          <template v-else>
            <button v-for="memory in recent" :key="memory.id" class="hm-memory-row" type="button" @click="$emit('open-memory', memory.id)">
              <el-tag :type="kindTagType(memory.kind)" size="small" effect="plain">{{ memory.kindLabel }}</el-tag>
              <span class="hm-memory-text">{{ memory.content }}</span>
              <span class="hm-mono">{{ ago(memory.lastAccessAt ?? memory.createdAt) }}</span>
            </button>
          </template>
        </section>
        <section class="hm-card">
          <div class="hm-card-head">
            <h2>审计尾迹</h2>
            <el-button text type="primary" @click="$emit('navigate', 'audit')">查看</el-button>
          </div>
          <div v-if="!audit" class="hm-empty small">
            <el-icon><Lock /></el-icon>
            <p>需要 admin 权限</p>
          </div>
          <div v-else-if="!audit.length" class="hm-empty small"><p>暂无审计记录</p></div>
          <template v-else>
            <div v-for="entry in audit" :key="entry.id" class="hm-audit-row">
              <span class="hm-audit-dot" />
              <div>
                <strong>{{ entry.action }}</strong>
                <span>{{ entry.actor ?? '—' }} · {{ entry.path ?? '' }}</span>
              </div>
              <span class="hm-mono">{{ ago(entry.at) }}</span>
            </div>
          </template>
        </section>
      </div>
    </template>
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { KIND_LABEL, KIND_ORDER, ago, api, fmtBytes, kindTagType } from '../lib'

const props = defineProps({
  refreshKey: { type: Number, default: 0 },
  namespace: { type: String, default: 'default' },
  auth: { type: Object, default: null },
})
defineEmits(['open-memory', 'navigate', 'refresh'])

const loading = ref(true)
const stats = ref({})
const monitor = ref({})
const recent = ref([])
const audit = ref(null)

const maxKind = computed(() => Math.max(1, ...KIND_ORDER.map((kind) => stats.value.byKind?.[kind] ?? 0)))

async function load() {
  loading.value = true
  try {
    const [monitorData, overviewData, auditData] = await Promise.all([
      api('/api/monitor'),
      api(`/api/overview?namespace=${encodeURIComponent(props.namespace)}`),
      api('/api/audit?limit=6').catch(() => null),
    ])
    monitor.value = monitorData
    // Overview stats follow the selected namespace; monitor keeps global cache/job data.
    stats.value = overviewData.stats ?? monitorData.memory ?? {}
    recent.value = overviewData.recent ?? []
    audit.value = auditData?.items ?? null
  } catch (error) {
    ElMessage.error(error.message)
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(() => [props.refreshKey, props.namespace], load)
</script>
