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
}

export type AdminTaskType =
  | "memory-dedup"
  | "profile-generate"
  | "model-check"
  | "bulk-review"
  | "self-iteration-analyze"
  | "self-iteration-apply"
  | "dev-plan-generate";
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

export type IterationFeedbackSource = "qq_command" | "admin";
export type IterationFeedbackCategory = "bug" | "behavior" | "data_quality" | "skill" | "model" | "feature" | "ops";
export type IterationFeedbackStatus = "open" | "planned" | "applied" | "rejected";
export type IterationRelatedEntityType = "skill" | "memory" | "candidate" | "knowledge" | "profile" | "model" | "command" | "ops";

export interface IterationFeedbackRecord {
  id: string;
  groupId: string;
  operatorUserId: string;
  source: IterationFeedbackSource;
  category: IterationFeedbackCategory;
  title: string;
  content: string;
  status: IterationFeedbackStatus;
  relatedEntityType?: IterationRelatedEntityType;
  relatedEntityId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface IterationFeedbackFile {
  feedback: IterationFeedbackRecord[];
}

export type IterationPlanStatus = "draft" | "approved" | "applied" | "rejected";
export type IterationPlanScope = "code" | "config" | "data" | "mixed";
export type IterationPlanRiskLevel = "low" | "medium" | "high";

export interface IterationPlanEvidenceItem {
  type: string;
  title: string;
  detail: string;
  groupId?: string;
  entityId?: string;
}

export interface IterationPlanRecommendation {
  type: "skill" | "config" | "data" | "code";
  title: string;
  detail: string;
  action?: "approve_candidates" | "reject_candidates" | "disable_knowledge" | "enable_knowledge" | "skill_patch" | "group_config_patch";
  targetId?: string;
  patch?: unknown;
}

export interface IterationPlanRecord {
  id: string;
  title: string;
  summary: string;
  status: IterationPlanStatus;
  generatedBy: "ai" | "manual";
  scope: IterationPlanScope;
  goalPrompt: string;
  evidence: IterationPlanEvidenceItem[];
  recommendations: IterationPlanRecommendation[];
  riskLevel: IterationPlanRiskLevel;
  createdAt: string;
  updatedAt: string;
  appliedAt?: string;
  appliedBy?: string;
  rejectionReason?: string;
}

export interface IterationPlansFile {
  plans: IterationPlanRecord[];
}

export interface SkillDefinition {
  id: string;
  name: string;
  systemPrompt: string;
  styleRules: string[];
  knowledge: string[];
  sourceSkillLines?: string[];
  ttsStyleHint?: string;
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

export interface AiIdentityContext {
  groupId: string;
  currentUserId: string;
  botUserId?: string;
  manualIdentities?: GroupManualIdentity[];
  memberProfiles?: GroupMemberProfile[];
  groupMemories?: GroupMemory[];
  knowledgeHits?: KnowledgeBaseEntry[];
  interactionTargets?: AiInteractionTarget[];
  replyContext?: AiReplyContext;
}

export type ReplyModelMode = string;
export type ScheduleDateRule = "all" | "workday" | "holiday" | "custom";

export interface GroupBotConfig {
  groupId: string;
  groupName?: string;
  enabled?: boolean;
  currentSkillId: string;
  replyModelMode?: ReplyModelMode;
  allowedSkillIds: string[];
  switcherUserIds: string[];
  liveChatUserIds: string[];
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
  memoryDisabledUserIds?: string[];
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

export interface ConversationsFile {
  conversations: Record<string, ConversationTurn[]>;
}

export interface AiReply {
  text: string;
  model: string;
  skillId: string;
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

export interface SystemSettings {
  profileSummaryMaxChars: number;
  profileShortSummaryMaxChars: number;
  dailyProfileReviewEnabled: boolean;
  dailyProfileReviewTime: string;
  memoryDedupEnabled: boolean;
  memoryDedupTime: string;
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
  shareToken?: string;
  publicEnabled?: boolean;
  expiresAt?: string;
  accessCount?: number;
  revokedAt?: string;
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
  openAiBaseUrl: string;
  openAiApiKey: string;
  openAiModel: string;
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
  iterationFeedbackPath: string;
  iterationPlansPath: string;
  adminHttpEnabled: boolean;
  adminHttpHost: string;
  adminHttpPort: number;
  adminPublicBaseUrl: string;
  adminUsername?: string;
  adminPassword?: string;
  adminGroupPassword?: string;
  adminSessionSecret?: string;
}
