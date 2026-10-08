import { onUnmounted, type Ref } from "vue";
import { onBeforeRouteLeave } from "vue-router";
import { confirmAction } from "./useConfirm";
const dirtyForms = new Set<Ref<boolean>>();
export async function allowContextChange(): Promise<boolean> {
  if (![...dirtyForms].some(form => form.value)) return true;
  return confirmAction({ title: "存在未保存的更改", message: "离开后这些更改将丢失。是否放弃更改？", confirmText: "放弃更改", danger: true });
}
export function useUnsavedChanges(dirty: Ref<boolean>): void {
  dirtyForms.add(dirty);
  onBeforeRouteLeave(() => dirty.value ? allowContextChange() : true);
  const beforeUnload = (event: BeforeUnloadEvent) => { if (dirty.value) { event.preventDefault(); event.returnValue = ""; } };
  window.addEventListener("beforeunload", beforeUnload);
  onUnmounted(() => { dirtyForms.delete(dirty); window.removeEventListener("beforeunload", beforeUnload); });
}
