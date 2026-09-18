<script setup lang="ts">
import AppIcon from "./AppIcon.vue";

defineProps<{
  title: string;
  value: string | number;
  delta?: string;
  tone?: "green" | "orange" | "blue" | "purple";
  icon: string;
}>();
</script>

<template>
  <article class="metric-card" :data-tone="tone || 'green'">
    <div class="metric-icon">
      <AppIcon :name="icon" :size="18" />
    </div>
    <div class="metric-body">
      <span>{{ title }}</span>
      <strong>{{ value }}</strong>
      <em v-if="delta">{{ delta }}</em>
    </div>
  </article>
</template>

<style scoped>
.metric-card {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  background: var(--surface);
  padding: 14px 16px;
}

.metric-icon {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: var(--radius-md);
  background: var(--surface-soft);
  color: var(--metric-color, var(--accent));
  flex-shrink: 0;
  border: 1px solid var(--line);
}

.metric-body {
  min-width: 0;
}

.metric-card span {
  display: block;
  font-size: 12px;
  font-weight: 500;
  color: var(--muted);
}

.metric-card strong {
  display: block;
  margin: 4px 0 0;
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.03em;
  color: var(--text-strong);
  line-height: 1.15;
  font-variant-numeric: tabular-nums;
}

.metric-card em {
  display: block;
  font-size: 11.5px;
  color: var(--muted);
  font-style: normal;
  margin-top: 2px;
}

[data-tone="green"] { --metric-color: var(--accent); }
[data-tone="orange"] { --metric-color: var(--warning); }
[data-tone="blue"] { --metric-color: var(--ok); }
[data-tone="purple"] { --metric-color: var(--purple); }
</style>
