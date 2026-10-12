/** The action was never dispatched and can safely be retried. */
export class NapCatActionNotSentError extends Error {
  constructor(message: string) { super(message); this.name = "NapCatActionNotSentError"; }
}

/** NapCat explicitly rejected the action; no platform message was created. */
export class NapCatActionRejectedError extends Error {
  constructor(message: string) { super(message); this.name = "NapCatActionRejectedError"; }
}

/** Dispatch happened, but success or failure could not be confirmed. */
export class NapCatActionOutcomeUnknownError extends Error {
  constructor(message: string) { super(message); this.name = "NapCatActionOutcomeUnknownError"; }
}

export function napCatActionFailure(action: string, response: { retcode?: number; status?: string; message?: unknown; wording?: unknown }): Error {
  const detail = [response.message, response.wording].filter(value => typeof value === "string").join(" ");
  if (["send_group_forward_msg", "delete_msg"].includes(action) && /timeout|timed[ -]?out|超时|outcome.*unknown|结果未知/iu.test(detail)) {
    return new NapCatActionOutcomeUnknownError(`NapCat reported a ${action} dispatch timeout; delivery outcome is unknown`);
  }
  return new NapCatActionRejectedError(`NapCat action failed with retcode ${response.retcode} (${response.status ?? "unknown"})`);
}
