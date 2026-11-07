<template>
  <div ref="wrap" class="hm-starmap">
    <canvas ref="canvas" @pointerdown="onPointerDown" @pointermove="onPointerMove" @pointerup="onPointerUp" @pointercancel="onPointerUp" @pointerleave="onPointerLeave" @wheel.prevent="onWheel" />
    <div v-show="tooltip.visible" class="hm-star-tooltip" :style="{ left: `${tooltip.x}px`, top: `${tooltip.y}px` }">
      <strong>{{ tooltip.kind }}</strong>
      <span>{{ tooltip.text }}</span>
      <em>{{ tooltip.meta }}</em>
    </div>
    <div class="hm-star-hint">拖拽节点 · 滚轮缩放 · 点击查看记忆</div>
  </div>
</template>

<script setup>
import { onMounted, onUnmounted, reactive, ref, watch } from 'vue'

const props = defineProps({
  graph: { type: Object, default: () => ({ nodes: [], edges: [] }) },
  labels: { type: Boolean, default: true },
})
const emit = defineEmits(['select'])

const wrap = ref(null)
const canvas = ref(null)
const tooltip = reactive({ visible: false, x: 0, y: 0, kind: '', text: '', meta: '' })

let ctx = null
let nodes = []
let edges = []
let width = 1
let height = 1
let dpr = 1
let transform = { x: 0, y: 0, k: 1 }
let raf = 0
let ticks = 0
let maxTicks = 200
let dirty = true
let selected = null
let hovered = null
let dragging = null
let panning = null
let observer = null

const KIND_COLOR = { persona: '#f5c86b', semantic: '#4de3c1', episodic: '#8aa8ff', buffer: '#8494b8' }

function colorOf(kind) {
  return KIND_COLOR[kind] ?? KIND_COLOR.buffer
}

function rebuild() {
  const graph = props.graph ?? { nodes: [], edges: [] }
  nodes = (graph.nodes ?? []).map((node, index) => {
    const angle = index * 2.399963
    const radius = 40 + Math.sqrt(index + 1) * 18
    return {
      ...node,
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      vx: 0,
      vy: 0,
      r: Math.max(3.5, Math.min(16, (node.size ?? 8) / 1.45)),
    }
  })
  const byId = new Map(nodes.map((node) => [node.id, node]))
  edges = (graph.edges ?? [])
    .map((edge) => ({ ...edge, a: byId.get(edge.source), b: byId.get(edge.target) }))
    .filter((edge) => edge.a && edge.b)
  maxTicks = nodes.length > 250 ? 70 : nodes.length > 120 ? 130 : 200
  ticks = 0
  selected = null
  hovered = null
  transform = { x: 0, y: 0, k: 1 }
  resize()
  dirty = true
}

function resize() {
  if (!canvas.value || !wrap.value) return
  const rect = wrap.value.getBoundingClientRect()
  width = Math.max(1, rect.width)
  height = Math.max(1, rect.height)
  dpr = Math.min(2, window.devicePixelRatio || 1)
  canvas.value.width = Math.floor(width * dpr)
  canvas.value.height = Math.floor(height * dpr)
  canvas.value.style.width = `${width}px`
  canvas.value.style.height = `${height}px`
  ctx = canvas.value.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  if (!transform.x && !transform.y) {
    transform.x = width / 2
    transform.y = height / 2
  }
  dirty = true
}

function worldToScreen(x, y) {
  return { x: x * transform.k + transform.x, y: y * transform.k + transform.y }
}

function screenToWorld(x, y) {
  return { x: (x - transform.x) / transform.k, y: (y - transform.y) / transform.k }
}

function step() {
  const count = nodes.length
  for (let i = 0; i < count; i += 1) {
    const a = nodes[i]
    for (let j = i + 1; j < count; j += 1) {
      const b = nodes[j]
      let dx = b.x - a.x
      let dy = b.y - a.y
      let distance = Math.hypot(dx, dy)
      if (distance < 0.01) {
        dx = Math.random() - 0.5
        dy = Math.random() - 0.5
        distance = 0.1
      }
      const force = 900 / (distance * distance)
      const fx = (dx / distance) * force
      const fy = (dy / distance) * force
      a.vx -= fx
      a.vy -= fy
      b.vx += fx
      b.vy += fy
    }
    a.vx -= a.x * 0.0015
    a.vy -= a.y * 0.0015
  }
  for (const edge of edges) {
    const dx = edge.b.x - edge.a.x
    const dy = edge.b.y - edge.a.y
    const distance = Math.hypot(dx, dy) || 0.1
    const rest = edge.type === 'conflict' ? 70 : 95
    const force = (distance - rest) * (edge.type === 'similar' ? 0.006 : 0.012) * (edge.weight || 1)
    const fx = (dx / distance) * force
    const fy = (dy / distance) * force
    edge.a.vx += fx
    edge.a.vy += fy
    edge.b.vx -= fx
    edge.b.vy -= fy
  }
  for (const node of nodes) {
    node.vx *= 0.86
    node.vy *= 0.86
    node.x += Math.max(-12, Math.min(12, node.vx))
    node.y += Math.max(-12, Math.min(12, node.vy))
  }
}

function draw() {
  if (!ctx) return
  ctx.clearRect(0, 0, width, height)
  ctx.save()
  ctx.strokeStyle = 'rgba(124,157,255,0.06)'
  ctx.lineWidth = 1
  for (let radius = 120; radius < 1000; radius += 120) {
    ctx.beginPath()
    ctx.arc(transform.x, transform.y, radius * transform.k, 0, Math.PI * 2)
    ctx.stroke()
  }
  ctx.restore()

  for (const edge of edges) {
    const a = worldToScreen(edge.a.x, edge.a.y)
    const b = worldToScreen(edge.b.x, edge.b.y)
    ctx.save()
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    if (edge.type === 'conflict') {
      ctx.strokeStyle = 'rgba(255,107,138,.66)'
      ctx.setLineDash([5, 5])
      ctx.lineWidth = 1.4
    } else if (edge.type === 'consolidation') {
      ctx.strokeStyle = 'rgba(77,227,193,.42)'
      ctx.lineWidth = 1.2
    } else if (edge.type === 'supersede') {
      ctx.strokeStyle = 'rgba(245,200,107,.26)'
      ctx.setLineDash([2, 4])
      ctx.lineWidth = 1
    } else if (edge.type === 'tag') {
      ctx.strokeStyle = 'rgba(142,163,200,.13)'
      ctx.lineWidth = 0.8
    } else {
      ctx.strokeStyle = 'rgba(167,139,250,.2)'
      ctx.lineWidth = 0.8
    }
    ctx.stroke()
    ctx.restore()
  }

  for (const node of nodes) {
    const point = worldToScreen(node.x, node.y)
    const radius = Math.max(2.5, node.r * transform.k)
    if (point.x < -80 || point.y < -80 || point.x > width + 80 || point.y > height + 80) continue
    const color = colorOf(node.kind)
    const isActive = node.status === 'active'
    ctx.save()
    ctx.globalAlpha = isActive ? 1 : 0.42
    ctx.shadowColor = color
    ctx.shadowBlur = node.kind === 'persona' || node.kind === 'semantic' ? 18 : 8
    ctx.beginPath()
    ctx.arc(point.x, point.y, radius, 0, Math.PI * 2)
    ctx.fillStyle = color
    ctx.fill()
    ctx.shadowBlur = 0
    if (node.status === 'conflict' || node.id === selected) {
      ctx.beginPath()
      ctx.arc(point.x, point.y, radius + 3.5, 0, Math.PI * 2)
      ctx.strokeStyle = node.status === 'conflict' ? '#ff6b8a' : '#ffffff'
      ctx.lineWidth = 1.6
      ctx.stroke()
    }
    if (node.id === hovered) {
      ctx.beginPath()
      ctx.arc(point.x, point.y, radius + 6, 0, Math.PI * 2)
      ctx.strokeStyle = 'rgba(255,255,255,.35)'
      ctx.lineWidth = 1
      ctx.stroke()
    }
    ctx.restore()
    if (props.labels && (node.id === selected || node.id === hovered || transform.k > 0.9 || nodes.length < 60)) {
      const text = (node.label ?? '').length > 26 ? `${(node.label ?? '').slice(0, 25)}…` : node.label
      ctx.save()
      ctx.font = '10px ui-monospace, monospace'
      ctx.fillStyle = node.id === selected ? '#ffffff' : 'rgba(214,229,255,.72)'
      ctx.fillText(text ?? '', point.x + radius + 5, point.y + 3)
      ctx.restore()
    }
  }
}

function frame() {
  if (ticks < maxTicks) {
    step()
    ticks += 1
    dirty = true
  }
  if (dirty) {
    draw()
    dirty = false
  }
  raf = requestAnimationFrame(frame)
}

function localPoint(event) {
  const rect = canvas.value.getBoundingClientRect()
  return { x: event.clientX - rect.left, y: event.clientY - rect.top }
}

function hitTest(x, y) {
  const world = screenToWorld(x, y)
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index]
    if (Math.hypot(node.x - world.x, node.y - world.y) <= Math.max(5, node.r + 4)) return node
  }
  return null
}

function onPointerDown(event) {
  const point = localPoint(event)
  const node = hitTest(point.x, point.y)
  canvas.value.setPointerCapture?.(event.pointerId)
  if (node) {
    dragging = { node, start: screenToWorld(point.x, point.y), moved: false }
    selected = node.id
    dirty = true
  } else {
    panning = { x: point.x, y: point.y, tx: transform.x, ty: transform.y }
    canvas.value.classList.add('dragging')
  }
  event.preventDefault()
}

function onPointerMove(event) {
  if (!canvas.value) return
  const point = localPoint(event)
  if (dragging) {
    const world = screenToWorld(point.x, point.y)
    if (Math.hypot(world.x - dragging.start.x, world.y - dragging.start.y) > 2) dragging.moved = true
    dragging.node.x = world.x
    dragging.node.y = world.y
    ticks = Math.min(ticks, Math.max(0, maxTicks - 30))
    dirty = true
    return
  }
  if (panning) {
    transform.x = panning.tx + (point.x - panning.x)
    transform.y = panning.ty + (point.y - panning.y)
    dirty = true
    return
  }
  const node = hitTest(point.x, point.y)
  hovered = node?.id ?? null
  dirty = true
  canvas.value.style.cursor = node ? 'pointer' : 'grab'
  if (node) {
    tooltip.visible = true
    tooltip.x = point.x + 14
    tooltip.y = point.y + 14
    tooltip.kind = node.kindLabel
    tooltip.text = node.label
    tooltip.meta = `重要性 ${node.importance} · ${node.statusLabel}`
  } else {
    tooltip.visible = false
  }
}

function onPointerUp() {
  if (dragging && !dragging.moved) emit('select', dragging.node.id)
  dragging = null
  panning = null
  canvas.value?.classList.remove('dragging')
}

function onPointerLeave() {
  tooltip.visible = false
  hovered = null
  dirty = true
}

function onWheel(event) {
  const point = localPoint(event)
  const before = screenToWorld(point.x, point.y)
  const factor = event.deltaY < 0 ? 1.12 : 0.9
  transform.k = Math.max(0.25, Math.min(4, transform.k * factor))
  const after = screenToWorld(point.x, point.y)
  transform.x += (after.x - before.x) * transform.k
  transform.y += (after.y - before.y) * transform.k
  ticks = Math.min(ticks, Math.max(0, maxTicks - 30))
  dirty = true
}

function reset() {
  transform = { x: width / 2, y: height / 2, k: 1 }
  for (const [index, node] of nodes.entries()) {
    const angle = index * 2.399963
    const radius = 40 + Math.sqrt(index + 1) * 18
    node.x = Math.cos(angle) * radius
    node.y = Math.sin(angle) * radius
    node.vx = 0
    node.vy = 0
  }
  ticks = 0
  dirty = true
}

defineExpose({ reset })

watch(() => props.graph, rebuild, { deep: false })
watch(() => props.labels, () => { dirty = true })

onMounted(() => {
  observer = new ResizeObserver(resize)
  observer.observe(wrap.value)
  rebuild()
  raf = requestAnimationFrame(frame)
})

onUnmounted(() => {
  cancelAnimationFrame(raf)
  observer?.disconnect()
})
</script>
