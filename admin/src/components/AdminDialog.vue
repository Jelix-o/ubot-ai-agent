<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref } from "vue";
const props = withDefaults(defineProps<{ title: string; drawer?: boolean; description?: string; busy?: boolean }>(), { drawer: false });
const emit = defineEmits<{ close: [] }>();
const panel = ref<HTMLElement>(); const previous = document.activeElement as HTMLElement | null;
function close() { if (!props.busy) emit("close"); }
function keydown(event: KeyboardEvent) {
  if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
  if (event.key !== "Tab") return;
  const nodes = [...(panel.value?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]') || [])].filter(el => el.getClientRects().length);
  const first = nodes[0], last = nodes.at(-1);
  if (!first) { event.preventDefault(); panel.value?.focus(); }
  else if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.value)) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}
let oldOverflow = "";
onMounted(async () => { oldOverflow = document.body.style.overflow; document.body.style.overflow = "hidden"; await nextTick(); panel.value?.focus(); });
onUnmounted(() => { document.body.style.overflow = oldOverflow; if (previous?.isConnected) previous.focus(); });
</script>
<template>
  <Teleport to="body"><div class="admin-overlay" :class="{ 'as-drawer': drawer }" @click.self="close" @keydown="keydown">
    <section ref="panel" class="admin-dialog" :class="{ 'admin-drawer': drawer }" role="dialog" aria-modal="true" :aria-label="title" tabindex="-1">
      <header class="admin-dialog-head"><div><h2>{{ title }}</h2><p v-if="description" class="muted">{{ description }}</p></div><button type="button" class="icon-btn" aria-label="关闭详情" :disabled="busy" @click="close">×</button></header>
      <div class="admin-dialog-body"><slot /></div><footer v-if="$slots.footer" class="admin-dialog-footer"><slot name="footer" /></footer>
    </section>
  </div></Teleport>
</template>
