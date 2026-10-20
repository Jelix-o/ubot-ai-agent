/** Shared by model settings, runtime requests and the admin editor. */
export const DEFAULT_REPLY_MAX_TOKENS = 32_768;
export const MIN_REPLY_MAX_TOKENS = 64;
export const MAX_REPLY_MAX_TOKENS = 65_536;

export function normalizeReplyMaxTokens(value: number | undefined): number {
  if (!Number.isFinite(value) || !value) return DEFAULT_REPLY_MAX_TOKENS;
  return Math.max(MIN_REPLY_MAX_TOKENS, Math.min(MAX_REPLY_MAX_TOKENS, Math.floor(value!)));
}
