<script setup lang="ts">
import { computed, onMounted, onUnmounted, shallowRef } from "vue";

export interface SelectOption {
  value: string;
  label: string;
  hint?: string;
}

const props = withDefaults(defineProps<{
  modelValue: string[];
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  allowCustom?: boolean;
}>(), {
  placeholder: "搜索并添加",
  disabled: false,
  allowCustom: true,
});

const emit = defineEmits<{
  "update:modelValue": [value: string[]];
}>();

const root = shallowRef<HTMLElement>();
const open = shallowRef(false);
const query = shallowRef("");

const selectedSet = computed(() => new Set(props.modelValue));
const selectedOptions = computed(() => props.modelValue.map((value) => ({
  value,
  label: props.options.find((option) => option.value === value)?.label || value,
})));
const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  return props.options
    .filter((option) => !selectedSet.value.has(option.value))
    .filter((option) => !q || `${option.label} ${option.value} ${option.hint || ""}`.toLowerCase().includes(q))
    .slice(0, 80);
});
const customValue = computed(() => query.value.trim());
const canAddCustom = computed(() => props.allowCustom && customValue.value && !selectedSet.value.has(customValue.value));

function update(values: string[]): void {
  const next = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  emit("update:modelValue", next);
}

function add(value: string): void {
  update([...props.modelValue, value]);
  query.value = "";
  open.value = true;
}

function remove(value: string): void {
  update(props.modelValue.filter((item) => item !== value));
}

function handleInput(event: Event): void {
  query.value = (event.target as HTMLInputElement).value;
  open.value = true;
}

function handleEnter(): void {
  const first = filtered.value[0];
  if (first) {
    add(first.value);
    return;
  }
  if (canAddCustom.value) {
    add(customValue.value);
  }
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
  <div ref="root" class="multi-tag-select">
    <div class="tag-input-shell" :class="{ disabled }">
      <span v-for="option in selectedOptions" :key="option.value" class="tag selected-tag">
        {{ option.label }}
        <button v-if="!disabled" type="button" @click="remove(option.value)">×</button>
      </span>
      <input
        class="tag-search-input"
        :disabled="disabled"
        :placeholder="modelValue.length ? '继续搜索添加' : placeholder"
        :value="query"
        @focus="open = true"
        @input="handleInput"
        @keydown.enter.prevent="handleEnter"
        @keydown.escape.prevent="open = false"
      />
    </div>
    <div v-if="open && !disabled" class="tag-menu">
      <button
        v-for="option in filtered"
        :key="option.value"
        class="tag-option"
        type="button"
        @click="add(option.value)"
      >
        <span>{{ option.label }}</span>
        <small v-if="option.hint">{{ option.hint }}</small>
      </button>
      <button v-if="canAddCustom" class="tag-option custom-option" type="button" @click="add(customValue)">
        添加：{{ customValue }}
      </button>
      <div v-if="!filtered.length && !canAddCustom" class="tag-empty">没有可添加项</div>
    </div>
  </div>
</template>

<style scoped>
.multi-tag-select {
  position: relative;
}

.tag-input-shell {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-height: 36px;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--surface);
  padding: 4px 6px;
}

.tag-input-shell:focus-within {
  border-color: var(--accent);
  box-shadow: var(--focus-ring);
}

.tag-input-shell.disabled {
  opacity: 0.62;
}

.selected-tag {
  max-width: 100%;
  gap: 5px;
  min-height: 24px;
  border-radius: var(--radius-sm);
  padding: 0 6px;
  font-size: 12px;
  font-weight: 650;
}

.selected-tag button {
  width: 16px;
  height: 16px;
  border-radius: 999px;
  background: color-mix(in oklch, var(--accent-strong) 14%, transparent);
  color: var(--accent-strong);
  font-size: 12px;
  line-height: 16px;
}

.selected-tag button:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}

.tag-search-input {
  flex: 1;
  min-width: 140px;
  min-height: 26px;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--text);
  font-size: 13px;
  padding: 2px 4px;
}

.tag-menu {
  position: absolute;
  z-index: 35;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  display: grid;
  gap: 2px;
  max-height: 280px;
  overflow: auto;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--surface);
  box-shadow: var(--shadow-md);
  padding: 4px;
}

.tag-option {
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

.tag-option small {
  font-size: 11.5px;
}

.tag-option:hover,
.tag-option:focus-visible {
  background: var(--accent-soft);
  color: var(--accent-strong);
}

.tag-option:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}

.tag-option small,
.tag-empty {
  color: var(--muted);
}

.custom-option {
  color: var(--accent-strong);
  font-weight: 650;
}

.tag-empty {
  padding: 10px;
  text-align: center;
  font-size: 12.5px;
}
</style>
