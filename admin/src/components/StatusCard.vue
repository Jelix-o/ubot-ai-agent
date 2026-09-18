<script setup lang="ts">
import type { HealthStatus } from "../services/api";

defineProps<{
  title: string;
  status?: HealthStatus;
  modelService?: boolean;
}>();
</script>

<template>
  <article class="status-card" :class="{ bad: status && !status.ok }">
    <div class="status-head">
      <span class="dot" />
      <strong>{{ title }}：{{ status?.ok ? "正常" : "异常" }}</strong>
    </div>
    <p>{{ status?.detail || "暂无检测结果" }}</p>
    <dl v-if="modelService">
      <div v-if="status?.model">
        <dt>模型</dt>
        <dd>{{ status.model }}</dd>
      </div>
      <div v-if="status?.baseUrl">
        <dt>地址</dt>
        <dd>{{ status.baseUrl }}</dd>
      </div>
      <div v-if="status?.checkedAt">
        <dt>检测</dt>
        <dd>{{ status.checkedAt }} · {{ status.latencyMs ?? 0 }}ms<span v-if="status.cached"> · 缓存</span></dd>
      </div>
    </dl>
  </article>
</template>

<style scoped>
.status-card {
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  background: var(--surface);
  padding: 14px;
}

.status-card.bad {
  border-color: color-mix(in oklch, var(--danger) 40%, var(--line));
}

.status-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.status-head strong {
  font-size: 13px;
  font-weight: 650;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--ok);
  box-shadow: 0 0 0 3px var(--ok-soft);
}

.bad .dot {
  background: var(--danger);
  box-shadow: 0 0 0 3px var(--danger-soft);
}

p {
  margin: 10px 0 0;
  color: var(--muted);
  font-size: 12.5px;
  line-height: 1.5;
}

dl {
  display: grid;
  gap: 6px;
  margin: 10px 0 0;
  font-size: 12px;
}

dl div {
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr);
  gap: 8px;
}

dt {
  color: var(--subtle);
}

dd {
  margin: 0;
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--text);
  font-variant-numeric: tabular-nums;
}
</style>
