import OpenAI from "openai";

import { COMMON_PERSONA_CHAT_RULES } from "../persona/common-chat-behavior.js";
import { buildSubjectLabel } from "./member-profile-service.js";
import type {
  ControlledMentionDecision,
  AiIdentityContext,
  AiReply,
  ConversationTurn,
  GroupMemoryType,
  MessageImageInput,
  SkillDefinition,
} from "../types.js";
import type { BufferedMessage } from "./live-chat-service.js";

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ChatCompletionsClient = Pick<OpenAI.Chat.Completions, "create">;

const PROFILE_EXTRACTION_MAX_TOKENS = 8000;
const DAILY_PROFILE_SUMMARY_MAX_TOKENS = 4000;
const OVERALL_PROFILE_SUMMARY_MAX_TOKENS = 6000;
const DAILY_PROFILE_MEMORY_LIMIT = 200;
const OVERALL_PROFILE_MEMORY_LIMIT = 500;

export interface DailyReportTopicInsight {
  title: string;
  reason: string;
}

export interface DailyReportUserReasonInsight {
  userId: string;
  reason: string;
}

export interface DailyReportHighlightInsight {
  userId: string;
  reason: string;
}

export interface DailyReportQuoteInsight {
  userId?: string;
  text: string;
  reason?: string;
}

export interface DailyReportInsights {
  topics: DailyReportTopicInsight[];
  topUserReasons: DailyReportUserReasonInsight[];
  highlight?: DailyReportHighlightInsight;
  quote?: DailyReportQuoteInsight;
}

export interface ChatPeriodSummaryInput {
  dateLabel: string;
  periodLabel: string;
  rangeLabel: string;
  totalMessages: number;
  participantCount: number;
  topUsers: Array<{
    userName: string;
    messageCount: number;
  }>;
  sampleMessages: Array<{
    userName: string;
    text: string;
    timestamp: string;
  }>;
}

export interface MemoryCandidateExtractionMessage {
  userId: string;
  userName: string;
  text: string;
  timestamp: string;
}

export interface ExtractedGroupMemoryCandidate {
  type: GroupMemoryType;
  subjectUserId?: string;
  title: string;
  content: string;
  confidence: number;
}

export interface MemberProfileMemoryInput {
  title: string;
  content: string;
  createdAt?: string;
  confidence?: number;
}

export class AiService {
  private readonly client: OpenAI;
  private readonly chatCompletions: ChatCompletionsClient;

  constructor(
    baseURL: string,
    apiKey: string,
    private readonly model: string,
    chatCompletions?: ChatCompletionsClient,
  ) {
    this.client = new OpenAI({ baseURL, apiKey });
    this.chatCompletions = chatCompletions ?? this.client.chat.completions;
  }

  async generateReply(args: {
    skill: SkillDefinition;
    history: ConversationTurn[];
    userInput: string;
    images?: MessageImageInput[];
    identityContext?: AiIdentityContext;
  }): Promise<AiReply> {
    const { skill, history, userInput, images = [], identityContext } = args;
    const messages = buildChatMessages(skill, history, userInput, images, identityContext);

    // Some OpenAI-compatible gateways only provide text through stream chunks.
    const streamReply = await this.tryStreamReply(messages, skill.temperature);
    if (streamReply) {
      return {
        text: streamReply.text,
        model: streamReply.model,
        skillId: skill.id,
      };
    }

    const completion = await this.chatCompletions.create({
      model: this.model,
      temperature: skill.temperature,
      messages,
    });

    const text = completion.choices[0]?.message?.content?.trim();
    if (!text) {
      throw new Error("AI response was empty in both stream and non-stream modes.");
    }

    return {
      text,
      model: completion.model ?? this.model,
      skillId: skill.id,
    };
  }

  async evaluateReplyDesire(
    skill: SkillDefinition,
    history: ConversationTurn[],
    bufferedMessages: BufferedMessage[],
  ): Promise<"REPLY" | "SKIP"> {
    const systemPrompt = buildReplyDesireSystemPrompt(skill);
    const historyText = history
      .slice(-6)
      .map((turn) => `[${turn.role === "user" ? "群友" : skill.name}] ${turn.content}`)
      .join("\n");

    const messagesText = bufferedMessages
      .map((msg, i) => `${i + 1}. ${msg.text}`)
      .join("\n");

    const userContent = [
      historyText ? `最近群聊上下文：\n${historyText}` : "暂无群聊上下文。",
      `该成员最近发送的 ${bufferedMessages.length} 条消息：\n${messagesText}`,
      "请判断是否有回复欲望，只回复 [REPLY] 或 [SKIP]。",
    ].join("\n\n");

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ];

    try {
      const completion = await this.chatCompletions.create({
        model: this.model,
        temperature: 0.3,
        messages,
        max_tokens: 10,
      });

      const text = completion.choices[0]?.message?.content?.trim() ?? "";
      if (text.includes("REPLY")) {
        return "REPLY";
      }
      return "SKIP";
    } catch {
      return "SKIP";
    }
  }

  async evaluateControlledMention(args: {
    skill: SkillDefinition;
    history: ConversationTurn[];
    userInput: string;
    assistantReply: string;
    identityContext: AiIdentityContext;
  }): Promise<ControlledMentionDecision> {
    const identities = args.identityContext.manualIdentities ?? [];
    if (identities.length === 0) {
      return { shouldMention: false, reason: "no manual identities" };
    }

    const identityLines = identities
      .map((identity) => {
        const qqList = identity.userIds.join(" / ");
        const nameList = identity.names.join(" / ");
        return `- ${qqList}: ${nameList}`;
      })
      .join("\n");
    const historyText = args.history
      .slice(-8)
      .map((turn) => `[${turn.role === "assistant" ? args.skill.name : "群友"}] ${turn.content}`)
      .join("\n");

    const messages: ChatMessage[] = [
      {
        role: "system",
        content: [
          "你是 QQ 群机器人受控 @ 意图判定器。",
          "只判断机器人在本轮回复中是否已经自主同意 @ 一名配置人员。",
          "不要因为用户单方面要求就判定同意；必须结合机器人回复是否表达愿意叫人、帮忙喊人、同意 @ 对方。",
          "只能选择人工身份表中的一个目标，不能选择未配置人员。",
          "每次最多允许一个目标。",
          "只输出 JSON，不要输出 markdown。",
          '格式：{"shouldMention":true,"target":"名字或QQ","reason":"简短原因"} 或 {"shouldMention":false,"reason":"简短原因"}',
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          `当前 skill: ${args.skill.name}`,
          `当前群号: ${args.identityContext.groupId}`,
          `当前发言人 QQ: ${args.identityContext.currentUserId}`,
          `人工身份表:\n${identityLines}`,
          historyText ? `最近上下文:\n${historyText}` : "最近上下文: 无",
          `用户本轮输入:\n${args.userInput}`,
          `机器人本轮回复:\n${args.assistantReply}`,
          "请给出受控 @ 判定 JSON。",
        ].join("\n\n"),
      },
    ];

    try {
      const completion = await this.chatCompletions.create({
        model: this.model,
        temperature: 0,
        messages,
        max_tokens: 120,
      });
      const text = completion.choices[0]?.message?.content?.trim() ?? "";
      return parseControlledMentionDecision(text);
    } catch {
      return { shouldMention: false, reason: "decision failed" };
    }
  }

  async extractGroupMemoryCandidates(args: {
    groupId: string;
    messages: MemoryCandidateExtractionMessage[];
  }): Promise<ExtractedGroupMemoryCandidate[]> {
    if (args.messages.length === 0) {
      return [];
    }

    const messageLines = args.messages
      .map((message, index) =>
        `${index + 1}. [${message.timestamp}] ${message.userName}(${message.userId}): ${message.text}`,
      )
      .join("\n");
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: [
          "你是 QQ 群长期记忆候选提炼器。",
          "只提炼稳定、可长期帮助机器人理解群聊的信息。",
          "允许类型：member_profile 表示成员画像、偏好、稳定身份；group_fact 表示群规则、固定梗、长期事实。",
          "member_profile 必须使用聊天记录行里真实出现的 QQ 作为 subjectUserId；如果无法确认归属到某个 QQ，就改为 group_fact。",
          "不要记录短期情绪、临时闲聊、隐私敏感信息、辱骂攻击、未经确认的严重指控。",
          "只输出 JSON，不要输出 markdown。",
          '格式：{"candidates":[{"type":"member_profile","subjectUserId":"123","title":"简短标题","content":"稳定事实","confidence":0.7}]}',
          "如果没有值得记录的内容，输出 {\"candidates\":[]}",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          `群号：${args.groupId}`,
          "近期群聊：",
          messageLines,
          "请提炼候选记忆。",
        ].join("\n\n"),
      },
    ];

    try {
      const completion = await this.chatCompletions.create({
        model: this.model,
        temperature: 0.1,
        messages,
        max_tokens: PROFILE_EXTRACTION_MAX_TOKENS,
      });
      const text = completion.choices[0]?.message?.content?.trim() ?? "";
      return parseMemoryCandidateExtraction(text);
    } catch {
      return [];
    }
  }

  async summarizeDailyMemberProfile(args: {
    groupId: string;
    userId: string;
    displayName: string;
    dateKey: string;
    memories: MemberProfileMemoryInput[];
  }): Promise<string | null> {
    if (args.memories.length === 0) {
      return null;
    }

    const memoryLines = args.memories
      .slice(0, DAILY_PROFILE_MEMORY_LIMIT)
      .map((memory, index) => `${index + 1}. ${memory.title}：${memory.content}`)
      .join("\n");
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: [
          "你是 QQ 群成员画像审查助手。",
          "只能根据提供的新增长期记忆总结，不要编造新事实。",
          "输出 3 到 8 句完整中文，尽量覆盖昨日新增画像中的偏好、行为习惯、互动方式和稳定事实。",
          "不要 markdown，不要编号，不要标题，不要提到置信度。",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          `群号：${args.groupId}`,
          `成员：${args.displayName}（QQ ${args.userId}）`,
          `日期：${args.dateKey}`,
          "昨日新增长期画像记忆：",
          memoryLines,
          "请汇总成几句完整的话。",
        ].join("\n\n"),
      },
    ];

    try {
      const completion = await this.chatCompletions.create({
        model: this.model,
        temperature: 0.2,
        messages,
        max_tokens: DAILY_PROFILE_SUMMARY_MAX_TOKENS,
      });
      return normalizeProfileSummary(completion.choices[0]?.message?.content ?? "");
    } catch {
      return null;
    }
  }

  async summarizeOverallMemberProfile(args: {
    groupId: string;
    userId: string;
    displayName: string;
    memories: MemberProfileMemoryInput[];
  }): Promise<string | null> {
    if (args.memories.length === 0) {
      return null;
    }

    const memoryLines = args.memories
      .slice(0, OVERALL_PROFILE_MEMORY_LIMIT)
      .map((memory, index) => `${index + 1}. ${memory.title}：${memory.content}`)
      .join("\n");
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: [
          "你是 QQ 群成员整体画像汇总助手。",
          "只能根据提供的长期记忆总结，不要编造不存在的身份、关系、性格或事件。",
          "输出一段或数段完整中文，概括这个成员在群里的稳定画像、偏好、互动特点、常见话题和可被长期记住的事实。",
          "语气自然客观，不要为了省字数丢失关键细节。",
          "不要 markdown，不要编号，不要标题。",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          `群号：${args.groupId}`,
          `成员：${args.displayName}（QQ ${args.userId}）`,
          "长期画像记忆：",
          memoryLines,
          "请汇总成一段整体画像。",
        ].join("\n\n"),
      },
    ];

    try {
      const completion = await this.chatCompletions.create({
        model: this.model,
        temperature: 0.2,
        messages,
        max_tokens: OVERALL_PROFILE_SUMMARY_MAX_TOKENS,
      });
      return normalizeProfileSummary(completion.choices[0]?.message?.content ?? "");
    } catch {
      return null;
    }
  }

  async generateDailyReportInsights(args: {
    dateLabel: string;
    totalMessages: number;
    participantCount: number;
    peakHourLabel: string;
    topUsers: Array<{
      userId: string;
      userName: string;
      messageCount: number;
      sampleMessages: string[];
    }>;
    sampleMessages: Array<{
      userId: string;
      userName: string;
      text: string;
      timestamp: string;
    }>;
  }): Promise<DailyReportInsights | null> {
    const topUsersText = args.topUsers
      .map((user, index) => {
        const samples = user.sampleMessages.map((text) => `- ${text}`).join("\n");
        return [
          `${index + 1}. ${user.userName} (${user.userId})`,
          `发言数: ${user.messageCount}`,
          samples ? `代表发言:\n${samples}` : "",
        ]
          .filter(Boolean)
          .join("\n");
      })
      .join("\n\n");

    const sampleMessagesText = args.sampleMessages
      .map(
        (message, index) =>
          `${index + 1}. [${message.timestamp.slice(11, 16)}] ${message.userName} (${message.userId}): ${message.text}`,
      )
      .join("\n");

    const messages: ChatMessage[] = [
      {
        role: "system",
        content: [
          "你是QQ群聊日报分析助手",
          "你只能根据我提供的统计和样本发言做总结，不要编造不存在的人和话题",
          "请只输出 JSON，不要输出 markdown 代码块",
          "JSON 格式如下：",
          '{',
          '  "topics": [{"title": "话题名", "reason": "为什么今天会围绕它聊"}],',
          '  "topUserReasons": [{"userId": "QQ号", "reason": "该群友今天为什么能排进前列"}],',
          '  "highlight": {"userId": "QQ号", "reason": "为什么他是今天最高光的人"},',
          '  "quote": {"userId": "QQ号", "text": "一句最有代表性的原话", "reason": "为什么这句有代表性"}',
          "}",
          "要求：",
          "1. topics 最多 3 条",
          "2. topUserReasons 最多 3 条",
          "3. reason 要具体，基于样本内容，不要空话",
          "4. quote.text 必须来自样本发言原文，不能改写",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          `日期: ${args.dateLabel}`,
          `消息总数: ${args.totalMessages}`,
          `活跃人数: ${args.participantCount}`,
          `最热时段: ${args.peakHourLabel}`,
          "",
          "发言前列群友：",
          topUsersText || "暂无",
          "",
          "群聊样本：",
          sampleMessagesText || "暂无",
        ].join("\n"),
      },
    ];

    try {
      const completion = await this.chatCompletions.create({
        model: this.model,
        temperature: 0.4,
        messages,
        max_tokens: 900,
      });

      const text = completion.choices[0]?.message?.content?.trim();
      if (!text) {
        return null;
      }

      return parseDailyReportInsights(text);
    } catch {
      return null;
    }
  }

  async generateBroadcastQuip(
    scene: "holiday_morning" | "daily_report_evening",
  ): Promise<string> {
    const fallback =
      scene === "holiday_morning"
        ? "先把活挂着，别把摸鱼摸成工伤"
        : "班是公司的，命是自己的，别磨蹭";

    const sceneInstruction =
      scene === "holiday_morning"
        ? "场景：工作日早上九点，提醒群友该摸鱼了，语气搞笑、欠一点、像群里熟人开玩笑"
        : "场景：傍晚下班时间，提醒群友赶紧回家，语气搞笑、欠一点、像群里熟人催人撤退";

    const messages: ChatMessage[] = [
      {
        role: "system",
        content: [
          "你是QQ群定时提醒文案助手",
          "只输出一句中文短句",
          "不要超过50个中文字符",
          "不要换行，不要引号，不要emoji，不要解释",
          "语气要幽默、简短、自然，像群友之间互损",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          sceneInstruction,
          "只给我一句成品文案",
        ].join("\n"),
      },
    ];

    try {
      const completion = await this.chatCompletions.create({
        model: this.model,
        temperature: 0.9,
        messages,
        max_tokens: 80,
      });

      const text = normalizeBroadcastQuip(completion.choices[0]?.message?.content ?? "");
      return text || fallback;
    } catch {
      return fallback;
    }
  }

  async generateScheduledReminderText(args: {
    topic: string;
    groupId: string;
    intervalMinutes: number;
    recentMessages?: string[];
  }): Promise<string | null> {
    const recentText = (args.recentMessages ?? [])
      .slice(-5)
      .map((message, index) => `${index + 1}. ${message}`)
      .join("\n");
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: [
          "你是 QQ 群定时提醒文案助手。",
          "只输出一句中文提醒文案。",
          "不要超过60个中文字符。",
          "不要换行，不要引号，不要emoji，不要解释。",
          "不要输出【提醒...小助手】、标题、标签、冒号式前缀或任何固定栏目前缀。",
          "必须面向全体群友，使用'群友们''大家''各位'等群体称呼，不要针对单个人。",
          "表达要自然、有变化，像群里熟人随口提醒。",
          "如果提供了最近发送过的文案，本次不要复读同一句，也要避开相同开头和相同句式。",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          `群号: ${args.groupId}`,
          `提醒频率: 每 ${args.intervalMinutes} 分钟`,
          `提醒主题: ${args.topic}`,
          recentText ? `最近已发文案:\n${recentText}` : "最近已发文案: 无",
          "请生成本次提醒文案。",
        ].join("\n"),
      },
    ];

    try {
      const completion = await this.chatCompletions.create({
        model: this.model,
        temperature: 0.9,
        messages,
        max_tokens: 100,
      });

      return normalizeBroadcastQuip(completion.choices[0]?.message?.content ?? "").slice(0, 120) || null;
    } catch {
      return null;
    }
  }

  async generateChatPeriodSummary(args: ChatPeriodSummaryInput): Promise<string | null> {
    const topUsersText =
      args.topUsers.length > 0
        ? args.topUsers.map((user) => `${user.userName}${user.messageCount}条`).join("、")
        : "暂无明显活跃成员";

    const sampleMessagesText = args.sampleMessages
      .map(
        (message, index) =>
          `${index + 1}. [${message.timestamp.slice(11, 16)}] ${message.userName}: ${message.text}`,
      )
      .join("\n");

    const messages: ChatMessage[] = [
      {
        role: "system",
        content: [
          "你是QQ群时间段聊天总结助手",
          "只能根据我提供的聊天记录和统计信息做总结，不要编造不存在的话题、人物和情绪",
          "输出 3 到 4 行中文纯文本，不要 markdown，不要代码块，不要解释你在分析",
          "第1行固定写：<时间段>聊天总结",
          "第2行写：主要在聊：...",
          "第3行写：比较活跃：...",
          "第4行优先写：典型内容：...，不方便写典型内容时再写：整体感觉：...",
          "第2行必须明确点出1到3个具体话题、事件或关键词，优先复用聊天样本里的原词",
          "不要只写消息数、参与人数、大家在聊天、比较热闹、一直有人接话这类空话",
          "整段尽量控制在180字以内，语言自然，像群里随手帮大家做个总结",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          `日期：${args.dateLabel}`,
          `时间段：${args.periodLabel}`,
          `范围：${args.rangeLabel}`,
          `消息数：${args.totalMessages}`,
          `参与人数：${args.participantCount}`,
          `活跃成员：${topUsersText}`,
          "",
          "聊天样本：",
          sampleMessagesText || "暂无",
        ].join("\n"),
      },
    ];

    try {
      const completion = await this.chatCompletions.create({
        model: this.model,
        temperature: 0.4,
        messages,
        max_tokens: 260,
      });

      const text = completion.choices[0]?.message?.content?.trim();
      return text ? normalizeChatPeriodSummary(text) : null;
    } catch {
      return null;
    }
  }

  private async tryStreamReply(
    messages: ChatMessage[],
    temperature: number,
  ): Promise<{ text: string; model: string } | null> {
    try {
      const stream = await this.chatCompletions.create({
        model: this.model,
        temperature,
        messages,
        stream: true,
      });

      let text = "";
      let model = this.model;
      for await (const chunk of stream) {
        model = chunk.model ?? model;
        const delta = chunk.choices[0]?.delta?.content;
        if (typeof delta === "string") {
          text += delta;
        }
      }

      const normalized = text.trim();
      if (!normalized) {
        return null;
      }

      return { text: normalized, model };
    } catch {
      return null;
    }
  }
}

export function buildChatMessages(
  skill: SkillDefinition,
  history: ConversationTurn[],
  userInput: string,
  images: MessageImageInput[] = [],
  identityContext?: AiIdentityContext,
): ChatMessage[] {
  const exampleMessages =
    skill.exampleExchanges?.flatMap((example) => [
      {
        role: "user" as const,
        content: example.user,
      },
      {
        role: "assistant" as const,
        content: example.assistant,
      },
    ]) ?? [];

  const currentUserMessage = buildCurrentUserMessage(userInput, images);

  return [
    {
      role: "system",
      content: buildSystemPrompt(skill, identityContext),
    },
    ...exampleMessages,
    ...history.map((turn) => ({
      role: turn.role,
      content: turn.content,
    })),
    currentUserMessage,
  ];
}

function buildCurrentUserMessage(
  userInput: string,
  images: MessageImageInput[],
): OpenAI.Chat.Completions.ChatCompletionUserMessageParam {
  const usableImages = images.filter((image) => typeof image.url === "string" && image.url.length > 0);

  if (usableImages.length === 0) {
    return {
      role: "user",
      content: userInput,
    };
  }

  const text = userInput.trim() || "请根据这张图片的内容来理解我的意思并回复";

  return {
    role: "user",
    content: [
      {
        type: "text",
        text,
      },
      ...usableImages.map((image) => ({
        type: "image_url" as const,
        image_url: {
          url: image.url!,
        },
      })),
    ],
  };
}

function parseDailyReportInsights(text: string): DailyReportInsights | null {
  const jsonText = extractJsonObject(text);
  if (!jsonText) {
    return null;
  }

  try {
    const parsed = JSON.parse(jsonText) as Partial<DailyReportInsights>;
    const topics = Array.isArray(parsed.topics)
      ? parsed.topics
          .map((item) => ({
            title: typeof item?.title === "string" ? item.title.trim() : "",
            reason: typeof item?.reason === "string" ? item.reason.trim() : "",
          }))
          .filter((item) => item.title && item.reason)
          .slice(0, 3)
      : [];
    const topUserReasons = Array.isArray(parsed.topUserReasons)
      ? parsed.topUserReasons
          .map((item) => ({
            userId: typeof item?.userId === "string" ? item.userId.trim() : "",
            reason: typeof item?.reason === "string" ? item.reason.trim() : "",
          }))
          .filter((item) => item.userId && item.reason)
          .slice(0, 3)
      : [];
    const highlight =
      parsed.highlight &&
      typeof parsed.highlight.userId === "string" &&
      typeof parsed.highlight.reason === "string"
        ? {
            userId: parsed.highlight.userId.trim(),
            reason: parsed.highlight.reason.trim(),
          }
        : undefined;
    const quote =
      parsed.quote && typeof parsed.quote.text === "string"
        ? {
            userId:
              typeof parsed.quote.userId === "string" ? parsed.quote.userId.trim() : undefined,
            text: parsed.quote.text.trim(),
            reason:
              typeof parsed.quote.reason === "string" ? parsed.quote.reason.trim() : undefined,
          }
        : undefined;

    return {
      topics,
      topUserReasons,
      highlight,
      quote: quote?.text ? quote : undefined,
    };
  } catch {
    return null;
  }
}

function extractJsonObject(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced?.[1]?.trim() ?? text.trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");

  if (start === -1 || end === -1 || end <= start) {
    return null;
  }

  return raw.slice(start, end + 1);
}

function parseControlledMentionDecision(raw: string): ControlledMentionDecision {
  const jsonText = extractJsonObject(raw);
  if (!jsonText) {
    return { shouldMention: false, reason: "no json" };
  }

  try {
    const parsed = JSON.parse(jsonText) as Partial<ControlledMentionDecision>;
    const target = typeof parsed.target === "string" ? parsed.target.trim() : undefined;
    const reason = typeof parsed.reason === "string" ? parsed.reason.trim() : undefined;
    return {
      shouldMention: parsed.shouldMention === true,
      ...(target ? { target } : {}),
      ...(reason ? { reason } : {}),
    };
  } catch {
    return { shouldMention: false, reason: "invalid json" };
  }
}

function normalizeBroadcastQuip(text: string): string {
  return text
    .replace(/\r?\n/g, " ")
    .replace(/["“”'‘’]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 50);
}

function normalizeChatPeriodSummary(text: string): string {
  return text
    .replace(/\r/g, "")
    .replace(/```(?:text)?/gi, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 220);
}

function normalizeProfileSummary(text: string): string | null {
  const normalized = text
    .replace(/\r/g, "")
    .replace(/```(?:text)?|```/gi, "")
    .replace(/^#+\s*/gm, "")
    .replace(/^[\s-]*画像总结[:：]\s*/i, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim()
    .slice(0, 260);
  return normalized || null;
}

export function buildSystemPrompt(skill: SkillDefinition, identityContext?: AiIdentityContext): string {
  const commonChatBehavior = COMMON_PERSONA_CHAT_RULES.map((rule) => `- ${rule}`).join("\n");
  const style = skill.styleRules.map((rule) => `- ${rule}`).join("\n");
  const knowledge = skill.knowledge.map((item) => `- ${item}`).join("\n");
  const runtimeContext = buildRuntimeContext(new Date());
  const manualIdentityContext = buildManualIdentityContext(identityContext);
  const groupMemoryContext = buildGroupMemoryContext(identityContext);
  const knowledgeContext = buildKnowledgeContext(identityContext);
  const interactionContext = buildInteractionContext(identityContext);
  const examples =
    skill.exampleExchanges?.length
      ? [
          "",
          "Target chat examples:",
          ...skill.exampleExchanges.flatMap((example, index) => [
            `${index + 1}. User: ${example.user}`,
            `   Assistant: ${example.assistant}`,
          ]),
        ].join("\n")
      : "";
  const sourceSkill =
    skill.sourceSkillLines?.length
      ? [
          "",
          "Original source skill content:",
          ...skill.sourceSkillLines,
        ].join("\n")
      : "";

  return [
    skill.systemPrompt,
    "",
    "Shared group chat behavior:",
    commonChatBehavior,
    "",
    "Response style:",
    style,
    "",
    "Known context:",
    knowledge,
    "",
    "Runtime context:",
    runtimeContext,
    manualIdentityContext ? ["", "Manual group identity memory:", manualIdentityContext].join("\n") : "",
    groupMemoryContext ? ["", "Approved group memory:", groupMemoryContext].join("\n") : "",
    knowledgeContext ? ["", "Matched group knowledge:", knowledgeContext].join("\n") : "",
    interactionContext ? ["", "Current interaction context:", interactionContext].join("\n") : "",
    examples,
    sourceSkill,
  ].join("\n");
}

function parseMemoryCandidateExtraction(text: string): ExtractedGroupMemoryCandidate[] {
  const jsonText = extractJsonObject(text);
  if (!jsonText) {
    return [];
  }

  try {
    const parsed = JSON.parse(jsonText) as {
      candidates?: Array<Partial<ExtractedGroupMemoryCandidate>>;
    };
    if (!Array.isArray(parsed.candidates)) {
      return [];
    }

    return parsed.candidates
      .map((candidate) => {
        const type = candidate.type === "member_profile" ? "member_profile" : candidate.type === "group_fact" ? "group_fact" : undefined;
        const title = typeof candidate.title === "string" ? candidate.title.trim() : "";
        const content = typeof candidate.content === "string" ? candidate.content.trim() : "";
        if (!type || !title || !content) {
          return undefined;
        }

        const confidence =
          typeof candidate.confidence === "number" && Number.isFinite(candidate.confidence)
            ? Math.max(0, Math.min(1, candidate.confidence))
            : 0.6;
        const subjectUserId =
          typeof candidate.subjectUserId === "string" && /^\d+$/.test(candidate.subjectUserId.trim())
            ? candidate.subjectUserId.trim()
            : undefined;

        return {
          type,
          ...(subjectUserId ? { subjectUserId } : {}),
          title: title.slice(0, 80),
          content: content.slice(0, 600),
          confidence,
        };
      })
      .filter((candidate): candidate is ExtractedGroupMemoryCandidate => Boolean(candidate))
      .slice(0, 5);
  } catch {
    return [];
  }
}

function buildManualIdentityContext(identityContext?: AiIdentityContext): string {
  const identities = identityContext?.manualIdentities ?? [];
  if (!identityContext || identities.length === 0) {
    return "";
  }

  const lines = [
    `- 当前群号：${identityContext.groupId}`,
    `- 当前发言人 QQ：${identityContext.currentUserId}`,
  ];

  if (identityContext.botUserId) {
    lines.push(`- 机器人自己的 QQ：${identityContext.botUserId}`);
  }

  lines.push(
    "- 识别人时必须以 QQ 号为准，群名片、昵称和发言内容只作参考；如果有人使用别人的名字或外号发言，不要把他当成被冒充的人。",
    "- 对已配置人员说话或提到他们时，优先使用身份表里的第一个名字作为主称呼，可自然使用后续别名；不要生硬直接称呼 QQ 号。",
    "- 可以根据当前上下文、历史对话和群友称呼表现熟络、吐槽或带一点情绪，但不要凭空编造身份表没有提供的人物关系设定。",
    "- 你拥有受控 @ 配置人员的能力：可以拒绝用户要求，也可以被说服后同意叫某个人；不要自己写 CQ @ 码，最终是否真正 @ 由程序校验。",
    "- 下面是本群人工维护的身份表：",
  );

  for (const identity of identities) {
    const qqList = identity.userIds.join(" / ");
    const nameList = identity.names.join(" / ");
    const note = identity.note ? `；${identity.note}` : "";
    lines.push(`  - ${qqList}：${nameList}${note}`);
  }

  return lines.join("\n");
}

function buildGroupMemoryContext(identityContext?: AiIdentityContext): string {
  const memories = identityContext?.groupMemories ?? [];
  if (memories.length === 0) {
    return "";
  }

  const lines = [
    "- 这些是管理员批准后的长期群记忆，只用于补充稳定背景，不得覆盖人工身份表。",
    "- 如果记忆和当前用户发言冲突，以当前明确上下文为准；不要把记忆说成系统配置。",
  ];
  for (const memory of memories.slice(0, 20)) {
    const subject = buildSubjectLabel(
      {
        groupId: identityContext?.groupId ?? memory.groupId,
        currentSkillId: "",
        allowedSkillIds: [],
        switcherUserIds: [],
        liveChatUserIds: [],
        manualIdentities: identityContext?.manualIdentities,
      },
      memory.subjectUserId,
      identityContext?.memberProfiles ?? [],
      memory.type,
    ).label;
    lines.push(`  - [${memory.type}]${subject}：${memory.title}：${memory.content}`);
  }
  return lines.join("\n");
}

function buildKnowledgeContext(identityContext?: AiIdentityContext): string {
  const hits = identityContext?.knowledgeHits ?? [];
  if (hits.length === 0) {
    return "";
  }

  const lines = [
    "- 以下 FAQ 是本轮问题的关键词命中结果。回答相关问题时优先采用这些内容。",
    "- 未命中的资料不要编造；如果 FAQ 不足以回答，可以说明需要管理员补充知识库。",
  ];
  for (const hit of hits.slice(0, 3)) {
    const keywords = hit.keywords.length > 0 ? `；关键词：${hit.keywords.join("、")}` : "";
    lines.push(`  - ${hit.title}${keywords}\n    问：${hit.question}\n    答：${hit.answer}`);
  }
  return lines.join("\n");
}

function buildInteractionContext(identityContext?: AiIdentityContext): string {
  if (!identityContext) {
    return "";
  }

  const lines = [
    `- Current speaker QQ: ${identityContext.currentUserId}`,
    "- Treat the following people as semantic context only. Do not output CQ at codes for third parties and do not write textual @ before their names.",
    "- Identify people by QQ number and the manual identity table first. When referring to them, prefer the first configured/manual name, then aliases, then group card or nickname, and only use raw QQ when no name is known.",
  ];

  const targets = identityContext.interactionTargets ?? [];
  if (targets.length > 0) {
    lines.push("- Mentioned or replied people:");
    for (const target of targets) {
      const label = target.source === "reply" ? "replied-message sender" : "mentioned target";
      const id = target.userId ? ` QQ ${target.userId}` : "";
      const names = target.names.length > 0 ? ` names ${target.names.join(" / ")}` : "";
      lines.push(`  - ${label}:${id}${names}`);
    }
  }

  if (identityContext.replyContext) {
    const reply = identityContext.replyContext;
    const sender = [reply.userName, reply.userId ? `QQ ${reply.userId}` : ""]
      .filter(Boolean)
      .join(" ");
    lines.push("- Referenced message:");
    lines.push(`  - message id: ${reply.messageId}`);
    lines.push(`  - sender: ${sender || "unknown"}`);
    lines.push(`  - content: ${reply.text || "[non-text message]"}`);
  }

  return lines.join("\n");
}

function buildRuntimeContext(now: Date): string {
  const timeZone = "Asia/Hong_Kong";
  const parts = getTimeParts(now, timeZone);
  const weekday = getWeekdayLabel(parts);

  return [
    `- 当前时间：${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} UTC+8`,
    `- 当前日期：${parts.year}年${parts.month}月${parts.day}日 星期${weekday}`,
    "- 当用户问今天、现在几点、星期几、日期或相对时间时，以这里的运行时上下文为准，不要凭训练数据猜。",
  ].join("\n");
}

function getTimeParts(now: Date, timeZone: string): {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
} {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);

  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

function getWeekdayLabel(parts: { year: string; month: string; day: string }): string {
  const weekdayIndex = new Date(
    Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)),
  ).getUTCDay();
  return ["日", "一", "二", "三", "四", "五", "六"][weekdayIndex]!;
}

export function buildReplyDesireSystemPrompt(skill: SkillDefinition): string {
  return [
    `你现在扮演的角色是「${skill.name}」。以下是你的角色设定：`,
    "",
    skill.systemPrompt,
    "",
    "你的任务：判断作为这个角色，看到群成员发的消息后，是否有强烈的回复欲望？",
    "",
    "判断标准：",
    "- 消息内容是否触发了你的性格特征（被挑衅、被嘲讽、被提及、话题与你相关、情绪共鸣等）",
    "- 你的性格是否决定了你会忍不住插嘴、抬杠、吐槽或回应",
    "- 消息内容是否有足够的情感冲击力让你产生反应",
    "",
    "如果消息平淡无奇、与你无关、或者你性格上不太在意这种内容，就选择跳过。",
    "",
    "回复规则：只回复以下两个标签之一，不要回复任何其他内容：",
    "[REPLY] - 有强烈的回复欲望，想插嘴",
    "[SKIP] - 没有回复欲望，不值得回",
  ].join("\n");
}
