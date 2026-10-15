import type { GroupsConfigFile, SystemSettings } from "../types.js";
import { defaultReplyRouting } from "./system-settings-store.js";
import { StateCipher, V3StateRepository } from "./v3-state-repository.js";

const marker = "model_policy_v3_0_39";
const backupType = "release-policy-backup";
const backupKey = "v3.0.39";

export function checkModelPolicyUpgrade(repository: V3StateRepository): void {
  repository.requireCutover();
  const settings = repository.getSystemSettings();
  for (const id of ["sol", "gpt", "ds"]) {
    const model = settings?.models.find(model => model.id === id && model.purpose === "reply" && model.enabled && model.apiKey?.trim());
    if (!model) throw new Error(`required_reply_model_unavailable:${id}`);
    if (id === "gpt" && model.supportsVision !== true && model.capabilities?.vision !== true) throw new Error("required_gpt_vision_unavailable");
  }
}

export function upgradeModelPolicy(repository: V3StateRepository, encryptionKey: string, options: { retryAfterRollback?: boolean } = {}): { applied: boolean; groupCount: number } {
  return repository.runAtomically(() => {
    repository.requireCutover();
    const state = repository.getMeta(marker);
    if (state && !(state === "restored" && options.retryAfterRollback === true)) return { applied: false, groupCount: repository.getGroups().groups.length };
    checkModelPolicyUpgrade(repository);
    const settings = repository.getSystemSettings()!;
    const groups = repository.getGroups();
    const ciphertext = new StateCipher(encryptionKey).encrypt(backupKey, JSON.stringify({ settings, groups }));
    repository.saveDocument(backupType, backupKey, { ciphertext });
    repository.saveSystemSettings({ ...settings,
      selectedModelIds: { ...settings.selectedModelIds, reply: "sol" },
      replyRouting: { ...defaultReplyRouting(), fallbackModelIds: ["gpt", "ds"] },
      commands: settings.commands.map(command => command.id === "image_generation" ? { ...command, permission: "member" } : command.id === "model" ? { ...command, permission: "super_admin" } : command),
      updatedAt: new Date().toISOString(),
    });
    for (const group of groups.groups) repository.saveGroup({ ...group, replyModelSource: "global" });
    repository.setMeta(marker, "complete");
    return { applied: true, groupCount: groups.groups.length };
  });
}

export function rollbackModelPolicy(repository: V3StateRepository, encryptionKey: string): { restored: boolean } {
  return repository.runAtomically(() => {
    repository.requireCutover();
    if (repository.getMeta(marker) === "restored") return { restored: false };
    const backup = repository.getDocument<{ ciphertext?: string }>(backupType, backupKey, {});
    if (!backup.ciphertext) throw new Error("model_policy_backup_missing");
    const snapshot = JSON.parse(new StateCipher(encryptionKey).decrypt(backupKey, backup.ciphertext)) as { settings: SystemSettings; groups: GroupsConfigFile };
    repository.saveSystemSettings(snapshot.settings);
    for (const group of snapshot.groups.groups) {
      const current = repository.getGroup(group.groupId);
      if (current) repository.saveGroup({ ...current, replyModelMode: group.replyModelMode, replyModelSource: group.replyModelSource });
    }
    repository.setMeta(marker, "restored");
    return { restored: true };
  });
}
