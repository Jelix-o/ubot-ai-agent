<script setup lang="ts">
defineProps<{ count: number; groupCount?: number; busy?: boolean; disabled?: boolean; deleteOnly?: boolean; tags?: boolean; allSelected?: boolean; hasItems?: boolean }>();
defineEmits<{ selectPage: []; clear: []; action: [action: "enable" | "disable" | "delete" | "tags"] }>();
</script>
<template>
  <div class="content-bulk-bar" :class="{ selected: count > 0 }" role="region" aria-label="批量操作">
    <label class="page-selection"><input type="checkbox" :checked="allSelected" :disabled="disabled || busy || !hasItems" aria-label="选择当前页" @change="$emit('selectPage')" /> 当前页</label>
    <span class="selection-count">已选择 <strong>{{ count }}</strong> 项<span v-if="groupCount && groupCount > 1"> · {{ groupCount }} 个群</span></span>
    <template v-if="!deleteOnly">
      <button class="ghost-btn" type="button" :disabled="disabled || busy || !count" @click="$emit('action', 'enable')">批量启用</button>
      <button class="ghost-btn" type="button" :disabled="disabled || busy || !count" @click="$emit('action', 'disable')">批量停用</button>
      <button v-if="tags" class="ghost-btn" type="button" :disabled="disabled || busy || !count" @click="$emit('action', 'tags')">更新标签</button>
    </template>
    <button v-if="!tags" class="ghost-btn danger" type="button" :disabled="disabled || busy || !count" @click="$emit('action', 'delete')">批量删除</button>
    <button v-if="count" class="ghost-btn clear-selection" type="button" :disabled="busy" @click="$emit('clear')">清空选择</button>
    <span v-if="busy" class="muted" role="status">准备预览…</span>
  </div>
</template>
<style scoped>
.content-bulk-bar { display:flex; flex-wrap:wrap; align-items:center; gap:10px; min-height:56px; padding:10px 14px; margin:16px 0; border:1px solid var(--line); border-radius:var(--radius-sm); background:var(--surface-soft); font-size:13px; }
.content-bulk-bar.selected { border-color:color-mix(in srgb,var(--accent) 24%,var(--line)); background:var(--accent-soft); }
.page-selection { display:flex; align-items:center; gap:7px; white-space:nowrap; }
.selection-count { color:var(--muted); margin-right:8px; }.selection-count strong { color:var(--text-strong); font-variant-numeric:tabular-nums; }
.clear-selection { margin-left:auto; }.danger { color:var(--danger); }
@media(max-width:600px) { .content-bulk-bar { gap:8px; padding:10px; }.content-bulk-bar .ghost-btn { padding:0 10px; }.clear-selection { margin-left:0; } }
</style>
