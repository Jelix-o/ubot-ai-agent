<script setup lang="ts">
import { computed, onMounted, reactive, shallowRef, watch } from "vue";

import SearchableSelect from "../components/SearchableSelect.vue";
import { useRefreshEvents } from "../composables/useRefreshEvents";
import { api, queryString, type MemberProfile, type MemberProfileSummary, type Pagination, type ProfileRecord } from "../services/api";
import { useAppStore } from "../stores/app";
import { formatDateTime, profileTypeLabel } from "../utils/format";

const app = useAppStore();
const records = shallowRef<ProfileRecord[]>([]);
const memberOptions = shallowRef<MemberProfile[]>([]);
const activeRecord = shallowRef<ProfileRecord>();
const loading = shallowRef(false);
const detailLoading = shallowRef(false);
const generating = shallowRef(false);
const pagination = reactive<Pagination>({ page: 1, pageSize: 20, total: 0, totalPages: 1 });
const filters = reactive({
  q: "",
  userId: "",
  type: "" as "" | "overall" | "yesterday",
});
const memberSelectOptions = computed(() => memberOptions.value.map((member) => ({
  value: member.userId,
  label: `${member.displayName} / ${member.userId}`,
  hint: member.note || member.role || undefined,
})));

async function load(): Promise<void> {
  if (!app.groupId) return;
  loading.value = true;
  try {
    const data = await api<{ records: ProfileRecord[]; pagination: Pagination }>(`/api/profile-records${queryString({
      groupId: app.groupId,
      q: filters.q,
      userId: filters.userId,
      type: filters.type,
      page: pagination.page,
      pageSize: pagination.pageSize,
    })}`);
    records.value = data.records;
    Object.assign(pagination, data.pagination);
    if (activeRecord.value && !data.records.some((record) => record.id === activeRecord.value?.id)) {
      activeRecord.value = undefined;
    }
  } finally {
    loading.value = false;
  }
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

async function openRecord(record: ProfileRecord): Promise<void> {
  detailLoading.value = true;
  try {
    activeRecord.value = await api<ProfileRecord>(`/api/profile-records/${encodeURIComponent(record.id)}`);
  } catch (error) {
    app.showToast((error as Error).message, "error");
  } finally {
    detailLoading.value = false;
  }
}

async function regenerate(record?: ProfileRecord): Promise<void> {
  const target = record || activeRecord.value;
  const userId = target?.userId || filters.userId;
  const type = target?.type || filters.type || "overall";
  if (!app.groupId || !userId) {
    app.showToast("请先选择成员", "error");
    return;
  }
  generating.value = true;
  try {
    const result = await api<MemberProfileSummary>("/api/profile-records", {
      method: "POST",
      body: JSON.stringify({ groupId: app.groupId, userId, type }),
    });
    if (result.record) activeRecord.value = result.record;
    await load();
    app.showToast("画像总结已重新生成");
  } catch (error) {
    app.showToast((error as Error).message, "error");
  } finally {
    generating.value = false;
  }
}

async function removeRecord(record: ProfileRecord): Promise<void> {
  if (!confirm(`删除这条${profileTypeLabel(record.type)}记录？`)) return;
  await api(`/api/profile-records/${encodeURIComponent(record.id)}`, { method: "DELETE" });
  if (activeRecord.value?.id === record.id) activeRecord.value = undefined;
  await load();
  app.showToast("画像记录已删除");
}

function shareStatusLabel(record?: ProfileRecord): string {
  if (!record?.shareToken) return "暂无链接";
  if (record.revokedAt || record.publicEnabled === false) return "已撤销";
  if (record.expiresAt && new Date(record.expiresAt).getTime() <= Date.now()) return "已过期";
  return "公开中";
}

function shareUrl(record: ProfileRecord): string {
  return record.shareUrl || "";
}

function canUseShareUrl(record: ProfileRecord): boolean {
  const expiresAt = record.expiresAt ? new Date(record.expiresAt).getTime() : undefined;
  return Boolean(shareUrl(record)) &&
    record.publicEnabled !== false &&
    !record.revokedAt &&
    (expiresAt === undefined || expiresAt > Date.now());
}

function openShareUrl(record: ProfileRecord): void {
  const url = shareUrl(record);
  if (!url) {
    app.showToast("这条画像还没有公开链接", "error");
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

async function copyShareUrl(record: ProfileRecord): Promise<void> {
  const url = shareUrl(record);
  if (!url) {
    app.showToast("这条画像还没有公开链接", "error");
    return;
  }
  await navigator.clipboard.writeText(url);
  app.showToast("公开链接已复制");
}

async function updateShareState(record: ProfileRecord, publicEnabled: boolean): Promise<void> {
  const updated = await api<ProfileRecord>(`/api/profile-records/${encodeURIComponent(record.id)}/share`, {
    method: "PUT",
    body: JSON.stringify({
      publicEnabled,
      revokedAt: publicEnabled ? null : new Date().toISOString(),
    }),
  });
  if (activeRecord.value?.id === record.id) activeRecord.value = updated;
  records.value = records.value.map((item) => item.id === record.id ? updated : item);
  app.showToast(publicEnabled ? "画像公开链接已恢复" : "画像公开链接已撤销");
}

function memberLabel(userId?: string): string {
  if (!userId) return "未选择成员";
  const member = memberOptions.value.find((item) => item.userId === userId);
  return member ? `${member.displayName} / ${member.userId}` : userId;
}

function applyFilters(): void {
  pagination.page = 1;
  void load().catch((error) => app.showToast(error.message, "error"));
}

function onRefresh(): void {
  void load().catch((error) => app.showToast(error.message, "error"));
}

function onGroupChanged(): void {
  filters.userId = "";
  activeRecord.value = undefined;
  pagination.page = 1;
  void Promise.all([load(), loadMemberOptions()]).catch((error) => app.showToast(error.message, "error"));
}

onMounted(() => {
  void Promise.all([load(), loadMemberOptions()]);
});

useRefreshEvents({ refresh: onRefresh, groupChanged: onGroupChanged });

watch(() => [pagination.page, pagination.pageSize], () => {
  void load();
});
</script>

<template>
  <section class="profiles-layout">
    <section class="panel">
      <div class="section-head">
        <div>
          <h2>画像总结 <span class="tag">{{ pagination.total }}</span></h2>
          <p>集中查看群聊画像和昨日画像的历史记录，完整内容不混入长期记忆列表。</p>
        </div>
      </div>

      <div class="filter-card">
        <label>关键词<input v-model="filters.q" class="input" placeholder="搜索画像内容、QQ、创建人..." @change="applyFilters" /></label>
        <label>画像成员
          <SearchableSelect
            v-model="filters.userId"
            :options="memberSelectOptions"
            placeholder="搜索成员昵称或 QQ"
            empty-label="全部成员"
            @change="applyFilters"
          />
        </label>
        <label>画像类型
          <select v-model="filters.type" class="select" @change="applyFilters">
            <option value="">全部类型</option>
            <option value="overall">群聊画像</option>
            <option value="yesterday">昨日画像</option>
          </select>
        </label>
        <label>每页条数
          <select v-model="pagination.pageSize" class="select">
            <option :value="10">10 条</option>
            <option :value="20">20 条</option>
            <option :value="50">50 条</option>
          </select>
        </label>
      </div>

      <div v-if="loading" class="empty">正在加载画像记录...</div>
      <div v-else-if="!records.length" class="empty">当前筛选下暂无画像记录。</div>
      <div v-else class="profile-list">
        <article v-for="record in records" :key="record.id" class="profile-row" :class="{ active: activeRecord?.id === record.id }">
          <button class="profile-main" type="button" @click="openRecord(record)">
            <span class="tag">{{ profileTypeLabel(record.type) }}</span>
            <strong>{{ memberLabel(record.userId) }}</strong>
            <small>创建人 {{ record.createdBy }}</small>
          </button>
          <div class="row-actions">
            <span class="tag" :class="{ danger: record.publicEnabled === false || Boolean(record.revokedAt) }">{{ shareStatusLabel(record) }}</span>
            <button v-if="record.shareUrl" class="ghost-btn" type="button" :disabled="!canUseShareUrl(record)" @click="openShareUrl(record)">查看链接</button>
            <button v-if="record.shareUrl" class="ghost-btn" type="button" :disabled="!canUseShareUrl(record)" @click="copyShareUrl(record)">复制链接</button>
            <button v-if="!record.shareToken" class="ghost-btn" type="button" @click="updateShareState(record, true)">生成链接</button>
            <button v-else-if="record.publicEnabled !== false && !record.revokedAt" class="ghost-btn danger" type="button" @click="updateShareState(record, false)">撤销公开</button>
            <button v-else class="ghost-btn" type="button" @click="updateShareState(record, true)">恢复公开</button>
            <button class="ghost-btn" type="button" :disabled="generating" @click="regenerate(record)">重新生成</button>
            <button class="ghost-btn danger" type="button" @click="removeRecord(record)">删除</button>
          </div>
        </article>
      </div>

      <div class="pager">
        <button class="ghost-btn" type="button" :disabled="pagination.page <= 1" @click="pagination.page -= 1">上一页</button>
        <span class="muted">第 {{ pagination.page }} / {{ pagination.totalPages }} 页</span>
        <button class="ghost-btn" type="button" :disabled="pagination.page >= pagination.totalPages" @click="pagination.page += 1">下一页</button>
      </div>
    </section>

    <aside class="panel detail-panel sticky-detail-panel">
      <div class="section-head">
        <div>
          <h2>画像详情</h2>
          <p>{{ memberLabel(activeRecord?.userId) }}</p>
        </div>
      </div>
      <div v-if="detailLoading" class="empty compact">正在读取画像详情...</div>
      <template v-else-if="activeRecord">
        <dl class="detail-meta">
          <div><dt>类型</dt><dd>{{ profileTypeLabel(activeRecord.type) }}</dd></div>
          <div><dt>生成时间</dt><dd>{{ formatDateTime(activeRecord.generatedAt) }}</dd></div>
          <div><dt>来源记忆</dt><dd>{{ activeRecord.sourceMemoryCount }} 条</dd></div>
          <div><dt>创建人</dt><dd>{{ activeRecord.createdBy }}</dd></div>
          <div><dt>公开链接</dt><dd>{{ shareStatusLabel(activeRecord) }} / {{ activeRecord.accessCount || 0 }} 次访问</dd></div>
          <div v-if="activeRecord.expiresAt"><dt>过期时间</dt><dd>{{ formatDateTime(activeRecord.expiresAt) }}</dd></div>
        </dl>
        <article class="summary-text">{{ activeRecord.summary }}</article>
      </template>
      <div v-else class="empty compact">选择左侧记录后查看完整画像。</div>
    </aside>
  </section>
</template>

<style scoped>
.profiles-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(320px, 380px);
  gap: 18px;
  align-items: start;
}

.filter-card {
  display: grid;
  grid-template-columns: minmax(220px, 1.2fr) minmax(200px, 1fr) 150px 118px;
  gap: 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--surface-raised);
  padding: 16px;
  margin-bottom: 14px;
}

.filter-card label {
  display: grid;
  gap: 8px;
  color: var(--muted);
  font-weight: 700;
}

.profile-list {
  display: grid;
  gap: 10px;
}

.profile-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(360px, auto);
  gap: 12px;
  align-items: center;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--surface-raised);
  padding: 14px;
}

.profile-row.active {
  border-color: color-mix(in oklch, var(--accent) 55%, var(--line));
}

.profile-main {
  display: grid;
  grid-template-columns: auto minmax(150px, 1fr) minmax(100px, 0.45fr);
  gap: 12px;
  align-items: center;
  min-width: 0;
  background: transparent;
  color: var(--text);
  text-align: left;
}

.profile-main strong,
.profile-main span,
.profile-main small {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.profile-main small {
  color: var(--muted);
}

.row-actions,
.detail-actions,
.pager {
  display: flex;
  align-items: center;
  gap: 10px;
}

.row-actions {
  flex-wrap: wrap;
  justify-content: flex-end;
}

.detail-actions {
  flex-wrap: wrap;
  justify-content: flex-end;
}

.pager {
  justify-content: center;
  margin-top: 18px;
}

.detail-panel {
  min-height: 320px;
}

.detail-meta {
  display: grid;
  gap: 10px;
  margin: 0 0 16px;
}

.detail-meta div {
  display: grid;
  grid-template-columns: 80px minmax(0, 1fr);
  gap: 10px;
}

.detail-meta dt {
  color: var(--muted);
}

.detail-meta dd {
  margin: 0;
  overflow-wrap: anywhere;
}

.summary-text {
  white-space: pre-wrap;
  line-height: 1.85;
  border-top: 1px solid var(--line);
  padding-top: 14px;
}

.danger {
  color: var(--danger);
}

.compact {
  min-height: 180px;
}

@media (max-width: 1180px) {
  .profiles-layout,
  .filter-card,
  .profile-row,
  .profile-main {
    grid-template-columns: 1fr;
  }

}

@media (max-width: 620px) {
  .row-actions {
    flex-wrap: wrap;
  }

  .row-actions .ghost-btn {
    flex: 1;
  }
}
</style>
