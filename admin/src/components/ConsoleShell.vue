<script setup lang="ts">
import { computed, onMounted, onUnmounted, shallowRef, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import AppIcon from "./AppIcon.vue";
import AdminDialog from "./AdminDialog.vue";
import ReauthDialog from "./ReauthDialog.vue";
import { confirmation, resolveConfirmation } from "../composables/useConfirm";
import { allowContextChange } from "../composables/useUnsavedChanges";
import { dispatchGroupChanged, dispatchRefreshCurrent } from "../composables/useRefreshEvents";
import { routes } from "../router";
import { workspaces } from "../workspaces";
import { api, queryString, type GlobalSearchResult } from "../services/api";
import { useAppStore } from "../stores/app";

const app = useAppStore();
const route = useRoute();
const router = useRouter();
const version = __UBOT_VERSION__;
const mobileNavOpen = shallowRef(false);
const collapsed = shallowRef(localStorage.getItem("ubot-nav-collapsed") === "true");
const themeOpen = shallowRef(false);
const userOpen = shallowRef(false);
const commandOpen = shallowRef(false);
const commandQuery = shallowRef("");
const searchResults = shallowRef<GlobalSearchResult[]>([]);
const searchLoading = shallowRef(false);

const isLogin = computed(() => route.name === "login");
const pages = computed(() => routes.filter(item => item.name && item.name !== "login" && item.meta.navigation !== false && (!item.meta.superOnly || app.role === "super_admin")));
const navigation = computed(() => workspaces
  .map(workspace => ({ ...workspace, items: pages.value.filter(page => workspace.pages.includes(String(page.name))) }))
  .filter(workspace => workspace.items.length));
const workspace = computed(() => navigation.value.find(item => item.id === route.meta.workspace));
const roleLabel = computed(() => app.role === "super_admin" ? "超级管理员" : "群管理员");
const currentTitle = computed(() => String(route.meta.title || workspace.value?.title || "控制台"));
const tabs = computed(() => (workspace.value?.items || []).flatMap(item => item.name === "settings"
  ? [{ path: "/settings", title: "模型", query: { tab: "models" } }, { path: "/settings", title: "运行策略", query: { tab: "runtime" } }]
  : [{ path: item.path, title: String(item.meta.title), query: {} as Record<string, string> }]));
const matchingPages = computed(() => pages.value.filter(item => `${item.meta.title} ${item.meta.subtitle}`.toLowerCase().includes(commandQuery.value.trim().toLowerCase())));
const pageIcons: Record<string, string> = {
  overview: "overview",
  analytics: "list",
  groups: "settings",
  "group-bulk": "tasks",
  interactions: "health",
  audio: "bell",
  members: "users",
  memories: "memory",
  knowledge: "knowledge",
  "html-previews": "knowledge",
  "image-previews": "overview",
  memes: "overview",
  persona: "users",
  commands: "list",
  tasks: "tasks",
  audit: "audit",
  settings: "settings",
  health: "health",
  security: "audit",
};

function tabActive(tab: typeof tabs.value[number]) {
  return route.path === tab.path && (!tab.query.tab || (route.query.tab || "models") === tab.query.tab);
}

function pageIcon(name: unknown, fallback: string) {
  return pageIcons[String(name)] || fallback;
}

function pageLink(path: string, query: Record<string, string> = {}) {
  return { path, query: { ...query, ...(app.groupId ? { group: app.groupId } : {}) } };
}

function closeFloating() {
  themeOpen.value = false;
  userOpen.value = false;
}

async function go(path: string, groupId?: string) {
  commandOpen.value = false;
  mobileNavOpen.value = false;
  closeFloating();
  await router.push({ path, query: groupId || app.groupId ? { group: groupId || app.groupId } : {} });
}

async function logout() {
  if (!await allowContextChange()) return;
  try {
    await app.logout();
  } catch (error) {
    app.showToast((error as Error).message, "error");
  }
}

function changeGroup(event: Event) {
  const groupId = (event.target as HTMLSelectElement).value;
  void router.replace({ query: { ...route.query, group: groupId || undefined } });
}

function themeLabel(mode: string) {
  return ({ light: "浅色", dark: "深色", system: "跟随系统" } as Record<string, string>)[mode] || mode;
}

function keydown(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    commandOpen.value = true;
    closeFloating();
  }
  if (event.key === "Escape") {
    closeFloating();
    mobileNavOpen.value = false;
  }
}

onMounted(async () => {
  app.applyTheme();
  window.addEventListener("keydown", keydown);
  if (!isLogin.value) {
    await app.loadSession();
    await app.loadGroups();
    const initial = String(route.query.group || "");
    if (app.groups.some(group => group.groupId === initial)) app.groupId = initial;
  }
});

onUnmounted(() => window.removeEventListener("keydown", keydown));

watch(collapsed, value => localStorage.setItem("ubot-nav-collapsed", String(value)));
watch(() => app.groupId, () => {
  dispatchGroupChanged();
  if (!isLogin.value && app.groupId && route.query.group !== app.groupId) {
    void router.replace({ query: { ...route.query, group: app.groupId } });
  }
});
watch(() => route.query.group, value => {
  if (value && app.groups.some(group => group.groupId === value) && app.groupId !== value) app.groupId = String(value);
});
watch(() => route.fullPath, () => {
  mobileNavOpen.value = false;
  closeFloating();
});
watch(commandQuery, async (value, _, cleanup) => {
  const q = value.trim();
  searchResults.value = [];
  if (!q) return;
  const controller = new AbortController();
  cleanup(() => controller.abort());
  searchLoading.value = true;
  try {
    const data = await api<{ results: GlobalSearchResult[] }>(`/api/search${queryString({ q, groupId: app.groupId })}`, { signal: controller.signal });
    searchResults.value = data.results;
  } catch (error) {
    if (!controller.signal.aborted) app.showToast((error as Error).message, "error");
  } finally {
    if (!controller.signal.aborted) searchLoading.value = false;
  }
});
</script>

<template>
  <ReauthDialog />
  <RouterView v-if="isLogin" />
  <div v-else class="console-stage">
    <div class="console-shell" :class="{ 'nav-collapsed': collapsed }">
      <a href="#page-content" class="skip-link">跳到页面内容</a>
      <aside class="console-rail m-rail" :class="{ open: mobileNavOpen }" aria-label="工作区导航">
        <a class="rail-brand" href="/" @click.prevent="go('/')">
          <span class="rail-mark" aria-hidden="true"><span>UB</span><i /></span>
          <span class="rail-brand-copy"><strong>UBot v{{ version }}</strong><small>群聊运营控制台</small></span>
        </a>
        <div class="rail-scroll">
          <nav class="rail-nav">
            <section v-for="space in navigation" :key="space.id" class="rail-group">
              <p class="rail-group-title"><AppIcon :name="space.icon" :size="14" /><span>{{ space.title }}</span></p>
              <RouterLink
                v-for="item in space.items"
                :key="String(item.name)"
                :to="pageLink(item.path)"
                class="rail-item"
                :class="{ active: route.path === item.path }"
                :title="String(item.meta.title)"
                @click="mobileNavOpen = false"
              >
                <AppIcon :name="pageIcon(item.name, space.icon)" :size="16" />
                <span>{{ item.meta.title }}</span>
              </RouterLink>
            </section>
          </nav>
        </div>
        <footer class="rail-footer">
          <div class="rail-account">
            <span class="account-avatar">{{ app.username.slice(0, 1).toUpperCase() }}</span>
            <span class="rail-account-copy"><strong>{{ app.username }}</strong><small>{{ roleLabel }}</small></span>
          </div>
          <button class="rail-collapse" type="button" :aria-label="collapsed ? '展开侧栏' : '折叠侧栏'" @click="collapsed = !collapsed">
            <AppIcon :name="collapsed ? 'chevronRight' : 'chevronLeft'" :size="15" />
            <span>{{ collapsed ? '展开侧栏' : '折叠侧栏' }}</span>
          </button>
        </footer>
      </aside>
      <button v-if="mobileNavOpen" class="nav-backdrop" aria-label="关闭导航" @click="mobileNavOpen = false" />
      <main class="console-main">
        <header class="console-topbar">
          <button class="mobile-menu-btn icon-btn" type="button" :aria-expanded="mobileNavOpen" aria-label="打开导航" @click="mobileNavOpen = !mobileNavOpen"><AppIcon name="menu" /></button>
          <div class="console-breadcrumb" aria-label="当前位置">
            <AppIcon name="overview" :size="16" />
            <span>控制台</span><span class="breadcrumb-separator">/</span><strong>{{ workspace?.title }}</strong><span class="breadcrumb-separator">/</span><span>{{ currentTitle }}</span>
          </div>
          <div class="top-actions">
            <label class="group-picker m-pill">
              <AppIcon name="users" :size="15" />
              <select :value="app.groupId" class="group-select select" aria-label="当前群" @change="changeGroup">
                <option v-for="group in app.groups" :key="group.groupId" :value="group.groupId">{{ group.groupName || group.groupId }}</option>
                <option v-if="!app.groups.length" value="">暂无授权群</option>
              </select>
            </label>
            <button class="command-trigger m-pill" aria-label="搜索页面、成员、记忆" @click="commandOpen = true"><AppIcon name="search" :size="16" /><span>搜索控制台</span><kbd>Ctrl K</kbd></button>
            <button class="icon-btn" type="button" title="刷新当前页" aria-label="刷新当前页" @click="dispatchRefreshCurrent"><AppIcon name="refresh" /></button>
            <div class="popover-wrap theme-menu">
              <button class="icon-btn" type="button" title="切换主题" aria-label="切换主题" @click="themeOpen = !themeOpen; userOpen = false"><AppIcon name="theme" /></button>
              <div v-if="themeOpen" class="top-popover m-float">
                <strong>显示主题</strong>
                <button v-for="mode in (['light', 'dark', 'system'] as const)" :key="mode" :data-smoke="'theme-' + mode" :class="{ active: app.themeMode === mode }" @click="app.applyTheme(mode); themeOpen = false">{{ themeLabel(mode) }}</button>
              </div>
            </div>
            <div class="popover-wrap account-menu">
              <button class="account-chip m-pill" aria-label="账号菜单" @click="userOpen = !userOpen; themeOpen = false"><span class="account-avatar">{{ app.username.slice(0, 1).toUpperCase() }}</span><span class="account-meta"><strong>{{ app.username }}</strong><small>{{ roleLabel }}</small></span><AppIcon name="chevronDown" :size="14" /></button>
              <div v-if="userOpen" class="top-popover m-float">
                <strong>{{ app.username }}</strong><small class="muted">{{ roleLabel }}</small>
                <button @click="go('/security')">账号与安全</button>
                <button data-smoke="logout" @click="logout">退出登录</button>
              </div>
            </div>
          </div>
        </header>
        <button v-if="themeOpen || userOpen" class="popover-backdrop" aria-label="关闭菜单" @click="closeFloating" />
        <nav class="workspace-tabs" aria-label="当前工作区页面">
          <RouterLink v-for="tab in tabs" :key="tab.title" :to="pageLink(tab.path, tab.query)" :class="{ active: tabActive(tab) }">{{ tab.title }}</RouterLink>
        </nav>
        <section id="page-content" class="content-scroll" tabindex="-1"><RouterView /></section>
      </main>
    </div>
  </div>
  <div v-if="app.toast.visible" class="toast m-float" :class="app.toast.type" role="status">{{ app.toast.message }}</div>
  <AdminDialog v-if="commandOpen" title="搜索控制台" @close="commandOpen = false">
    <input v-model="commandQuery" class="input command-input" placeholder="页面、成员、记忆、FAQ…" aria-label="搜索关键词" autofocus />
    <div class="command-results">
      <small v-if="searchLoading" class="muted">正在搜索…</small>
      <button v-for="item in searchResults" :key="item.path + item.title" @click="go(item.path, item.groupId)"><strong>{{ item.title }}</strong><small>{{ item.subtitle }}</small></button>
      <span v-if="commandQuery && !searchLoading && !searchResults.length" class="muted">没有匹配的业务记录</span>
      <p class="eyebrow">页面</p>
      <button v-for="item in matchingPages" :key="item.path" @click="go(item.path)"><strong>{{ item.meta.title }}</strong><small>{{ item.meta.subtitle }}</small></button>
    </div>
  </AdminDialog>
  <AdminDialog v-if="confirmation" :title="confirmation.title" @close="resolveConfirmation(false)">
    <p class="confirm-message">{{ confirmation.message }}</p>
    <template #footer><button class="ghost-btn" type="button" @click="resolveConfirmation(false)">取消</button><button class="btn" :class="{ danger: confirmation.danger }" type="button" @click="resolveConfirmation(true)">{{ confirmation.confirmText || '确定' }}</button></template>
  </AdminDialog>
</template>
