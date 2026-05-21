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

export interface GroupBotConfig {
  groupId: string;
  currentSkillId: string;
  allowedSkillIds: string[];
  switcherUserIds: string[];
  liveChatUserIds: string[];
  liveChatDelaySeconds?: number;
  liveChatDelayMinutes?: number;
  dailyReportEnabled?: boolean;
  dailyReportTime?: string;
  dailyReportTopUserCount?: number;
  holidayCountdownEnabled?: boolean;
  holidayCountdownTime?: string;
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
}
