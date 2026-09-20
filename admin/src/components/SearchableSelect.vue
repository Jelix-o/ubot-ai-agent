<script setup lang="ts">
import { computed, onMounted, onUnmounted, shallowRef } from "vue";

export interface SelectOption {
  value: string;
  label: string;
  hint?: string;
}

const props = withDefaults(defineProps<{
  modelValue: string;
  options: SelectOption[];
  placeholder?: string;
  emptyLabel?: string;
  disabled?: boolean;
}>(), {
  placeholder: "搜索选择",
  emptyLabel: "全部",
  disabled: false,
});

const emit = defineEmits<{
  "update:modelValue": [value: string];
  change: [value: string];
}>();

const root = shallowRef<HTMLElement>();
const open = shallowRef(false);
const query = shallowRef("");

const selected = computed(() => props.options.find((option) => option.value === props.modelValue));
const displayText = computed(() => open.value ? query.value : selected.value?.label || "");
const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return props.options.slice(0, 80);
  return props.options
    .filter((option) => `${option.label} ${option.value} ${option.hint || ""}`.toLowerCase().includes(q))
    .slice(0, 80);
});

function select(value: string): void {
  emit("update:modelValue", value);
  emit("change", value);
  query.value = "";
  open.value = false;
}

function handleInput(event: Event): void {
  query.value = (event.target as HTMLInputElement).value;
  open.value = true;
}

function handleFocus(): void {
  if (props.disabled) return;
  query.value = "";
  open.value = true;
}

function onDocumentPointerDown(event: PointerEvent): void {
  if (!root.value?.contains(event.target as Node)) {
    open.value = false;
    query.value = "";
  }
}

onMounted(() => {
  document.addEventListener("pointerdown", onDocumentPointerDown);
});

onUnmounted(() => {
  document.removeEventListener("pointerdown", onDocumentPointerDown);
});
</script>

<template>
  <div ref="root" class="searchable-select">
    <input
      class="input searchable-input"
      :disabled="disabled"
      :placeholder="selected?.label || placeholder"
      :value="displayText"
      @focus="handleFocus"
      @input="handleInput"
      @keydown.escape.prevent="open = false"
    />
    <button v-if="modelValue && !disabled" class="select-clear" type="button" @click="select('')">清空</button>
    <div v-if="open && !disabled" class="select-menu">
      <button class="select-option muted-option" type="button" @click="select('')">{{ emptyLabel }}</button>
      <button
        v-for="option in filtered"
        :key="option.value"
        class="select-option"
        type="button"
        :class="{ active: option.value === modelValue }"
        @click="select(option.value)"
      >
        <span>{{ option.label }}</span>
        <small v-if="option.hint">{{ option.hint }}</small>
      </button>
      <div v-if="!filtered.length" class="select-empty">没有匹配项</div>
    </div>
  </div>
</template>

<style scoped>
.searchable-select {
  position: relative;
}

.searchable-input {
  height: 36px;
  min-height: 36px;
  padding-right: 56px;
  border: 1px solid var(--line);
}

.searchable-input:focus {
  border-color: var(--accent);
  box-shadow: var(--focus-ring);
}

.select-clear {
  position: absolute;
  top: 5px;
  right: 6px;
  min-height: 26px;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: var(--surface-soft);
  color: var(--muted);
  padding: 0 8px;
  font-size: 11.5px;
  font-weight: 650;
}

.select-clear:hover {
  color: var(--text);
  border-color: var(--line-strong);
}

.select-clear:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}

.select-menu {
  position: absolute;
  z-index: 35;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  display: grid;
  gap: 2px;
  max-height: 220px;
  overflow: auto;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--surface);
  box-shadow: var(--shadow-md);
  padding: 4px;
}

.select-option {
  display: grid;
  gap: 2px;
  min-height: 34px;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text);
  padding: 6px 8px;
  text-align: left;
  font-size: 13px;
}

.select-option span,
.select-option small {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.select-option small {
  font-size: 11.5px;
}

.select-option:hover,
.select-option.active {
  background: var(--accent-soft);
  color: var(--accent-strong);
}

.select-option:focus-visible {
  outline: none;
  background: var(--accent-soft);
  color: var(--accent-strong);
  box-shadow: var(--focus-ring);
}

.select-option small,
.muted-option,
.select-empty {
  color: var(--muted);
}

.select-option.active small {
  color: var(--accent-strong);
}

.select-empty {
  padding: 10px;
  text-align: center;
  font-size: 12.5px;
}
</style>
