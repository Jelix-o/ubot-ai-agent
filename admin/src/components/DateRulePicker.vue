<script setup lang="ts">
import { computed, watch } from "vue";

type DateRule = "all" | "workday" | "holiday" | "custom";

const props = withDefaults(defineProps<{
  rule?: DateRule;
  weekdays?: number[];
  disabled?: boolean;
  compact?: boolean;
  showWeekdayPreview?: boolean;
  title?: string;
}>(), {
  rule: "all",
  weekdays: () => [],
  disabled: false,
  compact: false,
  showWeekdayPreview: false,
  title: "",
});

const emit = defineEmits<{
  "update:rule": [value: DateRule];
  "update:weekdays": [value: number[]];
}>();

const ruleOptions: Array<{ value: DateRule; label: string; hint: string; preview: number[] }> = [
  { value: "all", label: "全部日期", hint: "每天执行", preview: [1, 2, 3, 4, 5, 6, 0] },
  { value: "workday", label: "智能工作日", hint: "跳过法定节假日，包含调休上班日", preview: [1, 2, 3, 4, 5] },
  { value: "holiday", label: "智能非工作日", hint: "周末和法定节假日，排除调休上班日", preview: [6, 0] },
  { value: "custom", label: "自定义", hint: "手动选择星期", preview: [] },
];

const weekdayOptions = [
  { value: 1, label: "一" },
  { value: 2, label: "二" },
  { value: 3, label: "三" },
  { value: 4, label: "四" },
  { value: 5, label: "五" },
  { value: 6, label: "六" },
  { value: 0, label: "日" },
];

const activePreview = computed(() => {
  if (props.rule === "custom") return props.weekdays ?? [];
  return ruleOptions.find((option) => option.value === props.rule)?.preview ?? [];
});
const showWeekdays = computed(() => !props.compact || props.showWeekdayPreview || props.rule === "custom");

function setRule(value: DateRule): void {
  emit("update:rule", value);
  if (value !== "custom") {
    emit("update:weekdays", []);
  }
}

function toggleWeekday(value: number): void {
  const current = new Set(props.weekdays ?? []);
  if (current.has(value)) current.delete(value);
  else current.add(value);
  emit("update:weekdays", [...current].sort((left, right) => left - right));
}

watch(() => props.rule, (value) => {
  if (value !== "custom" && props.weekdays.length) {
    emit("update:weekdays", []);
  }
});
</script>

<template>
  <div class="date-rule-picker" :class="{ compact, 'with-weekday-preview': showWeekdayPreview }">
    <div v-if="title || !compact" class="rule-title">
      <strong v-if="title">{{ title }}</strong>
      <small v-if="!compact">{{ ruleOptions.find((option) => option.value === rule)?.hint }}</small>
    </div>

    <div class="rule-segment" role="group" aria-label="日期规则">
      <button
        v-for="option in ruleOptions"
        :key="option.value"
        class="rule-option"
        :class="{ active: rule === option.value }"
        type="button"
        :disabled="disabled"
        @click="setRule(option.value)"
      >
        <span>{{ option.label }}</span>
      </button>
    </div>

    <div v-if="showWeekdays" class="weekday-preview" :class="{ editable: rule === 'custom' }">
      <button
        v-for="item in weekdayOptions"
        :key="item.value"
        class="weekday-chip"
        :class="{ active: activePreview.includes(item.value) }"
        type="button"
        :disabled="disabled || rule !== 'custom'"
        @click="rule === 'custom' && toggleWeekday(item.value)"
      >
        {{ item.label }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.date-rule-picker {
  display: grid;
  gap: 10px;
}

.rule-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.rule-title strong {
  font-size: 13px;
  font-weight: 650;
  color: var(--text-strong);
}

.rule-title small {
  color: var(--muted);
  font-size: 12px;
}

.rule-segment {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 0;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--surface);
}

.rule-option {
  min-width: 0;
  min-height: 36px;
  padding: 0 8px;
  border-right: 1px solid var(--line);
  background: transparent;
  color: var(--text);
  font-size: 12.5px;
  font-weight: 650;
  line-height: 1.2;
  white-space: normal;
}

.rule-option:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
  position: relative;
  z-index: 1;
}

.rule-option:last-child {
  border-right: 0;
}

.rule-option.active {
  background: var(--accent-soft);
  color: var(--accent-strong);
  box-shadow: inset 0 0 0 1px color-mix(in oklch, var(--accent) 40%, transparent);
}

.weekday-preview {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  border-top: 1px solid var(--line);
  padding-top: 10px;
}

.weekday-chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 28px;
  height: 26px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface-soft);
  color: var(--muted);
  font-size: 12px;
  font-weight: 650;
}

.weekday-chip:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}

.weekday-chip.active {
  border-color: color-mix(in oklch, var(--accent) 45%, var(--line));
  background: var(--accent-soft);
  color: var(--accent-strong);
}

.weekday-preview:not(.editable) .weekday-chip {
  cursor: default;
  opacity: 0.86;
}

.compact {
  gap: 8px;
}

.compact .rule-segment {
  min-width: 0;
  border-radius: var(--radius-md);
  background: color-mix(in oklch, var(--surface-soft) 40%, var(--surface));
}

.compact .rule-option {
  min-height: 34px;
  padding: 0 10px;
  font-size: 12px;
  color: var(--muted);
}

.compact .rule-option.active {
  background: var(--accent-soft);
  color: var(--accent-strong);
  box-shadow: inset 0 0 0 1px color-mix(in oklch, var(--accent) 58%, transparent);
}

.compact .weekday-preview {
  padding-top: 8px;
  border-top: 0;
}

@media (max-width: 760px) {
  .rule-segment,
  .compact .rule-segment {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    min-width: 0;
  }

  .rule-option:nth-child(2) {
    border-right: 0;
  }

  .rule-option:nth-child(-n + 2) {
    border-bottom: 1px solid var(--line);
  }
}
</style>
