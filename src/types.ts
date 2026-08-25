export type MessageSegment =
  | {
      type: string;
      data?: Record<string, string>;
    }
  | string;

export interface NapcatSender {
  user_id?: number;
  nickname?: string;
  card?: string;
  role?: string;
}

export interface NapcatGroupMember {
  user_id: number;
  nickname?: string;
  card?: string;
  role?: string;
}

export interface NapcatGroupInfo {
  group_id: number;
  group_name?: string;
  member_count?: number;
  max_member_count?: number;
}

export interface NapcatGroupMessageEvent {
  post_type: "message";
  message_type: "group";
  sub_type?: string;
  self_id: number;
  group_id: number;
  user_id: number;
  message_id: number;
  /** OneBot 规范所有事件都带 Unix 秒时间戳；NapCat 在消息事件上提供。 */
  time?: number;
  raw_message: string;
  message: MessageSegment[] | string;
  sender?: NapcatSender;
}

export interface AiHealthStatus {
  ok: boolean;
  detail: string;
  model: string;
  baseUrl: string;
  checkedAt: string;
  latencyMs: number;
  cached: boolean;
  skipped?: boolean;
  probeType?: "chat" | "tts";
  upstreamStatusCode?: number;
  failureKind?: "auth" | "rate_limit" | "unavailable" | "timeout" | "network" | "format_error" | "unknown";
}

export type AdminTaskType =
  | "memory-dedup"
  | "profile-generate"
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

export interface AdminTasksFile {
  tasks: AdminTaskRecord[];
}

export interface SkillDefinition {
  id: string;
  name: string;
  systemPrompt: string;
  styleRules: string[];
  knowledge: string[];
  /** @deprecated Read only for old skill JSON imports. New saves migrate it to ttsConfig.stylePrompt. */
  ttsStyleHint?: string;
  ttsConfig?: SkillTtsConfig;
  exampleExchanges?: Array<{
    user: string;
    assistant: string;
  }>;
  temperature: number;
  maxContextTurns: number;
  maxReplyCharsPerMessage?: number;
  maxTotalReplyChars?: number;
  maxReplyMessages?: number;
  preferredMaxReplyMessages?: number;
  stripAsterisks?: boolean;
  singleSentencePerMessage?: boolean;
  stripTerminalPunctuation?: boolean;
  respectLineBreaks?: boolean;
  allowBurstOnHighEmotion?: boolean;
  highEmotionKeywords?: string[];
}

export interface SkillTtsConfig {
  stylePrompt?: string;
  voice?: string;
  dialect?: string;
  personaTone?: string;
}

export interface MessageImageInput {
  url?: string;
  file?: string;
  summary?: string;
}

export interface ReferencedMessage {
  messageId: string;
  userId?: string;
  userName?: string;
  text: string;
  images: MessageImageInput[];
}

export interface GroupManualIdentity {
  userIds: string[];
  names: string[];
  note?: string;
}

export type GroupMemoryType = "member_profile" | "group_fact";

export interface GroupMemoryEvidence {
  startAt: string;
  endAt: string;
  messageCount: number;
  speakers: Array<{
    userId: string;
    userName: string;
  }>;
  summary: string;
}

export interface GroupMemoryEvidencePreview {
  startAt: string;
  endAt: string;
  messageCount: number;
  speakerCount: number;
  summaryPreview: string;
  hasFullEvidence: boolean;
}

export interface GroupMemory {
  id: string;
  groupId: string;
  type: GroupMemoryType;
  subjectUserId?: string;
  title: string;
  content: string;
  confidence: number;
  source: string;
  createdAt: string;
  updatedAt: string;
  enabled: boolean;
  evidence?: GroupMemoryEvidence;
  /** 覆盖链：新事实到达时不删旧事实，打上 superseded_by 标记（计划 §3 L1）。 */
  supersededBy?: string;
}

export type GroupMemoryCandidateStatus = "pending" | "approved" | "rejected";

export interface GroupMemoryCandidate {
  id: string;
  groupId: string;
  type: GroupMemoryType;
  subjectUserId?: string;
  title: string;
  content: string;
  confidence: number;
  source: string;
  status: GroupMemoryCandidateStatus;
  createdAt: string;
  updatedAt: string;
  evidence?: GroupMemoryEvidence;
}

export interface KnowledgeBaseEntry {
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

export interface GroupMemberIdentity {
  userId: string;
  names: string[];
}

export interface GroupMemberProfile {
  userId: string;
  displayName: string;
  card?: string;
  nickname?: string;
  role?: string;
  aliases: string[];
  note?: string;
  hasManualIdentity: boolean;
  memoryCount: number;
  pendingCandidateCount: number;
  memoryDisabled?: boolean;
}

export interface AiInteractionTarget {
  userId?: string;
  names: string[];
  source: "mention" | "reply";
}

export interface AiReplyContext {
  messageId: string;
  userId?: string;
  userName?: string;
  text: string;
  images?: MessageImageInput[];
}

export type RealtimeLookupKind = "weather" | "stock" | "web";
export type RealtimeLookupStatus = "ok" | "needs_location" | "unavailable";

export interface RealtimeLookupSource {
  name: string;
  url: string;
}

export interface RealtimeLookupResult {
  kind: RealtimeLookupKind;
  status: RealtimeLookupStatus;
  queriedAt: string;
  dataAt?: string;
  sources: RealtimeLookupSource[];
  failureReason?: string;
  promptContext: string;
}

export interface RecentGroupMessage {
  messageId: string;
  userId: string;
  text: string;
  timestamp: string;
  senderCard?: string;
  senderNickname?: string;
}

export interface AiIdentityContext {
  groupId: string;
  currentUserId: string;
  currentSpeaker?: {
    manualName?: string;
    senderCard?: string;
    senderNickname?: string;
  };
  botUserId?: string;
  manualIdentities?: GroupManualIdentity[];
  memberProfiles?: GroupMemberProfile[];
  groupMemories?: GroupMemory[];
  knowledgeHits?: KnowledgeBaseEntry[];
  interactionTargets?: AiInteractionTarget[];
  replyContext?: AiReplyContext;
  realtimeLookup?: RealtimeLookupResult;
  /** 脱敏后的群氛围摘要；不得包含聊天原文或成员身份。 */
  atmosphereSummary?: string;
}

export type ReplyModelMode = string;
export type ParticipationMode = "mentions_only" | "mentions_and_keywords" | "selected_members";
export type ScheduleDateRule = "all" | "workday" | "holiday" | "custom";

export interface GroupBotConfig {
  groupId: string;
  groupName?: string;
  enabled?: boolean;
  currentSkillId: string;
  replyModelMode?: ReplyModelMode;
  participationMode?: ParticipationMode;
  allowedSkillIds: string[];
  switcherUserIds: string[];
  liveChatUserIds: string[];
  roastModeUserIds?: string[];
  manualIdentities?: GroupManualIdentity[];
  liveChatDelaySeconds?: number;
  liveChatDelayMinutes?: number;
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
  triggerKeywords?: Array<{
    keyword: string;
    enabled: boolean;
  }>;
  voiceReplyEnabled?: boolean;
  defaultVoiceReplyEnabled?: boolean;
  memoryDisabledUserIds?: string[];
  onlineLookupEnabled?: boolean;
  visionEnabled?: boolean;
}

export interface GroupsConfigFile {
  superAdminUserIds?: string[];
  groups: GroupBotConfig[];
}

export interface ConversationTurn {
  groupId: string;
  role: "user" | "assistant";
  content: string;
  userId?: string;
  timestamp: string;
}

export interface SharedConversationTurn {
  role: "user" | "assistant";
  content: string;
  userId?: string;
  senderCard?: string;
  senderNickname?: string;
  timestamp: string;
}

export interface SharedConversationTopic {
  id: string;
  groupId: string;
  createdAt: string;
  updatedAt: string;
  turns: SharedConversationTurn[];
}

export interface ConversationsFile {
  conversations: Record<string, ConversationTurn[]>;
  sharedTopics?: Record<string, SharedConversationTopic>;
  sharedTopicMessageIndex?: Record<string, string>;
}

export interface AiReply {
  text: string;
  model: string;
  skillId: string;
  promptChars?: number;
  reasoningEffort?: ReasoningEffort;
  imageInspectionUsed?: boolean;
}

export interface ControlledMentionDecision {
  shouldMention: boolean;
  target?: string;
  reason?: string;
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

export interface ScheduledRemindersFile {
  tasks: Record<string, ScheduledReminderTask>;
}

export type AdminRole = "super_admin" | "group_admin";

export interface AdminSession {
  role: AdminRole;
  username: string;
  userId?: string;
  allowedGroupIds: string[];
  csrfToken: string;
  expiresAt: string;
}

export type SystemModelPurpose = "reply" | "profile" | "memory" | "dedup" | "summary" | "knowledge" | "tts" | "custom";
export type ReasoningEffort = "high" | "xhigh";

export interface SystemModelConfig {
  id: string;
  name: string;
  shortName: string;
  baseUrl: string;
  model: string;
  purpose: SystemModelPurpose;
  apiKey?: string;
  hasApiKey: boolean;
  enabled: boolean;
  apiProtocol?: "openai" | "anthropic";
  supportsVision?: boolean;
  reasoningEffort?: ReasoningEffort;
  maxCompletionTokens?: number;
  requestTimeoutMs?: number;
  createdAt: string;
  updatedAt: string;
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

export interface TokenCostControlSettings {
  memoryCandidateExtractionEnabled: boolean;
  memoryCandidateNormalizationEnabled: boolean;
  memorySemanticDedupEnabled: boolean;
  dailyProfileReviewAiEnabled: boolean;
  dailyReportAiQuipEnabled: boolean;
  chatSummaryAiEnabled: boolean;
  scheduledReminderAiRewriteEnabled: boolean;
  modelHealthAutoProbeEnabled: boolean;
}

export interface SystemSettings {
  profileSummaryMaxChars: number;
  profileShortSummaryMaxChars: number;
  dailyProfileReviewEnabled: boolean;
  dailyProfileReviewTime: string;
  memoryDedupEnabled: boolean;
  memoryDedupTime: string;
  memoryDedupSemanticTimeoutMinutes: number;
  memoryCandidateConfidenceThreshold: number;
  memoryAutoApproveConfidenceThreshold: number;
  memoryUnattendedModeEnabled: boolean;
  onlineLookupEnabled: boolean;
  tokenCostControl: TokenCostControlSettings;
  adminSecretHash?: string;
  groupAdminSecretHash?: string;
  adminSecretConfigured?: boolean;
  groupAdminSecretConfigured?: boolean;
  defaultTriggerKeywords: Array<{
    keyword: string;
    enabled: boolean;
  }>;
  models: SystemModelConfig[];
  removedDefaultModelIds?: string[];
  selectedModelIds: Partial<Record<SystemModelPurpose, string>>;
  commands: SystemCommandConfig[];
  updatedAt: string;
}

export type ProfileRecordType = "overall" | "yesterday";

export interface ProfileRecord {
  id: string;
  groupId: string;
  userId: string;
  type: ProfileRecordType;
  summary: string;
  sourceMemoryCount: number;
  generatedAt: string;
  createdAt: string;
  createdBy: string;
}

export interface ProfileRecordsFile {
  records: ProfileRecord[];
}

export interface AppConfig {
  napcatMode: "forward" | "reverse";
  napcatWsUrl: string;
  napcatAccessToken?: string;
  napcatReverseWsHost: string;
  napcatReverseWsPort: number;
  napcatReverseWsPath: string;
  ingressReadApiPort: number;
  openAiBaseUrl: string;
  openAiApiKey: string;
  openAiModel: string;
  realtimeSearchUrl: string;
  profileAiBaseUrl: string;
  profileAiApiKey: string;
  profileAiModel: string;
  ttsBaseUrl: string;
  ttsApiKey: string;
  ttsModel: string;
  ttsVoice: string;
  ttsAudioFormat: "wav" | "mp3" | "pcm" | "pcm16";
  ttsStyleHint?: string;
  ttsAllowNapCatAiFallback: boolean;
  ttsCacheDir: string;
  dataDir: string;
  botQq: string;
  groupsConfigPath: string;
  skillsDir: string;
  conversationsPath: string;
  dailyReportStorePath: string;
  holidayCountdownStorePath: string;
  scheduledReminderStorePath: string;
  adminOperationLogPath: string;
  groupMemoryPath: string;
  groupMemoryCandidatesPath: string;
  dailyProfileReviewPath: string;
  knowledgeBasePath: string;
  systemSettingsPath: string;
  profileRecordsPath: string;
  adminTasksPath: string;
  modelHealthHistoryPath: string;
  adminHttpEnabled: boolean;
  adminHttpHost: string;
  adminHttpPort: number;
  adminPublicBaseUrl: string;
  adminUsername?: string;
  adminPassword?: string;
  adminGroupPassword?: string;
  adminSessionSecret?: string;
}
