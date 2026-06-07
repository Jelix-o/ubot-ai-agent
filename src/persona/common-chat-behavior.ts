import type { SkillDefinition } from "../types.js";

export const COMMON_PERSONA_CHAT_RULES = [
  "像 QQ 或私聊里真人回消息，不像在写文章、演讲稿、客服回复或标准答案",
  "不要使用 markdown，不要使用星号包装强调，不要输出标题或分节小标题",
  "默认少铺垫、少总结、少官话，优先直接回应用户真正关心的点",
  "优先口语化、拟人化、自然一点，可以像真人一样有停顿感、语气感和轻微幽默感",
  "默认回复尽量简短，通常控制在 1 到 3 句话，总字数尽量不超过 150 字，每条尽量不超过 70 字，宁可简化也不要半句话被截断",
  "不要为了显得聪明而长篇大论，也不要为了简短而变得空泛",
  "如果用户情绪低落、焦虑、迷茫，先接住情绪，再给建议，不要像鸡汤号",
  "如果内容更适合分条发送，就按聊天气泡习惯拆开，不要机械地一句拆一条",
  "尽量避免模型腔表达，例如“作为 AI”“客观来说”“从某种角度看”“需要指出的是”",
  "默认每条消息结尾不要带句号，尽量像真人聊天收尾",
  "人名、群昵称、Skill 名称、QQ 昵称和固定别名必须按上下文原样输出，不要音近改写、谐音改写、错字改写或自行编造称呼",
];

const DEFAULT_MAX_REPLY_CHARS = 70;
const DEFAULT_MAX_TOTAL_REPLY_CHARS = 150;
const DEFAULT_MAX_REPLY_MESSAGES = 3;
const DEFAULT_PREFERRED_MAX_REPLY_MESSAGES = 2;
const DEFAULT_STRIP_ASTERISKS = true;
const DEFAULT_SINGLE_SENTENCE_PER_MESSAGE = false;
const DEFAULT_STRIP_TERMINAL_PUNCTUATION = true;
const DEFAULT_RESPECT_LINE_BREAKS = true;
const DEFAULT_ALLOW_BURST_ON_HIGH_EMOTION = false;
const DEFAULT_HIGH_EMOTION_KEYWORDS: string[] = [];

export type ReplyBehaviorOptions = {
  maxChars: number;
  maxTotalChars: number;
  maxMessages: number;
  preferredMaxMessages: number;
  stripAsterisks: boolean;
  singleSentencePerMessage: boolean;
  stripTerminalPunctuation: boolean;
  respectLineBreaks: boolean;
  allowBurstOnHighEmotion: boolean;
  highEmotionKeywords: string[];
};

export function getReplyBehaviorOptions(skill: SkillDefinition): ReplyBehaviorOptions {
  const maxChars = Math.min(
    skill.maxReplyCharsPerMessage ?? DEFAULT_MAX_REPLY_CHARS,
    DEFAULT_MAX_REPLY_CHARS,
  );
  const maxTotalChars = Math.min(
    skill.maxTotalReplyChars ?? DEFAULT_MAX_TOTAL_REPLY_CHARS,
    DEFAULT_MAX_TOTAL_REPLY_CHARS,
  );
  const maxMessages = Math.min(
    skill.maxReplyMessages ?? DEFAULT_MAX_REPLY_MESSAGES,
    DEFAULT_MAX_REPLY_MESSAGES,
  );
  const preferredMaxMessages = Math.min(
    skill.preferredMaxReplyMessages ?? DEFAULT_PREFERRED_MAX_REPLY_MESSAGES,
    maxMessages,
  );

  return {
    maxChars,
    maxTotalChars,
    maxMessages,
    preferredMaxMessages,
    stripAsterisks: skill.stripAsterisks ?? DEFAULT_STRIP_ASTERISKS,
    singleSentencePerMessage:
      skill.singleSentencePerMessage ?? DEFAULT_SINGLE_SENTENCE_PER_MESSAGE,
    stripTerminalPunctuation:
      skill.stripTerminalPunctuation ?? DEFAULT_STRIP_TERMINAL_PUNCTUATION,
    respectLineBreaks: skill.respectLineBreaks ?? DEFAULT_RESPECT_LINE_BREAKS,
    allowBurstOnHighEmotion:
      skill.allowBurstOnHighEmotion ?? DEFAULT_ALLOW_BURST_ON_HIGH_EMOTION,
    highEmotionKeywords: skill.highEmotionKeywords ?? DEFAULT_HIGH_EMOTION_KEYWORDS,
  };
}
