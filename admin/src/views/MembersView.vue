<script setup lang="ts">
import { computed, onMounted, reactive, shallowRef, watch } from "vue";
import { useRoute } from "vue-router";
import { useRouter } from "vue-router";

import { useRefreshEvents } from "../composables/useRefreshEvents";
import { api, queryString, type MemberProfile, type MemberProfileSummary, type Pagination, type ProfileRecord } from "../services/api";
import { useAppStore } from "../stores/app";
import { formatDateTime, profileTypeLabel } from "../utils/format";

const route = useRoute();
const router = useRouter();
const app = useAppStore();
const members = shallowRef<MemberProfile[]>([]);
const records = shallowRef<ProfileRecord[]>([]);
const memberPagination = reactive<Pagination>({ page: 1, pageSize: 24, total: 0, totalPages: 1 });
const recordPagination = reactive<Pagination>({ page: 1, pageSize: 8, total: 0, totalPages: 1 });
const query = shallowRef("");
const loading = shallowRef(false);
const recordsLoading = shallowRef(false);
const summaryLoading = shallowRef(false);
const togglingMemoryUserId = shallowRef("");
const editingNoteUserId = shallowRef("");
const noteDraft = shallowRef("");
const savingNoteUserId = shallowRef("");
const activeSummary = shallowRef<MemberProfileSummary>();
const activeMember = shallowRef<MemberProfile>();
const activeRecord = shallowRef<ProfileRecord>();
const activeProfileType = shallowRef<"overall" | "yesterday">("overall");
const readonly = computed(() => app.readonly);

function ensureWritable(): boolean {
  if (!readonly.value) return true;
  app.showToast("只读模式不能修改成员或画像", "error");
  return false;
}

async function load(): Promise<void> {
  if (!app.groupId) return;
  loading.value = true;
  try {
    const data = await api<{ members: MemberProfile[]; pagination: Pagination }>(`/api/groups/${encodeURIComponent(app.groupId)}/members${queryString({
      q: query.value,
      includeNapcat: 1,
      page: memberPagination.page,
      pageSize: memberPagination.pageSize,
    })}`);
    members.value = data.members;
    Object.assign(memberPagination, data.pagination);
  } finally {
    loading.value = false;
  }
}

async function loadRecords(): Promise<void> {
  if (!app.groupId) return;
  recordsLoading.value = true;
  try {
    const data = await api<{ records: ProfileRecord[]; pagination: Pagination }>(`/api/profile-records${queryString({
      groupId: app.groupId,
      userId: activeMember.value?.userId,
      page: recordPagination.page,
      pageSize: recordPagination.pageSize,
    })}`);
    records.value = data.records;
    Object.assign(recordPagination, data.pagination);
  } finally {
    recordsLoading.value = false;
  }
}

async function profile(member: MemberProfile, type: "overall" | "yesterday", refresh = false): Promise<void> {
  if (refresh && !ensureWritable()) return;
  summaryLoading.value = true;
  activeMember.value = member;
  activeProfileType.value = type;
  activeSummary.value = undefined;
  activeRecord.value = undefined;
  try {
    activeSummary.value = refresh
      ? await api<MemberProfileSummary>("/api/profile-records", {
          method: "POST",
          body: JSON.stringify({ groupId: app.groupId, userId: member.userId, type }),
        })
      : await api<MemberProfileSummary>(`/api/groups/${encodeURIComponent(app.groupId)}/members/${encodeURIComponent(member.userId)}/profile-summary${queryString({ type })}`);
    recordPagination.page = 1;
    await loadRecords();
    app.showToast(refresh ? "画像已重新生成" : "已打开画像");
  } catch (error) {
    app.showToast((error as Error).message, "error");
  } finally {
    summaryLoading.value = false;
  }
}

function closeSummary(): void {
  activeSummary.value = undefined;
  activeMember.value = undefined;
  activeRecord.value = undefined;
  records.value = [];
}

async function openMemberRecords(member: MemberProfile): Promise<void> {
  activeMember.value = member;
  activeProfileType.value = "overall";
  activeSummary.value = undefined;
  activeRecord.value = undefined;
  recordPagination.page = 1;
  await loadRecords().catch((error) => app.showToast(error.message, "error"));
}

async function openRecord(record: ProfileRecord): Promise<void> {
  activeRecord.value = await api<ProfileRecord>(`/api/profile-records/${encodeURIComponent(record.id)}`);
  activeProfileType.value = activeRecord.value.type;
  activeSummary.value = undefined;
}

async function regenerateActiveProfile(): Promise<void> {
  if (!ensureWritable()) return;
  if (!activeMember.value) return;
  await profile(activeMember.value, activeRecord.value?.type || activeSummary.value?.type || activeProfileType.value, true);
}

async function deleteRecord(record: ProfileRecord): Promise<void> {
  if (!ensureWritable()) return;
  if (!confirm(`删除这条${profileTypeLabel(record.type)}记录？`)) return;
  await api(`/api/profile-records/${encodeURIComponent(record.id)}`, { method: "DELETE" });
  if (activeRecord.value?.id === record.id) activeRecord.value = undefined;
  await loadRecords();
  app.showToast("画像记录已删除");
}

async function toggleMemoryCollection(member: MemberProfile): Promise<void> {
  if (!ensureWritable()) return;
  if (!app.groupId || togglingMemoryUserId.value) return;
  togglingMemoryUserId.value = member.userId;
  try {
    const config = await api<{ memoryDisabledUserIds?: string[] }>(`/api/groups/${encodeURIComponent(app.groupId)}/config`);
    const disabled = new Set(config.memoryDisabledUserIds || []);
    const nextDisabled = !member.memoryDisabled;
    if (nextDisabled) disabled.add(member.userId);
    else disabled.delete(member.userId);
    await api(`/api/groups/${encodeURIComponent(app.groupId)}/config`, {
      method: "PUT",
      body: JSON.stringify({ memoryDisabledUserIds: [...disabled] }),
    });
    member.memoryDisabled = nextDisabled;
    if (activeMember.value?.userId === member.userId) {
      activeMember.value.memoryDisabled = nextDisabled;
    }
    app.showToast(nextDisabled ? "已禁用该成员记忆收集" : "已启用该成员记忆收集");
    await load();
  } catch (error) {
    app.showToast((error as Error).message, "error");
  } finally {
    togglingMemoryUserId.value = "";
  }
}

function applyFilters(): void {
  memberPagination.page = 1;
  void load().catch((error) => app.showToast(error.message, "error"));
}

function startEditNote(member: MemberProfile): void {
  if (!ensureWritable()) return;
  editingNoteUserId.value = member.userId;
  noteDraft.value = member.note || "";
}

async function saveNote(member: MemberProfile): Promise<void> {
  if (!ensureWritable()) return;
  if (!app.groupId || savingNoteUserId.value) return;
  savingNoteUserId.value = member.userId;
  try {
    const data = await api<{ member: MemberProfile }>(`/api/groups/${encodeURIComponent(app.groupId)}/members/${encodeURIComponent(member.userId)}/identity`, {
      method: "PUT",
      body: JSON.stringify({
        names: [member.displayName || member.userId, ...member.aliases].filter(Boolean),
        note: noteDraft.value.trim(),
      }),
    });
    const nextMember = data.member;
    members.value = members.value.map((item) => item.userId === nextMember.userId ? nextMember : item);
    if (activeMember.value?.userId === nextMember.userId) activeMember.value = nextMember;
    editingNoteUserId.value = "";
    app.showToast("成员备注已保存");
  } catch (error) {
    app.showToast((error as Error).message, "error");
  } finally {
    savingNoteUserId.value = "";
  }
}

function viewMemberMemories(member: MemberProfile): void {
  void router.push({ path: "/memories", query: { userId: member.userId, type: "member_profile" } });
}

function deduplicateMemberMemories(member: MemberProfile): void {
  if (!ensureWritable()) return;
  void router.push({ path: "/memories", query: { userId: member.userId, type: "member_profile", dedup: "1" } });
}

function onRefresh(): void {
  void load().catch((error) => app.showToast(error.message, "error"));
}

onMounted(() => {
  const q = typeof route.query.q === "string" ? route.query.q : "";
  if (q) query.value = q;
  void load();
});

useRefreshEvents({ refresh: onRefresh, groupChanged: onRefresh });

watch(() => route.query.q, (value) => {
  if (typeof value === "string") {
    query.value = value;
    memberPagination.page = 1;
    void load();
  }
});

watch(() => [memberPagination.page, memberPagination.pageSize], () => {
  void load();
});

watch(() => [recordPagination.page, recordPagination.pageSize], () => {
  void loadRecords().catch((error) => app.showToast(error.message, "error"));
});
</script>

<template>
  <section class="members-layout">
    <section class="panel">
      <div class="section-head">
        <div>
          <h2>成员管理 <span class="tag">{{ memberPagination.total }}</span></h2>
          <p>查看成员备注、长期记忆、画像记录和完整画像。</p>
        </div>
      </div>
      <div class="filter-bar">
        <input v-model="query" class="input" placeholder="搜索成员昵称、QQ、备注" @change="applyFilters" />
        <select v-model="memberPagination.pageSize" class="select">
          <option :value="12">12 条/页</option>
          <option :value="24">24 条/页</option>
          <option :value="50">50 条/页</option>
          <option :value="100">100 条/页</option>
        </select>
      </div>
      <div v-if="loading" class="empty">正在加载成员...</div>
      <div v-else-if="!members.length" class="empty">当前群暂无成员数据。</div>
      <div v-else class="member-grid">
        <article v-for="member in members" :key="member.userId" class="card member-card">
          <div class="avatar">{{ member.displayName.slice(0, 1) }}</div>
          <div>
            <div class="member-head">
              <h3>{{ member.displayName }}</h3>
              <span v-if="member.hasManualIdentity" class="tag">人工身份</span>
            </div>
            <p>QQ {{ member.userId }} · {{ member.role || "member" }}</p>
            <div v-if="editingNoteUserId === member.userId" class="note-editor">
              <textarea v-model="noteDraft" class="textarea compact-note" placeholder="填写成员备注" />
              <div class="note-actions">
                <button class="btn" type="button" :disabled="savingNoteUserId === member.userId" @click="saveNote(member)">保存备注</button>
                <button class="ghost-btn" type="button" :disabled="savingNoteUserId === member.userId" @click="editingNoteUserId = ''">取消</button>
              </div>
            </div>
            <p v-else>{{ member.note || member.aliases.join("、") || "暂无备注" }}</p>
            <div class="member-stats">
              <span class="tag">记忆 {{ member.memoryCount }}</span>
              <span class="tag warn">待审 {{ member.pendingCandidateCount }}</span>
              <span v-if="member.memoryDisabled" class="tag danger">禁用记忆</span>
            </div>
            <div class="member-actions">
              <button class="ghost-btn" type="button" @click="profile(member, 'overall')">群聊画像</button>
              <button class="ghost-btn" type="button" @click="profile(member, 'yesterday')">昨日画像</button>
              <button class="ghost-btn" type="button" :disabled="readonly" @click="activeMember?.userId === member.userId ? regenerateActiveProfile() : profile(member, 'overall', true)">重新生成</button>
              <button class="ghost-btn" type="button" @click="openMemberRecords(member)">画像记录</button>
              <button class="ghost-btn" type="button" @click="viewMemberMemories(member)">查看记忆</button>
              <button class="ghost-btn" type="button" :disabled="readonly" @click="startEditNote(member)">修改备注</button>
              <button class="ghost-btn" type="button" :disabled="readonly" @click="deduplicateMemberMemories(member)">记忆去重</button>
              <button
                class="ghost-btn"
                :class="{ danger: !member.memoryDisabled }"
                type="button"
                :disabled="readonly || togglingMemoryUserId === member.userId"
                @click="toggleMemoryCollection(member)"
              >
                {{ member.memoryDisabled ? "启用记忆" : "禁用记忆" }}
              </button>
            </div>
          </div>
        </article>
      </div>
      <div class="pager">
        <button class="ghost-btn" type="button" :disabled="memberPagination.page <= 1" @click="memberPagination.page -= 1">上一页</button>
        <span class="muted">第 {{ memberPagination.page }} / {{ memberPagination.totalPages }} 页</span>
        <button class="ghost-btn" type="button" :disabled="memberPagination.page >= memberPagination.totalPages" @click="memberPagination.page += 1">下一页</button>
      </div>
    </section>

    <aside class="profile-panel sticky-detail-panel" :class="{ open: activeMember || summaryLoading }">
      <div class="profile-head">
        <div>
          <span class="tag">{{ activeRecord ? profileTypeLabel(activeRecord.type) : profileTypeLabel(activeSummary?.type) }}</span>
          <h3>{{ activeMember?.displayName || activeRecord?.userId || "成员画像" }}</h3>
          <p v-if="activeMember">QQ {{ activeMember.userId }}</p>
        </div>
        <button class="icon-close" type="button" @click="closeSummary">×</button>
      </div>
      <div v-if="summaryLoading" class="empty compact">正在生成画像...</div>
      <template v-else-if="activeRecord">
        <dl class="summary-meta">
          <div>
            <dt>生成时间</dt>
            <dd>{{ formatDateTime(activeRecord.generatedAt) }}</dd>
          </div>
          <div>
            <dt>来源记忆</dt>
            <dd>{{ activeRecord.sourceMemoryCount }} 条</dd>
          </div>
          <div>
            <dt>创建人</dt>
            <dd>{{ activeRecord.createdBy }}</dd>
          </div>
        </dl>
        <article class="summary-text">{{ activeRecord.summary }}</article>
      </template>
      <template v-else-if="activeSummary">
        <dl class="summary-meta">
          <div>
            <dt>生成时间</dt>
            <dd>{{ formatDateTime(activeSummary.generatedAt) }}</dd>
          </div>
          <div>
            <dt>来源记忆</dt>
            <dd>{{ activeSummary.sourceMemoryCount ?? activeSummary.memoryCount ?? 0 }} 条</dd>
          </div>
          <div>
            <dt>缓存</dt>
            <dd>{{ activeSummary.cached ? "是" : "否" }}</dd>
          </div>
        </dl>
        <article class="summary-text">{{ activeSummary.summary }}</article>
      </template>
      <div v-else class="empty compact">选择成员后可查看完整画像。</div>

      <section class="record-list">
        <div class="record-head">
          <h4>画像记录</h4>
          <span class="muted">{{ recordPagination.total }} 条</span>
        </div>
        <div v-if="recordsLoading" class="muted">正在加载画像记录...</div>
        <div v-else-if="!records.length" class="muted">暂无画像记录。</div>
        <article v-for="record in records" :key="record.id" class="record-row">
          <button class="record-main" type="button" @click="openRecord(record)">
            <strong>{{ profileTypeLabel(record.type) }}</strong>
            <span>{{ formatDateTime(record.generatedAt) }}</span>
          </button>
          <button class="ghost-btn danger" type="button" :disabled="readonly" @click="deleteRecord(record)">删除</button>
        </article>
        <div class="record-pager">
          <button class="ghost-btn" type="button" :disabled="recordPagination.page <= 1" @click="recordPagination.page -= 1">上一页</button>
          <button class="ghost-btn" type="button" :disabled="recordPagination.page >= recordPagination.totalPages" @click="recordPagination.page += 1">下一页</button>
        </div>
      </section>
    </aside>
  </section>
</template>

<style scoped>
.members-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(320px, 360px);
  gap: 18px;
  align-items: start;
}

.member-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.filter-bar {
  display: grid;
  grid-template-columns: minmax(260px, 1fr) 136px;
  gap: 12px;
  margin-bottom: 16px;
}

.member-card {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 14px;
  padding: 14px;
}

.note-editor {
  display: grid;
  gap: 8px;
  margin: 4px 0 8px;
}

.compact-note {
  min-height: 74px;
}

.note-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.avatar {
  display: grid;
  place-items: center;
  width: 46px;
  height: 46px;
  border-radius: 50%;
  background: var(--accent-soft);
  color: var(--accent-strong);
  font-weight: 900;
}

.member-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

h3,
p {
  margin: 0 0 8px;
}

p {
  color: var(--muted);
}

.member-stats,
.member-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  margin-top: 10px;
}

.member-actions .ghost-btn {
  min-height: 32px;
  padding: 0 11px;
}

.pager,
.record-pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  margin-top: 16px;
}

.profile-panel {
  display: grid;
  gap: 16px;
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  background: var(--surface);
  box-shadow: var(--shadow-sm);
  padding: 18px;
  min-height: 320px;
}

.profile-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}

.profile-head h3 {
  margin-top: 10px;
}

.icon-close {
  width: 34px;
  height: 34px;
  border-radius: 999px;
  background: var(--surface-soft);
  color: var(--muted);
  font-size: 22px;
}

.summary-meta {
  display: grid;
  gap: 10px;
  margin: 0;
}

.summary-meta div {
  display: grid;
  grid-template-columns: 76px minmax(0, 1fr);
  gap: 10px;
}

dt {
  color: var(--muted);
}

dd {
  margin: 0;
  overflow-wrap: anywhere;
}

.summary-text {
  white-space: pre-wrap;
  line-height: 1.85;
  color: var(--text);
  border-top: 1px solid var(--line);
  padding-top: 14px;
}

.record-list {
  display: grid;
  gap: 10px;
  border-top: 1px solid var(--line);
  padding-top: 14px;
}

.record-head,
.record-row,
.record-main {
  display: flex;
  align-items: center;
  gap: 10px;
}

.record-head {
  justify-content: space-between;
}

.record-head h4 {
  margin: 0;
}

.record-row {
  justify-content: space-between;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface-soft);
  padding: 10px;
}

.record-main {
  min-width: 0;
  flex: 1;
  justify-content: space-between;
  background: transparent;
  color: var(--text);
  text-align: left;
}

.record-main span {
  color: var(--muted);
  font-size: 13px;
}

.danger {
  color: var(--danger);
}

.compact {
  min-height: 180px;
}

@media (max-width: 1180px) {
  .members-layout {
    grid-template-columns: 1fr;
  }

  .filter-bar {
    grid-template-columns: 1fr;
  }

}

@media (max-width: 520px) {
  .filter-bar,
  .member-card {
    grid-template-columns: 1fr;
  }

  .member-grid {
    grid-template-columns: 1fr;
  }

  .member-head {
    align-items: flex-start;
  }
}
</style>
