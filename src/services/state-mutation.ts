import { createHash } from "node:crypto";

export function revision(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(sortValue(value))).digest("hex");
}
function sortValue(value: any): any {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortValue(value[key])]));
  return value;
}
/** The callback is synchronous and shares the authoritative SQLite transaction. */
export interface MutationGuard { expectedRevision: string; committed?: () => void }
export class StateConflictError extends Error {
  constructor() { super("target_changed"); this.name = "StateConflictError"; }
}
export function assertRevision(value: unknown, guard?: MutationGuard): void {
  if (guard && (!value || revision(value) !== guard.expectedRevision)) throw new StateConflictError();
}
