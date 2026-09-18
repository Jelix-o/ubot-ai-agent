export interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export type MemoryType = "member_profile" | "group_fact";
export type ScheduleDateRule = "all" | "workday" | "holiday" | "custom";
export type ParticipationMode = "mentions_only" | "mentions_and_keywords" | "selected_members";

export interface GroupConfig {
  groupId: string;
  groupName?: string;
  enabled?: boolean;
  currentSkillId: string;
  replyModelMode?: string;
  participationMode?: ParticipationMode;
  allowedSkillIds: string[];
  switcherUserIds: string[];
  liveChatUserIds: string[];
  roastModeUserIds?: string[];
  manualIdentities?: Array<{ userIds: string[]; names: string[]; note?: string }>;
  liveChatDelaySeconds?: number;
  dailyReportEnabled?: boolean;
  dailyReportTime?: string;
  dailyReportDateRule?: ScheduleDateRule;
  dailyReportWeekdays?: number[];
  dailyReportTopUserCount?: number;
  holidayCountdownEnabled?: boolean;
  holidayCountdownTime?: string;
  holidayCountdownDateRule?: ScheduleDateRule;
  holidayCountdownWeekdays?: number[];
  botMuted?: boolean;
  scheduledRemindersEnabled?: boolean;
  blacklistedUserIds?: string[];
  opsAlertsEnabled?: boolean;
  triggerKeywords?: Array<{ keyword: string; enabled: boolean }>;
  memoryDisabledUserIds?: string[];
  onlineLookupEnabled?: boolean;
  visionEnabled?: boolean;
  ambientGroupContextEnabled?: boolean;
  htmlPreviewEnabled?: boolean;
}

export type HtmlPreviewStatus = "pending" | "published" | "failed" | "expired" | "deleted";

/** Metadata only. The admin API never returns generated page source. */
export interface HtmlPreviewMetadata {
  id: string;
  groupId: string;
  creatorUserId?: string;
  sourceMessageId?: string;
  title: string;
  previewUrl: string;
  status: HtmlPreviewStatus;
  createdAt: string;
  expiresAt: string;
  deletedAt?: string;
  byteSize?: number;
}

export type MemeScope = "normal_chat" | "blacklisted_at";

export interface MemeLibraryPolicy {
  enabled: boolean;
  probabilityPercent: number;
  cooldownSeconds: number;
}

export interface MemeTag {
  id: string;
  name: string;
  description: string;
  keywords: string[];
  createdAt: string;
  updatedAt: string;
}

export interface MemeAsset {
  id: string;
  name: string;
  scope: MemeScope;
  enabled: boolean;
  tags: string[];
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
  updatedAt: string;
  protected: boolean;
}

export interface MemeLibrarySnapshot {
  policy: MemeLibraryPolicy;
  tags: MemeTag[];
  assets: MemeAsset[];
}

export interface SubjectLabel {
  label: string;
  kind?: string;
}

export interface Memory {
  id: string;
  groupId: string;
  type: MemoryType;
  subjectUserId?: string;
  subjectLabel?: SubjectLabel;
  title: string;
  content: string;
  confidence: number;
  source: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  evidence?: EvidencePreview | EvidenceFull;
}

export interface EvidencePreview {
  startAt: string;
  endAt: string;
  messageCount: number;
  speakerCount: number;
  summaryPreview: string;
  hasFullEvidence: boolean;
}

export interface EvidenceFull {
  startAt: string;
  endAt: string;
  messageCount: number;
  speakers: Array<{ userId: string; userName: string }>;
  summary: string;
}

export interface KnowledgeEntry {
  id: string;
  groupId: string;
  title: string;
  question: string;
  answer: string;
  keywords: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MemberProfile {
  userId: string;
  displayName: string;
  role?: string;
  aliases: string[];
  note?: string;
  hasManualIdentity: boolean;
  memoryCount: number;
  memoryDisabled?: boolean;
}

export type MemberCacheStatus = "cached" | "refreshed" | "unloaded";

export interface MemberListResponse {
  members: MemberProfile[];
  pagination: Pagination;
  cacheStatus: MemberCacheStatus;
}

export interface HealthStatus {
  ok: boolean;
  detail: string;
  model?: string;
  baseUrl?: string;
  checkedAt?: string;
  latencyMs?: number;
  cached?: boolean;
  skipped?: boolean;
  probeType?: "chat";
  upstreamStatusCode?: number;
  failureKind?: "auth" | "rate_limit" | "unavailable" | "timeout" | "network" | "format_error" | "unknown";
}

export interface ModelHealthStatus extends HealthStatus {
  id: string;
  purpose: SystemModelPurpose;
  name: string;
  shortName: string;
  selected: boolean;
}

export interface ModelHealthHistoryEntry extends ModelHealthStatus {
  source: "manual" | "overview" | "health" | "runtime";
}

export interface OverviewData {
  groups: GroupConfig[];
  groupId?: string;
  stats: {
    groupCount: number;
    memoryCount: number;
    knowledgeCount: number;
  };
  recent: {
    memories: Memory[];
    knowledge: KnowledgeEntry[];
  };
  transportHealth: HealthStatus;
  modelStatuses?: ModelHealthStatus[];
  abnormalModelStatuses?: ModelHealthStatus[];
  modelStatusSummary?: {
    total: number;
    abnormal: number;
    checkedAt: string;
  };
}

export interface EnvironmentStatus {
  transportHealth: HealthStatus;
  node: HealthStatus;
  memory: HealthStatus;
}

export interface ServerStatus {
  hostname: string;
  platform: string;
  uptimeSeconds: number;
  loadAverage: number[];
  cpuCount: number;
  totalMemory: number;
  freeMemory: number;
  usedMemory: number;
  process: {
    pid: number;
    uptimeSeconds: number;
    nodeVersion: string;
    rss: number;
    heapUsed: number;
    heapTotal: number;
  };
  checkedAt: string;
}

export interface SystemHealthData {
  transportHealth: HealthStatus;
  modelStatuses: ModelHealthStatus[];
  abnormalModelStatuses: ModelHealthStatus[];
  modelStatusSummary: {
    total: number;
    abnormal: number;
    checkedAt: string;
  };
  environmentStatus?: EnvironmentStatus;
  serverStatus?: ServerStatus;
  uptimeSeconds: number;
  nodeVersion: string;
  pid: number;
  memory: { rss: number; heapUsed: number };
}

export interface AdminSession {
  role: "super_admin" | "group_admin";
  username: string;
  userId?: string;
  allowedGroupIds: string[];
  csrfToken: string;
  publicBaseUrl: string;
}

export interface AdminAccount {
  id: string;
  username: string;
  role: "super_admin" | "group_admin";
  groupIds: string[];
  qqUserId?: string;
  disabledAt?: string;
  createdAt: string;
  lastLoginAt?: string;
}

export interface AdminInvite {
  id: string;
  role: "super_admin" | "group_admin";
  groupIds: string[];
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
  usedAt?: string;
}

export interface AdminAuthAuditEntry {
  id: number;
  accountId?: string;
  action: string;
  targetAccountId?: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

export type SystemModelPurpose = "reply" | "summary" | "knowledge" | "custom";
export type ReasoningEffort = "high" | "xhigh";

export interface SystemModelConfig {
  id: string;
  name: string;
  shortName: string;
  baseUrl: string;
  model: string;
  purpose: SystemModelPurpose;
  hasApiKey: boolean;
  enabled: boolean;
  apiProtocol?: "openai" | "anthropic";
  supportsVision?: boolean;
  reasoningEffort?: ReasoningEffort;
  maxCompletionTokens?: number;
  requestTimeoutMs?: number;
  createdAt: string;
  updatedAt: string;
  apiKey?: string;
}

export interface ModelOption {
  id: string;
  label: string;
  name?: string;
  shortName?: string;
  purpose: SystemModelPurpose;
  enabled: boolean;
  hasApiKey?: boolean;
  baseUrl?: string;
  model?: string;
}

export interface SystemCommandConfig {
  id: string;
  title: string;
  primary: string;
  aliases: string[];
  permission: "member" | "group_admin" | "super_admin";
  enabled: boolean;
  help: string;
  updatedAt: string;
}

export interface SystemSettings {
  onlineLookupEnabled: boolean;
  tokenCostControl: {
    dailyReportAiQuipEnabled: boolean;
    chatSummaryAiEnabled: boolean;
    scheduledReminderAiRewriteEnabled: boolean;
    modelHealthAutoProbeEnabled: boolean;
  };
  defaultTriggerKeywords: Array<{ keyword: string; enabled: boolean }>;
  models: SystemModelConfig[];
  removedDefaultModelIds?: string[];
  selectedModelIds: Partial<Record<SystemModelPurpose, string>>;
  commands: SystemCommandConfig[];
  updatedAt: string;
}

export interface SkillDefinition {
  id: string;
  name: string;
  systemPrompt: string;
  styleRules: string[];
  knowledge: string[];
  temperature: number;
  maxContextTurns: number;
  maxReplyCharsPerMessage?: number;
  maxTotalReplyChars?: number;
  maxReplyMessages?: number;
  preferredMaxReplyMessages?: number;
  exampleExchanges?: Array<{ user: string; assistant: string }>;
  stripAsterisks?: boolean;
  singleSentencePerMessage?: boolean;
  stripTerminalPunctuation?: boolean;
  respectLineBreaks?: boolean;
  allowBurstOnHighEmotion?: boolean;
  highEmotionKeywords?: string[];
}

export type AdminTaskType =
  | "memory-dedup"
  | "model-check"
  | "bulk-review";
export type AdminTaskStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface AdminTaskRecord {
  id: string;
  type: AdminTaskType;
  status: AdminTaskStatus;
  title: string;
  groupId?: string;
  subjectUserId?: string;
  operatorUserId: string;
  progress: number;
  detail?: string;
  error?: string;
  result?: unknown;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
}

export interface AdminOperationLogEntry {
  timestamp: string;
  groupId: string;
  operatorUserId: string;
  action: string;
  target?: string;
  detail?: string;
}

export interface SchedulePreviewDay {
  date: string;
  items: Array<{
    type: "daily_report" | "holiday_countdown" | "scheduled_reminder";
    title: string;
    time: string;
    enabled: boolean;
    taskId?: string;
  }>;
}

export interface GlobalSearchResult {
  type: "group" | "member" | "memory" | "knowledge" | "page";
  title: string;
  subtitle: string;
  path: string;
  groupId?: string;
}

export interface ScheduledReminderTask {
  id: string;
  groupId: string;
  creatorUserId: string;
  intervalMinutes: number;
  topic: string;
  executionStartTime?: string;
  executionEndTime?: string;
  executionIntervalMinutes?: number;
  scheduledTime?: string;
  advanceMinutes?: number;
  dateRule?: ScheduleDateRule;
  weekdays?: number[];
  createdAt: string;
  nextRunAt: string;
  enabled: boolean;
  recentMessages?: string[];
}

let csrfToken = "";

export function setCsrfToken(token: string | undefined): void {
  csrfToken = token || "";
}

function setReadonlySession(_session: AdminSession | undefined): void {
  // Sessions are always full-authorized in the current auth model.
}

export function friendlyApiError(code: string): string {
  return ({
    recent_reauth_required: "此操作需要近期密码复验，请先到「账号与安全」完成验证。",
    invalid_password: "密码至少 12 位，请更换后重试。",
    invalid_credentials: "账号或密码错误。",
    invalid_current_password: "当前密码不正确。",
    too_many_login_attempts: "尝试次数过多，请稍后再试。",
    csrf_required: "登录状态已失效，请重新登录。",
    forbidden: "当前账号无权执行该操作。",
    voice_feature_retired: "语音功能已下线，该配置不再可用。",
    legacy_qq_admin_retired: "群内 #管理员 管理已下线，请在后台账号中维护权限。",
  } as Record<string, string>)[code] || code;
}

function shouldSendCsrf(method: string | undefined): boolean {
  const normalized = (method || "GET").toUpperCase();
  return normalized !== "GET" && normalized !== "HEAD" && normalized !== "OPTIONS";
}

export async function api<T>(url: string, options: RequestInit = {}): Promise<T> {
  if (url !== "/api/logout" && shouldSendCsrf(options.method) && !csrfToken && url.startsWith("/api/")) {
    // CSRF token is issued after login; requests without it fail server-side with a clear code.
  }
  const headers = new Headers(options.headers);
  const isFormData = typeof FormData !== "undefined" && options.body instanceof FormData;
  if (!headers.has("Content-Type") && !isFormData) {
    headers.set("Content-Type", "application/json");
  }
  if (csrfToken && shouldSendCsrf(options.method)) {
    headers.set("X-CSRF-Token", csrfToken);
  }
  let res: Response;
  try {
    res = await fetch(url, {
      ...options,
      headers,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(detail === "Failed to fetch"
      ? "网络连接失败或服务器暂时无响应，请稍后重试。"
      : `网络连接失败或服务器暂时无响应：${detail}`);
  }
  if (res.status === 401) {
    const contentType401 = res.headers.get("content-type") || "";
    let code401 = "unauthorized";
    if (contentType401.includes("application/json")) {
      const data401 = await res.json().catch(() => ({})) as { error?: string };
      code401 = typeof data401.error === "string" && data401.error ? data401.error : "unauthorized";
    }
    // Business auth failures (wrong current password) are not session expiry.
    if (code401 === "invalid_current_password" || code401 === "invalid_credentials") {
      throw new Error(friendlyApiError(code401));
    }
    if (window.location.pathname !== "/login") {
      window.location.href = "/login";
    }
    throw new Error("unauthorized");
  }
  if (!res.ok) {
    const contentType = res.headers.get("content-type") || "";
    let message = await res.text();
    try {
      const data = JSON.parse(message) as { error?: string };
      message = data.error || message;
    } catch {
      if (contentType.includes("text/html") || /Cloudflare|gateway time-out|<html/i.test(message)) {
        message = res.status === 504
          ? "请求超时：服务器处理时间过长，请稍后刷新重试。"
          : `请求失败：HTTP ${res.status}`;
      } else {
        message = message.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 180);
      }
    }
    const known = friendlyApiError(message);
    throw new Error(known !== message ? known : (message || "请求失败"));
  }
  const data = await res.json() as T;
  if (url === "/api/session" || url.startsWith("/api/auth/")) {
    const authResponse = data as { session?: AdminSession; csrfToken?: string };
    const nextCsrfToken = authResponse.session?.csrfToken ?? authResponse.csrfToken;
    // Security actions such as recovery-code rotation return `{ ok: true }`.
    // They must retain the opaque session's existing CSRF token instead of
    // accidentally clearing it for every following management request.
    if (typeof nextCsrfToken === "string") {
      setCsrfToken(nextCsrfToken);
    }
    if (authResponse.session) {
      setReadonlySession(authResponse.session);
    }
  }
  return data;
}
export function queryString(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      search.set(key, String(value));
    }
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}
