<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, shallowRef, watch } from "vue";

import { useRefreshEvents } from "../composables/useRefreshEvents";
import { api, queryString, type AdminTaskRecord, type AdminTaskStatus, type AdminTaskType, type Pagination } from "../services/api";
import { useAppStore } from "../stores/app";
import { formatDateTime } from "../utils/format";

const app = useAppStore();
const tasks = shallowRef<AdminTaskRecord[]>([]);
const activeTask = shallowRef<AdminTaskRecord | null>(null);
const loading = shallowRef(false);
const detailLoading = shallowRef(false);
let refreshTimer: ReturnType<typeof setInterval> | undefined;
const pagination = reactive<Pagination>({ page: 1, pageSize: 20, total: 0, totalPages: 1 });
const filters = reactive({
  q: "",
  scope: "all" as "current" | "all",
  type: "" as "" | AdminTaskType,
  status: "" as "" | AdminTaskStatus,
});

const runningCount = computed(() => tasks.value.filter((task) => task.status === "queued" || task.status === "running").length);
const canUseAllGroups = computed(() => app.role === "super_admin");
const currentGroupLabel = computed(() => {
  const group = app.groups.find((item) => item.groupId === app.groupId);
  return group?.groupName ? `${group.groupName} / ${group.groupId}` : app.groupId || "未选择群";
});
const queryScopeLabel = computed(() => filters.scope === "all" && canUseAllGroups.value ? "全部群" : currentGroupLabel.value);
const activeTaskResult = computed(() => {
  const task = activeTask.value;
  if (!task || task.result === undefined) return "";
  try {
    return JSON.stringify(task.result, null, 2);
  } catch {
    return String(task.result);
  }
});
const activeTaskTimeline = computed(() => {
  const task = activeTask.value;
  if (!task) return [];
  return [
    { label: "创建时间", value: formatDateTime(task.createdAt) },
    { label: "开始时间", value: task.startedAt ? formatDateTime(task.startedAt) : "-" },
    { label: "完成时间", value: task.finishedAt ? formatDateTime(task.finishedAt) : "-" },
    { label: "更新时间", value: formatDateTime(task.updatedAt) },
  ];
});
const activeTaskMeta = computed(() => {
  const task = activeTask.value;
  if (!task) return [];
  return [
    { label: "任务 ID", value: task.id },
    { label: "任务类型", value: typeLabel(task.type) },
    { label: "任务状态", value: statusLabel(task.status) },
    { label: "执行范围", value: scopeLabel(task) },
    { label: "操作人", value: task.operatorUserId || "-" },
    { label: "耗时", value: durationLabel(task) },
  ];
});

async function load(): Promise<void> {
  loading.value = true;
  try {
    const groupId = filters.scope === "all" && canUseAllGroups.value ? undefined : app.groupId;
    const data = await api<{ tasks: AdminTaskRecord[]; pagination: Pagination }>(`/api/tasks${queryString({
      groupId,
      q: filters.q.trim(),
      type: filters.type,
      status: filters.status,
      page: pagination.page,
      pageSize: pagination.pageSize,
    })}`);
    tasks.value = data.tasks;
    Object.assign(pagination, data.pagination);
    syncAutoRefresh();
    if (activeTask.value) {
      const visibleTask = data.tasks.find((task) => task.id === activeTask.value?.id);
      if (visibleTask) activeTask.value = { ...activeTask.value, ...visibleTask };
    }
  } finally {
    loading.value = false;
  }
}

function applyFilters(): void {
  pagination.page = 1;
  void load().catch((error) => app.showToast(error.message, "error"));
}

function resetFilters(): void {
  filters.q = "";
  filters.scope = canUseAllGroups.value ? "all" : "current";
  filters.type = "";
  filters.status = "";
  pagination.page = 1;
  void load().catch((error) => app.showToast(error.message, "error"));
}

function statusLabel(status: AdminTaskStatus): string {
  return ({
    queued: "排队中",
    running: "执行中",
    succeeded: "已完成",
    failed: "失败",
    cancelled: "已取消",
  } as Record<AdminTaskStatus, string>)[status];
}

function typeLabel(type: AdminTaskType): string {
  return ({
    "memory-dedup": "记忆去重",
    "profile-generate": "画像生成",
    "model-check": "模型检测",
    "bulk-review": "批量审核",
  } as Record<AdminTaskType, string>)[type];
}

function statusClass(status: AdminTaskStatus): Record<string, boolean> {
  return {
    danger: status === "failed",
    warn: status === "running" || status === "queued",
  };
}

function scopeLabel(task: AdminTaskRecord): string {
  const group = task.groupId || "system";
  return task.subjectUserId ? `${group} / ${task.subjectUserId}` : group;
}

function resultSummary(task: AdminTaskRecord): string {
  if (task.error) return task.error;
  if (task.result === undefined) return task.detail || "-";
  try {
    return JSON.stringify(task.result).slice(0, 220);
  } catch {
    return String(task.result).slice(0, 220);
  }
}

function durationLabel(task: AdminTaskRecord): string {
  if (task.durationMs === undefined) return "-";
  if (task.durationMs < 1000) return `${task.durationMs}ms`;
  return `${Math.round(task.durationMs / 100) / 10}s`;
}

async function openTaskDetail(task: AdminTaskRecord): Promise<void> {
  activeTask.value = task;
  detailLoading.value = true;
  try {
    activeTask.value = await api<AdminTaskRecord>(`/api/tasks/${encodeURIComponent(task.id)}`);
  } catch (error) {
    app.showToast(error instanceof Error ? error.message : "任务详情加载失败", "error");
  } finally {
    detailLoading.value = false;
  }
}

function closeTaskDetail(): void {
  activeTask.value = null;
}

function syncAutoRefresh(): void {
  if (runningCount.value > 0) {
    if (!refreshTimer) {
      refreshTimer = setInterval(() => {
        if (!loading.value) {
          void load().catch((error) => app.showToast(error.message, "error"));
        }
      }, 5000);
    }
    return;
  }
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = undefined;
  }
}

function onRefresh(): void {
  void load().catch((error) => app.showToast(error.message, "error"));
}

onMounted(() => {
  void load();
});

onUnmounted(() => {
  if (refreshTimer) {
    clearInterval(refreshTimer);
  }
});

useRefreshEvents({ refresh: onRefresh, groupChanged: onRefresh });

watch(() => app.role, () => {
  if (!canUseAllGroups.value) filters.scope = "current";
}, { immediate: true });

watch(() => [pagination.page, pagination.pageSize], () => {
  void load();
});
</script>

<template>
  <section class="page">
    <section class="panel">
      <div class="section-head">
        <div>
          <h2>任务中心 <span class="tag">{{ pagination.total }}</span></h2>
          <p>追踪去重、画像生成、模型检测和批量审核等耗时管理任务。</p>
        </div>
        <button class="btn" type="button" :disabled="loading" @click="load">
          {{ loading ? "刷新中..." : "刷新" }}
        </button>
      </div>

      <div class="task-summary">
        <article>
          <span>进行中</span>
          <strong>{{ runningCount }}</strong>
        </article>
        <article>
          <span>总任务</span>
          <strong>{{ pagination.total }}</strong>
        </article>
        <article>
          <span>查询范围</span>
          <strong>{{ queryScopeLabel }}</strong>
        </article>
        <article>
          <span>当前页</span>
          <strong>{{ pagination.page }} / {{ pagination.totalPages }}</strong>
        </article>
      </div>

      <div class="filter-card">
        <label>关键词
          <input v-model="filters.q" class="input" placeholder="任务 ID、标题、操作者、目标或结果" @keyup.enter="applyFilters" />
        </label>
        <label>范围
          <select v-model="filters.scope" class="select" :disabled="!canUseAllGroups" @change="applyFilters">
            <option value="current">当前群</option>
            <option value="all">全部群</option>
          </select>
        </label>
        <label>任务类型
          <select v-model="filters.type" class="select" @change="applyFilters">
            <option value="">全部类型</option>
            <option value="memory-dedup">记忆去重</option>
            <option value="profile-generate">画像生成</option>
            <option value="model-check">模型检测</option>
            <option value="bulk-review">批量审核</option>
          </select>
        </label>
        <label>任务状态
          <select v-model="filters.status" class="select" @change="applyFilters">
            <option value="">全部状态</option>
            <option value="queued">排队中</option>
            <option value="running">执行中</option>
            <option value="succeeded">已完成</option>
            <option value="failed">失败</option>
            <option value="cancelled">已取消</option>
          </select>
        </label>
        <label>每页数量
          <select v-model="pagination.pageSize" class="select">
            <option :value="10">10</option>
            <option :value="20">20</option>
            <option :value="50">50</option>
          </select>
        </label>
        <div class="filter-actions">
          <button class="ghost-btn" type="button" @click="resetFilters">重置</button>
          <button class="btn" type="button" :disabled="loading" @click="applyFilters">查询</button>
        </div>
      </div>

      <div v-if="loading" class="empty compact">正在加载任务...</div>
      <div v-else-if="!tasks.length" class="empty compact">暂无匹配的任务记录。</div>
      <div v-else class="task-table">
        <div class="task-table-head">
          <span>任务</span>
          <span>状态</span>
          <span>进度</span>
          <span>范围</span>
          <span>耗时</span>
          <span>更新时间</span>
          <span>操作</span>
        </div>
        <article v-for="task in tasks" :key="task.id" class="task-row" :class="{ active: activeTask?.id === task.id }">
          <div class="task-title">
            <strong>{{ task.title }}</strong>
            <small>{{ typeLabel(task.type) }} · {{ resultSummary(task) }}</small>
          </div>
          <span class="tag" :class="statusClass(task.status)">
            {{ statusLabel(task.status) }}
          </span>
          <div class="progress-cell">
            <span>{{ task.progress }}%</span>
            <i><b :style="{ width: `${task.progress}%` }"></b></i>
          </div>
          <span class="muted">{{ scopeLabel(task) }}</span>
          <span>{{ durationLabel(task) }}</span>
          <span class="muted">{{ formatDateTime(task.updatedAt) }}</span>
          <button class="link-btn row-action" type="button" :disabled="detailLoading && activeTask?.id === task.id" @click="openTaskDetail(task)">
            {{ detailLoading && activeTask?.id === task.id ? "加载中" : "查看详情" }}
          </button>
        </article>
      </div>

      <section v-if="activeTask" class="task-detail" aria-live="polite">
        <div class="detail-head">
          <div>
            <h3>{{ activeTask.title }}</h3>
            <p>{{ activeTask.detail || "任务详情已从执行记录读取。" }}</p>
          </div>
          <button class="ghost-btn" type="button" @click="closeTaskDetail">收起</button>
        </div>
        <div class="detail-body">
          <div class="detail-block">
            <h4>基础信息</h4>
            <dl class="detail-list">
              <template v-for="item in activeTaskMeta" :key="item.label">
                <dt>{{ item.label }}</dt>
                <dd>{{ item.value }}</dd>
              </template>
            </dl>
          </div>
          <div class="detail-block">
            <h4>执行时间线</h4>
            <dl class="detail-list">
              <template v-for="item in activeTaskTimeline" :key="item.label">
                <dt>{{ item.label }}</dt>
                <dd>{{ item.value }}</dd>
              </template>
            </dl>
          </div>
          <div class="detail-block detail-result">
            <h4>执行结果</h4>
            <p v-if="activeTask.error" class="error-text">{{ activeTask.error }}</p>
            <pre v-else-if="activeTaskResult">{{ activeTaskResult }}</pre>
            <p v-else class="muted">暂无结构化结果。</p>
          </div>
        </div>
      </section>

      <div class="pager">
        <button class="ghost-btn" type="button" :disabled="pagination.page <= 1" @click="pagination.page -= 1">上一页</button>
        <span class="muted">第 {{ pagination.page }} / {{ pagination.totalPages }} 页</span>
        <button class="ghost-btn" type="button" :disabled="pagination.page >= pagination.totalPages" @click="pagination.page += 1">下一页</button>
      </div>
    </section>
  </section>
</template>

<style scoped>
.task-summary,
.filter-card {
  display: grid;
  gap: 12px;
  min-width: 0;
  max-width: 100%;
}

.page,
.panel {
  min-width: 0;
  max-width: 100%;
}

.task-summary {
  grid-template-columns: repeat(4, minmax(0, 1fr));
  margin-bottom: 14px;
}

.task-summary article,
.filter-card {
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--surface-raised);
  padding: 14px;
}

.task-summary article {
  display: grid;
  gap: 6px;
  min-width: 0;
}

.task-summary span,
.task-title small {
  color: var(--muted);
}

.task-summary strong {
  font-size: 24px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.filter-card {
  grid-template-columns: minmax(220px, 1.2fr) 130px minmax(160px, 0.8fr) minmax(160px, 0.8fr) 120px auto;
  align-items: end;
  margin-bottom: 14px;
}

.filter-card label {
  display: grid;
  gap: 8px;
  color: var(--muted);
  font-weight: 800;
}

.filter-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  min-width: 0;
}

.task-table {
  width: 100%;
  min-width: 0;
  max-width: 100%;
  overflow: auto;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
}

.task-table-head,
.task-row {
  display: grid;
  grid-template-columns: minmax(280px, 1.2fr) 120px 150px 180px 100px 170px 96px;
  gap: 14px;
  align-items: center;
  min-width: 1130px;
  border-bottom: 1px solid var(--line);
  padding: 12px 16px;
}

.task-table-head {
  position: sticky;
  top: 0;
  background: var(--surface-soft);
  color: var(--muted);
  font-size: 13px;
  font-weight: 900;
}

.task-row:last-child {
  border-bottom: 0;
}

.task-row.active {
  background: var(--surface-soft);
}

.task-title {
  display: grid;
  gap: 5px;
  min-width: 0;
}

.task-title strong,
.task-title small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.progress-cell {
  display: grid;
  gap: 6px;
}

.progress-cell i {
  display: block;
  height: 8px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--surface-soft);
}

.progress-cell b {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--accent-strong);
}

.row-action {
  justify-self: start;
}

.task-detail {
  margin-top: 16px;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--surface-raised);
  overflow: hidden;
}

.detail-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 16px;
  border-bottom: 1px solid var(--line);
  background: var(--surface-soft);
}

.detail-head h3,
.detail-head p,
.detail-block h4,
.detail-list {
  margin: 0;
}

.detail-head h3 {
  font-size: 16px;
}

.detail-head p {
  margin-top: 6px;
  color: var(--muted);
}

.detail-body {
  display: grid;
  grid-template-columns: minmax(260px, 0.9fr) minmax(240px, 0.8fr) minmax(320px, 1.2fr);
  gap: 0;
}

.detail-block {
  min-width: 0;
  padding: 16px;
  border-right: 1px solid var(--line);
}

.detail-block:last-child {
  border-right: 0;
}

.detail-block h4 {
  margin-bottom: 12px;
  color: var(--text);
  font-size: 14px;
}

.detail-list {
  display: grid;
  grid-template-columns: 84px minmax(0, 1fr);
  gap: 10px 12px;
}

.detail-list dt {
  color: var(--muted);
  font-weight: 800;
}

.detail-list dd {
  min-width: 0;
  overflow-wrap: anywhere;
}

.detail-result pre {
  max-height: 260px;
  margin: 0;
  overflow: auto;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface);
  padding: 12px;
  color: var(--text);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
}

.error-text {
  margin: 0;
  color: var(--danger);
  font-weight: 800;
  overflow-wrap: anywhere;
}

.pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  margin-top: 16px;
}

.compact {
  min-height: 120px;
}

@media (max-width: 760px) {
  .task-summary,
  .filter-card {
    grid-template-columns: 1fr;
  }

  .filter-actions {
    display: grid;
    grid-template-columns: 1fr;
    justify-content: stretch;
  }

  .filter-actions .btn,
  .filter-actions .ghost-btn {
    width: 100%;
  }

  .detail-head,
  .detail-body {
    display: grid;
    grid-template-columns: 1fr;
  }

  .detail-block {
    border-right: 0;
    border-bottom: 1px solid var(--line);
  }

  .detail-block:last-child {
    border-bottom: 0;
  }
}
</style>
