<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, shallowRef, watch } from "vue";
import { useRoute } from "vue-router";

import SearchableSelect from "../components/SearchableSelect.vue";
import { useRefreshEvents } from "../composables/useRefreshEvents";
import { api, queryString, type Candidate, type MemberProfile, type MemoryType, type Pagination } from "../services/api";
import { useAppStore } from "../stores/app";
import { useCandidatesStore } from "../stores/candidates";
import { evidenceSpeakers, evidenceSummary, formatDateTime } from "../utils/format";

const route = useRoute();
const app = useAppStore();
const candidates = useCandidatesStore();
const activeId = shallowRef("");
const editingId = shallowRef("");
const evidenceItem = shallowRef<Candidate>();
const evidenceLoading = shallowRef(false);
const memberOptions = shallowRef<MemberProfile[]>([]);
const savingIds = shallowRef<Set<string>>(new Set());
const editForm = reactive({
  title: "",
  content: "",
  type: "member_profile" as MemoryType,
  subjectUserId: "",
  confidence: 0.8,
});
const memberSelectOptions = computed(() => memberOptions.value.map((member) => ({
  value: member.userId,
  label: `${member.displayName} / ${member.userId}`,
  hint: member.note || member.role || undefined,
})));

function isBusy(id: string): boolean {
  return savingIds.value.has(id) || candidates.bulkApproving;
}

function setBusy(id: string, busy: boolean): void {
  const next = new Set(savingIds.value);
  if (busy) next.add(id);
  else next.delete(id);
  savingIds.value = next;
}

function typeLabel(type: MemoryType): string {
  return type === "member_profile" ? "成员画像" : "群内事实";
}

function statusLabel(status: Candidate["status"]): string {
  return ({ pending: "待处理", approved: "已入库", rejected: "不采纳" } as const)[status];
}

function confidenceText(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function needsSubject(item: Candidate): boolean {
  return item.type === "member_profile" && !item.subjectUserId;
}

function candidateErrorLabel(error: string): string {
  const map: Record<string, string> = {
    member_profile_requires_subject_user_id: "成员画像缺少记忆成员，请先编辑选择成员，或作为群事实入库",
    not_found: "候选不存在",
    forbidden: "没有权限处理该候选",
    status_rejected: "候选已不采纳",
    status_approved: "候选已入库",
  };
  return map[error] || error;
}

function summarizeBulkResult(result: { approvedCount: number; alreadyApprovedCount: number; skipped?: Array<{ id: string; error: string }>; errors?: Array<{ id: string; error: string }> }): string {
  const failed = [...(result.skipped || []), ...(result.errors || [])];
  if (!failed.length) {
    return `已入库 ${result.approvedCount} 条，已处理跳过 ${result.alreadyApprovedCount} 条`;
  }
  const reasonCounts = new Map<string, number>();
  for (const item of failed) {
    const label = candidateErrorLabel(item.error);
    reasonCounts.set(label, (reasonCounts.get(label) ?? 0) + 1);
  }
  const reasonText = [...reasonCounts.entries()].map(([label, count]) => `${label} ${count} 条`).join("；");
  return `已入库 ${result.approvedCount} 条，失败/跳过 ${failed.length} 条：${reasonText}`;
}

async function load(): Promise<void> {
  if (!app.groupId) return;
  await candidates.load(app.groupId);
}

async function loadMemberOptions(): Promise<void> {
  if (!app.groupId) return;
  const data = await api<{ members: MemberProfile[]; pagination: Pagination }>(`/api/groups/${encodeURIComponent(app.groupId)}/members${queryString({
    includeNapcat: 1,
    page: 1,
    pageSize: 1000,
  })}`);
  memberOptions.value = data.members;
}

async function approveSelected(): Promise<void> {
  try {
    const result = await candidates.approveSelected();
    await load();
    await app.loadNotifications();
    app.showToast(summarizeBulkResult(result), result.skippedCount + result.errorCount > 0 ? "error" : "ok");
  } catch (error) {
    app.showToast((error as Error).message, "error");
  }
}

async function approveOne(item: Candidate, asGroupFact = false): Promise<void> {
  if (!asGroupFact && needsSubject(item)) {
    app.showToast("这条成员画像缺少记忆成员，请先编辑选择成员，或点击“作为群事实”。", "error");
    return;
  }
  setBusy(item.id, true);
  try {
    const patch = asGroupFact
      ? { type: "group_fact", subjectUserId: "", title: item.title, content: item.content, confidence: item.confidence }
      : { title: item.title, content: item.content, type: item.type, subjectUserId: item.subjectUserId, confidence: item.confidence };
    await api(`/api/memory-candidates/${encodeURIComponent(item.id)}/approve`, {
      method: "POST",
      body: JSON.stringify(patch),
    });
    candidates.selectedIds.delete(item.id);
    await load();
    await app.loadNotifications();
    app.showToast(asGroupFact ? "已作为群内事实入长期记忆" : "已入长期记忆");
  } catch (error) {
    app.showToast((error as Error).message, "error");
  } finally {
    setBusy(item.id, false);
  }
}

async function rejectOne(item: Candidate): Promise<void> {
  setBusy(item.id, true);
  try {
    await api(`/api/memory-candidates/${encodeURIComponent(item.id)}/reject`, { method: "POST", body: "{}" });
    candidates.selectedIds.delete(item.id);
    await load();
    await app.loadNotifications();
    app.showToast("已标记为不采纳");
  } catch (error) {
    app.showToast((error as Error).message, "error");
  } finally {
    setBusy(item.id, false);
  }
}

function startEdit(item: Candidate): void {
  editingId.value = item.id;
  activeId.value = item.id;
  editForm.title = item.title;
  editForm.content = item.content;
  editForm.type = item.type;
  editForm.subjectUserId = item.subjectUserId || "";
  editForm.confidence = item.confidence;
}

async function openEvidence(item: Candidate): Promise<void> {
  activeId.value = item.id;
  evidenceItem.value = item;
  evidenceLoading.value = true;
  try {
    evidenceItem.value = await api<Candidate>(`/api/memory-candidates/${encodeURIComponent(item.id)}`);
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

async function saveEdit(item: Candidate): Promise<void> {
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
    await api<Candidate>(`/api/memory-candidates/${encodeURIComponent(item.id)}`, {
      method: "PUT",
      body: JSON.stringify({
        title: editForm.title.trim(),
        content: editForm.content.trim(),
        type: editForm.type,
        subjectUserId: editForm.type === "group_fact" ? "" : editForm.subjectUserId.trim(),
        confidence: Number(editForm.confidence),
      }),
    });
    editingId.value = "";
    await load();
    app.showToast("候选记忆已保存");
  } catch (error) {
    app.showToast((error as Error).message, "error");
  } finally {
    setBusy(item.id, false);
  }
}

async function deleteOne(item: Candidate): Promise<void> {
  if (!confirm(`删除候选记忆「${item.title}」？`)) return;
  setBusy(item.id, true);
  try {
    await api(`/api/memory-candidates/${encodeURIComponent(item.id)}`, { method: "DELETE" });
    candidates.selectedIds.delete(item.id);
    await load();
    app.showToast("候选记忆已删除");
  } catch (error) {
    app.showToast((error as Error).message, "error");
  } finally {
    setBusy(item.id, false);
  }
}

function applyFilters(): void {
  candidates.pagination.page = 1;
  void load().catch((error) => app.showToast(error.message, "error"));
}

function setStatus(status: Candidate["status"] | ""): void {
  candidates.filters.status = status;
  applyFilters();
}

function onRefresh(): void {
  void load().catch((error) => app.showToast(error.message, "error"));
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape" && evidenceItem.value) {
    closeEvidence();
  }
}

onMounted(() => {
  const q = typeof route.query.q === "string" ? route.query.q : "";
  if (q) candidates.filters.q = q;
  void Promise.all([load(), loadMemberOptions()]);
  window.addEventListener("keydown", onKeydown);
});

onUnmounted(() => {
  window.removeEventListener("keydown", onKeydown);
});

useRefreshEvents({ refresh: onRefresh, groupChanged: onRefresh });

watch(() => app.groupId, () => {
  candidates.filters.subjectUserId = "";
  void loadMemberOptions().catch((error) => app.showToast(error.message, "error"));
});

watch(() => [candidates.pagination.page, candidates.pagination.pageSize], () => {
  void load();
});
</script>

<template>
  <section class="panel">
    <div class="section-head">
      <div>
        <h2>候选记忆 <span class="tag">{{ candidates.pagination.total }}</span></h2>
        <p>审核与优化候选记忆，决定是否进入长期记忆库。</p>
      </div>
    </div>

    <div class="filter-card">
      <label>
        关键词 / 来源
        <input v-model="candidates.filters.q" class="input" :disabled="candidates.bulkApproving" placeholder="搜索标题、内容、来源或关键词..." @change="applyFilters" />
      </label>
      <label>
        记忆成员
        <SearchableSelect
          v-model="candidates.filters.subjectUserId"
          :options="memberSelectOptions"
          placeholder="搜索成员昵称或 QQ"
          empty-label="全部成员"
          :disabled="candidates.bulkApproving"
          @change="applyFilters"
        />
      </label>
      <label>
        记忆类型
        <select v-model="candidates.filters.type" class="select" :disabled="candidates.bulkApproving" @change="applyFilters">
          <option value="">全部类型</option>
          <option value="member_profile">成员画像</option>
          <option value="group_fact">群内事实</option>
        </select>
      </label>
      <label>
        每页显示
        <select v-model="candidates.pagination.pageSize" class="select" :disabled="candidates.bulkApproving">
          <option :value="10">10 条</option>
          <option :value="20">20 条</option>
          <option :value="50">50 条</option>
          <option :value="100">100 条</option>
        </select>
      </label>
    </div>

    <div class="tabs">
      <button type="button" :class="{ active: candidates.filters.status === 'pending' }" @click="setStatus('pending')">待处理 <span>{{ candidates.statusCounts.pending }}</span></button>
      <button type="button" :class="{ active: candidates.filters.status === 'approved' }" @click="setStatus('approved')">已入库 <span>{{ candidates.statusCounts.approved }}</span></button>
      <button type="button" :class="{ active: candidates.filters.status === 'rejected' }" @click="setStatus('rejected')">不采纳 <span>{{ candidates.statusCounts.rejected }}</span></button>
      <button type="button" :class="{ active: candidates.filters.status === '' }" @click="setStatus('')">全部历史</button>
    </div>

    <div class="bulk-bar">
      <label><input type="checkbox" :checked="candidates.allPageSelected" :disabled="candidates.bulkApproving || candidates.items.length === 0" @change="candidates.togglePage()" /> 选择当前页待处理项</label>
      <span class="muted">已选择 {{ candidates.selectedCount }} 项</span>
      <button class="btn" type="button" :disabled="candidates.bulkApproving || candidates.selectedCount === 0" @click="approveSelected">
        {{ candidates.bulkApproving ? "正在入长期记忆..." : "批量入长期记忆" }}
      </button>
      <button class="ghost-btn" type="button" :disabled="candidates.bulkApproving || candidates.selectedCount === 0" @click="candidates.clearSelection()">清空选择</button>
      <span class="muted push-right">共 {{ candidates.pagination.total }} 条 · 当前 {{ candidates.pagination.page }}/{{ candidates.pagination.totalPages }} 页</span>
    </div>

    <div v-if="candidates.loading" class="empty">正在加载候选记忆...</div>
    <div v-else-if="!candidates.items.length" class="empty">当前筛选下没有候选记忆。</div>
    <div v-else class="candidate-list">
      <article v-for="item in candidates.items" :key="item.id" class="candidate-row" :class="{ active: activeId === item.id }">
        <input type="checkbox" :checked="candidates.selectedIds.has(item.id)" :disabled="isBusy(item.id) || item.status !== 'pending'" @change="candidates.toggle(item.id)" />
        <div class="candidate-main">
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
              <label>记忆成员
                <SearchableSelect
                  v-model="editForm.subjectUserId"
                  :options="memberSelectOptions"
                  placeholder="搜索成员昵称或 QQ"
                  empty-label="未选择成员"
                  :disabled="editForm.type === 'group_fact'"
                />
              </label>
              <label>置信度<input v-model.number="editForm.confidence" class="input" type="number" min="0" max="1" step="0.01" /></label>
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
                <span class="tag" :class="{ warn: item.status === 'pending', danger: item.status === 'rejected' }">{{ statusLabel(item.status) }}</span>
                <span class="tag">{{ typeLabel(item.type) }}</span>
                <span v-if="needsSubject(item)" class="tag danger">待归属成员</span>
              </div>
            </div>
            <p class="row-content">{{ item.content }}</p>
            <p v-if="needsSubject(item)" class="candidate-warning">这条成员画像没有识别到 QQ，需编辑选择记忆成员后入库，或直接作为群事实入库。</p>
            <div class="row-meta-grid">
              <span>来源：{{ item.subjectLabel?.label || item.subjectUserId || "群整体" }}</span>
              <span>QQ：{{ item.subjectUserId || "--" }}</span>
              <span>置信度：{{ confidenceText(item.confidence) }}</span>
              <span>{{ formatDateTime(item.createdAt) }}</span>
            </div>
          </template>
        </div>
        <div v-if="editingId !== item.id" class="candidate-actions">
          <button class="ghost-btn strong" type="button" :disabled="isBusy(item.id) || item.status !== 'pending'" @click="approveOne(item)">入长期记忆</button>
          <button class="ghost-btn" type="button" :disabled="isBusy(item.id) || item.status !== 'pending'" @click="approveOne(item, true)">作为群事实</button>
          <button class="ghost-btn" type="button" @click="openEvidence(item)">溯源</button>
          <button class="ghost-btn" type="button" :disabled="isBusy(item.id)" @click="startEdit(item)">编辑</button>
          <button class="ghost-btn" type="button" :disabled="isBusy(item.id) || item.status !== 'pending'" @click="rejectOne(item)">不采纳</button>
          <button class="ghost-btn danger" type="button" :disabled="isBusy(item.id)" @click="deleteOne(item)">删除</button>
        </div>
      </article>
    </div>

    <div class="pager">
      <button class="ghost-btn" type="button" :disabled="candidates.bulkApproving || candidates.pagination.page <= 1" @click="candidates.pagination.page -= 1">上一页</button>
      <span class="muted">第 {{ candidates.pagination.page }} / {{ candidates.pagination.totalPages }} 页</span>
      <button class="ghost-btn" type="button" :disabled="candidates.bulkApproving || candidates.pagination.page >= candidates.pagination.totalPages" @click="candidates.pagination.page += 1">下一页</button>
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
  grid-template-columns: minmax(260px, 1.4fr) repeat(3, minmax(150px, 0.55fr));
  gap: 16px;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--surface-raised);
  padding: 16px;
  margin-bottom: 16px;
}

.filter-card label,
.edit-grid label {
  display: grid;
  gap: 8px;
  color: var(--muted);
  font-weight: 700;
}

.tabs {
  display: flex;
  gap: 22px;
  border-bottom: 1px solid var(--line);
  margin: 4px -22px 16px;
  padding: 0 22px;
}

.tabs button {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 48px;
  border-bottom: 3px solid transparent;
  background: transparent;
  color: var(--muted);
  font-weight: 800;
}

.tabs .active {
  border-color: var(--accent-strong);
  color: var(--accent-strong);
}

.tabs span {
  border-radius: 999px;
  background: var(--surface-soft);
  padding: 2px 8px;
  font-size: 12px;
}

.push-right {
  margin-left: auto;
}

.candidate-list {
  display: grid;
  gap: 10px;
}

.candidate-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 16px;
  align-items: start;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--surface-raised);
  padding: 16px;
}

.candidate-row.active {
  border-color: color-mix(in oklch, var(--accent) 55%, var(--line));
}

.candidate-main {
  min-width: 0;
}

.row-tags,
.row-actions,
.candidate-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.candidate-main > .row-actions {
  margin-top: 14px;
}

.candidate-actions {
  justify-content: flex-end;
  max-width: 360px;
}

.candidate-actions .ghost-btn {
  min-height: 34px;
  padding: 0 12px;
}

.candidate-actions .strong {
  color: var(--accent-strong);
  border-color: color-mix(in oklch, var(--accent) 45%, var(--line));
}

.candidate-actions .danger {
  color: var(--danger);
}

.row-meta-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  color: var(--muted);
  font-size: 13px;
}

.candidate-warning {
  margin: 10px 0 12px;
  border: 1px solid color-mix(in oklch, var(--warning) 45%, var(--line));
  border-radius: var(--radius-sm);
  background: color-mix(in oklch, var(--warning) 16%, var(--surface));
  color: var(--text);
  padding: 9px 11px;
  line-height: 1.55;
}

.edit-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

.wide {
  grid-column: 1 / -1;
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
  .candidate-row,
  .row-meta-grid,
  .edit-grid {
    grid-template-columns: 1fr;
  }

  .candidate-actions {
    justify-content: flex-start;
    max-width: none;
  }
}
</style>
