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
  border: 1px solid color-mix(in oklch, var(--ok) 50%, var(--line));
  border-radius: var(--radius-md);
  background: var(--surface-raised);
  padding: 18px;
}

.status-card.bad {
  border-color: color-mix(in oklch, var(--danger) 55%, var(--line));
}

.status-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--ok);
  box-shadow: 0 0 0 5px color-mix(in oklch, var(--ok) 18%, transparent);
}

.bad .dot {
  background: var(--danger);
  box-shadow: 0 0 0 5px color-mix(in oklch, var(--danger) 18%, transparent);
}

p {
  margin: 14px 0 0;
  color: var(--muted);
  line-height: 1.65;
}

dl {
  display: grid;
  gap: 8px;
  margin: 14px 0 0;
}

dl div {
  display: grid;
  grid-template-columns: 52px minmax(0, 1fr);
  gap: 10px;
}

dt {
  color: var(--muted);
}

dd {
  margin: 0;
  min-width: 0;
  overflow-wrap: anywhere;
}
</style>
