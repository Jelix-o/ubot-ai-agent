<script setup lang="ts">
import { computed, onMounted, reactive, shallowRef, watch } from "vue";

import { useRefreshEvents } from "../composables/useRefreshEvents";
import { api, queryString, type AdminOperationLogEntry } from "../services/api";
import { useAppStore } from "../stores/app";
import { formatDateTime } from "../utils/format";

const app = useAppStore();
const entries = shallowRef<AdminOperationLogEntry[]>([]);
const activeEntry = shallowRef<AdminOperationLogEntry | null>(null);
const loading = shallowRef(false);
const filters = reactive({
  q: "",
  action: "",
  scope: "current" as "current" | "all",
  limit: 50,
});

const visibleEntries = computed(() => entries.value);
const canUseAllGroups = computed(() => app.role === "super_admin");
const activeEntryMeta = computed(() => {
  const entry = activeEntry.value;
  if (!entry) return [];
  return [
    { label: "操作时间", value: formatDateTime(entry.timestamp) },
    { label: "动作", value: actionLabel(entry.action) },
    { label: "动作代码", value: entry.action },
    { label: "操作者", value: entry.operatorUserId },
    { label: "群 ID", value: entry.groupId || "-" },
    { label: "目标", value: entry.target || "-" },
  ];
});
const currentGroupLabel = computed(() => {
  const group = app.groups.find((item) => item.groupId === app.groupId);
  return group?.groupName ? `${group.groupName} / ${group.groupId}` : app.groupId || "未选择群";
});

async function load(): Promise<void> {
  loading.value = true;
  try {
    const groupId = filters.scope === "all" && canUseAllGroups.value ? undefined : app.groupId;
    const data = await api<{ entries: AdminOperationLogEntry[] }>(`/api/logs${queryString({
      groupId,
      q: filters.q.trim(),
      action: filters.action.trim(),
      limit: filters.limit,
    })}`);
    entries.value = data.entries;
  } finally {
    loading.value = false;
  }
}

function applyFilters(): void {
  void load().catch((error) => app.showToast(error.message, "error"));
}

function actionLabel(action: string): string {
  return ({
    memory_dedup_apply: "记忆去重",
    candidate_bulk_approve: "批量审核",
    profile_generate: "画像生成",
    profile_refresh: "画像刷新",
    profile_share_revoke: "撤销公开",
    profile_share_update: "公开链接",
    model_check: "模型检测",
  } as Record<string, string>)[action] || action;
}

function detailLabel(entry: AdminOperationLogEntry): string {
  const detail = entry.detail || "";
  if (!detail) return "暂无详情。";
  if (entry.action === "model_check") {
    const ok = detail.match(/^ok\s+(\d+)ms$/i);
    if (ok) return `模型连接正常，延迟 ${ok[1]}ms。`;
    return `模型检测不通过：${detail}`;
  }
  if (entry.action === "memory_dedup_apply") {
    return detail
      .replace(/^applied=(\d+);\s*skipped=(\d+)$/i, "已处理 $1 条，跳过 $2 条。")
      .replace(/^(\d+) decisions$/i, "$1 条去重建议");
  }
  if (entry.action === "profile_share_revoke") return "已撤销画像公开链接。";
  if (entry.action === "profile_share_update") return "已更新画像公开链接。";
  if (entry.action === "profile_generate") return `生成画像：${profileTypeText(detail)}`;
  if (entry.action === "profile_refresh") return `刷新画像：${profileTypeText(detail)}`;
  return detail;
}

function profileTypeText(value: string): string {
  return value === "yesterday" ? "昨日画像" : value === "overall" ? "群聊画像" : value || "未指定类型";
}

function resetFilters(): void {
  filters.q = "";
  filters.action = "";
  filters.scope = "current";
  filters.limit = 50;
  applyFilters();
}

function openEntryDetail(entry: AdminOperationLogEntry): void {
  activeEntry.value = entry;
}

function closeEntryDetail(): void {
  activeEntry.value = null;
}

function onRefresh(): void {
  void load().catch((error) => app.showToast(error.message, "error"));
}

onMounted(() => {
  void load();
});

useRefreshEvents({ refresh: onRefresh, groupChanged: onRefresh });

watch(() => app.role, () => {
  if (!canUseAllGroups.value) filters.scope = "current";
});
</script>

<template>
  <section class="page">
    <section class="panel">
      <div class="section-head">
        <div>
          <h2>操作审计 <span class="tag">{{ visibleEntries.length }}</span></h2>
          <p>按群、操作者、动作和目标追踪后台管理行为。</p>
        </div>
        <button class="btn" type="button" :disabled="loading" @click="load">
          {{ loading ? "刷新中..." : "刷新" }}
        </button>
      </div>

      <div class="audit-summary">
        <article>
          <span>查询范围</span>
          <strong>{{ filters.scope === "all" && canUseAllGroups ? "全部群" : currentGroupLabel }}</strong>
        </article>
        <article>
          <span>返回数量</span>
          <strong>{{ visibleEntries.length }} / {{ filters.limit }}</strong>
        </article>
        <article>
          <span>最近时间</span>
          <strong>{{ visibleEntries[0] ? formatDateTime(visibleEntries[0].timestamp) : "-" }}</strong>
        </article>
      </div>

      <div class="filter-card">
        <label>关键词
          <input v-model="filters.q" class="input" placeholder="操作者、动作、目标或详情" @keyup.enter="applyFilters" />
        </label>
        <label>动作
          <input v-model="filters.action" class="input" placeholder="例如 profile、model、dedup" @keyup.enter="applyFilters" />
        </label>
        <label>范围
          <select v-model="filters.scope" class="select" :disabled="!canUseAllGroups" @change="applyFilters">
            <option value="current">当前群</option>
            <option value="all">全部群</option>
          </select>
        </label>
        <label>数量
          <select v-model="filters.limit" class="select" @change="applyFilters">
            <option :value="20">20</option>
            <option :value="50">50</option>
            <option :value="100">100</option>
            <option :value="200">200</option>
          </select>
        </label>
        <div class="filter-actions">
          <button class="ghost-btn" type="button" @click="resetFilters">重置</button>
          <button class="btn" type="button" :disabled="loading" @click="applyFilters">查询</button>
        </div>
      </div>

      <div v-if="loading" class="empty compact">正在加载操作日志...</div>
      <div v-else-if="!visibleEntries.length" class="empty compact">暂无匹配的操作记录。</div>
      <div v-else class="audit-table">
        <div class="audit-head">
          <span>时间</span>
          <span>动作</span>
          <span>操作者</span>
          <span>群</span>
          <span>目标</span>
          <span>详情</span>
          <span>操作</span>
        </div>
        <article
          v-for="entry in visibleEntries"
          :key="`${entry.timestamp}:${entry.groupId}:${entry.action}:${entry.target || ''}`"
          class="audit-row"
          :class="{ active: activeEntry === entry }"
        >
          <span class="muted">{{ formatDateTime(entry.timestamp) }}</span>
          <span class="tag">{{ actionLabel(entry.action) }}</span>
          <strong>{{ entry.operatorUserId }}</strong>
          <span>{{ entry.groupId }}</span>
          <span class="muted">{{ entry.target || "-" }}</span>
          <span class="detail">{{ detailLabel(entry) }}</span>
          <button class="link-btn row-action" type="button" @click="openEntryDetail(entry)">查看详情</button>
        </article>
      </div>

      <section v-if="activeEntry" class="audit-detail" aria-live="polite">
        <div class="detail-head">
          <div>
            <h3>{{ actionLabel(activeEntry.action) }}</h3>
            <p>{{ activeEntry.target || "无目标对象" }}</p>
          </div>
          <button class="ghost-btn" type="button" @click="closeEntryDetail">收起</button>
        </div>
        <div class="detail-body">
          <dl class="detail-list">
            <template v-for="item in activeEntryMeta" :key="item.label">
              <dt>{{ item.label }}</dt>
              <dd>{{ item.value }}</dd>
            </template>
          </dl>
          <div class="detail-text">
            <h4>完整详情</h4>
            <p>{{ detailLabel(activeEntry) }}</p>
          </div>
        </div>
      </section>
    </section>
  </section>
</template>

<style scoped>
.audit-summary,
.filter-card {
  display: grid;
  gap: 12px;
}

.audit-summary {
  grid-template-columns: 1.2fr 0.7fr 1fr;
  margin-bottom: 14px;
}

.audit-summary article,
.filter-card {
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--surface-raised);
  padding: 14px;
}

.audit-summary article {
  display: grid;
  gap: 6px;
  min-width: 0;
}

.audit-summary span {
  color: var(--muted);
}

.audit-summary strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.filter-card {
  grid-template-columns: minmax(180px, 1fr) minmax(180px, 1fr) 130px 110px auto;
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
  gap: 8px;
  justify-content: flex-end;
}

.audit-table {
  overflow: auto;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
}

.audit-head,
.audit-row {
  display: grid;
  grid-template-columns: 180px 110px 130px 140px 150px minmax(260px, 1fr) 96px;
  gap: 14px;
  align-items: center;
  min-width: 1190px;
  border-bottom: 1px solid var(--line);
  padding: 12px 16px;
}

.audit-head {
  position: sticky;
  top: 0;
  background: var(--surface-soft);
  color: var(--muted);
  font-size: 13px;
  font-weight: 900;
}

.audit-row:last-child {
  border-bottom: 0;
}

.audit-row.active {
  background: var(--surface-soft);
}

.detail {
  overflow: hidden;
  color: var(--muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-action {
  justify-self: start;
}

.audit-detail {
  margin-top: 16px;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--surface-raised);
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
.detail-list,
.detail-text h4,
.detail-text p {
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
  grid-template-columns: minmax(320px, 0.9fr) minmax(360px, 1.1fr);
}

.detail-list {
  display: grid;
  grid-template-columns: 84px minmax(0, 1fr);
  gap: 10px 12px;
  padding: 16px;
  border-right: 1px solid var(--line);
}

.detail-list dt {
  color: var(--muted);
  font-weight: 800;
}

.detail-list dd {
  min-width: 0;
  overflow-wrap: anywhere;
}

.detail-text {
  min-width: 0;
  padding: 16px;
}

.detail-text h4 {
  margin-bottom: 12px;
  font-size: 14px;
}

.detail-text p {
  overflow-wrap: anywhere;
  color: var(--text);
  line-height: 1.7;
}

.compact {
  min-height: 120px;
}

@media (max-width: 960px) {
  .audit-summary,
  .filter-card {
    grid-template-columns: 1fr;
  }

  .filter-actions {
    justify-content: stretch;
  }

  .filter-actions .btn,
  .filter-actions .ghost-btn {
    flex: 1;
  }

  .detail-body {
    grid-template-columns: 1fr;
  }

  .detail-list {
    border-right: 0;
    border-bottom: 1px solid var(--line);
  }
}
</style>
