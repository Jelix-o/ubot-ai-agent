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
  gap: 7px;
  min-height: 42px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface);
  padding: 7px;
}

.tag-input-shell:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in oklch, var(--accent-soft) 70%, transparent);
}

.tag-input-shell.disabled {
  opacity: 0.62;
}

.selected-tag {
  max-width: 100%;
  gap: 6px;
}

.selected-tag button {
  width: 18px;
  height: 18px;
  border-radius: 999px;
  background: color-mix(in oklch, var(--accent-strong) 14%, transparent);
  color: var(--accent-strong);
  line-height: 18px;
}

.tag-search-input {
  flex: 1;
  min-width: 160px;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--text);
  padding: 3px 4px;
}

.tag-menu {
  position: absolute;
  z-index: 35;
  top: calc(100% + 6px);
  left: 0;
  right: 0;
  display: grid;
  gap: 4px;
  max-height: 280px;
  overflow: auto;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--surface);
  box-shadow: var(--shadow-md);
  padding: 8px;
}

.tag-option {
  display: grid;
  gap: 2px;
  min-height: 38px;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text);
  padding: 7px 9px;
  text-align: left;
}

.tag-option:hover {
  background: var(--accent-soft);
  color: var(--accent-strong);
}

.tag-option small,
.tag-empty {
  color: var(--muted);
}

.custom-option {
  color: var(--accent-strong);
  font-weight: 800;
}

.tag-empty {
  padding: 10px;
  text-align: center;
}
</style>
