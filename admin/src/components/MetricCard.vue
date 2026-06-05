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
  gap: 20px;
  min-height: 150px;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  background: var(--surface);
  box-shadow: var(--shadow-sm);
  padding: 28px 26px;
}

.metric-icon {
  display: grid;
  place-items: center;
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: color-mix(in oklch, var(--metric-color) 16%, transparent);
  color: var(--metric-color);
}

.metric-card span,
.metric-card em {
  display: block;
  color: var(--muted);
  font-style: normal;
}

.metric-card strong {
  display: block;
  margin: 8px 0 0;
  font-size: 36px;
  line-height: 1;
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
