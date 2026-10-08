import { computed, shallowRef, watch } from "vue";
import { useRouter } from "vue-router";
import { api } from "../services/api";
import { useAppStore } from "../stores/app";

export type ContentBulkResource = "memories" | "knowledge" | "html-previews" | "memes";
export type ContentBulkAction = "enable" | "disable" | "delete" | "tags";
export interface ContentSelection { id: string; groupId?: string; title?: string; name?: string; protected?: boolean; status?: string }

export function useContentBulk(resource: ContentBulkResource) {
  const app = useAppStore();
  const router = useRouter();
  const selectedIds = shallowRef(new Set<string>());
  const selectedItems = shallowRef(new Map<string, { groupId: string; label: string }>());
  const preview = shallowRef<any>(null);
  const bulkBusy = shallowRef(false);
  const selectedGroupCount = computed(() => new Set([...selectedItems.value.values()].map((item) => item.groupId).filter(Boolean)).size);

  function eligible(item: ContentSelection): boolean {
    return !item.protected && !["deleted", "pending", "processing"].includes(item.status ?? "");
  }
  function clearSelection(): void { selectedIds.value = new Set(); selectedItems.value = new Map(); }
  function toggleSelection(item: ContentSelection): void {
    if (app.readonly || !eligible(item)) return;
    const ids = new Set(selectedIds.value);
    const records = new Map(selectedItems.value);
    if (ids.has(item.id)) { ids.delete(item.id); records.delete(item.id); }
    else { ids.add(item.id); records.set(item.id, { groupId: item.groupId ?? (resource === "memes" ? "" : app.groupId), label: item.title ?? item.name ?? item.id }); }
    selectedIds.value = ids;
    selectedItems.value = records;
  }
  function toggleSelectionPage(items: ContentSelection[]): void {
    const selectable = items.filter(eligible);
    const remove = selectable.length > 0 && selectable.every((item) => selectedIds.value.has(item.id));
    for (const item of selectable) if (selectedIds.value.has(item.id) === remove) toggleSelection(item);
  }
  function removeSelection(id: string): void {
    const ids = new Set(selectedIds.value); ids.delete(id); selectedIds.value = ids;
    const records = new Map(selectedItems.value); records.delete(id); selectedItems.value = records;
  }
  async function prepareBulk(action: ContentBulkAction, patch?: Record<string, unknown>): Promise<void> {
    if (app.readonly || !selectedIds.value.size || bulkBusy.value) return;
    bulkBusy.value = true;
    try {
      preview.value = await api("/api/bulk-operations/preview", { method: "POST", body: JSON.stringify({ resource, action,
        groupId: app.role === "super_admin" ? undefined : app.groupId, ids: [...selectedIds.value], patch }) });
    } catch (error) { app.showToast((error as Error).message, "error"); }
    finally { bulkBusy.value = false; }
  }
  async function executeBulk(): Promise<void> {
    if (!preview.value || bulkBusy.value) return;
    bulkBusy.value = true;
    try {
      const result = await api<{ taskId: string }>("/api/bulk-operations/apply", { method: "POST", body: JSON.stringify({ previewId: preview.value.id }) });
      preview.value = null;
      clearSelection();
      app.showToast("批量任务已提交，可在任务中心查看逐项结果");
      await router.push({ path: "/tasks", query: { task: result.taskId } });
    } catch (error) { app.showToast((error as Error).message, "error"); }
    finally { bulkBusy.value = false; }
  }
  watch(() => app.groupId, () => { preview.value = null; if (app.role !== "super_admin") clearSelection(); });
  return { selectedIds, selectedItems, selectedGroupCount, preview, bulkBusy, eligible, clearSelection, toggleSelection, toggleSelectionPage, removeSelection, prepareBulk, executeBulk };
}
