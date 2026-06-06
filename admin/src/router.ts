import { createRouter, createWebHistory } from "vue-router";
import { useAppStore } from "./stores/app";

export const routes = [
  { path: "/login", name: "login", component: () => import("./views/LoginView.vue"), meta: { title: "后台登录", subtitle: "输入管理员账号和秘钥进入 UBot 控制台" } },
  { path: "/", name: "overview", component: () => import("./views/OverviewView.vue"), meta: { title: "总览", subtitle: "查看群聊助手的关键数据、候选提醒和运行状态" } },
  { path: "/groups", name: "groups", component: () => import("./views/GroupsView.vue"), meta: { title: "群配置", subtitle: "管理群回复、权限、触发词、语音和定时能力" } },
  { path: "/members", name: "members", component: () => import("./views/MembersView.vue"), meta: { title: "成员管理", subtitle: "查看成员、身份、画像记录和记忆收集开关" } },
  { path: "/candidates", name: "candidates", component: () => import("./views/CandidatesView.vue"), meta: { title: "候选记忆", subtitle: "审核模型提取的候选记忆并批量入库" } },
  { path: "/memories", name: "memories", component: () => import("./views/MemoriesView.vue"), meta: { title: "长期记忆", subtitle: "维护长期记忆、状态、归属、溯源和去重" } },
  { path: "/profiles", name: "profiles", component: () => import("./views/ProfilesView.vue"), meta: { title: "画像总结", subtitle: "查看群聊画像和昨日画像的完整历史记录" } },
  { path: "/knowledge", name: "knowledge", component: () => import("./views/KnowledgeView.vue"), meta: { title: "知识库", subtitle: "管理群内 FAQ 和历史聊天提炼后的知识条目" } },
  { path: "/tasks", name: "tasks", component: () => import("./views/TasksView.vue"), meta: { title: "任务中心", subtitle: "追踪去重、画像生成、模型检测和批量审核任务" } },
  { path: "/skills", name: "skills", component: () => import("./views/SkillsView.vue"), meta: { title: "Skills 管理", subtitle: "创建、编辑、导入导出和备份机器人技能", superOnly: true } },
  { path: "/commands", name: "commands", component: () => import("./views/CommandsView.vue"), meta: { title: "指令管理", subtitle: "维护系统指令名称、别名、权限和帮助文案", superOnly: true } },
  { path: "/health", name: "health", component: () => import("./views/HealthView.vue"), meta: { title: "系统状态", subtitle: "监控服务运行、服务器资源和异常模型" } },
  { path: "/settings", name: "settings", component: () => import("./views/SettingsView.vue"), meta: { title: "系统管理", subtitle: "统一配置机器人全局行为、模型接入与记忆策略", superOnly: true } },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach(async (to) => {
  if (to.name === "login") return true;
  const app = useAppStore();
  if (!app.username) {
    await app.loadSession();
  }
  if (to.meta.superOnly && app.role !== "super_admin") {
    return { path: "/" };
  }
  return true;
});
