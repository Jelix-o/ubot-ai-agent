<script setup lang="ts">
import { computed, onMounted, onUnmounted, shallowRef, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import AppIcon from "./components/AppIcon.vue";
import { dispatchGroupChanged, dispatchRefreshCurrent } from "./composables/useRefreshEvents";
import { routes } from "./router";
import { api, queryString, type GlobalSearchResult } from "./services/api";
import { useAppStore } from "./stores/app";

const route = useRoute();
const router = useRouter();
const app = useAppStore();

const globalQuery = shallowRef("");
const notificationsOpen = shallowRef(false);
const commandOpen = shallowRef(false);
const commandQuery = shallowRef("");
const searchResults = shallowRef<GlobalSearchResult[]>([]);
const searchLoading = shallowRef(false);
const themeOpen = shallowRef(false);
const userOpen = shallowRef(false);
const mobileNavOpen = shallowRef(false);

const isLogin = computed(() => route.name === "login");
const navItems = computed(() => routes.filter((item) => item.name !== "login" && (!item.meta?.superOnly || app.role === "super_admin")));
const title = computed(() => String(route.meta.title || "UBot"));
const subtitle = computed(() => String(route.meta.subtitle || ""));
const roleLabel = computed(() => app.role === "super_admin" ? "超级管理员" : "群管理员");
const userInitials = computed(() => app.role === "super_admin" ? "SA" : "GA");
const pageCommandItems = computed(() => {
  const q = commandQuery.value.trim().toLowerCase();
  return navItems.value.filter((item) => {
    const text = `${String(item.meta?.title || "")} ${String(item.meta?.subtitle || "")}`.toLowerCase();
    return !q || text.includes(q);
  });
});
const hasCommandQuery = computed(() => commandQuery.value.trim().length > 0);

function iconFor(name: unknown): string {
  return ({
    overview: "overview",
    groups: "settings",
    members: "users",
    candidates: "candidate",
    memories: "memory",
    profiles: "users",
    knowledge: "knowledge",
    iteration: "iteration",
    tasks: "tasks",
    audit: "audit",
    health: "health",
    settings: "settings",
    skills: "candidate",
    commands: "memory",
  } as Record<string, string>)[String(name)] || "overview";
}

function closeFloating(): void {
  notificationsOpen.value = false;
  themeOpen.value = false;
  userOpen.value = false;
}

function refreshCurrent(): void {
  dispatchRefreshCurrent();
  void app.loadNotifications();
}

function go(path: string): void {
  commandOpen.value = false;
  commandQuery.value = "";
  searchResults.value = [];
  mobileNavOpen.value = false;
  closeFloating();
  void router.push(path);
}

function openCommand(query = ""): void {
  commandQuery.value = query;
  commandOpen.value = true;
  closeFloating();
  requestAnimationFrame(() => document.querySelector<HTMLInputElement>(".command-input")?.focus());
}

function runGlobalSearch(): void {
  const q = globalQuery.value.trim();
  if (!q) return;
  openCommand(q);
}

function goSearchResult(item: GlobalSearchResult): void {
  if (item.groupId && item.groupId !== app.groupId) {
    app.groupId = item.groupId;
  }
  go(item.path);
}

function searchTypeLabel(type: GlobalSearchResult["type"]): string {
  return ({
    group: "群聊",
    member: "成员",
    memory: "长期记忆",
    candidate: "候选记忆",
    knowledge: "FAQ",
    profile: "画像",
    page: "页面",
  } as Record<GlobalSearchResult["type"], string>)[type];
}

function resultIcon(type: GlobalSearchResult["type"]): string {
  return ({
    group: "users",
    member: "users",
    memory: "memory",
    candidate: "candidate",
    knowledge: "knowledge",
    profile: "users",
    page: "overview",
  } as Record<GlobalSearchResult["type"], string>)[type] || "search";
}

function runFirstCommandResult(): void {
  const firstSearch = searchResults.value[0];
  if (firstSearch) {
    goSearchResult(firstSearch);
    return;
  }
  const firstPage = pageCommandItems.value[0];
  if (firstPage) go(String(firstPage.path));
}

async function openNotifications(): Promise<void> {
  const next = !notificationsOpen.value;
  closeFloating();
  notificationsOpen.value = next;
  if (next) {
    await app.loadNotifications();
  }
}

function openTheme(): void {
  const next = !themeOpen.value;
  closeFloating();
  themeOpen.value = next;
}

function openUser(): void {
  const next = !userOpen.value;
  closeFloating();
  userOpen.value = next;
}

async function logout(): Promise<void> {
  closeFloating();
  try {
    await app.logout();
  } catch (error) {
    app.showToast(error instanceof Error ? error.message : "退出登录失败", "error");
  }
}

function onSearchKeydown(event: KeyboardEvent): void {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    openCommand();
    return;
  }
  if (event.key === "Escape") {
    commandOpen.value = false;
    mobileNavOpen.value = false;
    closeFloating();
  }
}

onMounted(async () => {
  app.applyTheme();
  window.addEventListener("keydown", onSearchKeydown);
  if (!isLogin.value) {
    await app.loadSession();
    await Promise.all([app.loadGroups(), app.loadNotifications()]);
  }
});

onUnmounted(() => {
  window.removeEventListener("keydown", onSearchKeydown);
});

watch(() => app.groupId, () => {
  dispatchGroupChanged();
});

watch(() => route.fullPath, () => {
  mobileNavOpen.value = false;
  closeFloating();
});

watch(commandQuery, async (value, _oldValue, onCleanup) => {
  const q = value.trim();
  if (!q) {
    searchResults.value = [];
    searchLoading.value = false;
    return;
  }
  const controller = new AbortController();
  onCleanup(() => controller.abort());
  searchLoading.value = true;
  try {
    const data = await api<{ results: GlobalSearchResult[] }>(`/api/search${queryString({ q, groupId: app.groupId })}`, {
      signal: controller.signal,
    });
    searchResults.value = data.results;
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "AbortError")) {
      app.showToast((error as Error).message, "error");
    }
  } finally {
    if (!controller.signal.aborted) searchLoading.value = false;
  }
});
</script>

<template>
  <RouterView v-if="isLogin" />
  <div v-else class="app-shell">
    <aside class="sidebar" :class="{ open: mobileNavOpen }">
      <div class="brand">
        <span class="brand-mark">UB</span>
        <div>
          <strong>UBot</strong>
          <small>群聊运营控制台</small>
        </div>
      </div>

      <nav class="nav-list">
        <RouterLink v-for="item in navItems" :key="String(item.name)" :to="item.path" class="nav-item" @click="mobileNavOpen = false">
          <AppIcon :name="iconFor(item.name)" />
          <span>{{ item.meta?.title }}</span>
        </RouterLink>
      </nav>

      <div class="sidebar-footer">
        <div class="side-status">
          <strong><span /> 系统运行中</strong>
          <small>UBot v4.7.1</small>
        </div>
      </div>
    </aside>

    <main class="main-area">
      <header class="topbar">
        <button class="mobile-menu-btn" type="button" :aria-expanded="mobileNavOpen" aria-label="Toggle navigation" @click="mobileNavOpen = !mobileNavOpen">
          <AppIcon name="settings" :size="17" />
          <span>菜单</span>
        </button>

        <div class="top-title">
          <h1>{{ title }}</h1>
          <p>{{ subtitle }}</p>
        </div>

        <div class="top-actions">
          <form class="search-box" @submit.prevent="runGlobalSearch">
            <AppIcon name="search" :size="16" />
            <input v-model="globalQuery" placeholder="搜索成员、记忆、FAQ..." />
            <kbd>Ctrl K</kbd>
          </form>

          <select v-model="app.groupId" class="group-select">
            <option v-for="group in app.groups" :key="group.groupId" :value="group.groupId">
              {{ group.groupName || group.groupId }} / {{ group.groupId }}
            </option>
          </select>

          <button class="icon-btn" type="button" title="Refresh" @click="refreshCurrent">
            <AppIcon name="refresh" />
          </button>

          <div class="popover-wrap">
            <button class="icon-btn notify-btn" type="button" title="Notifications" @click="openNotifications">
              <AppIcon name="bell" />
              <span v-if="app.notifications.pendingCandidateCount > 0">{{ app.notifications.pendingCandidateCount }}</span>
            </button>
            <div v-if="notificationsOpen" class="top-popover notify-popover">
              <strong>候选记忆提醒</strong>
              <p>{{ app.notifications.pendingCandidateCount }} 条候选等待处理</p>
              <button class="btn" type="button" data-smoke="review-candidates" @click="go('/candidates')">去审核</button>
              <div class="notify-list">
                <div v-for="item in app.notifications.latestCandidates" :key="item.id" class="notify-item">
                  <span>{{ item.title }}</span>
                  <small>{{ item.groupId }}</small>
                </div>
              </div>
            </div>
          </div>

          <button v-if="app.role === 'super_admin'" class="icon-btn" type="button" title="Settings" @click="router.push('/settings')">
            <AppIcon name="settings" />
          </button>

          <div class="popover-wrap">
            <button class="icon-btn" type="button" title="Theme" @click="openTheme">
              <AppIcon name="theme" />
            </button>
            <div v-if="themeOpen" class="top-popover theme-popover">
              <strong>主题</strong>
              <button :class="{ active: app.themeMode === 'light' }" type="button" data-smoke="theme-light" @click="app.applyTheme('light')">浅色</button>
              <button :class="{ active: app.themeMode === 'dark' }" type="button" data-smoke="theme-dark" @click="app.applyTheme('dark')">深色</button>
              <button :class="{ active: app.themeMode === 'system' }" type="button" data-smoke="theme-system" @click="app.applyTheme('system')">跟随系统</button>
            </div>
          </div>

          <div class="popover-wrap">
            <button class="user-chip" type="button" title="User" @click="openUser">
              {{ userInitials }}
            </button>
            <div v-if="userOpen" class="top-popover user-popover">
              <strong>{{ app.username }}</strong>
              <p>{{ roleLabel }}</p>
              <p v-if="app.role !== 'super_admin'">可管理 {{ app.allowedGroupIds.length }} 个群</p>
              <button class="ghost-btn logout" type="button" data-smoke="logout" @click.stop="logout">退出登录</button>
            </div>
          </div>
        </div>
      </header>

      <button v-if="notificationsOpen || themeOpen || userOpen || mobileNavOpen" class="popover-backdrop" type="button" aria-label="Close popover" @click="closeFloating(); mobileNavOpen = false" />

      <section class="content-scroll">
        <RouterView />
      </section>
      <div v-if="app.toast.visible" class="toast" :class="app.toast.type">{{ app.toast.message }}</div>
    </main>

    <aside v-if="commandOpen" class="command-overlay" @click.self="commandOpen = false">
      <section class="command-panel" role="dialog" aria-modal="true">
        <div class="command-head">
          <AppIcon name="search" :size="18" />
          <input v-model="commandQuery" class="command-input" placeholder="搜索页面、成员、记忆、FAQ..." @keydown.enter="runFirstCommandResult" />
          <button class="icon-close" type="button" @click="commandOpen = false">x</button>
        </div>
        <div class="command-list">
          <div v-if="hasCommandQuery" class="command-section-title">
            <span>搜索结果</span>
            <small v-if="searchLoading">搜索中...</small>
            <small v-else>{{ searchResults.length }} 项</small>
          </div>
          <button v-for="item in searchResults" :key="`${item.type}:${item.path}:${item.groupId || ''}`" class="command-row result-row" type="button" @click="goSearchResult(item)">
            <AppIcon :name="resultIcon(item.type)" />
            <span>{{ item.title }}</span>
            <small><b>{{ searchTypeLabel(item.type) }}</b> · {{ item.subtitle }}</small>
          </button>
          <div v-if="hasCommandQuery && !searchLoading && !searchResults.length" class="command-empty">没有匹配的成员、记忆或 FAQ。</div>

          <div class="command-section-title">
            <span>页面</span>
            <small>{{ pageCommandItems.length }} 项</small>
          </div>
          <button v-for="item in pageCommandItems" :key="String(item.name)" class="command-row" type="button" @click="go(String(item.path))">
            <AppIcon :name="iconFor(item.name)" />
            <span>{{ item.meta?.title }}</span>
            <small>{{ item.meta?.subtitle }}</small>
          </button>
        </div>
      </section>
    </aside>
  </div>
</template>

<style scoped>
.app-shell {
  display: grid;
  grid-template-columns: var(--sidebar-width) minmax(0, 1fr);
  width: 100%;
  min-height: 100vh;
  overflow: visible;
}

.sidebar {
  position: sticky;
  top: 0;
  display: grid;
  grid-template-rows: auto 1fr auto;
  min-height: 0;
  height: 100dvh;
  overflow: hidden;
  border-right: 1px solid var(--line);
  background: color-mix(in oklch, var(--surface) 90%, transparent);
  padding: 24px 18px 18px;
}

.brand,
.top-actions,
.search-box,
.nav-item {
  display: flex;
  align-items: center;
}

.brand {
  gap: 14px;
  padding: 0 10px;
}

.brand-mark,
.user-chip {
  display: grid;
  place-items: center;
  background: var(--accent-strong);
  color: oklch(0.99 0.004 160);
  font-weight: 900;
}

.brand-mark {
  width: 42px;
  height: 42px;
  border-radius: 13px;
  box-shadow: 0 12px 30px oklch(0.55 0.16 164 / 24%);
}

.brand strong {
  display: block;
  font-size: 28px;
}

.brand small,
.side-status small,
.notify-item small,
.top-popover p {
  color: var(--muted);
}

.nav-list {
  display: grid;
  align-content: start;
  gap: 8px;
  min-height: 0;
  margin-top: 34px;
  overflow: auto;
  padding-right: 2px;
}

.nav-item {
  gap: 14px;
  min-height: 46px;
  border-radius: var(--radius-sm);
  color: var(--muted);
  padding: 0 18px;
  font-weight: 800;
}

.nav-item.router-link-active {
  background: var(--accent-soft);
  color: var(--accent-strong);
}

.sidebar-footer {
  display: grid;
  gap: 10px;
  min-height: 0;
}

.side-status {
  display: grid;
  gap: 8px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface);
  padding: 12px;
}

.side-status strong {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--accent-strong);
}

.side-status span {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--accent);
}

.main-area {
  position: relative;
  display: grid;
  grid-template-rows: auto auto;
  align-content: start;
  width: min(100%, var(--page-max));
  min-width: 0;
  min-height: 100vh;
  margin: 0 auto;
  padding: 22px 28px 34px;
  overflow: visible;
}

.topbar {
  position: sticky;
  top: 0;
  z-index: 30;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
  margin: -22px -28px 20px;
  padding: 22px 28px 12px;
  border: 1px solid color-mix(in oklch, var(--line) 72%, transparent);
  border-top: 0;
  border-radius: 0 0 18px 18px;
  background: color-mix(in oklch, var(--surface) 94%, transparent);
}

.top-title {
  min-width: 220px;
}

.topbar h1 {
  margin: 0 0 8px;
  font-size: 28px;
}

.topbar p {
  margin: 0;
  color: var(--muted);
}

.content-scroll {
  min-height: 0;
  overflow: visible;
  padding-bottom: 0;
}

.top-actions {
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
}

.search-box {
  gap: 10px;
  width: clamp(220px, 22vw, 340px);
  min-height: 42px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface);
  padding: 0 12px;
  color: var(--muted);
}

.search-box input {
  min-width: 0;
  flex: 1;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--text);
}

kbd {
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 2px 7px;
  color: var(--muted);
  font-size: 12px;
}

.group-select {
  width: min(250px, 21vw);
  min-width: 172px;
  min-height: 42px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface);
  color: var(--text);
  padding: 0 14px;
}

.popover-wrap {
  position: relative;
  z-index: 45;
  display: inline-flex;
}

.popover-backdrop {
  position: fixed;
  inset: 0;
  z-index: 21;
  background: transparent;
}

.notify-btn span {
  position: absolute;
  top: -6px;
  right: -6px;
  min-width: 20px;
  height: 20px;
  border-radius: 999px;
  background: var(--danger);
  color: oklch(0.99 0.004 25);
  font-size: 12px;
  line-height: 20px;
}

.top-popover {
  position: absolute;
  z-index: 46;
  top: 52px;
  right: 0;
  display: grid;
  gap: 10px;
  min-width: 230px;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--surface);
  box-shadow: var(--shadow-md);
  padding: 14px;
}

.notify-popover {
  width: 330px;
}

.notify-list {
  display: grid;
  gap: 10px;
  max-height: min(318px, calc(6 * 54px));
  overflow: auto;
}

.notify-item {
  display: grid;
  gap: 4px;
  border-top: 1px solid var(--line);
  padding-top: 10px;
}

.theme-popover button {
  min-height: 36px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface);
  color: var(--text);
}

.theme-popover button.active {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent-strong);
  font-weight: 800;
}

.user-chip {
  width: 42px;
  height: 42px;
  border-radius: 999px;
}

.mobile-menu-btn {
  display: none;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 40px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface);
  color: var(--text);
  padding: 0 12px;
  font-weight: 800;
}

.user-popover {
  width: 250px;
}

.logout {
  width: 100%;
}

.command-overlay {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: grid;
  place-items: start center;
  background: color-mix(in oklch, var(--text) 18%, transparent);
  padding-top: 12vh;
}

.command-panel {
  width: min(680px, calc(100vw - 28px));
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  background: var(--surface);
  box-shadow: var(--shadow-md);
  padding: 14px;
}

.command-head {
  display: flex;
  align-items: center;
  gap: 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface-soft);
  padding: 0 10px;
}

.command-input {
  flex: 1;
  min-width: 0;
  min-height: 46px;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--text);
}

.command-list {
  display: grid;
  gap: 8px;
  max-height: 420px;
  overflow: auto;
  padding-top: 12px;
}

.command-row {
  display: grid;
  grid-template-columns: auto minmax(110px, 0.4fr) minmax(0, 1fr);
  gap: 12px;
  align-items: center;
  min-height: 48px;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text);
  padding: 0 12px;
  text-align: left;
}

.command-row:hover {
  background: var(--accent-soft);
  color: var(--accent-strong);
}

.command-row small {
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.command-row small b {
  color: var(--accent-strong);
}

.command-section-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--muted);
  padding: 8px 8px 2px;
  font-size: 12px;
  font-weight: 900;
}

.command-empty {
  border: 1px dashed var(--line);
  border-radius: var(--radius-sm);
  color: var(--muted);
  padding: 14px;
  text-align: center;
}

.icon-close {
  width: 34px;
  height: 34px;
  border-radius: 999px;
  background: transparent;
  color: var(--muted);
  font-size: 18px;
}

.toast {
  position: fixed;
  right: 28px;
  bottom: 28px;
  z-index: 40;
  max-width: 420px;
  border-radius: var(--radius-sm);
  background: var(--text);
  color: var(--surface);
  padding: 13px 16px;
  box-shadow: var(--shadow-md);
}

.toast.error {
  background: var(--danger);
  color: oklch(0.99 0.004 25);
}

@media (max-width: 980px) {
  .app-shell {
    grid-template-columns: 1fr;
    height: auto;
    min-height: 100vh;
    overflow: visible;
  }

  .sidebar {
    position: fixed;
    inset: 0 auto 0 0;
    z-index: 50;
    width: min(310px, calc(100vw - 42px));
    height: 100dvh;
    overflow: hidden;
    transform: translateX(-105%);
    transition: transform 0.18s ease-out;
    box-shadow: var(--shadow-md);
  }

  .sidebar.open {
    transform: translateX(0);
  }

  .nav-list {
    margin-top: 20px;
  }

  .topbar {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: start;
  }

  .main-area {
    height: auto;
    min-height: 100vh;
    overflow: visible;
  }

  .content-scroll {
    overflow: visible;
  }

  .search-box,
  .group-select {
    width: 100%;
  }

  .mobile-menu-btn {
    display: inline-flex;
  }

  .top-actions {
    grid-column: 1 / -1;
    justify-content: stretch;
  }
}

@media (max-width: 520px) {
  .main-area {
    padding: 18px 12px 34px;
  }

  .topbar {
    margin: -18px -12px 16px;
    padding: 14px 12px 10px;
    gap: 12px;
  }

  .topbar h1 {
    font-size: 23px;
    margin-bottom: 4px;
  }

  .topbar p {
    font-size: 13px;
  }

  .top-actions,
  .group-select {
    width: 100%;
  }

  .group-select {
    min-width: 0;
  }

  .nav-list {
    grid-template-columns: 1fr;
  }
}
</style>
