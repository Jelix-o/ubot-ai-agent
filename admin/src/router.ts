import { createRouter, createWebHistory } from "vue-router";
import { useAppStore } from "./stores/app";
import AppLoginView from "./views/LoginView.vue";
import AppOverviewView from "./views/OverviewView.vue";
import AppGroupsView from "./views/GroupsView.vue";
import AppMembersView from "./views/MembersView.vue";
import AppMemoriesView from "./views/MemoriesView.vue";
import AppKnowledgeView from "./views/KnowledgeView.vue";
import AppPersonaView from "./views/PersonaView.vue";
import AppCommandsView from "./views/CommandsView.vue";
import AppTasksView from "./views/TasksView.vue";
import AppAuditView from "./views/AuditView.vue";
import AppHealthView from "./views/HealthView.vue";
import AppSettingsView from "./views/SettingsView.vue";
import AppSecurityView from "./views/SecurityView.vue";
import AppHtmlPreviewsView from "./views/HtmlPreviewsView.vue";
import AppMemeLibraryView from "./views/MemeLibraryView.vue";
import AppAnalyticsView from "./views/AnalyticsView.vue";
import AppBulkConfigView from "./views/BulkConfigView.vue";
import { workspaces } from "./workspaces";
import { allowContextChange } from "./composables/useUnsavedChanges";

export const routes = [
  { path: "/login", name: "login", component: AppLoginView, meta: { title: "后台登录", subtitle: "使用管理员账号进入 UBot 控制台" } },
  { path: "/", name: "overview", component: AppOverviewView, meta: { title: "总览", subtitle: "查看群聊助手的关键数据和运行状态" } },
  { path: "/analytics", name: "analytics", component: AppAnalyticsView, meta: { title: "调用分析", subtitle: "查看真实模型请求、用量和上游计费" } },
  { path: "/groups/bulk", name: "group-bulk", component: AppBulkConfigView, meta: { title: "跨群配置", subtitle: "预览差异后，将选定配置复制到多个群", superOnly: true } },
  { path: "/groups", name: "groups", component: AppGroupsView, meta: { title: "群配置", subtitle: "管理群回复、权限、触发词和定时能力" } },
  { path: "/members", name: "members", component: AppMembersView, meta: { title: "成员管理", subtitle: "维护成员备注、身份标签、明确记忆和隐私退出" } },
  { path: "/memories", name: "memories", component: AppMemoriesView, meta: { title: "记忆", subtitle: "维护明确保存的记忆、归属、状态和来源" } },
  { path: "/knowledge", name: "knowledge", component: AppKnowledgeView, meta: { title: "知识库", subtitle: "管理群内 FAQ 和历史聊天提炼后的知识条目" } },
  { path: "/html-previews", name: "html-previews", component: AppHtmlPreviewsView, meta: { title: "网页预览", subtitle: "管理群内生成的静态网页预览链接和留存时间" } },
  { path: "/memes", name: "memes", component: AppMemeLibraryView, meta: { title: "表情包库", subtitle: "查看随机图片回复、场景标签和黑名单 @ 专用素材", superOnly: true } },
  { path: "/persona", name: "persona", component: AppPersonaView, meta: { title: "会仙人格", subtitle: "维护会仙的身份、表达边界和回复节奏", superOnly: true } },
  // Keep old bookmarks working without exposing this compatibility alias as a page.
  { path: "/skills", redirect: "/persona", meta: { navigation: false } },
  { path: "/commands", name: "commands", component: AppCommandsView, meta: { title: "指令管理", subtitle: "查看系统指令名称、别名、权限和帮助文案" } },
  { path: "/tasks", name: "tasks", component: AppTasksView, meta: { title: "任务中心", subtitle: "追踪显式记忆去重、模型检测和批量运营任务" } },
  { path: "/audit", name: "audit", component: AppAuditView, meta: { title: "操作审计", subtitle: "查看后台管理动作、操作者、目标和执行详情" } },
  { path: "/security", name: "security", component: AppSecurityView, meta: { title: "账号与安全", subtitle: "管理密码、后台账号与群授权" } },
  { path: "/health", name: "health", component: AppHealthView, meta: { title: "系统状态", subtitle: "监控服务运行、服务器资源和异常模型", superOnly: true } },
  { path: "/settings", name: "settings", component: AppSettingsView, meta: { title: "系统管理", subtitle: "统一配置机器人全局行为、模型接入与记忆策略", superOnly: true } },
];

for (const route of routes) Object.assign(route.meta, { workspace: workspaces.find(workspace => workspace.pages.includes(String(route.name)))?.id });

export const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach(async (to, from) => {
  if (from.name && to.fullPath !== from.fullPath &&
      (to.path !== from.path || to.query.group !== from.query.group) &&
      !(await allowContextChange())) return false;
  if (to.name === "login") return true;
  const app = useAppStore();
  if (!app.sessionLoaded) {
    await app.loadSession();
  }
  if (to.meta.superOnly && app.role !== "super_admin") {
    return { path: "/" };
  }
  return true;
});
