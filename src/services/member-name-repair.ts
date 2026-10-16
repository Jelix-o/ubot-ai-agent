import { StateCipher, V3StateRepository } from "./v3-state-repository.js";

const groupId = "1044162764";
const userId = "2458031445";
const expectedNames = ["外包仔", "外包仙人"];
const backupKey = "v3.0.46-member-names";

/** A single, checked repair. Never normalize names belonging to other people. */
export function repairMemberName(repository: V3StateRepository, encryptionKey: string, apply = false) {
  return repository.runAtomically(() => {
    repository.requireCutover();
    const group = repository.getGroup(groupId);
    const matches = group?.manualIdentities?.filter(identity => identity.userIds.includes(userId)) ?? [];
    const identity = matches[0];
    if (matches.length !== 1 || !identity || identity.userIds.length !== 1 || JSON.stringify(identity.names) !== JSON.stringify(expectedNames)) {
      return { applied: false, reason: "record_changed_or_missing", groupId, userId };
    }
    if (repository.getDocument<{ ciphertext?: string }>("release-policy-backup", backupKey, {}).ciphertext) {
      return { applied: false, reason: "backup_already_exists", groupId, userId };
    }
    if (!apply) return { applied: false, reason: "ready", groupId, userId };
    const ciphertext = new StateCipher(encryptionKey).encrypt(backupKey, JSON.stringify({ groupId, identity }));
    repository.saveDocument("release-policy-backup", backupKey, { ciphertext });
    repository.saveGroup({ ...group!, manualIdentities: group!.manualIdentities!.map(item => item === identity ? { ...item, names: ["外包仙人"] } : item) });
    return { applied: true, reason: "repaired", groupId, userId };
  });
}
