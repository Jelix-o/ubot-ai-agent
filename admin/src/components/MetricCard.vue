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
      <AppIcon :name="icon" :size="28" />
    </div>
    <div>
      <span>{{ title }}</span>
      <strong>{{ value }}</strong>
      <em v-if="delta">{{ delta }}</em>
    </div>
  </article>
</template>

<style scoped>
.metric-card {
  position: relative;
  display: flex;
  align-items: center;
  gap: 16px;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--surface);
  box-shadow: var(--shadow-sm);
  padding: 18px 20px;
  transition: all 0.15s ease;
}

.metric-card:hover {
  box-shadow: var(--shadow-md);
  border-color: var(--line-strong);
  transform: translateY(-1px);
}

.metric-icon {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--metric-color) 12%, transparent);
  color: var(--metric-color);
  flex-shrink: 0;
}

.metric-card span {
  display: block;
  font-size: 13px;
  font-weight: 500;
  color: var(--muted);
}

.metric-card strong {
  display: block;
  margin: 4px 0 0;
  font-size: 26px;
  font-weight: 800;
  letter-spacing: -0.02em;
  color: var(--text);
  line-height: 1.1;
}

.metric-card em {
  display: block;
  font-size: 11px;
  color: var(--muted);
  font-style: normal;
  margin-top: 2px;
}

[data-tone="green"] {
  --metric-color: var(--accent);
}

[data-tone="orange"] {
  --metric-color: var(--orange);
}

[data-tone="blue"] {
  --metric-color: var(--blue);
}

[data-tone="purple"] {
  --metric-color: var(--purple);
}
</style>
