import assert from "node:assert/strict";
import test from "node:test";

import { COMMON_PERSONA_CHAT_RULES } from "../persona/common-chat-behavior.js";
import type { ConversationTurn, SkillDefinition } from "../types.js";
import { AiService, buildChatMessages, buildSystemPrompt } from "./ai-service.js";

const skill: SkillDefinition = {
  id: "leijun",
  name: "雷总私聊版",
  systemPrompt: "你是一个更像私聊里回消息的雷军分身",
  styleRules: ["短句", "口语化"],
  knowledge: ["更像聊天，不像演讲"],
  sourceSkillLines: ["# 原始技能", "请严格遵循原始技能内容"],
  exampleExchanges: [
    {
      user: "最近状态不太好",
      assistant: "先别把自己绷太紧，睡够一觉再说",
    },
  ],
  temperature: 0.86,
  maxContextTurns: 12,
};

test("buildSystemPrompt includes target examples", () => {
  const prompt = buildSystemPrompt(skill);

  assert.equal(prompt.includes("Shared group chat behavior:"), true);
  assert.equal(prompt.includes(COMMON_PERSONA_CHAT_RULES[1] ?? ""), true);
  assert.equal(prompt.includes(COMMON_PERSONA_CHAT_RULES[4] ?? ""), true);
  assert.equal(prompt.includes("Target chat examples:"), true);
  assert.equal(prompt.includes("User: 最近状态不太好"), true);
  assert.equal(prompt.includes("Assistant: 先别把自己绷太紧，睡够一觉再说"), true);
  assert.equal(prompt.includes("Original source skill content:"), true);
  assert.equal(prompt.includes("# 原始技能"), true);
  assert.equal(prompt.includes("Runtime context:"), true);
  assert.match(prompt, /当前时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC\+8/);
  assert.equal(prompt.includes("当用户问今天、现在几点、星期几、日期或相对时间时"), true);
});

test("buildSystemPrompt includes manual group identity memory", () => {
  const prompt = buildSystemPrompt(skill, {
    groupId: "866209871",
    currentUserId: "1569671790",
    botUserId: "428881701",
    manualIdentities: [
      {
        userIds: ["1967410653"],
        names: ["小菜鸡", "前端哥"],
      },
      {
        userIds: ["927345463", "1551925371"],
        names: ["渣渣辉"],
      },
    ],
  });

  assert.equal(prompt.includes("Manual group identity memory:"), true);
  assert.equal(prompt.includes("当前群号：866209871"), true);
  assert.equal(prompt.includes("当前发言人 QQ：1569671790"), true);
  assert.equal(prompt.includes("机器人自己的 QQ：428881701"), true);
  assert.equal(prompt.includes("1967410653：小菜鸡 / 前端哥"), true);
  assert.equal(prompt.includes("927345463 / 1551925371：渣渣辉"), true);
  assert.equal(prompt.includes("识别人时必须以 QQ 号为准"), true);
  assert.equal(prompt.includes("优先使用身份表里的第一个名字作为主称呼"), true);
  assert.equal(prompt.includes("不要凭空编造身份表没有提供的人物关系设定"), true);
  assert.equal(prompt.includes("你拥有受控 @ 配置人员的能力"), true);
});

test("buildSystemPrompt includes approved group memory and matched knowledge", () => {
  const prompt = buildSystemPrompt(skill, {
    groupId: "67890",
    currentUserId: "20001",
    manualIdentities: [
      {
        userIds: ["20001"],
        names: ["Tester"],
        note: "核心测试成员",
      },
    ],
    memberProfiles: [
      {
        userId: "20001",
        displayName: "Tester",
        aliases: ["Tester"],
        note: "核心测试成员",
        hasManualIdentity: true,
        memoryCount: 1,
        pendingCandidateCount: 0,
      },
    ],
    groupMemories: [
      {
        id: "mem-1",
        groupId: "67890",
        type: "member_profile",
        subjectUserId: "20001",
        title: "Tester 偏好",
        content: "Tester 喜欢简短回答。",
        confidence: 0.8,
        source: "admin",
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:00:00.000Z",
        enabled: true,
      },
    ],
    knowledgeHits: [
      {
        id: "faq-1",
        groupId: "67890",
        title: "报销规则",
        question: "怎么报销发票",
        answer: "先贴发票，再找管理员登记。",
        keywords: ["报销", "发票"],
        enabled: true,
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:00:00.000Z",
      },
    ],
  });

  assert.match(prompt, /Approved group memory/);
  assert.match(prompt, /Tester \/ QQ 20001 \/ 核心测试成员/);
  assert.match(prompt, /Tester 喜欢简短回答/);
  assert.match(prompt, /Matched group knowledge/);
  assert.match(prompt, /先贴发票/);
});

test("buildChatMessages injects examples before conversation history", () => {
  const history: ConversationTurn[] = [
    {
      groupId: "1",
      role: "user",
      content: "上一轮内容",
      userId: "2",
      timestamp: new Date().toISOString(),
    },
  ];

  const messages = buildChatMessages(skill, history, "这轮问题");

  assert.deepEqual(
    messages.map((message) => message.role),
    ["system", "user", "assistant", "user", "user"],
  );
  assert.equal(messages[1]?.content, "最近状态不太好");
  assert.equal(messages[2]?.content, "先别把自己绷太紧，睡够一觉再说");
  assert.equal(messages.at(-1)?.content, "这轮问题");
});

test("buildChatMessages passes manual identity memory into system prompt", () => {
  const messages = buildChatMessages(skill, [], "你认识小菜鸡吗", [], {
    groupId: "866209871",
    currentUserId: "1569671790",
    manualIdentities: [
      {
        userIds: ["1967410653"],
        names: ["小菜鸡", "前端哥"],
      },
    ],
  });

  assert.equal(messages[0]?.role, "system");
  assert.equal(typeof messages[0]?.content, "string");
  assert.match(String(messages[0]?.content), /1967410653：小菜鸡 \/ 前端哥/);
});

test("buildChatMessages includes interaction and referenced message context", () => {
  const messages = buildChatMessages(skill, [], "你怎么看", [], {
    groupId: "866209871",
    currentUserId: "1569671790",
    botUserId: "428881701",
    manualIdentities: [
      {
        userIds: ["1120909472"],
        names: ["飞哥", "群主"],
      },
    ],
    interactionTargets: [
      {
        userId: "1120909472",
        names: ["飞哥", "群主"],
        source: "mention",
      },
      {
        userId: "1418509802",
        names: ["鸡哥"],
        source: "reply",
      },
    ],
    replyContext: {
      messageId: "9001",
      userId: "1418509802",
      userName: "鸡哥",
      text: "被引用的原消息",
      images: [],
    },
  });

  const prompt = String(messages[0]?.content);
  assert.equal(prompt.includes("Current interaction context:"), true);
  assert.equal(prompt.includes("Current speaker QQ: 1569671790"), true);
  assert.equal(prompt.includes("mentioned target: QQ 1120909472 names 飞哥 / 群主"), true);
  assert.equal(prompt.includes("replied-message sender: QQ 1418509802 names 鸡哥"), true);
  assert.equal(prompt.includes("content: 被引用的原消息"), true);
  assert.equal(prompt.includes("Do not output CQ at codes"), true);
  assert.equal(prompt.includes("prefer the first configured/manual name"), true);
  assert.equal(prompt.includes("only use raw QQ when no name is known"), true);
});

test("buildChatMessages supports image inputs on current user turn", () => {
  const messages = buildChatMessages(skill, [], "帮我看看这张图", [
    { url: "https://example.com/demo.png" },
  ]);

  const lastMessage = messages.at(-1);
  assert.equal(lastMessage?.role, "user");
  assert.equal(Array.isArray(lastMessage?.content), true);
  const content = lastMessage?.content as Array<{ type: string }>;
  assert.equal(content[0]?.type, "text");
  assert.equal(content[1]?.type, "image_url");
});

test("evaluateControlledMention asks for structured consent and parses json", async () => {
  const calls: unknown[] = [];
  const service = new AiService("https://example.invalid/v1", "test-key", "test-model", {
    async create(args: unknown) {
      calls.push(args);
      return {
        choices: [
          {
            message: {
              content: "```json\n{\"shouldMention\":true,\"target\":\"悠米\",\"reason\":\"机器人同意叫人\"}\n```",
            },
          },
        ],
      };
    },
  } as never);

  const decision = await service.evaluateControlledMention({
    skill,
    history: [
      {
        groupId: "866209871",
        role: "assistant",
        content: "先别叫",
        timestamp: new Date().toISOString(),
      },
    ],
    userInput: "真有急事，你帮我叫一下悠米",
    assistantReply: "行吧，我叫悠米",
    identityContext: {
      groupId: "866209871",
      currentUserId: "1569671790",
      manualIdentities: [
        {
          userIds: ["429462108"],
          names: ["悠米"],
        },
      ],
    },
  });

  assert.deepEqual(decision, {
    shouldMention: true,
    target: "悠米",
    reason: "机器人同意叫人",
  });
  const request = calls[0] as { temperature?: number; max_tokens?: number; messages?: Array<{ content: string }> };
  assert.equal(request.temperature, 0);
  assert.equal(request.max_tokens, 120);
  assert.match(request.messages?.[0]?.content ?? "", /只判断机器人在本轮回复中是否已经自主同意/);
  assert.match(request.messages?.[1]?.content ?? "", /429462108: 悠米/);
});

test("evaluateControlledMention falls back to no mention when model output is invalid", async () => {
  const service = new AiService("https://example.invalid/v1", "test-key", "test-model", {
    async create() {
      return {
        choices: [
          {
            message: {
              content: "not json",
            },
          },
        ],
      };
    },
  } as never);

  const decision = await service.evaluateControlledMention({
    skill,
    history: [],
    userInput: "帮我叫一下悠米",
    assistantReply: "行",
    identityContext: {
      groupId: "866209871",
      currentUserId: "1569671790",
      manualIdentities: [
        {
          userIds: ["429462108"],
          names: ["悠米"],
        },
      ],
    },
  });

  assert.equal(decision.shouldMention, false);
});
