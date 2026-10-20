import { createHash } from "node:crypto";
import { StateCipher, V3StateRepository } from "./v3-state-repository.js";

export interface MemberAliasMaintenanceInput {
  groupId: string;
  userId: string;
  expectedPrimaryName: string;
  alias: string;
}

const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/\s+/gu, "");
export const MEMBER_ALIAS_BACKUP_TYPE = "member-alias-backup";

/** Explicit operator input only; never infer or bulk-normalize member names. */
export function maintainMemberAlias(repository: V3StateRepository, encryptionKey: string, input: MemberAliasMaintenanceInput, apply = false) {
  if (!input || !/^\d+$/u.test(input.groupId) || !/^\d+$/u.test(input.userId) ||
    typeof input.expectedPrimaryName !== "string" || !input.expectedPrimaryName.trim() ||
    typeof input.alias !== "string" || !input.alias.trim() || input.alias.length > 64 ||
    /[\p{Cc}\p{Cf}]|\[CQ:/u.test(input.alias) || /^\d+$/u.test(normalize(input.alias))) throw new Error("invalid_member_alias_input");
  const alias = input.alias.trim();
  const backupKey = createHash("sha256").update(JSON.stringify([input.groupId, input.userId, normalize(alias)])).digest("hex");
  return repository.runAtomically(() => {
    repository.requireCutover();
    const group = repository.getGroup(input.groupId);
    const matches = group?.manualIdentities?.filter(identity => identity.userIds.includes(input.userId)) ?? [];
    const identity = matches[0];
    if (!group || matches.length !== 1 || !identity || identity.userIds.length !== 1 ||
      normalize(identity.names[0] ?? "") !== normalize(input.expectedPrimaryName)) {
      throw new Error("member_alias_target_changed_or_not_unique");
    }
    if (group.manualIdentities!.some(other => other !== identity && other.names.some(name => normalize(name) === normalize(alias)))) {
      throw new Error("member_alias_already_owned_by_another_identity");
    }
    if (identity.names.some(name => normalize(name) === normalize(alias))) return { applied: false, reason: "already_present", backupKey };
    if (repository.getDocument<{ ciphertext?: string }>(MEMBER_ALIAS_BACKUP_TYPE, backupKey, {}).ciphertext) {
      throw new Error("member_alias_previously_applied_then_changed");
    }
    if (!apply) return { applied: false, reason: "ready", backupKey };
    // The complete group config is recoverable, including administrator fields.
    const ciphertext = new StateCipher(encryptionKey).encrypt(backupKey, JSON.stringify(group));
    repository.saveDocument(MEMBER_ALIAS_BACKUP_TYPE, backupKey, { ciphertext });
    repository.saveGroup({ ...group, manualIdentities: group.manualIdentities!.map(other =>
      other === identity ? { ...other, names: [...other.names, alias] } : other) });
    return { applied: true, reason: "alias_added", backupKey };
  });
}
