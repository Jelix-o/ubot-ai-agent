export interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export type MemoryType = "member_profile" | "group_fact";
export type CandidateStatus = "pending" | "approved" | "rejected";
export type ScheduleDateRule = "all" | "workday" | "holiday" | "custom";

export interface GroupConfig {
  groupId: string;
  groupName?: string;
  enabled?: boolean;
  currentSkillId: string;
  replyModelMode?: string;
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
  voiceReplyEnabled?: boolean;
  memoryDisabledUserIds?: string[];
}

export interface SubjectLabel {
  label: string;
  kind?: string;
}

export interface Candidate {
  id: string;
  groupId: string;
  type: MemoryType;
  subjectUserId?: string;
  subjectLabel?: SubjectLabel;
  title: string;
  content: string;
  confidence: number;
  source: string;
  status: CandidateStatus;
  createdAt: string;
  updatedAt: string;
  evidence?: EvidencePreview | EvidenceFull;
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
  pendingCandidateCount: number;
  memoryDisabled?: boolean;
}

export interface MemberProfileSummary {
  groupId: string;
  userId: string;
  type: "overall" | "yesterday";
  subjectLabel?: SubjectLabel;
  summary: string;
  generatedAt?: string;
  memoryCount?: number;
  sourceMemoryCount?: number;
  cached?: boolean;
  record?: ProfileRecord;
}

export interface HealthStatus {
  ok: boolean;
  detail: string;
  model?: string;
  baseUrl?: string;
  checkedAt?: string;
  latencyMs?: number;
  cached?: boolean;
}

export interface ModelHealthStatus extends HealthStatus {
  id: string;
  purpose: SystemModelPurpose;
  name: string;
  shortName: string;
  selected: boolean;
}

export interface OverviewData {
  groups: GroupConfig[];
  groupId?: string;
  stats: {
    groupCount: number;
    memoryCount: number;
    pendingCandidateCount: number;
    knowledgeCount: number;
  };
  recent: {
    candidates: Candidate[];
    memories: Memory[];
    knowledge: KnowledgeEntry[];
  };
  transportHealth: HealthStatus;
  profileAiHealth: HealthStatus;
  modelStatuses?: ModelHealthStatus[];
  abnormalModelStatuses?: ModelHealthStatus[];
  modelStatusSummary?: {
    total: number;
    abnormal: number;
    checkedAt: string;
  };
}

export interface AdminSession {
  role: "super_admin" | "group_admin";
  username: string;
  userId?: string;
  allowedGroupIds: string[];
  publicBaseUrl: string;
}

export interface NotificationData {
  pendingCandidateCount: number;
  latestCandidates: Candidate[];
}

export interface CandidateStatusCounts {
  pending: number;
  approved: number;
  rejected: number;
}

export interface CandidateListResponse {
  candidates: Candidate[];
  pagination: Pagination;
  statusCounts: CandidateStatusCounts;
}

export type SystemModelPurpose = "reply" | "profile" | "memory" | "dedup" | "summary" | "knowledge" | "tts" | "custom";

export interface SystemModelConfig {
  id: string;
  name: string;
  shortName: string;
  baseUrl: string;
  model: string;
  purpose: SystemModelPurpose;
  hasApiKey: boolean;
  enabled: boolean;
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
  hasApiKey: boolean;
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
  profileSummaryMaxChars: number;
  profileShortSummaryMaxChars: number;
  dailyProfileReviewEnabled: boolean;
  dailyProfileReviewTime: string;
  memoryDedupEnabled: boolean;
  memoryDedupTime: string;
  adminSecretConfigured?: boolean;
  groupAdminSecretConfigured?: boolean;
  defaultTriggerKeywords: Array<{ keyword: string; enabled: boolean }>;
  models: SystemModelConfig[];
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
  sourceSkillLines?: string[];
  temperature: number;
  maxContextTurns: number;
  maxReplyCharsPerMessage?: number;
  maxTotalReplyChars?: number;
  maxReplyMessages?: number;
  preferredMaxReplyMessages?: number;
  ttsStyleHint?: string;
  exampleExchanges?: Array<{ user: string; assistant: string }>;
  stripAsterisks?: boolean;
  singleSentencePerMessage?: boolean;
  stripTerminalPunctuation?: boolean;
  respectLineBreaks?: boolean;
  allowBurstOnHighEmotion?: boolean;
  highEmotionKeywords?: string[];
}

export interface ProfileRecord {
  id: string;
  groupId: string;
  userId: string;
  type: "overall" | "yesterday";
  summary: string;
  shareToken?: string;
  shareUrl?: string;
  sourceMemoryCount: number;
  generatedAt: string;
  createdAt: string;
  createdBy: string;
}

export interface GlobalSearchResult {
  type: "group" | "member" | "memory" | "candidate" | "knowledge" | "profile" | "page";
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

export interface SkillOption {
  id: string;
  name: string;
}

export interface BulkApproveResult {
  approved: Array<{ candidate: Candidate; memory: Memory }>;
  alreadyApproved: Array<{ id: string; candidate: Candidate }>;
  skipped: Array<{ id: string; error: string }>;
  errors: Array<{ id: string; error: string }>;
  approvedCount: number;
  alreadyApprovedCount: number;
  skippedCount: number;
  errorCount: number;
}

export async function api<T>(url: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  if (res.status === 401) {
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
    throw new Error(message || "请求失败");
  }
  return res.json() as Promise<T>;
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

