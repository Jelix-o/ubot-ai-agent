<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, shallowRef, watch } from "vue";
import { useRoute } from "vue-router";

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
const selectedIds = shallowRef<Set<string>>(new Set());
const editingId = shallowRef("");
const evidenceItem = shallowRef<Memory>();
const evidenceLoading = shallowRef(false);
const busyIds = shallowRef<Set<string>>(new Set());
const dedupLoading = shallowRef(false);
const dedupTask = shallowRef<AdminTaskRecord | null>(null);
const dedupTaskMessage = shallowRef("");
const dedupDecisions = shallowRef<DedupDecision[]>([]);
const readonly = computed(() => app.readonly);
let dedupPollTimer: ReturnType<typeof setTimeout> | undefined;

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
  decisionCount: number;
  decisions: DedupDecision[];
  semanticStats?: Record<string, number>;
}

interface DedupPreviewResponse extends Partial<DedupPreviewResult> {
  queued?: boolean;
  taskId?: string;
  task?: AdminTaskRecord;
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
const memberSelectOptions = computed(() => memberOptions.value.map((member) => ({
  value: member.userId,
  label: `${member.displayName} / ${member.userId}`,
  hint: member.note || member.role || undefined,
})));

function typeLabel(type: MemoryType): string {
  return type === "member_profile" ? "成员画像" : "群内事实";
}

function confidenceText(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function isBusy(id: string): boolean {
  return busyIds.value.has(id);
}

function ensureWritable(): boolean {
  if (!readonly.value) return true;
  app.showToast("只读模式不能修改长期记忆", "error");
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
  loading.value = true;
  try {
    const data = await api<{ memories: Memory[]; pagination: Pagination }>(`/api/memories${queryString({
      groupId: app.groupId,
      q: filters.q,
      subjectUserId: filters.userId,
      type: filters.type,
      enabled: filters.enabled,
      excludeProfileRecords: 1,
      evidence: "preview",
      page: pagination.page,
      pageSize: pagination.pageSize,
    })}`);
    items.value = data.memories;
    Object.assign(pagination, data.pagination);
    selectedIds.value = new Set([...selectedIds.value].filter((id) => data.memories.some((item) => item.id === id)));
  } finally {
    loading.value = false;
  }
}

async function loadMemberOptions(): Promise<void> {
  if (!app.groupId) return;
  try {
    const data = await api<{ members: MemberProfile[]; pagination: Pagination }>(`/api/groups/${encodeURIComponent(app.groupId)}/members${queryString({
      includeNapcat: 1,
      page: 1,
      pageSize: 1000,
    })}`);
    memberOptions.value = data.members;
  } catch (error) {
    app.showToast((error as Error).message, "error");
  }
}

function applyFilters(): void {
  pagination.page = 1;
  void load().catch((error) => app.showToast(error.message, "error"));
}

function toggle(id: string): void {
  if (readonly.value) return;
  const next = new Set(selectedIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selectedIds.value = next;
}

function togglePage(): void {
  if (readonly.value) return;
  const allSelected = items.value.length > 0 && items.value.every((item) => selectedIds.value.has(item.id));
  selectedIds.value = allSelected
    ? new Set([...selectedIds.value].filter((id) => !items.value.some((item) => item.id === id)))
    : new Set([...selectedIds.value, ...items.value.map((item) => item.id)]);
}

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
    app.showToast("成员画像需要填写 QQ", "error");
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
    app.showToast("长期记忆已保存");
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
    app.showToast(enabled ? "长期记忆已启用" : "长期记忆已停用");
  } catch (error) {
    app.showToast((error as Error).message, "error");
  } finally {
    setBusy(item.id, false);
  }
}

async function deleteOne(item: Memory): Promise<void> {
  if (!ensureWritable()) return;
  if (!confirm(`删除长期记忆「${item.title}」？`)) return;
  setBusy(item.id, true);
  try {
    await api(`/api/memories/${encodeURIComponent(item.id)}`, { method: "DELETE" });
    selectedIds.value.delete(item.id);
    await load();
    app.showToast("长期记忆已删除");
  } catch (error) {
    app.showToast((error as Error).message, "error");
  } finally {
    setBusy(item.id, false);
  }
}

async function bulk(action: "disable" | "delete"): Promise<void> {
  if (!ensureWritable()) return;
  const ids = [...selectedIds.value];
  if (!ids.length) {
    app.showToast("请先选择长期记忆", "error");
    return;
  }
  if (action === "delete" && !confirm(`删除已选择的 ${ids.length} 条长期记忆？`)) return;
  loading.value = true;
  try {
    const result = await api<{ processedCount: number; skippedCount: number }>("/api/memories/bulk", {
      method: "POST",
      body: JSON.stringify({ action, ids }),
    });
    selectedIds.value = new Set();
    await load();
    app.showToast(`已处理 ${result.processedCount} 条，跳过 ${result.skippedCount} 条`);
  } catch (error) {
    app.showToast((error as Error).message, "error");
  } finally {
    loading.value = false;
  }
}

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
  clearDedupPolling();
  app.showToast(`发现 ${result.decisions.length} 组疑似重复记忆`);
}

async function pollDedupPreviewTask(taskId: string): Promise<void> {
  if (dedupTask.value?.id !== taskId) return;
  try {
    const task = await api<AdminTaskRecord>(`/api/tasks/${encodeURIComponent(taskId)}`);
    if (dedupTask.value?.id !== taskId) return;
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
    dedupTaskMessage.value = `后台检测中，进度 ${task.progress}%`;
    dedupPollTimer = setTimeout(() => {
      void pollDedupPreviewTask(taskId);
    }, 1500);
  } catch (error) {
    dedupLoading.value = false;
    dedupTaskMessage.value = "";
    clearDedupPolling();
    app.showToast((error as Error).message, "error");
  }
}

async function previewDeduplicate(): Promise<void> {
  if (!app.groupId) return;
  if (!filters.userId) {
    app.showToast("请先选择一个记忆成员，再检查该成员的重复记忆。", "error");
    return;
  }
  clearDedupPolling();
  dedupLoading.value = true;
  dedupTask.value = null;
  dedupTaskMessage.value = "正在提交后台检测任务...";
  dedupDecisions.value = [];
  try {
    const data = await api<DedupPreviewResponse>("/api/memories/deduplicate/preview", {
      method: "POST",
      body: JSON.stringify({
        groupId: app.groupId,
        type: filters.type || undefined,
        subjectUserId: filters.userId,
      }),
    });
    if (data.queued && data.taskId) {
      dedupTask.value = data.task ?? null;
      dedupTaskMessage.value = "后台检测任务已启动，模型判断较慢时会自动等待完成";
      app.showToast("去重检测已转入后台任务");
      dedupPollTimer = setTimeout(() => {
        void pollDedupPreviewTask(data.taskId!);
      }, 800);
      return;
    }
    finishDedupPreview({
      groupId: data.groupId ?? app.groupId,
      subjectUserId: data.subjectUserId ?? filters.userId,
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
  if (!confirm(`确认处理 ${dedupDecisions.value.length} 条重复记忆？重复项会被停用。`)) return;
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
  selectedIds.value = new Set();
  pagination.page = 1;
  filters.userId = "";
  dedupTask.value = null;
  dedupTaskMessage.value = "";
  dedupLoading.value = false;
  dedupDecisions.value = [];
  void Promise.all([load(), loadMemberOptions()]).catch((error) => app.showToast(error.message, "error"));
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape" && evidenceItem.value) {
    closeEvidence();
  }
}

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
      void previewDeduplicate();
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
  <section class="panel">
    <div class="section-head">
      <div>
        <h2>长期记忆 <span class="tag">{{ pagination.total }}</span></h2>
        <p>维护已批准保留的成员记忆，可停用、编辑、删除重复或错误内容。</p>
      </div>
    </div>

    <div class="filter-card">
      <label>关键词 / 来源<input v-model="filters.q" class="input" placeholder="搜索记忆标题、关键词、内容..." @change="applyFilters" /></label>
      <label>记忆成员
        <SearchableSelect
          v-model="filters.userId"
          :options="memberSelectOptions"
          placeholder="搜索成员昵称或 QQ"
          empty-label="全部成员"
          @change="applyFilters"
        />
      </label>
      <label>记忆类型
        <select v-model="filters.type" class="select" @change="applyFilters">
          <option value="">全部类型</option>
          <option value="member_profile">成员画像</option>
          <option value="group_fact">群内事实</option>
        </select>
      </label>
      <label>状态
        <select v-model="filters.enabled" class="select" @change="applyFilters">
          <option value="">全部状态</option>
          <option value="true">已启用</option>
          <option value="false">已停用</option>
        </select>
      </label>
      <label>每页条数
        <select v-model="pagination.pageSize" class="select">
          <option :value="10">10 条</option>
          <option :value="20">20 条</option>
          <option :value="50">50 条</option>
          <option :value="100">100 条</option>
        </select>
      </label>
    </div>

    <div class="notice">
      <span>按成员与类型维护长期记忆，重复或相似内容可以先停用再删除。</span>
      <button class="ghost-btn" type="button" @click="filters.q = ''; filters.userId = ''; filters.type = ''; filters.enabled = ''; applyFilters()">清空筛选</button>
    </div>

    <section class="dedup-panel">
      <div>
        <h3>记忆去重</h3>
        <p>请选择一个记忆成员后再检查重复。去重只处理该成员的长期记忆，避免全局扫描超时。</p>
      </div>
      <div class="dedup-actions">
        <button class="ghost-btn" type="button" :disabled="dedupLoading" @click="previewDeduplicate">
          {{ dedupLoading ? "检测中..." : "检测当前成员重复" }}
        </button>
        <button class="btn" type="button" :disabled="readonly || dedupLoading || !dedupDecisions.length" @click="applyDeduplicate">
          {{ readonly ? "只读模式不可去重" : "应用去重" }}
        </button>
      </div>
      <div v-if="dedupTaskMessage || dedupTask" class="dedup-task-status">
        <span>{{ dedupTaskMessage || "后台任务已更新" }}</span>
        <span v-if="dedupTask" class="muted">任务 {{ dedupTask.id }} · {{ dedupTask.status }} · {{ dedupTask.progress }}%</span>
      </div>
      <div v-if="dedupDecisions.length" class="dedup-results">
        <div class="dedup-summary">发现 {{ dedupDecisions.length }} 条处理建议，先展示前 5 条。</div>
        <article v-for="decision in dedupDecisions.slice(0, 5)" :key="decision.duplicateId" class="dedup-row">
          <span class="tag">{{ decision.action }}</span>
          <span class="muted">重复项 {{ decision.duplicateId }}</span>
          <span class="muted">相似度 {{ confidenceText(decision.similarity) }}</span>
          <p>{{ decision.reason }}</p>
        </article>
      </div>
    </section>

    <div class="bulk-bar">
      <label><input type="checkbox" :checked="items.length > 0 && items.every((item) => selectedIds.has(item.id))" :disabled="readonly || loading || !items.length" @change="togglePage" /> 选择当前页</label>
      <span class="muted">已选择 {{ selectedIds.size }} 项</span>
      <button class="ghost-btn" type="button" :disabled="readonly || loading || !selectedIds.size" @click="bulk('disable')">批量停用</button>
      <button class="ghost-btn danger" type="button" :disabled="readonly || loading || !selectedIds.size" @click="bulk('delete')">批量删除</button>
    </div>

    <div v-if="loading" class="empty">正在加载长期记忆...</div>
    <div v-else-if="!items.length" class="empty">暂无长期记忆。</div>
    <div v-else class="memory-list">
      <article v-for="item in items" :key="item.id" class="memory-row">
        <input type="checkbox" :checked="selectedIds.has(item.id)" :disabled="readonly || isBusy(item.id)" @change="toggle(item.id)" />
        <div class="memory-main">
          <template v-if="editingId === item.id">
            <div class="edit-grid">
              <label class="wide">标题<input v-model="editForm.title" class="input" /></label>
              <label class="wide">内容<textarea v-model="editForm.content" class="textarea" /></label>
              <label>类型
                <select v-model="editForm.type" class="select">
                  <option value="member_profile">成员画像</option>
                  <option value="group_fact">群内事实</option>
                </select>
              </label>
              <label>QQ<input v-model="editForm.subjectUserId" class="input" :disabled="editForm.type === 'group_fact'" /></label>
              <label>来源<input v-model="editForm.source" class="input" /></label>
              <label>置信度<input v-model.number="editForm.confidence" class="input" type="number" min="0" max="1" step="0.01" /></label>
              <label class="check-line"><input v-model="editForm.enabled" type="checkbox" /> 启用</label>
            </div>
            <div class="row-actions">
              <button class="btn" type="button" :disabled="isBusy(item.id)" @click="saveEdit(item)">保存</button>
              <button class="ghost-btn" type="button" :disabled="isBusy(item.id)" @click="editingId = ''">取消</button>
            </div>
          </template>
          <template v-else>
            <div class="row-top">
              <h3 class="row-title">{{ item.title }}</h3>
              <div class="row-tags">
                <span class="tag" :class="{ danger: !item.enabled }">{{ item.enabled ? "已启用" : "已停用" }}</span>
                <span class="tag">{{ typeLabel(item.type) }}</span>
              </div>
            </div>
            <p class="row-content">{{ item.content }}</p>
            <div class="row-meta-grid">
              <span>{{ item.subjectLabel?.label || item.subjectUserId || "群整体" }}</span>
              <span>{{ item.source }}</span>
              <span>{{ confidenceText(item.confidence) }}</span>
              <span>{{ formatDateTime(item.updatedAt || item.createdAt) }}</span>
            </div>
          </template>
        </div>
        <div v-if="editingId !== item.id" class="row-actions">
          <button class="ghost-btn" type="button" @click="openEvidence(item)">溯源</button>
          <button class="ghost-btn" type="button" :disabled="readonly || isBusy(item.id)" @click="startEdit(item)">编辑</button>
          <button class="ghost-btn" type="button" :disabled="readonly || isBusy(item.id)" @click="setEnabled(item, !item.enabled)">{{ item.enabled ? "停用" : "启用" }}</button>
          <button class="ghost-btn danger" type="button" :disabled="readonly || isBusy(item.id)" @click="deleteOne(item)">删除</button>
        </div>
      </article>
    </div>

    <div class="pager">
      <button class="ghost-btn" type="button" :disabled="pagination.page <= 1" @click="pagination.page -= 1">上一页</button>
      <span class="muted">第 {{ pagination.page }} / {{ pagination.totalPages }} 页</span>
      <button class="ghost-btn" type="button" :disabled="pagination.page >= pagination.totalPages" @click="pagination.page += 1">下一页</button>
    </div>

    <aside v-if="evidenceItem" class="evidence-drawer" @click.self="closeEvidence">
      <div class="drawer-panel" role="dialog" aria-modal="true">
        <div class="section-head">
          <div>
            <h3>记忆溯源</h3>
            <p>{{ evidenceItem.title }}</p>
          </div>
          <button class="icon-close" type="button" @click="closeEvidence">×</button>
        </div>
        <dl class="evidence-meta">
          <div><dt>时间范围</dt><dd>{{ formatDateTime(evidenceItem.evidence?.startAt) }} 至 {{ formatDateTime(evidenceItem.evidence?.endAt) }}</dd></div>
          <div><dt>消息数量</dt><dd>{{ evidenceItem.evidence?.messageCount ?? 0 }} 条</dd></div>
          <div><dt>发言人</dt><dd>{{ evidenceSpeakers(evidenceItem.evidence) }}</dd></div>
        </dl>
        <div v-if="evidenceLoading" class="empty compact">Loading full evidence...</div>
        <article class="evidence-text">{{ formattedEvidenceSummary() }}</article>
      </div>
    </aside>
  </section>
</template>

<style scoped>
.filter-card {
  display: grid;
  grid-template-columns:
    minmax(240px, 1.15fr)
    minmax(220px, 1fr)
    minmax(150px, 0.62fr)
    minmax(130px, 0.52fr)
    minmax(130px, 0.52fr);
  gap: 16px;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--surface-raised);
  padding: 16px;
  margin-bottom: 14px;
}

.filter-card label,
.edit-grid label {
  display: grid;
  gap: 8px;
  color: var(--muted);
  font-weight: 700;
}

.notice {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border: 1px solid color-mix(in oklch, var(--accent) 35%, var(--line));
  border-radius: var(--radius-md);
  background: color-mix(in oklch, var(--accent-soft) 55%, var(--surface));
  color: var(--accent-strong);
  padding: 12px 16px;
  margin-bottom: 14px;
}

.dedup-panel {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 16px;
  align-items: start;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--surface-raised);
  padding: 16px;
  margin-bottom: 14px;
}

.dedup-panel h3,
.dedup-panel p {
  margin: 0;
}

.dedup-panel p {
  margin-top: 6px;
  color: var(--muted);
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
  gap: 8px 14px;
  align-items: center;
  border-top: 1px solid var(--line);
  padding-top: 12px;
  color: var(--accent-strong);
  font-size: 13px;
  font-weight: 700;
}

.dedup-results {
  grid-column: 1 / -1;
  display: grid;
  gap: 8px;
  border-top: 1px solid var(--line);
  padding-top: 12px;
}

.dedup-summary {
  color: var(--muted);
  font-size: 13px;
  font-weight: 700;
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
}

.memory-list {
  display: grid;
  gap: 10px;
}

.memory-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 16px;
  align-items: start;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--surface-raised);
  padding: 16px;
}

.memory-main {
  min-width: 0;
}

.row-tags,
.row-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
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
  gap: 10px;
  color: var(--muted);
  font-size: 13px;
}

.edit-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
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
  gap: 14px;
  margin-top: 18px;
}

.evidence-drawer {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: flex;
  justify-content: flex-end;
  background: color-mix(in oklch, var(--text) 18%, transparent);
}

.drawer-panel {
  width: min(520px, 100vw);
  height: 100%;
  overflow: auto;
  border-left: 1px solid var(--line);
  background: var(--surface);
  box-shadow: var(--shadow-md);
  padding: 22px;
}

.icon-close {
  width: 34px;
  height: 34px;
  border-radius: 999px;
  background: var(--surface-soft);
  color: var(--muted);
  font-size: 22px;
}

.evidence-meta {
  display: grid;
  gap: 12px;
  margin: 0 0 16px;
}

.evidence-meta div {
  display: grid;
  grid-template-columns: 86px minmax(0, 1fr);
  gap: 12px;
}

.evidence-meta dt {
  color: var(--muted);
}

.evidence-meta dd {
  margin: 0;
  overflow-wrap: anywhere;
}

.evidence-text {
  white-space: pre-wrap;
  line-height: 1.8;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--surface-soft);
  padding: 14px;
}

@media (max-width: 1180px) {
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
