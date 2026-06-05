import { defineStore } from "pinia";
import { computed, reactive, shallowRef } from "vue";

import { api, type AdminSession, type GroupConfig, type NotificationData } from "../services/api";

export type ThemeMode = "light" | "dark" | "system";

const themeStorageKey = "ubot-admin-theme";

export const useAppStore = defineStore("app", () => {
  const groups = shallowRef<GroupConfig[]>([]);
  const groupId = shallowRef("");
  const username = shallowRef("");
  const role = shallowRef<AdminSession["role"]>("super_admin");
  const allowedGroupIds = shallowRef<string[]>([]);
  const publicBaseUrl = shallowRef("");
  const notifications = shallowRef<NotificationData>({ pendingCandidateCount: 0, latestCandidates: [] });
  const toast = reactive({ message: "", type: "ok" as "ok" | "error", visible: false });
  const themeMode = shallowRef<ThemeMode>((localStorage.getItem(themeStorageKey) as ThemeMode) || "system");
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  const currentGroup = computed(() => groups.value.find((group) => group.groupId === groupId.value));

  function applyTheme(mode = themeMode.value): void {
    themeMode.value = mode;
    localStorage.setItem(themeStorageKey, mode);
    const dark = mode === "dark" || (mode === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    document.documentElement.dataset.themeMode = mode;
  }

  function showToast(message: string, type: "ok" | "error" = "ok"): void {
    toast.message = message;
    toast.type = type;
    toast.visible = true;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.visible = false;
    }, type === "error" ? 5200 : 2400);
  }

  async function loadSession(): Promise<void> {
    const session = await api<AdminSession>("/api/session");
    username.value = session.username;
    role.value = session.role;
    allowedGroupIds.value = session.allowedGroupIds;
    publicBaseUrl.value = session.publicBaseUrl;
  }

  async function loadNotifications(): Promise<void> {
    notifications.value = await api<NotificationData>("/api/notifications");
  }

  async function loadGroups(options: { includeDisabled?: boolean } = {}): Promise<void> {
    const data = await api<{ groups: GroupConfig[] }>(options.includeDisabled ? "/api/groups?includeDisabled=1" : "/api/groups");
    groups.value = data.groups;
    if (!groupId.value && data.groups[0]) {
      groupId.value = data.groups[0].groupId;
    }
    if (groupId.value && !data.groups.some((group) => group.groupId === groupId.value) && data.groups[0]) {
      groupId.value = data.groups[0].groupId;
    }
  }

  async function logout(): Promise<void> {
    await api("/api/logout", { method: "POST", body: "{}" });
    window.location.href = "/login";
  }

  return {
    groups,
    groupId,
    username,
    role,
    allowedGroupIds,
    publicBaseUrl,
    notifications,
    toast,
    themeMode,
    currentGroup,
    applyTheme,
    showToast,
    loadSession,
    loadGroups,
    loadNotifications,
    logout,
  };
});
