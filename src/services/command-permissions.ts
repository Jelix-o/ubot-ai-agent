import type { SystemCommandConfig } from "../types.js";

export type CommandPermission = SystemCommandConfig["permission"];
const ranks: Record<CommandPermission, number> = { member: 0, group_admin: 1, super_admin: 2 };
const memberCommands = new Set(["bt_search", "conversation", "html_preview", "image_generation", "help", "self_memory", "self_memory_edit", "self_memory_delete", "personal_reminder", "spoken_reply", "original_song"]);
export function minimumCommandPermission(id: string): CommandPermission {
  return id === "model" ? "super_admin" : memberCommands.has(id) ? "member" : "group_admin";
}
export function isCommandPermission(value: unknown): value is CommandPermission {
  return value === "member" || value === "group_admin" || value === "super_admin";
}
export function permissionAtLeast(actual: CommandPermission, required: CommandPermission): boolean {
  return ranks[actual] >= ranks[required];
}
export function normalizeCommandPermission(id: string, value: unknown): CommandPermission {
  const minimum = minimumCommandPermission(id);
  return isCommandPermission(value) && permissionAtLeast(value, minimum) ? value : minimum;
}
