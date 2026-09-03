<script setup lang="ts">
import { computed, onMounted, reactive, shallowRef, watch } from "vue";
import { useRouter } from "vue-router";

import AppIcon from "../components/AppIcon.vue";
import { useRefreshEvents } from "../composables/useRefreshEvents";
import { api, queryString, type MemberListResponse, type MemberProfile, type Pagination } from "../services/api";
import { useAppStore } from "../stores/app";

const app = useAppStore();
const router = useRouter();
const members = shallowRef<MemberProfile[]>([]);
const loading = shallowRef(false);
const memberLoadError = shallowRef("");
const refreshingGroups = reactive(new Set<string>());
const editingMember = shallowRef<MemberProfile | null>(null);
const savingUserId = shallowRef("");
const privacyBusyUserId = shallowRef("");
const query = shallowRef("");
const pagination = reactive<Pagination>({ page: 1, pageSize: 24, total: 0, totalPages: 1 });
const noteDraft = shallowRef("");
const aliasesDraft = shallowRef("");
const viewMode = shallowRef<"grid" | "table">("grid");
const roleFilter = shallowRef<"all" | "admin" | "member">("all");
const statusFilter = shallowRef<"all" | "has_note" | "has_memory" | "opted_out">("all");
const failedAvatars = reactive(new Set<string>());

const canReenablePrivacy = computed(() => app.role === "super_admin");
const refreshing = computed(() => Boolean(app.groupId) && refreshingGroups.has(app.groupId));

let activeLoadId = 0;
let autoRefreshAttemptedGroupId = "";
const memberRefreshInflight = new Map<string, Promise<void>>();

function isCurrentLoad(groupId: string, loadId: number): boolean {
  return app.groupId === groupId && activeLoadId === loadId;
}

function memberListUrl(groupId: string): string {
  return `/api/groups/${encodeURIComponent(groupId)}/members${queryString({
    q: query.value.trim(),
    page: pagination.page,
    pageSize: pagination.pageSize,
  })}`;
}

function memberLoadErrorMessage(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error);
  if (code === "napcat_members_unavailable") {
    return "无法从 NapCat 读取成员，请确认机器人在线后点击刷新成员重试。";
  }
  return "成员列表加载失败，请确认机器人与服务在线后点击刷新成员重试。";
}

async function refreshMemberCache(groupId: string): Promise<void> {
  const existing = memberRefreshInflight.get(groupId);
  if (existing) {
    return existing;
  }

  const request = (async () => {
    refreshingGroups.add(groupId);
    try {
      await api<MemberListResponse>(`/api/groups/${encodeURIComponent(groupId)}/members/refresh`, {
        method: "POST",
        body: "{}",
      });
    } finally {
      refreshingGroups.delete(groupId);
    }
  })();
  memberRefreshInflight.set(groupId, request);
  try {
    await request;
  } finally {
    if (memberRefreshInflight.get(groupId) === request) {
      memberRefreshInflight.delete(groupId);
    }
  }
}

async function load(): Promise<boolean> {
  const groupId = app.groupId;
  const loadId = ++activeLoadId;
  if (!groupId) {
    members.value = [];
    memberLoadError.value = "";
    loading.value = false;
    return false;
  }
  loading.value = true;
  memberLoadError.value = "";
  try {
    let data = await api<MemberListResponse>(memberListUrl(groupId));
    if (!isCurrentLoad(groupId, loadId)) return false;

    if (data.cacheStatus === "unloaded") {
      const refreshAlreadyRunning = memberRefreshInflight.has(groupId);
      if (autoRefreshAttemptedGroupId === groupId && !refreshAlreadyRunning) {
        memberLoadError.value = "成员列表尚未可用，请点击刷新成员重试。";
        return false;
      }
      if (!refreshAlreadyRunning) {
        autoRefreshAttemptedGroupId = groupId;
      }
      await refreshMemberCache(groupId);
      if (!isCurrentLoad(groupId, loadId)) return false;
      data = await api<MemberListResponse>(memberListUrl(groupId));
      if (!isCurrentLoad(groupId, loadId)) return false;
      if (data.cacheStatus === "unloaded") {
        memberLoadError.value = "成员列表尚未可用，请点击刷新成员重试。";
        return false;
      }
    }

    members.value = data.members;
    Object.assign(pagination, data.pagination);
    return true;
  } catch (error) {
    if (isCurrentLoad(groupId, loadId)) {
      memberLoadError.value = memberLoadErrorMessage(error);
      app.showToast(memberLoadError.value, "error");
    }
    return false;
  } finally {
    if (isCurrentLoad(groupId, loadId)) {
      loading.value = false;
    }
  }
}

async function refreshMembers(): Promise<void> {
  const groupId = app.groupId;
  if (!groupId) return;
  memberLoadError.value = "";
  try {
    await refreshMemberCache(groupId);
    if (app.groupId !== groupId) return;
    const loaded = await load();
    if (loaded && app.groupId === groupId) {
      app.showToast("成员列表已刷新");
    }
  } catch (error) {
    if (app.groupId === groupId) {
      memberLoadError.value = memberLoadErrorMessage(error);
      app.showToast(memberLoadError.value, "error");
    }
  }
}

function beginEdit(member: MemberProfile): void {
  editingMember.value = member;
  noteDraft.value = member.note || "";
  aliasesDraft.value = member.aliases.join(", ");
}

async function saveNoteModal(): Promise<void> {
  const member = editingMember.value;
  if (!app.groupId || !member) return;
  savingUserId.value = member.userId;
  try {
    const rawAliases = aliasesDraft.value
      .split(/[,，\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const names = Array.from(new Set([member.displayName, ...rawAliases]));

    const data = await api<{ member: MemberProfile }>(
      `/api/groups/${encodeURIComponent(app.groupId)}/members/${encodeURIComponent(member.userId)}/identity`,
      {
        method: "PUT",
        body: JSON.stringify({
          names,
          note: noteDraft.value.trim(),
        }),
      },
    );
    members.value = members.value.map((item) => item.userId === data.member.userId ? data.member : item);
    editingMember.value = null;
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

function copyUserId(userId: string): void {
  void navigator.clipboard?.writeText(userId);
  app.showToast(`已复制 QQ: ${userId}`);
}

function applyFilters(): void {
  if (pagination.page !== 1) {
    pagination.page = 1;
    return;
  }
  void load();
}

function clearSearch(): void {
  query.value = "";
  applyFilters();
}

function getAvatarUrl(userId: string): string {
  if (failedAvatars.has(userId)) return "";
  return `https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(userId)}&s=100`;
}

function onAvatarError(userId: string): void {
  failedAvatars.add(userId);
}

function roleLabel(role?: string): string {
  if (role === "owner") return "群主";
  if (role === "admin") return "管理员";
  return "成员";
}

function roleClass(role?: string): string {
  if (role === "owner") return "badge-owner";
  if (role === "admin") return "badge-admin";
  return "badge-member";
}

const displayedMembers = computed(() => {
  return members.value.filter((m) => {
    if (roleFilter.value === "admin" && m.role !== "owner" && m.role !== "admin") return false;
    if (roleFilter.value === "member" && (m.role === "owner" || m.role === "admin")) return false;
    if (statusFilter.value === "has_note" && !m.note && !m.aliases.length && !m.hasManualIdentity) return false;
    if (statusFilter.value === "has_memory" && (!m.memoryCount || m.memoryCount <= 0)) return false;
    if (statusFilter.value === "opted_out" && !m.memoryDisabled) return false;
    return true;
  });
});

const adminCount = computed(() => members.value.filter((m) => m.role === "owner" || m.role === "admin").length);
const noteCount = computed(() => members.value.filter((m) => Boolean(m.note || m.aliases.length || m.hasManualIdentity)).length);
const optOutCount = computed(() => members.value.filter((m) => m.memoryDisabled).length);

watch(() => app.groupId, () => {
  activeLoadId += 1;
  autoRefreshAttemptedGroupId = "";
  members.value = [];
  memberLoadError.value = "";
  editingMember.value = null;
  pagination.total = 0;
  pagination.totalPages = 1;
  failedAvatars.clear();
  if (!app.groupId) {
    loading.value = false;
    return;
  }
  if (pagination.page !== 1) {
    pagination.page = 1;
    return;
  }
  void load();
});

watch(() => [pagination.page, pagination.pageSize], () => {
  if (app.groupId) void load();
});

onMounted(() => void load());
useRefreshEvents({ refresh: () => void refreshMembers() });
</script>

<template>
  <section class="page members-page">
    <!-- Top Summary Metrics Bar -->
    <div class="metric-grid">
      <div class="stat-card">
        <div class="stat-icon-wrap blue">
          <AppIcon name="users" :size="20" />
        </div>
        <div>
          <div class="stat-num">{{ pagination.total }}</div>
          <div class="stat-label">群成员总数</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon-wrap amber">
          <AppIcon name="settings" :size="20" />
        </div>
        <div>
          <div class="stat-num">{{ adminCount }}</div>
          <div class="stat-label">群主与管理</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon-wrap purple">
          <AppIcon name="knowledge" :size="20" />
        </div>
        <div>
          <div class="stat-num">{{ noteCount }}</div>
          <div class="stat-label">已设身份备注</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon-wrap red">
          <AppIcon name="security" :size="20" />
        </div>
        <div>
          <div class="stat-num">{{ optOutCount }}</div>
          <div class="stat-label">隐私退出保护</div>
        </div>
      </div>
    </div>

    <!-- Main Workspace Panel -->
    <section class="panel">
      <!-- Section Header -->
      <div class="section-head">
        <div>
          <h2>成员管理 <span class="tag">{{ pagination.total }}</span></h2>
          <p>维护群成员身份标签、独立备注与记忆归属。隐私退出成员将立即停止其对话记忆收集。</p>
        </div>
        <div class="head-actions">
          <button class="ghost-btn refresh-btn" type="button" :disabled="refreshing" @click="refreshMembers">
            <AppIcon name="refresh" :size="15" :class="{ spinning: refreshing }" />
            <span>{{ refreshing ? "同步成员中..." : "刷新成员列表" }}</span>
          </button>
        </div>
      </div>

      <!-- Filter & Search Toolbar -->
      <div class="toolbar-box">
        <div class="search-input-wrap">
          <AppIcon name="search" :size="16" class="search-icon" />
          <input
            v-model="query"
            class="input search-input"
            placeholder="搜索成员昵称、QQ号、备注或别名..."
            @keydown.enter="applyFilters"
          />
          <button v-if="query" class="clear-btn" type="button" title="清空搜索" @click="clearSearch">✕</button>
        </div>

        <div class="filter-controls">
          <select v-model="roleFilter" class="select select-compact">
            <option value="all">全部角色</option>
            <option value="admin">仅管理员 / 群主</option>
            <option value="member">仅普通成员</option>
          </select>

          <select v-model="statusFilter" class="select select-compact">
            <option value="all">全部状态</option>
            <option value="has_note">有备注/身份</option>
            <option value="has_memory">已沉淀记忆</option>
            <option value="opted_out">已隐私退出</option>
          </select>

          <select v-model="pagination.pageSize" class="select select-compact">
            <option :value="12">12 条/页</option>
            <option :value="24">24 条/页</option>
            <option :value="48">48 条/页</option>
            <option :value="96">96 条/页</option>
          </select>

          <!-- View Mode Toggle -->
          <div class="view-toggle">
            <button
              class="view-toggle-btn"
              :class="{ active: viewMode === 'grid' }"
              type="button"
              title="卡片视图"
              @click="viewMode = 'grid'"
            >
              <AppIcon name="overview" :size="14" />
              <span>卡片</span>
            </button>
            <button
              class="view-toggle-btn"
              :class="{ active: viewMode === 'table' }"
              type="button"
              title="表格视图"
              @click="viewMode = 'table'"
            >
              <AppIcon name="tasks" :size="14" />
              <span>表格</span>
            </button>
          </div>
        </div>
      </div>

      <!-- Error Notice -->
      <div v-if="memberLoadError" class="member-load-error" role="alert">
        <div class="error-text">
          <AppIcon name="security" :size="18" />
          <span>{{ memberLoadError }}</span>
        </div>
        <button class="btn" type="button" :disabled="refreshing" @click="refreshMembers">
          {{ refreshing ? "刷新中..." : "重新尝试" }}
        </button>
      </div>

      <!-- Loading State -->
      <div v-if="loading" class="empty">
        <div class="loading-state">
          <div class="spinner" />
          <span>正在加载成员数据...</span>
        </div>
      </div>

      <!-- Empty State -->
      <div v-else-if="!displayedMembers.length && !memberLoadError" class="empty">
        <div class="empty-state">
          <AppIcon name="users" :size="32" class="empty-icon" />
          <p>当前筛选条件下暂无成员数据</p>
          <button v-if="query || roleFilter !== 'all' || statusFilter !== 'all'" class="ghost-btn" type="button" @click="query = ''; roleFilter = 'all'; statusFilter = 'all'">
            清空所有筛选
          </button>
        </div>
      </div>

      <!-- 1. Card Grid View -->
      <div v-else-if="viewMode === 'grid'" class="member-grid">
        <article v-for="member in displayedMembers" :key="member.userId" class="member-card">
          <!-- Card Header: Avatar, Name, Role, QQ -->
          <div class="member-card-header">
            <div class="avatar-wrap">
              <img
                v-if="getAvatarUrl(member.userId)"
                :src="getAvatarUrl(member.userId)"
                :alt="member.displayName"
                class="qq-avatar"
                loading="lazy"
                @error="onAvatarError(member.userId)"
              />
              <div v-else class="initial-avatar">
                {{ member.displayName.slice(0, 1).toUpperCase() }}
              </div>
            </div>

            <div class="member-primary-info">
              <div class="name-row">
                <h3 class="member-name" :title="member.displayName">{{ member.displayName }}</h3>
                <span class="role-badge" :class="roleClass(member.role)">{{ roleLabel(member.role) }}</span>
              </div>
              <div class="qq-row" title="点击复制QQ号" @click="copyUserId(member.userId)">
                <span class="qq-num">QQ: {{ member.userId }}</span>
                <span class="copy-hint">复制</span>
              </div>
            </div>
          </div>

          <!-- Note & Aliases Section -->
          <div class="member-note-block" @click="beginEdit(member)">
            <div class="note-content" :class="{ 'no-note': !member.note && !member.aliases.length }">
              <span v-if="member.note">{{ member.note }}</span>
              <span v-else-if="member.aliases.length">别名: {{ member.aliases.join("、") }}</span>
              <span v-else>暂无备注身份 (点击添加)</span>
            </div>
            <button class="edit-note-btn" type="button" title="编辑备注">
              <AppIcon name="settings" :size="13" />
            </button>
          </div>

          <!-- Tags Bar -->
          <div class="tags-strip">
            <span v-if="member.hasManualIdentity" class="tag neutral">人工身份</span>
            <span class="tag" :class="{ neutral: !member.memoryCount }">记忆 {{ member.memoryCount || 0 }}</span>
            <span v-if="member.memoryDisabled" class="tag danger">已隐私退出</span>
          </div>

          <!-- Action Buttons Footer -->
          <div class="member-card-actions">
            <button class="action-btn" type="button" title="查看成员记忆" @click="openMemories(member)">
              <AppIcon name="memory" :size="14" />
              <span>记忆 ({{ member.memoryCount || 0 }})</span>
            </button>
            <button class="action-btn" type="button" title="设置备注与身份" @click="beginEdit(member)">
              <AppIcon name="settings" :size="14" />
              <span>备注</span>
            </button>
            <button
              v-if="!member.memoryDisabled"
              class="action-btn danger-action"
              type="button"
              :disabled="privacyBusyUserId === member.userId"
              title="暂停该成员的记忆提取"
              @click="setPrivacyOptOut(member, true)"
            >
              <span>隐私退出</span>
            </button>
            <button
              v-else
              class="action-btn restore-action"
              type="button"
              :disabled="privacyBusyUserId === member.userId || !canReenablePrivacy"
              title="恢复记忆收集（需超级管理员权限）"
              @click="setPrivacyOptOut(member, false)"
            >
              <span>恢复收集</span>
            </button>
          </div>
        </article>
      </div>

      <!-- 2. Data Table View -->
      <div v-else class="table-container">
        <table class="data-table">
          <thead>
            <tr>
              <th style="width: 240px">成员</th>
              <th style="width: 100px">群角色</th>
              <th>身份备注 / 别名</th>
              <th style="width: 130px">状态</th>
              <th style="width: 90px">记忆数</th>
              <th style="width: 200px; text-align: right">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="member in displayedMembers" :key="member.userId">
              <td>
                <div class="table-user-cell">
                  <div class="avatar-wrap table-avatar">
                    <img
                      v-if="getAvatarUrl(member.userId)"
                      :src="getAvatarUrl(member.userId)"
                      :alt="member.displayName"
                      class="qq-avatar"
                      loading="lazy"
                      @error="onAvatarError(member.userId)"
                    />
                    <div v-else class="initial-avatar">
                      {{ member.displayName.slice(0, 1).toUpperCase() }}
                    </div>
                  </div>
                  <div>
                    <div class="member-name">{{ member.displayName }}</div>
                    <span class="qq-num-sm" title="点击复制" @click="copyUserId(member.userId)">
                      {{ member.userId }}
                    </span>
                  </div>
                </div>
              </td>
              <td>
                <span class="role-badge" :class="roleClass(member.role)">{{ roleLabel(member.role) }}</span>
              </td>
              <td>
                <div class="table-note-cell">
                  <span v-if="member.note" class="text-note">{{ member.note }}</span>
                  <span v-else-if="member.aliases.length" class="text-aliases">{{ member.aliases.join(", ") }}</span>
                  <span v-else class="muted">-</span>
                </div>
              </td>
              <td>
                <div class="table-tags-cell">
                  <span v-if="member.hasManualIdentity" class="tag neutral">人工身份</span>
                  <span v-if="member.memoryDisabled" class="tag danger">隐私退出</span>
                  <span v-if="!member.hasManualIdentity && !member.memoryDisabled" class="muted">正常</span>
                </div>
              </td>
              <td>
                <span class="memory-count-badge">{{ member.memoryCount || 0 }}</span>
              </td>
              <td>
                <div class="table-actions-cell">
                  <button class="ghost-btn table-btn" type="button" @click="openMemories(member)">记忆</button>
                  <button class="ghost-btn table-btn" type="button" @click="beginEdit(member)">备注</button>
                  <button
                    v-if="!member.memoryDisabled"
                    class="ghost-btn table-btn danger"
                    type="button"
                    :disabled="privacyBusyUserId === member.userId"
                    @click="setPrivacyOptOut(member, true)"
                  >退出</button>
                  <button
                    v-else
                    class="ghost-btn table-btn"
                    type="button"
                    :disabled="privacyBusyUserId === member.userId || !canReenablePrivacy"
                    @click="setPrivacyOptOut(member, false)"
                  >恢复</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Pagination -->
      <div class="pagination">
        <button class="ghost-btn" type="button" :disabled="pagination.page <= 1" @click="pagination.page -= 1">
          上一页
        </button>
        <span class="page-indicator">第 {{ pagination.page }} / {{ pagination.totalPages }} 页</span>
        <button class="ghost-btn" type="button" :disabled="pagination.page >= pagination.totalPages" @click="pagination.page += 1">
          下一页
        </button>
      </div>
    </section>

    <!-- Modal for Editing Member Note and Aliases -->
    <div v-if="editingMember" class="modal-overlay" @click.self="editingMember = null">
      <div class="modal-card">
        <div class="modal-header">
          <div>
            <h3>设置成员备注与身份</h3>
            <p class="muted">{{ editingMember.displayName }} (QQ: {{ editingMember.userId }})</p>
          </div>
          <button class="icon-btn close-modal-btn" type="button" @click="editingMember = null">✕</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label class="form-label">成员备注</label>
            <input
              v-model="noteDraft"
              class="input"
              placeholder="例如：技术骨干、后端开发、常驻核心"
              autofocus
            />
            <small class="muted">用于在后台直观标识该成员身份与特征。</small>
          </div>
          <div class="form-group">
            <label class="form-label">别名 / 称呼（多项用逗号分隔）</label>
            <input
              v-model="aliasesDraft"
              class="input"
              placeholder="例如：小李, 老李, 李哥"
            />
            <small class="muted">机器人在群聊中识别这些称呼时，将自动关联此成员并调取专属记忆。</small>
          </div>
        </div>
        <div class="modal-footer">
          <button class="ghost-btn" type="button" :disabled="savingUserId === editingMember.userId" @click="editingMember = null">
            取消
          </button>
          <button class="btn" type="button" :disabled="savingUserId === editingMember.userId" @click="saveNoteModal">
            {{ savingUserId === editingMember.userId ? "保存中..." : "保存备注" }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.members-page {
  display: grid;
  gap: 18px;
}

/* Stat Cards */
.stat-card {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 16px 20px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
}

.stat-icon-wrap {
  width: 44px;
  height: 44px;
  border-radius: var(--radius-md);
  display: grid;
  place-items: center;
  flex-shrink: 0;
}

.stat-icon-wrap.blue { background: #eff6ff; color: #2563eb; }
.stat-icon-wrap.amber { background: #fffbeb; color: #d97706; }
.stat-icon-wrap.purple { background: #f5f3ff; color: #7c3aed; }
.stat-icon-wrap.red { background: #fef2f2; color: #dc2626; }

:root[data-theme="dark"] .stat-icon-wrap.blue { background: rgba(37, 99, 235, 0.2); color: #60a5fa; }
:root[data-theme="dark"] .stat-icon-wrap.amber { background: rgba(217, 119, 6, 0.2); color: #fbbf24; }
:root[data-theme="dark"] .stat-icon-wrap.purple { background: rgba(124, 58, 237, 0.2); color: #a78bfa; }
:root[data-theme="dark"] .stat-icon-wrap.red { background: rgba(220, 38, 38, 0.2); color: #f87171; }

.stat-num {
  font-size: 22px;
  font-weight: 800;
  line-height: 1.1;
  color: var(--text);
  letter-spacing: -0.02em;
}

.stat-label {
  font-size: 12px;
  color: var(--muted);
  margin-top: 4px;
}

/* Head Actions */
.head-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.refresh-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* Toolbar */
.toolbar-box {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  margin-bottom: 20px;
  flex-wrap: wrap;
}

.search-input-wrap {
  position: relative;
  flex: 1;
  min-width: 260px;
  display: flex;
  align-items: center;
}

.search-icon {
  position: absolute;
  left: 12px;
  color: var(--subtle);
  pointer-events: none;
}

.search-input {
  padding-left: 36px;
  padding-right: 32px;
}

.clear-btn {
  position: absolute;
  right: 10px;
  background: transparent;
  border: none;
  color: var(--subtle);
  cursor: pointer;
  font-size: 13px;
  padding: 4px;
}

.clear-btn:hover {
  color: var(--text);
}

.filter-controls {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.select-compact {
  width: auto;
  min-width: 110px;
}

/* Error message */
.member-load-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 18px;
  border: 1px solid rgba(239, 68, 68, 0.3);
  background: var(--danger-soft);
  border-radius: var(--radius-md);
  color: var(--danger);
  padding: 14px 18px;
}

.error-text {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13.5px;
  font-weight: 500;
}

/* Loading & Empty States */
.loading-state,
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 30px;
}

.spinner {
  width: 28px;
  height: 28px;
  border: 3px solid var(--line);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.empty-icon {
  color: var(--subtle);
}

/* Card Grid */
.member-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 16px;
}

.member-card {
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  padding: 18px;
  box-shadow: var(--shadow-sm);
  transition: all 0.18s ease;
  position: relative;
}

.member-card:hover {
  border-color: var(--line-strong);
  box-shadow: var(--shadow-md);
  transform: translateY(-2px);
}

.member-card-header {
  display: flex;
  align-items: center;
  gap: 12px;
}

.avatar-wrap {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  overflow: hidden;
  background: var(--surface-soft);
  border: 1px solid var(--line);
  flex-shrink: 0;
  display: grid;
  place-items: center;
}

.qq-avatar {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.initial-avatar {
  font-size: 16px;
  font-weight: 800;
  color: var(--accent);
}

.member-primary-info {
  flex: 1;
  min-width: 0;
}

.name-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.member-name {
  margin: 0;
  font-size: 14.5px;
  font-weight: 700;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.role-badge {
  font-size: 11px;
  font-weight: 600;
  padding: 1px 7px;
  border-radius: 999px;
  flex-shrink: 0;
}

.badge-owner { background: #fef3c7; color: #b45309; }
.badge-admin { background: #dbeafe; color: #1d4ed8; }
.badge-member { background: var(--surface-soft); color: var(--muted); border: 1px solid var(--line); }

:root[data-theme="dark"] .badge-owner { background: rgba(245, 158, 11, 0.2); color: #fbbf24; }
:root[data-theme="dark"] .badge-admin { background: rgba(59, 130, 246, 0.2); color: #93c5fd; }

.qq-row {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 3px;
  cursor: pointer;
  border-radius: 4px;
  padding: 1px 4px;
  margin-left: -4px;
  transition: background 0.12s ease;
}

.qq-row:hover {
  background: var(--surface-soft);
}

.qq-num {
  font-size: 12px;
  color: var(--muted);
  font-family: monospace;
}

.copy-hint {
  font-size: 10.5px;
  color: var(--accent);
  opacity: 0;
  transition: opacity 0.12s ease;
}

.qq-row:hover .copy-hint {
  opacity: 1;
}

/* Note block */
.member-note-block {
  margin: 14px 0 10px;
  padding: 8px 10px;
  background: var(--surface-soft);
  border: 1px dashed var(--line);
  border-radius: var(--radius-sm);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  cursor: pointer;
  transition: border-color 0.15s ease;
}

.member-note-block:hover {
  border-color: var(--accent);
}

.note-content {
  font-size: 12.5px;
  color: var(--text);
  line-height: 1.4;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.note-content.no-note {
  color: var(--subtle);
  font-style: italic;
}

.edit-note-btn {
  background: transparent;
  border: none;
  color: var(--muted);
  padding: 2px;
  cursor: pointer;
  display: flex;
}

.tags-strip {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}

/* Card Actions */
.member-card-actions {
  margin-top: auto;
  display: flex;
  align-items: center;
  gap: 6px;
  padding-top: 12px;
  border-top: 1px solid var(--line);
}

.action-btn {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 30px;
  border: 1px solid var(--line);
  background: var(--surface);
  border-radius: var(--radius-sm);
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
  cursor: pointer;
  transition: all 0.15s ease;
}

.action-btn:hover {
  background: var(--surface-soft);
  border-color: var(--line-strong);
}

.action-btn.danger-action {
  color: var(--danger);
  flex: 0 0 auto;
  padding: 0 10px;
}

.action-btn.danger-action:hover {
  background: var(--danger-soft);
  border-color: var(--danger);
}

.action-btn.restore-action {
  color: var(--accent);
  flex: 0 0 auto;
  padding: 0 10px;
}

/* Table View styling */
.table-user-cell {
  display: flex;
  align-items: center;
  gap: 10px;
}

.table-avatar {
  width: 34px;
  height: 34px;
}

.qq-num-sm {
  font-size: 11px;
  color: var(--muted);
  font-family: monospace;
  cursor: pointer;
}

.qq-num-sm:hover {
  color: var(--accent);
  text-decoration: underline;
}

.table-note-cell {
  font-size: 12.5px;
}

.text-note {
  color: var(--text);
}

.text-aliases {
  color: var(--muted);
  font-size: 12px;
}

.table-tags-cell {
  display: flex;
  align-items: center;
  gap: 4px;
}

.memory-count-badge {
  display: inline-block;
  padding: 1px 8px;
  background: var(--surface-soft);
  border: 1px solid var(--line);
  border-radius: 999px;
  font-size: 12px;
  font-weight: 700;
  color: var(--text);
}

.table-actions-cell {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
}

.table-btn {
  min-height: 28px;
  padding: 0 8px;
  font-size: 12px;
}

/* Pagination */
.pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  margin-top: 24px;
}

.page-indicator {
  font-size: 13px;
  color: var(--muted);
  font-weight: 500;
}

/* Form in Modal */
.form-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.form-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}

.close-modal-btn {
  width: 32px;
  height: 32px;
}

@media (max-width: 768px) {
  .toolbar-box {
    flex-direction: column;
    align-items: stretch;
  }
  .filter-controls {
    justify-content: space-between;
  }
}
</style>
