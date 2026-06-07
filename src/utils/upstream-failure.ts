export type UpstreamFailureKind =
  | "auth"
  | "rate_limit"
  | "unavailable"
  | "timeout"
  | "network"
  | "format_error"
  | "unknown";

export function classifyUpstreamFailure(input: {
  statusCode?: number;
  message?: string;
  error?: unknown;
}): UpstreamFailureKind {
  const statusCode = input.statusCode;
  if (statusCode === 401 || statusCode === 403) {
    return "auth";
  }
  if (statusCode === 429) {
    return "rate_limit";
  }
  if (statusCode === 408 || statusCode === 504) {
    return "timeout";
  }
  if (statusCode && statusCode >= 500) {
    return "unavailable";
  }

  const message = [
    input.message,
    input.error instanceof Error ? input.error.message : undefined,
    typeof input.error === "string" ? input.error : undefined,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (!message) {
    return "unknown";
  }
  if (/unauthori[sz]ed|forbidden|invalid api[-_ ]?key|api key|permission denied/.test(message)) {
    return "auth";
  }
  if (/rate limit|too many requests|quota|429/.test(message)) {
    return "rate_limit";
  }
  if (/timeout|timed out|abort|etimedout|504/.test(message)) {
    return "timeout";
  }
  if (/fetch failed|network|econnreset|econnrefused|enotfound|eai_again|socket|dns/.test(message)) {
    return "network";
  }
  if (/invalid json|unexpected token|parse|did not contain|empty audio|no audio/.test(message)) {
    return "format_error";
  }
  if (/bad gateway|service unavailable|gateway|upstream|502|503|500/.test(message)) {
    return "unavailable";
  }
  return "unknown";
}
