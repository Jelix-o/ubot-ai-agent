<script setup lang="ts">
import { computed, onMounted, reactive, shallowRef, watch } from "vue";

import { useRefreshEvents } from "../composables/useRefreshEvents";
import { api, queryString, type AdminTaskRecord, type AdminTaskStatus, type AdminTaskType, type Pagination } from "../services/api";
import { useAppStore } from "../stores/app";
import { formatDateTime } from "../utils/format";

const app = useAppStore();
const tasks = shallowRef<AdminTaskRecord[]>([]);
const loading = shallowRef(false);
const pagination = reactive<Pagination>({ page: 1, pageSize: 20, total: 0, totalPages: 1 });
const filters = reactive({
  type: "" as "" | AdminTaskType,
  status: "" as "" | AdminTaskStatus,
});

const runningCount = computed(() => tasks.value.filter((task) => task.status === "queued" || task.status === "running").length);

async function load(): Promise<void> {
  loading.value = true;
  try {
    const data = await api<{ tasks: AdminTaskRecord[]; pagination: Pagination }>(`/api/tasks${queryString({
      groupId: app.role === "super_admin" ? undefined : app.groupId,
      type: filters.type,
      status: filters.status,
      page: pagination.page,
      pageSize: pagination.pageSize,
    })}`);
    tasks.value = data.tasks;
    Object.assign(pagination, data.pagination);
  } finally {
    loading.value = false;
  }
}

function applyFilters(): void {
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

function onRefresh(): void {
  void load().catch((error) => app.showToast(error.message, "error"));
}

onMounted(() => {
  void load();
});

useRefreshEvents({ refresh: onRefresh, groupChanged: onRefresh });

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
          <span>当前页</span>
          <strong>{{ pagination.page }} / {{ pagination.totalPages }}</strong>
        </article>
      </div>

      <div class="filter-card">
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
        </div>
        <article v-for="task in tasks" :key="task.id" class="task-row">
          <div class="task-title">
            <strong>{{ task.title }}</strong>
            <small>{{ typeLabel(task.type) }} · {{ resultSummary(task) }}</small>
          </div>
          <span class="tag" :class="{ danger: task.status === 'failed', warn: task.status === 'running' || task.status === 'queued' }">
            {{ statusLabel(task.status) }}
          </span>
          <div class="progress-cell">
            <span>{{ task.progress }}%</span>
            <i><b :style="{ width: `${task.progress}%` }"></b></i>
          </div>
          <span class="muted">{{ task.groupId || "system" }}<template v-if="task.subjectUserId"> / {{ task.subjectUserId }}</template></span>
          <span>{{ durationLabel(task) }}</span>
          <span class="muted">{{ formatDateTime(task.updatedAt) }}</span>
        </article>
      </div>

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
}

.task-summary {
  grid-template-columns: repeat(3, minmax(0, 1fr));
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
}

.task-summary span,
.task-title small {
  color: var(--muted);
}

.task-summary strong {
  font-size: 24px;
}

.filter-card {
  grid-template-columns: minmax(160px, 1fr) minmax(160px, 1fr) 120px;
  margin-bottom: 14px;
}

.filter-card label {
  display: grid;
  gap: 8px;
  color: var(--muted);
  font-weight: 800;
}

.task-table {
  overflow: auto;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
}

.task-table-head,
.task-row {
  display: grid;
  grid-template-columns: minmax(280px, 1.2fr) 120px 150px 180px 100px 170px;
  gap: 14px;
  align-items: center;
  min-width: 1020px;
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
}
</style>
