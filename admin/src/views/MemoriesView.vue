<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, shallowRef, watch } from "vue";
import { useRoute } from "vue-router";

import AdminDialog from "../components/AdminDialog.vue";
import BulkPreviewDialog from "../components/BulkPreviewDialog.vue";
import ContentBulkBar from "../components/ContentBulkBar.vue";
import { useContentBulk } from "../composables/useContentBulk";
import { contentPage, contentPageSize, useContentUrlState } from "../composables/useContentUrlState";
import { confirmAction } from "../composables/useConfirm";
import { useUnsavedChanges } from "../composables/useUnsavedChanges";
import SearchableSelect from "../components/SearchableSelect.vue";
import { useRefreshEvents } from "../composables/useRefreshEvents";
import { api, queryString, type AdminTaskRecord, type MemberProfile, type Memory, type MemoryType, type Pagination } from "../services/api";
import { useAppStore } from "../stores/app";
import { evidenceSpeakers, evidenceSummary, formatDateTime } from "../utils/format";

const route = useRoute();
const app = useAppStore();
const items = shallowRef<Memory[]>([]);
const memberOptions = shallowRef<MemberProfile[]>([]);
const pagination = reactive<Pagination>({ page: 1, pageSize: 20, total: 0, totalPages: 1 });
const filters = reactive({ q: "", userId: "", type: "" as MemoryType | "", enabled: "" });
const loading = shallowRef(false);
const { selectedIds, selectedGroupCount, preview: bulkPreview, bulkBusy, clearSelection, toggleSelection, toggleSelectionPage, removeSelection, prepareBulk, executeBulk } = useContentBulk("memories");
const loadError = shallowRef("");
const createVisible = shallowRef(false);
const editBaseline = shallowRef("");
let loadSerial = 0;
const editingId = shallowRef("");
const evidenceItem = shallowRef<Memory>();
const evidenceLoading = shallowRef(false);
const busyIds = shallowRef<Set<string>>(new Set());
const dedupLoading = shallowRef(false);
const dedupTask = shallowRef<AdminTaskRecord | null>(null);
const dedupTaskMessage = shallowRef("");
const dedupDecisions = shallowRef<DedupDecision[]>([]);
const dedupMode = shallowRef<DedupMode>("fast");
const dedupPollFailures = shallowRef(0);
const creating = shallowRef(false);
const readonly = computed(() => app.readonly);
let dedupPollTimer: ReturnType<typeof setTimeout> | undefined;

type DedupMode = "fast" | "deep";

interface DedupDecision {
  action: string;
  targetId?: string;
  duplicateId: string;
  reason: string;
  similarity: number;
}

interface DedupPreviewResult {
  groupId: string;
  subjectUserId: string;
  mode?: DedupMode;
  decisionCount: number;
  decisions: DedupDecision[];
  semanticStats?: Record<string, number>;
}

interface DedupPreviewResponse extends Partial<DedupPreviewResult> {
  queued?: boolean;
  taskId?: string;
  task?: AdminTaskRecord;
  mode?: DedupMode;
}
const editForm = reactive({
  title: "",
  content: "",
  type: "member_profile" as MemoryType,
  subjectUserId: "",
  confidence: 0.8,
  source: "admin",
  enabled: true,
});
const createForm = reactive({
  title: "",
  content: "",
  type: "member_profile" as MemoryType,
  subjectUserId: "",
  confidence: 1,
});
const memberSelectOptions = computed(() => memberOptions.value.map((member) => ({
  value: member.userId,
  label: `${member.displayName} / ${member.userId}`,
  hint: member.note || member.role || undefined,
})));

const editingItem = computed(() => items.value.find((item) => item.id === editingId.value));
const editDirty = computed(() => Boolean(editingId.value) && JSON.stringify(editForm) !== editBaseline.value);
const createDirty = computed(() => createVisible.value && Boolean(createForm.title.trim() || createForm.content.trim() || createForm.subjectUserId));
useUnsavedChanges(computed(() => editDirty.value || createDirty.value));
async function closeEdit(): Promise<void> { if (editDirty.value && !await confirmAction({ title: "放弃记忆更改？", message: "当前记忆尚未保存。", confirmText: "放弃更改", danger: true })) return; editingId.value = ""; }
async function closeCreate(): Promise<void> { if (createDirty.value && !await confirmAction({ title: "放弃新增记忆？", message: "已填写的内容尚未保存。", confirmText: "放弃更改", danger: true })) return; createVisible.value = false; }

function typeLabel(type: MemoryType): string {
  return type === "member_profile" ? "成员显式记忆" : "群内事实";
}

function confidenceText(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function isBusy(id: string): boolean {
  return busyIds.value.has(id);
}

function ensureWritable(): boolean {
  if (!readonly.value) return true;
  app.showToast("会话尚未就绪，无法修改长期记忆", "error");
  return false;
}

function setBusy(id: string, busy: boolean): void {
  const next = new Set(busyIds.value);
  if (busy) next.add(id);
  else next.delete(id);
  busyIds.value = next;
}

async function load(): Promise<void> {
  if (!app.groupId) return;
  const groupId = app.groupId;
  const serial = ++loadSerial;
  loading.value = true;
  loadError.value = "";
  try {
    const data = await api<{ memories: Memory[]; pagination: Pagination }>(`/api/memories${queryString({
      groupId,
      q: filters.q,
      subjectUserId: filters.userId,
      type: filters.type,
      enabled: filters.enabled,
      evidence: "preview",
      page: pagination.page,
      pageSize: pagination.pageSize,
    })}`);
    if (serial !== loadSerial || groupId !== app.groupId) return;
    items.value = data.memories;
    Object.assign(pagination, data.pagination);
  } catch (error) {
    if (serial === loadSerial) loadError.value = (error as Error).message;
  } finally {
    if (serial === loadSerial) loading.value = false;
  }
}

async function loadMemberOptions(): Promise<void> {
  const groupId = app.groupId;
  if (!groupId) return;
  try {
    let data = await api<{ members: MemberProfile[]; cacheStatus?: string }>(
      `/api/groups/${encodeURIComponent(groupId)}/members?all=1`,
    );
    if (data.cacheStatus === "unloaded" || (!data.members?.length && app.groupId === groupId)) {
      try {
        await api(`/api/groups/${encodeURIComponent(groupId)}/members/refresh`, { method: "POST", body: "{}" });
        data = await api<{ members: MemberProfile[]; cacheStatus?: string }>(
          `/api/groups/${encodeURIComponent(groupId)}/members?all=1`,
        );
      } catch {
        // ignore
      }
    }
    if (groupId === app.groupId) {
      memberOptions.value = data.members || [];
    }
  } catch (error) {
    app.showToast((error as Error).message, "error");
  }
}

async function createMemory(): Promise<void> {
  if (!ensureWritable() || !app.groupId) return;
  if (!createForm.title.trim() || !createForm.content.trim()) {
    app.showToast("标题和内容不能为空", "error");
    return;
  }
  if (createForm.type === "member_profile" && !createForm.subjectUserId.trim()) {
    app.showToast("成员记忆需要选择成员", "error");
    return;
  }
  creating.value = true;
  try {
    await api<Memory>("/api/memories", {
      method: "POST",
      body: JSON.stringify({
        groupId: app.groupId,
        type: createForm.type,
        subjectUserId: createForm.type === "group_fact" ? "" : createForm.subjectUserId.trim(),
        title: createForm.title.trim(),
        content: createForm.content.trim(),
        confidence: Number(createForm.confidence),
        source: "admin",
        enabled: true,
      }),
    });
    createVisible.value = false;
    createForm.title = "";
    createForm.content = "";
    createForm.subjectUserId = "";
    createForm.confidence = 1;
    await Promise.all([load(), loadMemberOptions()]);
    app.showToast("记忆已保存");
  } catch (error) {
    app.showToast((error as Error).message, "error");
  } finally {
    creating.value = false;
  }
}

function applyFilters(): void {
  pagination.page = 1;
  void load().catch((error) => app.showToast(error.message, "error"));
}

function toggle(item: Memory): void { toggleSelection(item); }
function togglePage(): void { toggleSelectionPage(items.value); }

function startEdit(item: Memory): void {
  if (!ensureWritable()) return;
  editingId.value = item.id;
  editForm.title = item.title;
  editForm.content = item.content;
  editForm.type = item.type;
  editForm.subjectUserId = item.subjectUserId || "";
  editForm.confidence = item.confidence;
  editForm.source = item.source || "admin";
  editForm.enabled = item.enabled;
  editBaseline.value = JSON.stringify(editForm);
}

async function openEvidence(item: Memory): Promise<void> {
  evidenceItem.value = item;
  evidenceLoading.value = true;
  try {
    evidenceItem.value = await api<Memory>(`/api/memories/${encodeURIComponent(item.id)}`);
  } catch (error) {
    app.showToast((error as Error).message, "error");
  } finally {
    evidenceLoading.value = false;
  }
}

function closeEvidence(): void {
  evidenceItem.value = undefined;
  evidenceLoading.value = false;
}

function formattedEvidenceSummary(): string {
  return evidenceSummary(evidenceItem.value?.evidence)
    .split(/\s*\/\s*/g)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

async function saveEdit(item: Memory): Promise<void> {
  if (!ensureWritable()) return;
  if (!editForm.title.trim() || !editForm.content.trim()) {
    app.showToast("标题和内容不能为空", "error");
    return;
  }
  if (editForm.type === "member_profile" && !editForm.subjectUserId.trim()) {
    app.showToast("成员显式记忆需要填写 QQ", "error");
    return;
  }
  setBusy(item.id, true);
  try {
    await api<Memory>(`/api/memories/${encodeURIComponent(item.id)}`, {
      method: "PUT",
      body: JSON.stringify({
        title: editForm.title.trim(),
        content: editForm.content.trim(),
        type: editForm.type,
        subjectUserId: editForm.type === "group_fact" ? "" : editForm.subjectUserId.trim(),
        confidence: Number(editForm.confidence),
        source: editForm.source.trim() || "admin",
        enabled: editForm.enabled,
      }),
    });
    editingId.value = "";
    await load();
    app.showToast("记忆已保存");
  } catch (error) {
    app.showToast((error as Error).message, "error");
  } finally {
    setBusy(item.id, false);
  }
}

async function setEnabled(item: Memory, enabled: boolean): Promise<void> {
  if (!ensureWritable()) return;
  setBusy(item.id, true);
  try {
    await api<Memory>(`/api/memories/${encodeURIComponent(item.id)}`, {
      method: "PUT",
      body: JSON.stringify({ enabled }),
    });
    await load();
    app.showToast(enabled ? "记忆已启用" : "记忆已停用");
  } catch (error) {
    app.showToast((error as Error).message, "error");
  } finally {
    setBusy(item.id, false);
  }
}

async function deleteOne(item: Memory): Promise<void> {
  if (!ensureWritable()) return;
  if (!await confirmAction({ title: "确认操作", message: `删除记忆「${item.title}」？`, confirmText: "确认", danger: true })) return;
  setBusy(item.id, true);
  try {
    await api(`/api/memories/${encodeURIComponent(item.id)}`, { method: "DELETE" });
    removeSelection(item.id);
    await load();
    app.showToast("记忆已删除");
  } catch (error) {
    app.showToast((error as Error).message, "error");
  } finally {
    setBusy(item.id, false);
  }
}

async function bulk(action: "enable" | "disable" | "delete" | "tags"): Promise<void> { if (action !== "tags") await prepareBulk(action); }

function clearDedupPolling(): void {
  if (dedupPollTimer) {
    clearTimeout(dedupPollTimer);
    dedupPollTimer = undefined;
  }
}

function readDedupPreviewResult(task: AdminTaskRecord): DedupPreviewResult | undefined {
  const result = task.result as DedupPreviewResult | undefined;
  if (!result || !Array.isArray(result.decisions)) return undefined;
  return result;
}

function finishDedupPreview(result: DedupPreviewResult): void {
  dedupDecisions.value = result.decisions;
  dedupLoading.value = false;
  dedupTaskMessage.value = "";
  dedupPollFailures.value = 0;
  clearDedupPolling();
  app.showToast(`发现 ${result.decisions.length} 组疑似重复记忆`);
}

function dedupModeLabel(mode: DedupMode): string {
  return mode === "deep" ? "深度检测" : "快速检测";
}

function scheduleDedupPoll(taskId: string, delayMs = 1500): void {
  clearDedupPolling();
  dedupPollTimer = setTimeout(() => {
    void pollDedupPreviewTask(taskId);
  }, delayMs);
}

async function pollDedupPreviewTask(taskId: string): Promise<void> {
  if (dedupTask.value?.id !== taskId) return;
  try {
    const task = await api<AdminTaskRecord>(`/api/tasks/${encodeURIComponent(taskId)}`);
    if (dedupTask.value?.id !== taskId) return;
    dedupPollFailures.value = 0;
    dedupTask.value = task;
    if (task.status === "succeeded") {
      const result = readDedupPreviewResult(task);
      if (!result) {
        throw new Error("去重任务完成，但结果格式异常");
      }
      finishDedupPreview(result);
      return;
    }
    if (task.status === "failed" || task.status === "cancelled") {
      dedupLoading.value = false;
      dedupTaskMessage.value = "";
      clearDedupPolling();
      app.showToast(task.error || "去重检测任务失败", "error");
      return;
    }
    dedupTaskMessage.value = `${dedupModeLabel(dedupMode.value)}后台处理中，进度 ${task.progress}%`;
    scheduleDedupPoll(taskId);
  } catch (error) {
    dedupPollFailures.value += 1;
    if (dedupPollFailures.value <= 3) {
      dedupTaskMessage.value = `连接暂时中断，正在重试（${dedupPollFailures.value}/3）。任务仍在后台运行。`;
      scheduleDedupPoll(taskId, 2500);
      return;
    }
    dedupLoading.value = false;
    dedupTaskMessage.value = dedupTask.value
      ? `轮询已暂停，请到任务中心查看任务 ${dedupTask.value.id}。`
      : "";
    clearDedupPolling();
    app.showToast((error as Error).message, "error");
  }
}

async function previewDeduplicate(mode: DedupMode = "fast"): Promise<void> {
  if (!ensureWritable()) return;
  if (!app.groupId) return;
  if (!filters.userId) {
    app.showToast("请先选择一个记忆成员，再检查该成员的重复记忆。", "error");
    return;
  }
  clearDedupPolling();
  dedupMode.value = mode;
  dedupPollFailures.value = 0;
  dedupLoading.value = true;
  dedupTask.value = null;
  dedupTaskMessage.value = `正在提交${dedupModeLabel(mode)}后台任务...`;
  dedupDecisions.value = [];
  try {
    const data = await api<DedupPreviewResponse>("/api/memories/deduplicate/preview", {
      method: "POST",
      body: JSON.stringify({
        groupId: app.groupId,
        type: filters.type || undefined,
        subjectUserId: filters.userId,
        mode,
      }),
    });
    if (data.queued && data.taskId) {
      dedupTask.value = data.task ?? null;
      dedupTaskMessage.value = `${dedupModeLabel(mode)}任务已启动${mode === "deep" ? "，会调用模型语义判断" : "，只跑本地相似度"}。`;
      app.showToast(`${dedupModeLabel(mode)}已转入后台任务`);
      scheduleDedupPoll(data.taskId, 800);
      return;
    }
    finishDedupPreview({
      groupId: data.groupId ?? app.groupId,
      subjectUserId: data.subjectUserId ?? filters.userId,
      mode: data.mode ?? mode,
      decisionCount: data.decisionCount ?? data.decisions?.length ?? 0,
      decisions: data.decisions ?? [],
      semanticStats: data.semanticStats,
    });
  } catch (error) {
    dedupTaskMessage.value = "";
    app.showToast((error as Error).message, "error");
    dedupLoading.value = false;
  }

}

async function applyDeduplicate(): Promise<void> {
  if (!ensureWritable()) return;
  if (!app.groupId || dedupDecisions.value.length === 0) return;
  if (!filters.userId) {
    app.showToast("请先选择一个记忆成员，再应用去重。", "error");
    return;
  }
  if (!await confirmAction({ title: "确认操作", message: `确认处理 ${dedupDecisions.value.length} 条重复记忆？重复项会被停用。`, confirmText: "确认", danger: true })) return;
  dedupLoading.value = true;
  try {
    const result = await api<{ appliedCount: number; skippedCount: number }>("/api/memories/deduplicate/apply", {
      method: "POST",
      body: JSON.stringify({ groupId: app.groupId, subjectUserId: filters.userId, decisions: dedupDecisions.value }),
    });
    dedupDecisions.value = [];
    await load();
    app.showToast(`去重完成：处理 ${result.appliedCount} 条，跳过 ${result.skippedCount} 条`);
  } catch (error) {
    app.showToast((error as Error).message, "error");
  } finally {
    dedupLoading.value = false;
  }
}

function onRefresh(): void {
  void load().catch((error) => app.showToast(error.message, "error"));
}

function onGroupChanged(): void {
  clearDedupPolling();
  if (app.role !== "super_admin") clearSelection();
  editingId.value = "";
  createVisible.value = false;
  closeEvidence();
  items.value = [];
  pagination.page = 1;
  filters.userId = "";
  dedupTask.value = null;
  dedupTaskMessage.value = "";
  dedupPollFailures.value = 0;
  dedupLoading.value = false;
  dedupDecisions.value = [];
  void Promise.all([load(), loadMemberOptions()]).catch((error) => app.showToast(error.message, "error"));
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape" && evidenceItem.value) {
    closeEvidence();
  }
}

useContentUrlState(() => ({ q: filters.q, userId: filters.userId, type: filters.type, enabled: filters.enabled, page: pagination.page, pageSize: pagination.pageSize }), (query) => {
  filters.q = query.q; filters.userId = query.userId; filters.type = ["member_profile", "group_fact"].includes(query.type) ? query.type as MemoryType : ""; filters.enabled = ["true", "false"].includes(query.enabled) ? query.enabled : ""; pagination.page = contentPage(query.page); pagination.pageSize = contentPageSize(query.pageSize);
}, onRefresh);

onMounted(() => {
  const q = typeof route.query.q === "string" ? route.query.q : "";
  const userId = typeof route.query.userId === "string" ? route.query.userId : "";
  const type = typeof route.query.type === "string" && ["member_profile", "group_fact"].includes(route.query.type)
    ? route.query.type as MemoryType
    : "";
  if (q) filters.q = q;
  if (userId) filters.userId = userId;
  if (type) filters.type = type;
  void Promise.all([load(), loadMemberOptions()]).then(() => {
    if (route.query.dedup === "1") {
      void previewDeduplicate("fast");
    }
  });
  window.addEventListener("keydown", onKeydown);
});

onUnmounted(() => {
  clearDedupPolling();
  window.removeEventListener("keydown", onKeydown);
});

useRefreshEvents({ refresh: onRefresh, groupChanged: onGroupChanged });

watch(() => [pagination.page, pagination.pageSize], () => {
  void load();
});
</script>

<template>
  <section class="panel content-panel">
    <div class="section-head">
      <div><h2>记忆 <span class="tag neutral">{{ pagination.total }}</span></h2><p>维护成员明确保存的信息和群内事实。</p></div>
      <div class="row-actions"><button class="ghost-btn" type="button" :disabled="loading" @click="onRefresh">刷新</button><button class="btn" type="button" :disabled="readonly" @click="createVisible = true">＋ 新增记忆</button></div>
    </div>
    <div class="filter-card">
      <label>搜索<input v-model="filters.q" class="input" type="search" placeholder="标题、内容或来源" @change="applyFilters" /></label>
      <label>关联成员<SearchableSelect v-model="filters.userId" :options="memberSelectOptions" placeholder="昵称或 QQ" empty-label="全部成员" @change="applyFilters" /></label>
      <label>类型<select v-model="filters.type" class="select" @change="applyFilters"><option value="">全部类型</option><option value="member_profile">成员显式记忆</option><option value="group_fact">群内事实</option></select></label>
      <label>状态<select v-model="filters.enabled" class="select" @change="applyFilters"><option value="">全部状态</option><option value="true">已启用</option><option value="false">已停用</option></select></label>
      <button class="ghost-btn" type="button" @click="filters.q = ''; filters.userId = ''; filters.type = ''; filters.enabled = ''; applyFilters()">重置</button>
    </div>
    <ContentBulkBar :count="selectedIds.size" :group-count="selectedGroupCount" :busy="bulkBusy" :disabled="readonly || loading" :has-items="items.length > 0" :all-selected="items.length > 0 && items.every(item => selectedIds.has(item.id))" @select-page="togglePage" @clear="clearSelection" @action="bulk" />
    <p v-if="selectedIds.size && app.role === 'super_admin'" class="scope-hint">切换顶部群选择可继续选择其他群的记忆，执行前会逐项预览。</p>
    <div v-if="loadError" class="error-state" role="alert"><strong>记忆加载失败</strong><p>{{ loadError }}</p><button class="ghost-btn" type="button" @click="load">重试</button></div>
    <div v-else-if="loading" class="empty" role="status">正在加载记忆…</div>
    <div v-else-if="!items.length" class="empty"><strong>没有匹配的记忆</strong><p>调整筛选条件，或新增一条明确获得的记忆。</p></div>
    <div v-else class="memory-table-wrap">
      <table class="memory-table">
        <thead><tr><th class="selection-cell"><span class="sr-only">选择</span></th><th>记忆内容</th><th>类型 / 状态</th><th>关联成员</th><th>来源 / 置信度</th><th>更新时间</th><th>操作</th></tr></thead>
        <tbody><tr v-for="item in items" :key="item.id" :class="{ selected: selectedIds.has(item.id) }">
          <td><input type="checkbox" :checked="selectedIds.has(item.id)" :disabled="readonly || isBusy(item.id)" :aria-label="'选择记忆 ' + item.title" @change="toggle(item)" /></td>
          <td class="memory-content-cell"><button class="text-title" type="button" @click="openEvidence(item)">{{ item.title }}</button><p class="content-preview">{{ item.content }}</p></td>
          <td><div class="status-stack"><span class="tag neutral">{{ typeLabel(item.type) }}</span><span class="status-dot" :class="{ inactive: !item.enabled }">{{ item.enabled ? "已启用" : "已停用" }}</span></div></td>
          <td>{{ item.subjectLabel?.label || item.subjectUserId || "群整体" }}</td>
          <td><span>{{ item.source || "—" }}</span><small class="cell-secondary">{{ confidenceText(item.confidence) }}</small></td>
          <td class="date-cell">{{ formatDateTime(item.updatedAt || item.createdAt) }}</td>
          <td><div class="row-actions"><button class="ghost-btn" type="button" :disabled="readonly || isBusy(item.id)" @click="startEdit(item)">编辑</button><button class="ghost-btn" type="button" :disabled="readonly || isBusy(item.id)" @click="setEnabled(item, !item.enabled)">{{ item.enabled ? "停用" : "启用" }}</button><button class="ghost-btn danger" type="button" :disabled="readonly || isBusy(item.id)" @click="deleteOne(item)">删除</button></div></td>
        </tr></tbody>
      </table>
    </div>
    <div class="pager"><span class="muted pager-total">共 {{ pagination.total }} 条</span><select v-model="pagination.pageSize" class="select page-size" aria-label="每页条数"><option :value="10">10 条 / 页</option><option :value="20">20 条 / 页</option><option :value="50">50 条 / 页</option><option :value="100">100 条 / 页</option></select><button class="ghost-btn" type="button" :disabled="loading || pagination.page <= 1" @click="pagination.page -= 1">上一页</button><span class="muted">{{ pagination.page }} / {{ pagination.totalPages }}</span><button class="ghost-btn" type="button" :disabled="loading || pagination.page >= pagination.totalPages" @click="pagination.page += 1">下一页</button></div>
    <details class="dedup-details">
      <summary>记忆去重 <span class="muted">检查当前成员的重复记忆</span></summary>
      <section class="dedup-panel">
        <div><h3>当前成员去重</h3><p>选择上方成员筛选后开始检测。快速检测使用本地相似度，深度检测会调用模型。</p></div>
        <div class="dedup-actions"><button class="ghost-btn" type="button" :disabled="readonly || dedupLoading || !filters.userId" @click="previewDeduplicate('fast')">{{ dedupLoading && dedupMode === "fast" ? "快速检测中…" : "快速检测" }}</button><button class="ghost-btn" type="button" :disabled="readonly || dedupLoading || !filters.userId" @click="previewDeduplicate('deep')">{{ dedupLoading && dedupMode === "deep" ? "深度检测中…" : "深度检测" }}</button><button class="btn" type="button" :disabled="readonly || dedupLoading || !dedupDecisions.length" @click="applyDeduplicate">应用去重</button></div>
        <div v-if="dedupTaskMessage || dedupTask" class="dedup-task-status"><span>{{ dedupTaskMessage || "后台任务已更新" }}</span><RouterLink v-if="dedupTask" :to="{ path: '/tasks', query: { task: dedupTask.id } }">查看任务 · {{ dedupTask.progress }}%</RouterLink></div>
        <div v-if="dedupDecisions.length" class="dedup-results"><div class="dedup-summary">发现 {{ dedupDecisions.length }} 条建议，展示前 5 条。</div><article v-for="decision in dedupDecisions.slice(0, 5)" :key="decision.duplicateId" class="dedup-row"><span class="tag">{{ decision.action }}</span><span class="muted">重复项 {{ decision.duplicateId }}</span><span class="muted">{{ confidenceText(decision.similarity) }}</span><p>{{ decision.reason }}</p></article></div>
      </section>
    </details>
    <AdminDialog v-if="createVisible" title="新增记忆" description="只保存已明确获得的信息。" drawer :busy="creating" @close="closeCreate">
      <div class="create-grid">
        <label>类型<select v-model="createForm.type" class="select"><option value="member_profile">成员显式记忆</option><option value="group_fact">群内事实</option></select></label>
        <label>关联成员<SearchableSelect v-model="createForm.subjectUserId" :options="memberSelectOptions" placeholder="选择成员" empty-label="群整体" :disabled="createForm.type === 'group_fact'" /></label>
        <label class="wide">标题<input v-model="createForm.title" class="input" placeholder="例如：回复偏好" /></label>
        <label class="wide">内容<textarea v-model="createForm.content" class="textarea" placeholder="填写明确偏好、边界或长期背景。" /></label>
        <label>置信度<input v-model.number="createForm.confidence" class="input" type="number" min="0" max="1" step="0.01" /></label>
      </div>
      <template #footer><button class="ghost-btn" type="button" :disabled="creating" @click="closeCreate">取消</button><button class="btn" type="button" :disabled="readonly || creating" @click="createMemory">{{ creating ? "保存中…" : "保存记忆" }}</button></template>
    </AdminDialog>
    <AdminDialog v-if="editingItem" title="编辑记忆" drawer :busy="isBusy(editingId)" @close="closeEdit">
      <div class="edit-grid"><label class="wide">标题<input v-model="editForm.title" class="input" /></label><label class="wide">内容<textarea v-model="editForm.content" class="textarea" /></label><label>类型<select v-model="editForm.type" class="select"><option value="member_profile">成员显式记忆</option><option value="group_fact">群内事实</option></select></label><label>关联 QQ<input v-model="editForm.subjectUserId" class="input" :disabled="editForm.type === 'group_fact'" /></label><label>来源<input v-model="editForm.source" class="input" /></label><label>置信度<input v-model.number="editForm.confidence" class="input" type="number" min="0" max="1" step="0.01" /></label><label class="check-line"><input v-model="editForm.enabled" type="checkbox" /> 已启用</label></div>
      <template #footer><button class="ghost-btn" type="button" :disabled="isBusy(editingId)" @click="closeEdit">取消</button><button class="btn" type="button" :disabled="isBusy(editingId)" @click="saveEdit(editingItem)">{{ isBusy(editingId) ? "保存中…" : "保存更改" }}</button></template>
    </AdminDialog>
    <AdminDialog v-if="evidenceItem" title="记忆详情" :description="evidenceItem.title" drawer @close="closeEvidence">
      <span class="tag" :class="{ neutral: !evidenceItem.enabled }">{{ evidenceItem.enabled ? "已启用" : "已停用" }}</span><article class="evidence-text">{{ evidenceItem.content }}</article>
      <dl class="evidence-meta"><div><dt>类型</dt><dd>{{ typeLabel(evidenceItem.type) }}</dd></div><div><dt>关联成员</dt><dd>{{ evidenceItem.subjectLabel?.label || evidenceItem.subjectUserId || "群整体" }}</dd></div><div><dt>来源</dt><dd>{{ evidenceItem.source || "—" }}</dd></div><div><dt>更新时间</dt><dd>{{ formatDateTime(evidenceItem.updatedAt) }}</dd></div><div><dt>时间范围</dt><dd>{{ formatDateTime(evidenceItem.evidence?.startAt) }} 至 {{ formatDateTime(evidenceItem.evidence?.endAt) }}</dd></div><div><dt>消息数量</dt><dd>{{ evidenceItem.evidence?.messageCount ?? 0 }} 条</dd></div><div><dt>发言人</dt><dd>{{ evidenceSpeakers(evidenceItem.evidence) }}</dd></div></dl>
      <h3>信息溯源</h3><div v-if="evidenceLoading" class="empty compact" role="status">正在读取完整溯源…</div><article v-else class="evidence-text">{{ formattedEvidenceSummary() || "未提供溯源记录" }}</article>
    </AdminDialog>
    <BulkPreviewDialog v-if="bulkPreview" :preview="bulkPreview" :busy="bulkBusy" @close="bulkPreview = null" @execute="executeBulk" />
  </section>
</template>

<style scoped>
.create-panel {
  display: grid;
  gap: 12px;
  border: 1px solid color-mix(in oklch, var(--accent) 32%, var(--line));
  border-radius: var(--radius-md);
  background: color-mix(in oklch, var(--accent-soft) 35%, var(--surface));
  padding: 14px;
  margin-bottom: 12px;
}

.create-panel h3,
.create-panel p { margin: 0; }
.create-panel h3 {
  font-size: 14px;
  font-weight: 650;
  color: var(--text-strong);
}
.create-panel p {
  margin-top: 4px;
  color: var(--muted);
  font-size: 12.5px;
  line-height: 1.5;
}
.create-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}
.create-grid label {
  display: grid;
  gap: 6px;
  color: var(--muted);
  font-size: 12.5px;
  font-weight: 650;
}
.create-actions { display: flex; justify-content: flex-end; }

.filter-card {
  display: grid;
  grid-template-columns:
    minmax(240px, 1.15fr)
    minmax(220px, 1fr)
    minmax(150px, 0.62fr)
    minmax(130px, 0.52fr)
    minmax(130px, 0.52fr);
  gap: 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--surface);
  padding: 14px;
  margin-bottom: 12px;
}

.filter-card label,
.edit-grid label {
  display: grid;
  gap: 6px;
  color: var(--muted);
  font-size: 12.5px;
  font-weight: 650;
}

.notice {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border: 1px solid color-mix(in oklch, var(--accent) 30%, var(--line));
  border-radius: var(--radius-md);
  background: color-mix(in oklch, var(--accent-soft) 45%, var(--surface));
  color: var(--accent-strong);
  padding: 10px 12px;
  margin-bottom: 12px;
  font-size: 12.5px;
}

.dedup-panel {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 12px;
  align-items: start;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--surface);
  padding: 14px;
  margin-bottom: 12px;
}

.dedup-panel h3,
.dedup-panel p {
  margin: 0;
}

.dedup-panel h3 {
  font-size: 14px;
  font-weight: 650;
  color: var(--text-strong);
}

.dedup-panel p {
  margin-top: 4px;
  color: var(--muted);
  font-size: 12.5px;
  line-height: 1.5;
}

.dedup-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: flex-end;
}

.dedup-task-status {
  grid-column: 1 / -1;
  display: flex;
  flex-wrap: wrap;
  gap: 6px 12px;
  align-items: center;
  border-top: 1px solid var(--line);
  padding-top: 10px;
  color: var(--accent-strong);
  font-size: 12.5px;
  font-weight: 650;
}

.dedup-results {
  grid-column: 1 / -1;
  display: grid;
  gap: 8px;
  border-top: 1px solid var(--line);
  padding-top: 10px;
}

.dedup-summary {
  color: var(--muted);
  font-size: 12.5px;
  font-weight: 650;
}

.dedup-row {
  display: grid;
  grid-template-columns: auto minmax(120px, 1fr) auto;
  gap: 8px 12px;
  align-items: center;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface-soft);
  padding: 10px 12px;
}

.dedup-row p {
  grid-column: 1 / -1;
  margin: 0;
  color: var(--text);
  font-size: 13px;
  line-height: 1.55;
}

.memory-list {
  display: grid;
  gap: 8px;
}

.memory-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 12px;
  align-items: start;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--surface);
  padding: 12px 14px;
}

.memory-main {
  min-width: 0;
}

.row-tags,
.row-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.row-actions {
  justify-content: flex-end;
}

.row-actions .danger {
  color: var(--danger);
}

.row-meta-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px 12px;
  margin-top: 8px;
  color: var(--muted);
  font-size: 12.5px;
}

.edit-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

.wide {
  grid-column: 1 / -1;
}

.check-line {
  display: flex !important;
  align-items: center;
}

.pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  margin-top: 14px;
}

.pager .ghost-btn {
  min-height: 30px;
  padding: 0 10px;
  font-size: 12px;
}

.pager .muted {
  font-size: 12.5px;
}

.evidence-drawer {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: flex;
  justify-content: flex-end;
  background: color-mix(in oklch, var(--text) 16%, transparent);
}

.drawer-panel {
  width: min(520px, 100vw);
  height: 100%;
  overflow: auto;
  border-left: 1px solid var(--line);
  background: var(--surface);
  box-shadow: var(--shadow-lg);
  padding: 18px;
}

.drawer-panel .section-head h3 {
  font-size: 15px;
  font-weight: 650;
}

.icon-close {
  width: 32px;
  height: 32px;
  border-radius: var(--radius-md);
  border: 1px solid var(--line);
  background: var(--surface);
  color: var(--muted);
  font-size: 18px;
  line-height: 1;
}

.icon-close:hover {
  border-color: var(--line-strong);
  background: var(--surface-soft);
  color: var(--text);
}

.evidence-meta {
  display: grid;
  gap: 10px;
  margin: 0 0 14px;
}

.evidence-meta div {
  display: grid;
  grid-template-columns: 86px minmax(0, 1fr);
  gap: 10px;
  font-size: 13px;
}

.evidence-meta dt {
  color: var(--muted);
  font-size: 12.5px;
}

.evidence-meta dd {
  margin: 0;
  overflow-wrap: anywhere;
}

.evidence-text {
  white-space: pre-wrap;
  line-height: 1.7;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--surface-soft);
  padding: 12px 14px;
  font-size: 13px;
}

@media (max-width: 1180px) {
  .create-grid,
  .filter-card,
  .dedup-panel,
  .dedup-row,
  .memory-row,
  .row-meta-grid,
  .edit-grid {
    grid-template-columns: 1fr;
  }

  .dedup-actions,
  .row-actions {
    justify-content: flex-start;
  }
}
</style>
