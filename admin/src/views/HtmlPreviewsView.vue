<script setup lang="ts">
import { computed, onMounted, reactive, shallowRef, watch } from "vue";

import { useRefreshEvents } from "../composables/useRefreshEvents";
import { api, queryString, type HtmlPreviewMetadata, type HtmlPreviewStatus, type Pagination } from "../services/api";
import { useAppStore } from "../stores/app";
import { formatDateTime } from "../utils/format";

const app = useAppStore();
const previews = shallowRef<HtmlPreviewMetadata[]>([]);
const loading = shallowRef(false);
const deletingIds = shallowRef(new Set<string>());
const pagination = reactive<Pagination>({ page: 1, pageSize: 20, total: 0, totalPages: 1 });
const filters = reactive<{ status: "" | HtmlPreviewStatus }>({ status: "" });
let loadSerial = 0;

const currentGroupLabel = computed(() => {
  const group = app.groups.find((item) => item.groupId === app.groupId);
  return group?.groupName ? `${group.groupName} / ${group.groupId}` : app.groupId || "未选择群";
});

function isDeleting(id: string): boolean {
  return deletingIds.value.has(id);
}

function setDeleting(id: string, deleting: boolean): void {
  const next = new Set(deletingIds.value);
  if (deleting) next.add(id);
  else next.delete(id);
  deletingIds.value = next;
}

function previewHref(item: HtmlPreviewMetadata): string | undefined {
  // The server emits this URL. Keep the UI defensive so a malformed stored
  // value can never turn an ordinary click into a script/data URL execution.
  try {
    const url = new URL(item.previewUrl);
    if (url.protocol !== "https:" || url.hostname !== "preview.9958.uk") return undefined;
    if (!/^\/p\/[A-Za-z0-9_-]{20,}\/$/.test(url.pathname)) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function statusLabel(status: HtmlPreviewStatus): string {
  return ({
    pending: "生成中",
    published: "可访问",
    failed: "生成失败",
    expired: "已过期",
    deleted: "已删除",
  } as Record<HtmlPreviewStatus, string>)[status] || status;
}

function statusClass(status: HtmlPreviewStatus): string {
  return status === "published" ? "ok" : status === "pending" ? "pending" : "danger";
}

function formatBytes(value?: number): string {
  if (!Number.isFinite(value) || !value || value < 0) return "-";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

async function load(): Promise<void> {
  const groupId = app.groupId;
  const serial = ++loadSerial;
  if (!groupId) {
    previews.value = [];
    Object.assign(pagination, { page: 1, total: 0, totalPages: 1 });
    return;
  }
  loading.value = true;
  try {
    const data = await api<{ previews: HtmlPreviewMetadata[]; pagination: Pagination }>(`/api/html-previews${queryString({
      groupId,
      status: filters.status || undefined,
      page: pagination.page,
      pageSize: pagination.pageSize,
    })}`);
    if (serial !== loadSerial || groupId !== app.groupId) return;
    previews.value = data.previews;
    Object.assign(pagination, data.pagination);
  } finally {
    if (serial === loadSerial) loading.value = false;
  }
}

function applyFilters(): void {
  if (pagination.page !== 1) {
    pagination.page = 1;
    return;
  }
  void load().catch((error) => app.showToast((error as Error).message, "error"));
}

async function deletePreview(item: HtmlPreviewMetadata): Promise<void> {
  if (!confirm(`立即删除网页预览「${item.title}」？删除后链接将无法访问。`)) return;
  setDeleting(item.id, true);
  try {
    await api<{ ok: boolean }>(`/api/html-previews/${encodeURIComponent(item.id)}`, { method: "DELETE" });
    app.showToast("网页预览已删除");
    if (previews.value.length === 1 && pagination.page > 1) pagination.page -= 1;
    else await load();
  } catch (error) {
    app.showToast((error as Error).message, "error");
  } finally {
    setDeleting(item.id, false);
  }
}

function resetFilters(): void {
  filters.status = "";
  applyFilters();
}

watch(() => app.groupId, () => {
  loadSerial += 1;
  previews.value = [];
  if (pagination.page !== 1) {
    pagination.page = 1;
    return;
  }
  void load().catch((error) => app.showToast((error as Error).message, "error"));
});

watch(() => [pagination.page, pagination.pageSize], () => {
  if (app.groupId) void load().catch((error) => app.showToast((error as Error).message, "error"));
});

onMounted(() => {
  void load().catch((error) => app.showToast((error as Error).message, "error"));
});

useRefreshEvents({ refresh: () => void load().catch((error) => app.showToast((error as Error).message, "error")), groupChanged: () => {} });
</script>

<template>
  <section class="page">
    <section class="panel">
      <div class="section-head">
        <div>
          <h2>网页预览 <span class="tag">{{ pagination.total }}</span></h2>
          <p>查看和删除由会仙在当前群生成的静态网页。页面内容不会在后台加载或展示。</p>
        </div>
        <button class="btn" type="button" :disabled="loading" @click="load">
          {{ loading ? "刷新中..." : "刷新" }}
        </button>
      </div>

      <div class="preview-summary">
        <article>
          <span>当前群</span>
          <strong>{{ currentGroupLabel }}</strong>
        </article>
        <article>
          <span>留存规则</span>
          <strong>生成后 30 天</strong>
        </article>
        <article>
          <span>当前结果</span>
          <strong>{{ previews.length }} / {{ pagination.total }}</strong>
        </article>
      </div>

      <div class="preview-toolbar">
        <label>状态
          <select v-model="filters.status" class="select" @change="applyFilters">
            <option value="">全部状态</option>
            <option value="published">可访问</option>
            <option value="pending">生成中</option>
            <option value="failed">生成失败</option>
            <option value="expired">已过期</option>
            <option value="deleted">已删除</option>
          </select>
        </label>
        <label>每页数量
          <select v-model="pagination.pageSize" class="select">
            <option :value="10">10 条 / 页</option>
            <option :value="20">20 条 / 页</option>
            <option :value="50">50 条 / 页</option>
          </select>
        </label>
        <div class="toolbar-actions">
          <button class="ghost-btn" type="button" :disabled="loading" @click="resetFilters">重置</button>
        </div>
      </div>

      <div v-if="loading" class="empty">正在读取网页预览...</div>
      <div v-else-if="!previews.length" class="empty-state">
        <div class="empty-visual">HTML</div>
        <div>
          <h3>暂无网页预览</h3>
          <p>群成员通过 #网页 或让会仙生成静态 HTML 页面后，链接会显示在这里。</p>
        </div>
      </div>
      <div v-else class="preview-table">
        <div class="preview-table-head">
          <span>网页</span>
          <span>状态</span>
          <span>创建者</span>
          <span>创建时间</span>
          <span>到期时间</span>
          <span>大小</span>
          <span>操作</span>
        </div>
        <article v-for="item in previews" :key="item.id" class="preview-row">
          <div class="preview-title">
            <strong>{{ item.title || "未命名网页" }}</strong>
            <small>{{ item.id }}</small>
          </div>
          <span class="tag" :class="statusClass(item.status)">{{ statusLabel(item.status) }}</span>
          <span class="muted">{{ item.creatorUserId || "-" }}</span>
          <span class="muted">{{ formatDateTime(item.createdAt) }}</span>
          <span class="muted">{{ formatDateTime(item.expiresAt) }}</span>
          <span>{{ formatBytes(item.byteSize) }}</span>
          <div class="row-actions">
            <a
              v-if="previewHref(item) && item.status === 'published'"
              class="ghost-btn preview-link"
              :href="previewHref(item)"
              target="_blank"
              rel="noopener noreferrer"
            >打开预览</a>
            <span v-else class="muted unavailable">不可访问</span>
            <button class="ghost-btn danger" type="button" :disabled="isDeleting(item.id)" @click="deletePreview(item)">
              {{ isDeleting(item.id) ? "删除中..." : "删除" }}
            </button>
          </div>
        </article>
      </div>

      <div class="pager">
        <button class="ghost-btn" type="button" :disabled="loading || pagination.page <= 1" @click="pagination.page -= 1">上一页</button>
        <span class="muted">第 {{ pagination.page }} / {{ pagination.totalPages }} 页</span>
        <button class="ghost-btn" type="button" :disabled="loading || pagination.page >= pagination.totalPages" @click="pagination.page += 1">下一页</button>
      </div>
    </section>
  </section>
</template>

<style scoped>
.preview-summary,
.preview-toolbar {
  display: grid;
  gap: 12px;
  margin-bottom: 14px;
}

.preview-summary {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.preview-summary article,
.preview-toolbar {
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--surface-raised);
  padding: 14px;
}

.preview-summary article {
  display: grid;
  gap: 6px;
  min-width: 0;
}

.preview-summary span,
.preview-summary strong,
.preview-title small,
.muted {
  color: var(--muted);
}

.preview-summary strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.preview-toolbar {
  grid-template-columns: minmax(160px, 220px) minmax(140px, 180px) auto;
  align-items: end;
}

.preview-toolbar label {
  display: grid;
  gap: 8px;
  color: var(--muted);
  font-weight: 800;
}

.toolbar-actions {
  display: flex;
  justify-content: flex-end;
}

.preview-table {
  overflow: auto;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
}

.preview-table-head,
.preview-row {
  display: grid;
  grid-template-columns: minmax(220px, 1.35fr) 90px 120px 170px 170px 82px minmax(180px, auto);
  gap: 14px;
  align-items: center;
  min-width: 1120px;
  padding: 12px 16px;
}

.preview-table-head {
  background: var(--surface-soft);
  color: var(--muted);
  font-size: 13px;
  font-weight: 900;
}

.preview-row {
  border-top: 1px solid var(--line);
  background: var(--surface-raised);
}

.preview-title {
  display: grid;
  gap: 5px;
  min-width: 0;
}

.preview-title strong,
.preview-title small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.preview-link {
  text-decoration: none;
}

.danger {
  color: var(--danger);
}

.tag.ok {
  color: var(--success, #16825d);
}

.tag.pending {
  color: var(--accent-strong);
}

.unavailable {
  min-width: 68px;
}

.empty-state {
  display: grid;
  grid-template-columns: 190px minmax(0, 1fr);
  align-items: center;
  gap: 24px;
  min-height: 210px;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--surface-raised);
  padding: 28px;
}

.empty-visual {
  display: grid;
  place-items: center;
  min-height: 110px;
  border-radius: var(--radius-md);
  background: color-mix(in oklch, var(--accent-soft) 72%, var(--surface));
  color: var(--accent-strong);
  font-size: 28px;
  font-weight: 900;
}

.empty-state h3,
.empty-state p {
  margin: 0;
}

.empty-state p {
  margin-top: 8px;
  color: var(--muted);
}

.pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 14px;
  margin-top: 18px;
}

@media (max-width: 900px) {
  .preview-summary,
  .preview-toolbar,
  .empty-state {
    grid-template-columns: 1fr;
  }

  .toolbar-actions .ghost-btn {
    flex: 1;
  }
}
</style>
