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
  revision?: string;
  groupId: string;
  groupName?: string;
  enabled?: boolean;
  currentSkillId: string;
  replyModelMode?: string;
  replyModelSource?: "global" | "override";
  participationMode?: ParticipationMode;
  allowedSkillIds: string[];
  switcherUserIds: string[];
  liveChatUserIds: string[];
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
  naturalImageRequestsEnabled?: boolean;
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

export type ImagePreviewStatus = "available" | "expired" | "deleted";
export type ImageRequestKind = "generation" | "edit" | "avatar_edit";
export type ImageRequestTriggerSource = "command" | "natural";
export type ImageRequestStatus = "accepted" | "submitting" | "generated" | "queued" | "delivered" | "failed" | "outcome_unknown" | "delivery_unknown";

/** List responses intentionally omit the full prompt. */
export interface ImagePreviewListItem {
  id: string;
  operation?: "generation" | "edit";
  referenceCount?: number;
  parentIds?: string[];
  outputSize?: string;
  outputMessageId?: string;
  requestKind?: ImageRequestKind;
  triggerSource?: ImageRequestTriggerSource;
  requestStatus?: ImageRequestStatus;
  /** Safe, code-like diagnostic only. It never contains a provider message. */
  failureReason?: string;

  groupId: string;
  creatorUserId?: string;
  promptSummary: string;
  modelId?: string;
  model?: string;
  fallbackUsed?: boolean;
  mimeType: string;
  byteSize: number;
  status: ImagePreviewStatus;
  createdAt: string;
  expiresAt: string;
  deletedAt?: string;
}

export interface ImagePreviewDetail extends ImagePreviewListItem {
  prompt: string;
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
  probeType?: "chat" | "image" | "image_intent";
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

export type SystemModelPurpose = "reply" | "summary" | "knowledge" | "image" | "image_intent" | "custom";
export type ReasoningEffort = "high" | "xhigh";

export interface SystemModelConfig {
  id: string;
  capabilities?: { imageEditing?: boolean; toolCalling?: boolean; [key: string]: unknown };
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
  minimumPermission?: "member" | "group_admin" | "super_admin";
  enabled: boolean;
  help: string;
  updatedAt: string;
}

export interface ReplyRoutingSettings {
  fallbackEnabled: boolean; fallbackModelIds: string[];
  chatAttemptTimeoutMs: number; chatTotalTimeoutMs: number;
  htmlAttemptTimeoutMs: number; htmlTotalTimeoutMs: number;
}

export interface SystemSettings {
  replyRouting?: ReplyRoutingSettings;
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
  | "bulk-review"
  | "bulk-operation";
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
let recoveryScope = new AbortController();
let sessionRefresh: Promise<unknown> | undefined;
let reauthPromise: Promise<void> | undefined;
let reauthGeneration = 0;
let reauthHandler: ((signal: AbortSignal) => Promise<void>) | undefined;

export class ApiError extends Error {
  constructor(public readonly code: string, public readonly status: number) {
    super(friendlyApiError(code));
    this.name = "ApiError";
  }
}

export function registerReauthHandler(handler: (signal: AbortSignal) => Promise<void>): () => void {
  reauthHandler = handler;
  return () => {
    if (reauthHandler !== handler) return;
    cancelAuthRecovery();
    reauthHandler = undefined;
  };
}

export function cancelAuthRecovery(): void {
  recoveryScope.abort();
  recoveryScope = new AbortController();
  sessionRefresh = undefined;
  reauthPromise = undefined;
}

function recoveryCancelled(): ApiError { return new ApiError("operation_cancelled", 0); }

async function waitForRecovery<T>(promise: Promise<T>, signals: Array<AbortSignal | null | undefined>): Promise<T> {
  if (signals.some(signal => signal?.aborted)) throw recoveryCancelled();
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  let cancel: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => { cancel = () => reject(recoveryCancelled()); });
  for (const signal of active) signal.addEventListener("abort", cancel, { once: true });
  try { return await Promise.race([promise, cancelled]); }
  finally { for (const signal of active) signal.removeEventListener("abort", cancel); }
}

export function setCsrfToken(token: string | undefined): void {
  csrfToken = token || "";
}

function setReadonlySession(_session: AdminSession | undefined): void {
  // Sessions are always full-authorized in the current auth model.
}

export function friendlyApiError(code: string): string {
  return ({
    recent_reauth_required: "此操作需要密码复验，请验证后继续。",
    invalid_password: "密码至少 12 位，请更换后重试。",
    invalid_credentials: "账号或密码错误。",
    invalid_current_password: "当前密码不正确。",
    too_many_login_attempts: "尝试次数过多，请稍后再试。",
    csrf_required: "请求校验未通过，请重试当前操作。",
    invalid_origin: "请求来源校验失败，请通过正常的后台地址访问。",
    operation_cancelled: "操作已取消。",
    model_retired: "Gemini 已下线，请选择其他模型。",
    forbidden: "当前账号无权执行该操作。",
    version_conflict: "配置已被其他操作修改，请刷新后重新编辑。",
    target_changed: "目标已发生变化，请重新预览。",
    preview_expired: "预览已过期，请重新预览。",
    protected_asset: "受保护素材不可执行此操作。",
    invalid_knowledge_source_command: "命令须以半角 # 开头，后接 1 至 31 个文字、数字、下划线或连字符，不可含空格。",
    knowledge_command_conflict: "该命令与知识源或系统命令重叠，请更换一个独立的命令。",
    knowledge_source_bindings_unavailable: "当前运行版本暂不支持编辑知识源命令。",
    voice_feature_retired: "语音功能已下线，该配置不再可用。",
    legacy_qq_admin_retired: "群内 #管理员 管理已下线，请在后台账号中维护权限。",
  } as Record<string, string>)[code] || code;
}

function shouldSendCsrf(method: string | undefined): boolean {
  const normalized = (method || "GET").toUpperCase();
  return normalized !== "GET" && normalized !== "HEAD" && normalized !== "OPTIONS";
}

export async function api<T>(url: string, options: RequestInit = {}): Promise<T> {
  const scope = recoveryScope.signal;
  let refreshed = false;
  let reauthenticated = false;
  const replayable = !(typeof ReadableStream !== "undefined" && options.body instanceof ReadableStream);
  for (;;) {
  const sentReauthGeneration = reauthGeneration;
  const sentCsrfToken = csrfToken;
  const headers = new Headers(options.headers);
  const isFormData = typeof FormData !== "undefined" && options.body instanceof FormData;
  if (!headers.has("Content-Type") && !isFormData) {
    headers.set("Content-Type", "application/json");
  }
  if (csrfToken && shouldSendCsrf(options.method) && url.startsWith("/api/")) {
    headers.set("X-CSRF-Token", csrfToken);
  }
  let res: Response;
  try {
    res = await fetch(url, {
      ...options,
      headers,
    });
  } catch (error) {
    if (options.signal?.aborted) throw recoveryCancelled();
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(detail === "Failed to fetch"
      ? "网络连接失败或服务器暂时无响应，请稍后重试。"
      : `网络连接失败或服务器暂时无响应：${detail}`);
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
    if (res.status === 401 && message === "unauthorized") {
      cancelAuthRecovery();
      setCsrfToken(undefined);
      if (window.location.pathname !== "/login") window.location.href = "/login";
    }
    const canRecover = replayable && url.startsWith("/api/") && shouldSendCsrf(options.method);
    if (canRecover && res.status === 403 && message === "csrf_required" && !refreshed) {
      refreshed = true;
      if (scope.aborted || options.signal?.aborted) throw recoveryCancelled();
      if (sentCsrfToken === csrfToken) {
        if (!sessionRefresh) {
          const pending = api("/api/session");
          sessionRefresh = pending;
          void pending.finally(() => { if (sessionRefresh === pending) sessionRefresh = undefined; }).catch(() => {});
        }
        await waitForRecovery(sessionRefresh, [scope, options.signal]);
      }
      if (scope.aborted || options.signal?.aborted) throw recoveryCancelled();
      continue;
    }
    if (canRecover && res.status === 403 && message === "recent_reauth_required" && !reauthenticated &&
        url !== "/api/auth/reauth" && url !== "/api/auth/logout") {
      reauthenticated = true;
      if (scope.aborted || options.signal?.aborted) throw recoveryCancelled();
      if (sentReauthGeneration === reauthGeneration) {
        if (!reauthPromise) {
          if (!reauthHandler) throw new ApiError(message, res.status);
          const pending = waitForRecovery(reauthHandler(scope), [scope]).then(() => { reauthGeneration += 1; });
          reauthPromise = pending;
          void pending.finally(() => { if (reauthPromise === pending) reauthPromise = undefined; }).catch(() => {});
        }
        await waitForRecovery(reauthPromise, [scope, options.signal]);
      }
      if (scope.aborted || options.signal?.aborted) throw recoveryCancelled();
      continue;
    }
    throw new ApiError(message || "请求失败", res.status);
  }
  const data = await res.json() as T;
  if (url === "/api/session" || url.startsWith("/api/auth/")) {
    const authResponse = data as { session?: AdminSession; csrfToken?: string };
    const nextCsrfToken = authResponse.session?.csrfToken ?? authResponse.csrfToken;
    // Security actions such as recovery-code rotation return `{ ok: true }`.
    // They must retain the opaque session's existing CSRF token instead of
    // accidentally clearing it for every following management request.
    if (typeof nextCsrfToken === "string" && !scope.aborted) {
      setCsrfToken(nextCsrfToken);
    }
    if (authResponse.session) {
      setReadonlySession(authResponse.session);
    }
  }
  return data;
  }
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
