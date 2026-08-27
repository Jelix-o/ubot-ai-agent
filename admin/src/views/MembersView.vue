<script setup lang="ts">
import { computed, onMounted, reactive, shallowRef, watch } from "vue";
import { useRouter } from "vue-router";

import { api, queryString, type MemberProfile, type Pagination } from "../services/api";
import { useAppStore } from "../stores/app";

const app = useAppStore();
const router = useRouter();
const members = shallowRef<MemberProfile[]>([]);
const loading = shallowRef(false);
const refreshing = shallowRef(false);
const editingUserId = shallowRef("");
const savingUserId = shallowRef("");
const privacyBusyUserId = shallowRef("");
const query = shallowRef("");
const pagination = reactive<Pagination>({ page: 1, pageSize: 24, total: 0, totalPages: 1 });
const noteDraft = shallowRef("");

const canReenablePrivacy = computed(() => app.role === "super_admin");

async function load(): Promise<void> {
  if (!app.groupId) {
    members.value = [];
    return;
  }
  loading.value = true;
  try {
    const data = await api<{ members: MemberProfile[]; pagination: Pagination }>(
      `/api/groups/${encodeURIComponent(app.groupId)}/members${queryString({
        q: query.value.trim(),
        page: pagination.page,
        pageSize: pagination.pageSize,
      })}`,
    );
    members.value = data.members;
    Object.assign(pagination, data.pagination);
  } catch (error) {
    app.showToast((error as Error).message, "error");
  } finally {
    loading.value = false;
  }
}

async function refreshMembers(): Promise<void> {
  if (!app.groupId) return;
  refreshing.value = true;
  try {
    await api(`/api/groups/${encodeURIComponent(app.groupId)}/members/refresh`, { method: "POST", body: "{}" });
    await load();
    app.showToast("成员列表已刷新");
  } catch (error) {
    app.showToast((error as Error).message, "error");
  } finally {
    refreshing.value = false;
  }
}

function beginNote(member: MemberProfile): void {
  editingUserId.value = member.userId;
  noteDraft.value = member.note || "";
}

async function saveNote(member: MemberProfile): Promise<void> {
  if (!app.groupId) return;
  savingUserId.value = member.userId;
  try {
    const data = await api<{ member: MemberProfile }>(
      `/api/groups/${encodeURIComponent(app.groupId)}/members/${encodeURIComponent(member.userId)}/identity`,
      {
        method: "PUT",
        body: JSON.stringify({
          names: [member.displayName, ...member.aliases].filter(Boolean),
          note: noteDraft.value.trim(),
        }),
      },
    );
    members.value = members.value.map((item) => item.userId === data.member.userId ? data.member : item);
    editingUserId.value = "";
    app.showToast("成员备注已保存");
  } catch (error) {
    app.showToast((error as Error).message, "error");
  } finally {
    savingUserId.value = "";
  }
}

async function setPrivacyOptOut(member: MemberProfile, optedOut: boolean): Promise<void> {
  if (!app.groupId) return;
  if (!optedOut && !canReenablePrivacy.value) {
    app.showToast("只有超级管理员可以重新启用成员的记忆收集", "error");
    return;
  }
  privacyBusyUserId.value = member.userId;
  try {
    await api(
      `/api/groups/${encodeURIComponent(app.groupId)}/members/${encodeURIComponent(member.userId)}/privacy-opt-out`,
      { method: optedOut ? "POST" : "DELETE", body: "{}" },
    );
    members.value = members.value.map((item) => item.userId === member.userId
      ? { ...item, memoryDisabled: optedOut }
      : item);
    app.showToast(optedOut ? "已记录成员的隐私退出请求" : "已重新启用成员的记忆收集");
  } catch (error) {
    app.showToast((error as Error).message, "error");
  } finally {
    privacyBusyUserId.value = "";
  }
}

function openMemories(member: MemberProfile): void {
  void router.push({ path: "/memories", query: { userId: member.userId, type: "member_profile" } });
}

function applyFilters(): void {
  pagination.page = 1;
  void load();
}

watch(() => app.groupId, () => {
  pagination.page = 1;
  editingUserId.value = "";
  void load();
});
watch(() => [pagination.page, pagination.pageSize], () => void load());
onMounted(() => void load());
</script>

<template>
  <section class="page">
    <section class="panel">
      <div class="section-head">
        <div>
          <h2>成员管理 <span class="tag">{{ pagination.total }}</span></h2>
          <p>维护成员备注、身份标签和明确记忆。隐私退出会立即停止该成员的记忆收集。</p>
        </div>
        <button class="ghost-btn" type="button" :disabled="refreshing" @click="refreshMembers">
          {{ refreshing ? "刷新中..." : "刷新成员" }}
        </button>
      </div>
      <div class="toolbar">
        <input v-model="query" class="input" placeholder="搜索成员昵称、QQ、备注" @change="applyFilters" />
        <select v-model="pagination.pageSize" class="select">
          <option :value="12">12 / 页</option>
          <option :value="24">24 / 页</option>
          <option :value="48">48 / 页</option>
        </select>
      </div>
      <div v-if="loading" class="empty">正在加载成员...</div>
      <div v-else-if="!members.length" class="empty">当前群暂无成员数据。</div>
      <div v-else class="member-grid">
        <article v-for="member in members" :key="member.userId" class="card member-card">
          <div class="member-head">
            <div class="avatar">{{ member.displayName.slice(0, 1) }}</div>
            <div>
              <h3>{{ member.displayName }}</h3>
              <p>QQ {{ member.userId }} · {{ member.role || "member" }}</p>
            </div>
          </div>
          <div v-if="editingUserId === member.userId" class="note-editor">
            <textarea v-model="noteDraft" class="textarea" placeholder="成员备注或身份标签" />
            <div class="inline-actions">
              <button class="btn" type="button" :disabled="savingUserId === member.userId" @click="saveNote(member)">保存备注</button>
              <button class="ghost-btn" type="button" :disabled="savingUserId === member.userId" @click="editingUserId = ''">取消</button>
            </div>
          </div>
          <p v-else class="member-note">{{ member.note || member.aliases.join("、") || "暂无备注" }}</p>
          <div class="tags">
            <span v-if="member.hasManualIdentity" class="tag">人工身份</span>
            <span class="tag">记忆 {{ member.memoryCount }}</span>
            <span v-if="member.memoryDisabled" class="tag danger">已隐私退出</span>
          </div>
          <div class="member-actions">
            <button class="ghost-btn" type="button" @click="openMemories(member)">查看记忆</button>
            <button class="ghost-btn" type="button" @click="beginNote(member)">修改备注</button>
            <button
              v-if="!member.memoryDisabled"
              class="ghost-btn danger"
              type="button"
              :disabled="privacyBusyUserId === member.userId"
              @click="setPrivacyOptOut(member, true)"
            >停止记忆收集</button>
            <button
              v-else
              class="ghost-btn"
              type="button"
              :disabled="privacyBusyUserId === member.userId || !canReenablePrivacy"
              @click="setPrivacyOptOut(member, false)"
            >重新启用收集</button>
          </div>
        </article>
      </div>
      <div class="pagination">
        <button class="ghost-btn" type="button" :disabled="pagination.page <= 1" @click="pagination.page -= 1">上一页</button>
        <span class="muted">第 {{ pagination.page }} / {{ pagination.totalPages }} 页</span>
        <button class="ghost-btn" type="button" :disabled="pagination.page >= pagination.totalPages" @click="pagination.page += 1">下一页</button>
      </div>
    </section>
  </section>
</template>

<style scoped>
.toolbar, .inline-actions, .member-actions, .pagination, .member-head, .tags { display: flex; align-items: center; gap: 10px; }
.toolbar { margin-bottom: 18px; }
.toolbar .input { flex: 1; }
.member-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 14px; }
.member-card { display: grid; gap: 14px; }
.member-head { align-items: flex-start; }
.member-head h3, .member-head p, .member-note { margin: 0; }
.member-head p, .member-note { color: var(--muted); }
.avatar { display: grid; place-items: center; width: 42px; height: 42px; border-radius: 50%; background: var(--accent-soft); color: var(--accent-strong); font-weight: 900; }
.note-editor { display: grid; gap: 8px; }
.note-editor .textarea { min-height: 84px; }
.tags { flex-wrap: wrap; }
.member-actions { flex-wrap: wrap; }
.danger { color: var(--danger); }
.pagination { justify-content: center; margin-top: 20px; }
@media (max-width: 640px) { .toolbar { align-items: stretch; flex-direction: column; } }
</style>
