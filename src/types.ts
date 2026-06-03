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

export type ReplyModelMode = "gpt" | "mimo";

export interface GroupBotConfig {
  groupId: string;
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
  dailyReportTopUserCount?: number;
  holidayCountdownEnabled?: boolean;
  holidayCountdownTime?: string;
  botMuted?: boolean;
  scheduledRemindersEnabled?: boolean;
  blacklistedUserIds?: string[];
  opsAlertsEnabled?: boolean;
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
  createdAt: string;
  nextRunAt: string;
  enabled: boolean;
  recentMessages?: string[];
}

export interface ScheduledRemindersFile {
  tasks: Record<string, ScheduledReminderTask>;
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
  adminHttpEnabled: boolean;
  adminHttpHost: string;
  adminHttpPort: number;
  adminPublicBaseUrl: string;
  adminUsername?: string;
  adminPassword?: string;
  adminSessionSecret?: string;
}
