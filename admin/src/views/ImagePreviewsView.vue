<script setup lang="ts">
import { computed, onMounted, reactive, shallowRef, watch } from "vue";

import AdminDialog from "../components/AdminDialog.vue";
import BulkPreviewDialog from "../components/BulkPreviewDialog.vue";
import ContentBulkBar from "../components/ContentBulkBar.vue";
import { confirmAction } from "../composables/useConfirm";
import { useContentBulk } from "../composables/useContentBulk";
import { useRefreshEvents } from "../composables/useRefreshEvents";
import { api, queryString, type ImagePreviewDetail, type ImagePreviewListItem, type ImagePreviewStatus, type Pagination } from "../services/api";
import { useAppStore } from "../stores/app";
import { formatDateTime } from "../utils/format";

const app = useAppStore();
const previews = shallowRef<ImagePreviewListItem[]>([]);
const { selectedIds, selectedGroupCount, preview: bulkPreview, bulkBusy, eligible, toggleSelection, toggleSelectionPage, clearSelection, prepareBulk, executeBulk } = useContentBulk("image-previews");
const loading = shallowRef(false);
const deletingIds = shallowRef(new Set<string>());
const selectedPreview = shallowRef<ImagePreviewDetail | null>(null);
const detailLoading = shallowRef(false);
const detailError = shallowRef("");
const imageUnavailable = shallowRef(false);
const pagination = reactive<Pagination>({ page: 1, pageSize: 20, total: 0, totalPages: 1 });
const filters = reactive<{ status: "" | ImagePreviewStatus }>({ status: "" });
let loadSerial = 0;
let detailSerial = 0;

const currentGroupLabel = computed(() => {
  const group = app.groups.find((item) => item.groupId === app.groupId);
  return group?.groupName ? `${group.groupName} / ${group.groupId}` : app.groupId || "未选择群";
});

function selection(item: ImagePreviewListItem) {
  return { id: item.id, groupId: item.groupId, title: item.promptSummary || item.id, status: item.status };
}

function canDelete(item: ImagePreviewListItem | ImagePreviewDetail): boolean {
  return eligible(selection(item));
}

function isDeleting(id: string): boolean {
  return deletingIds.value.has(id);
}

function setDeleting(id: string, deleting: boolean): void {
  const next = new Set(deletingIds.value);
  if (deleting) next.add(id);
  else next.delete(id);
  deletingIds.value = next;
}

function statusLabel(status: ImagePreviewStatus): string {
  return ({ available: "可预览", expired: "已过期", deleted: "已删除" } as Record<ImagePreviewStatus, string>)[status] || status;
}

function statusClass(status: ImagePreviewStatus): string {
  if (status === "available") return "ok";
  if (status === "expired") return "pending";
  return "neutral";
}

function formatBytes(value?: number): string {
  if (!Number.isFinite(value) || !value || value < 0) return "-";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function modelLabel(item: ImagePreviewListItem | ImagePreviewDetail): string {
  return item.model || item.modelId || "-";
}

function previewSrc(id: string): string {
  return `/api/image-previews/${encodeURIComponent(id)}/preview`;
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
    const data = await api<{ previews: ImagePreviewListItem[]; pagination: Pagination }>(`/api/image-previews${queryString({
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

function closeDetail(): void {
  detailSerial += 1;
  detailLoading.value = false;
  selectedPreview.value = null;
  detailError.value = "";
  imageUnavailable.value = false;
}

async function openPreview(item: ImagePreviewListItem): Promise<void> {
  const serial = ++detailSerial;
  selectedPreview.value = null;
  detailError.value = "";
  imageUnavailable.value = false;
  detailLoading.value = true;
  try {
    const data = await api<{ preview: ImagePreviewDetail }>(`/api/image-previews/${encodeURIComponent(item.id)}`);
    if (serial !== detailSerial) return;
    selectedPreview.value = data.preview;
  } catch (error) {
    if (serial !== detailSerial) return;
    detailError.value = (error as Error).message;
  } finally {
    if (serial === detailSerial) detailLoading.value = false;
  }
}

async function deletePreview(item: ImagePreviewListItem | ImagePreviewDetail): Promise<void> {
  if (!canDelete(item)) return;
  if (!await confirmAction({
    title: "删除生图预览",
    message: "删除后将标记为已删除，原图和完整提示词将无法恢复。",
    confirmText: "删除预览",
    danger: true,
  })) return;
  setDeleting(item.id, true);
  try {
    await api<{ ok: boolean }>(`/api/image-previews/${encodeURIComponent(item.id)}`, { method: "DELETE" });
    closeDetail();
    app.showToast("生图预览已删除");
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

function allVisibleSelected(): boolean {
  const selectable = previews.value.filter(canDelete);
  return selectable.length > 0 && selectable.every((item) => selectedIds.value.has(item.id));
}

function onBulkAction(action: "enable" | "disable" | "delete" | "tags"): void {
  if (action === "delete") void prepareBulk(action);
}

watch(() => app.groupId, () => {
  loadSerial += 1;
  closeDetail();
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

onMounted(() => void load().catch((error) => app.showToast((error as Error).message, "error")));
useRefreshEvents({ refresh: () => void load().catch((error) => app.showToast((error as Error).message, "error")), groupChanged: () => {} });
</script>

<template>
  <section class="page">
    <section class="panel">
      <div class="section-head">
        <div>
          <h2>生图预览 <span class="tag">{{ pagination.total }}</span></h2>
          <p>查看和删除当前群已私有留存的生图。原图和完整提示词只会在打开单项预览时加载。</p>
        </div>
        <button class="btn" type="button" :disabled="loading" @click="load">{{ loading ? "刷新中..." : "刷新" }}</button>
      </div>

      <div class="preview-summary">
        <article><span>当前群</span><strong>{{ currentGroupLabel }}</strong></article>
        <article><span>留存规则</span><strong>生成后 30 天</strong></article>
        <article><span>当前结果</span><strong>{{ previews.length }} / {{ pagination.total }}</strong></article>
      </div>

      <div class="preview-toolbar">
        <label>状态
          <select v-model="filters.status" class="select" @change="applyFilters">
            <option value="">全部状态</option>
            <option value="available">可预览</option>
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
        <div class="toolbar-actions"><button class="ghost-btn" type="button" :disabled="loading" @click="resetFilters">重置</button></div>
      </div>

      <ContentBulkBar
        :count="selectedIds.size"
        :group-count="selectedGroupCount"
        :busy="bulkBusy"
        :disabled="app.readonly"
        delete-only
        :all-selected="allVisibleSelected()"
        :has-items="previews.some(canDelete)"
        @select-page="toggleSelectionPage(previews.filter(canDelete).map(selection))"
        @clear="clearSelection"
        @action="onBulkAction"
      />

      <div v-if="loading" class="empty">正在读取生图预览...</div>
      <div v-else-if="!previews.length" class="empty-state">
        <div class="empty-visual">IMG</div>
        <div><h3>暂无生图预览</h3><p>群成员让会仙生成图片后，成功留存的图片会显示在这里。</p></div>
      </div>
      <div v-else class="preview-table">
        <div class="preview-table-head">
          <span><input type="checkbox" :checked="allVisibleSelected()" aria-label="选择当前页生图预览" @change="toggleSelectionPage(previews.filter(canDelete).map(selection))" /></span>
          <span>提示词摘要</span><span>状态</span><span>模型</span><span>创建者</span><span>创建时间</span><span>到期时间</span><span>大小</span><span>操作</span>
        </div>
        <article v-for="item in previews" :key="item.id" class="preview-row">
          <span><input type="checkbox" :checked="selectedIds.has(item.id)" :disabled="app.readonly || !canDelete(item)" :aria-label="`选择生图预览 ${item.id}`" @change="toggleSelection(selection(item))" /></span>
          <div class="prompt-summary" :title="item.promptSummary"><strong>{{ item.promptSummary || "未记录提示词摘要" }}</strong><small>{{ item.mimeType || "-" }} · {{ item.id }}</small></div>
          <span class="tag" :class="statusClass(item.status)">{{ statusLabel(item.status) }}</span>
          <div class="model-cell"><span>{{ modelLabel(item) }}</span><small v-if="item.fallbackUsed">已切备用</small></div>
          <span class="muted">{{ item.creatorUserId || "-" }}</span>
          <span class="muted">{{ formatDateTime(item.createdAt) }}</span>
          <span class="muted">{{ formatDateTime(item.expiresAt) }}</span>
          <span>{{ formatBytes(item.byteSize) }}</span>
          <div class="row-actions">
            <button v-if="item.status === 'available'" class="ghost-btn" type="button" @click="openPreview(item)">打开预览</button>
            <span v-else class="muted unavailable">不可访问</span>
            <button v-if="canDelete(item)" class="ghost-btn danger" type="button" :disabled="app.readonly || isDeleting(item.id)" @click="deletePreview(item)">{{ isDeleting(item.id) ? "删除中..." : "删除" }}</button>
          </div>
        </article>
      </div>

      <div class="pager">
        <button class="ghost-btn" type="button" :disabled="loading || pagination.page <= 1" @click="pagination.page -= 1">上一页</button>
        <span class="muted">第 {{ pagination.page }} / {{ pagination.totalPages }} 页</span>
        <button class="ghost-btn" type="button" :disabled="loading || pagination.page >= pagination.totalPages" @click="pagination.page += 1">下一页</button>
      </div>
    </section>

    <AdminDialog v-if="detailLoading || selectedPreview || detailError" title="生图预览" :busy="detailLoading" :description="selectedPreview ? formatDateTime(selectedPreview.createdAt) : '正在读取留存内容'" @close="closeDetail">
      <div v-if="detailLoading" class="dialog-state">正在读取原图和提示词...</div>
      <div v-else-if="detailError" class="dialog-state error-state">{{ detailError }}</div>
      <template v-else-if="selectedPreview">
        <div v-if="selectedPreview.status === 'available'" class="image-frame">
          <img v-if="!imageUnavailable" :src="previewSrc(selectedPreview.id)" alt="已生成图片预览" @error="imageUnavailable = true" />
          <p v-else class="dialog-state error-state">原图目前无法读取，请刷新列表后重试。</p>
        </div>
        <dl class="detail-meta">
          <div><dt>创作方式</dt><dd>{{ selectedPreview.operation === 'edit' ? '图片编辑' : '文字生图' }} · {{ selectedPreview.referenceCount || 0 }} 张参考图</dd></div>
          <div><dt>输出尺寸</dt><dd>{{ selectedPreview.outputSize === 'auto' ? '自动' : selectedPreview.outputSize || '1024x1024' }}</dd></div>
          <div v-if="selectedPreview.parentIds?.length"><dt>父版本</dt><dd v-for="id in selectedPreview.parentIds" :key="id">{{ id }}</dd></div>
          <div><dt>模型</dt><dd>{{ modelLabel(selectedPreview) }}<small v-if="selectedPreview.fallbackUsed">已切备用模型</small></dd></div>
          <div><dt>文件</dt><dd>{{ selectedPreview.mimeType }} · {{ formatBytes(selectedPreview.byteSize) }}</dd></div>
          <div><dt>创建者</dt><dd>{{ selectedPreview.creatorUserId || "-" }}</dd></div>
          <div><dt>状态</dt><dd>{{ statusLabel(selectedPreview.status) }}</dd></div>
        </dl>
        <section class="prompt-detail"><h3>完整提示词</h3><pre>{{ selectedPreview.prompt || "提示词已清除" }}</pre></section>
      </template>
      <template v-if="selectedPreview && canDelete(selectedPreview)" #footer>
        <button class="ghost-btn" type="button" @click="closeDetail">关闭</button>
        <button class="ghost-btn danger" type="button" :disabled="isDeleting(selectedPreview.id)" @click="deletePreview(selectedPreview)">{{ isDeleting(selectedPreview.id) ? "删除中..." : "删除预览" }}</button>
      </template>
    </AdminDialog>
    <BulkPreviewDialog v-if="bulkPreview" :preview="bulkPreview" :busy="bulkBusy" @close="bulkPreview = null" @execute="executeBulk" />
  </section>
</template>

<style scoped>
.page,.panel { min-width:0; }
.preview-summary,.preview-toolbar { display:grid; gap:12px; margin-bottom:12px; }
.preview-summary { grid-template-columns:repeat(3,minmax(0,1fr)); }
.preview-summary article,.preview-toolbar { border:1px solid var(--line); border-radius:var(--radius-md); background:var(--surface); padding:12px 14px; }
.preview-summary article { display:grid; gap:6px; min-width:0; }
.preview-summary span,.prompt-summary small,.model-cell small,.muted { color:var(--muted); font-size:12.5px; }
.preview-summary strong { color:var(--text-strong); font-size:14px; font-weight:650; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.preview-toolbar { grid-template-columns:minmax(160px,220px) minmax(140px,180px) auto; align-items:end; }
.preview-toolbar label { display:grid; gap:6px; color:var(--muted); font-size:12.5px; font-weight:650; }
.toolbar-actions { display:flex; justify-content:flex-end; }
.preview-table { min-width:0; max-width:100%; overflow-x:auto; overflow-y:hidden; border:1px solid var(--line); border-radius:var(--radius-md); background:var(--surface); }
.preview-table-head,.preview-row { display:grid; grid-template-columns:30px minmax(230px,1.55fr) 92px minmax(130px,.75fr) 120px 160px 160px 78px minmax(180px,auto); gap:12px; align-items:center; min-width:1430px; padding:12px 14px; }
.preview-table-head { background:var(--surface-soft); color:var(--muted); font-size:12.5px; font-weight:650; }
.preview-row { border-top:1px solid var(--line); background:var(--surface); }
.prompt-summary,.model-cell { display:grid; gap:4px; min-width:0; }
.prompt-summary strong,.prompt-summary small,.model-cell span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.prompt-summary strong { color:var(--text-strong); font-size:14px; font-weight:650; }
.model-cell span,.preview-row > span { font-size:12.5px; }
.row-actions { display:flex; align-items:center; gap:8px; }.danger { color:var(--danger); }
.tag.ok { background:var(--ok-soft); color:var(--ok); }.tag.pending { background:var(--accent-soft); color:var(--accent-strong); }.tag.neutral { background:var(--surface-soft); color:var(--muted); border:1px solid var(--line); }.unavailable { min-width:68px; }
.empty-state { display:grid; grid-template-columns:170px minmax(0,1fr); align-items:center; gap:20px; min-height:180px; border:1px solid var(--line); border-radius:var(--radius-md); background:var(--surface); padding:22px; }
.empty-visual { display:grid; place-items:center; min-height:96px; border:1px solid color-mix(in oklch,var(--accent) 24%,var(--line)); border-radius:var(--radius-md); background:color-mix(in oklch,var(--accent-soft) 55%,var(--surface)); color:var(--accent-strong); font-size:24px; font-weight:700; letter-spacing:.04em; }
.empty-state h3,.prompt-detail h3 { margin:0; font-size:14px; font-weight:650; }.empty-state p { margin:6px 0 0; color:var(--muted); font-size:12.5px; line-height:1.5; }
.pager { display:flex; align-items:center; justify-content:center; gap:10px; margin-top:14px; }.pager .ghost-btn { min-height:30px; padding:0 10px; font-size:12px; }.pager .muted { font-size:12.5px; }
.dialog-state { min-height:100px; display:grid; place-items:center; color:var(--muted); text-align:center; line-height:1.6; }.error-state { color:var(--danger); }
.image-frame { display:grid; place-items:center; min-height:180px; border:1px solid var(--line); border-radius:var(--radius-md); background:var(--surface-soft); overflow:hidden; }.image-frame img { display:block; width:100%; max-height:min(58vh,620px); object-fit:contain; }
.detail-meta { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; margin:14px 0; }.detail-meta div { min-width:0; padding:10px 12px; border:1px solid var(--line); border-radius:var(--radius-sm); background:var(--surface-soft); }.detail-meta dt { margin-bottom:5px; color:var(--muted); font-size:12px; }.detail-meta dd { margin:0; overflow-wrap:anywhere; color:var(--text-strong); font-size:13px; }.detail-meta small { display:block; margin-top:3px; color:var(--muted); }
.prompt-detail { display:grid; gap:8px; }.prompt-detail pre { max-height:250px; overflow:auto; margin:0; padding:12px; border:1px solid var(--line); border-radius:var(--radius-sm); background:var(--surface-soft); color:var(--text); font:inherit; line-height:1.65; overflow-wrap:anywhere; white-space:pre-wrap; }
@media (max-width:900px) { .preview-summary,.preview-toolbar,.empty-state,.detail-meta { grid-template-columns:1fr; }.toolbar-actions .ghost-btn { flex:1; } }
</style>
