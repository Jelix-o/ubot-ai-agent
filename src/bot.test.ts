import assert from "node:assert/strict";
import test from "node:test";

import { BotApplication, type MessageTransport } from "./bot.js";
import { GroupLock } from "./services/group-lock.js";
import { LiveChatService } from "./services/live-chat-service.js";
import { resolveMentionTargetsFromMembers } from "./utils/mention-resolver.js";
import type {
  AiReply,
  ConversationTurn,
  GroupBotConfig,
  NapcatGroupMember,
  NapcatGroupMessageEvent,
  SkillDefinition,
} from "./types.js";

class FakeTransport implements MessageTransport {
  readonly sent: Array<{ groupId: string; text: string }> = [];
  readonly records: Array<{ groupId: string; recordFile: string }> = [];
  readonly aiRecords: Array<{ groupId: string; text: string }> = [];
  memberDirectoryByGroup: Record<string, NapcatGroupMember[]> = {
    "67890": [
      { user_id: 67890, nickname: "小王", card: "项目经理" },
      { user_id: 55667788, nickname: "老张", card: "张三" },
      { user_id: 20001, nickname: "Tester", card: "测试同学" },
    ],
  };

  async sendGroupMessage(groupId: string, text: string): Promise<void> {
    this.sent.push({ groupId, text });
  }

  async sendGroupRecord(groupId: string, recordFile: string): Promise<void> {
    this.records.push({ groupId, recordFile });
  }

  async sendGroupAiRecord(groupId: string, text: string): Promise<void> {
    this.aiRecords.push({ groupId, text });
  }

  async resolveImageInputs(
    images: Array<{ url?: string; file?: string; summary?: string }>,
  ): Promise<Array<{ url?: string; file?: string; summary?: string }>> {
    return images.map((image) =>
      image.url
        ? image
        : image.file
          ? {
              ...image,
              url: `https://resolved.example/${image.file}.png`,
            }
          : image,
    );
  }

  async resolveMentionTargets(groupId: string, candidates: string[]): Promise<string[]> {
    return resolveMentionTargetsFromMembers(this.memberDirectoryByGroup[groupId] ?? [], candidates);
  }
}

class FakeGroupConfigService {
  constructor(
    public groups: GroupBotConfig[],
    public superAdminUserIds: string[] = [],
  ) {}

  async getAll(): Promise<GroupBotConfig[]> {
    return this.groups.map((group) => cloneGroup(group));
  }

  async getGroup(groupId: string): Promise<GroupBotConfig | undefined> {
    const group = this.groups.find((item) => item.groupId === groupId);
    return group ? cloneGroup(group) : undefined;
  }

  async updateCurrentSkill(groupId: string, skillId: string): Promise<GroupBotConfig> {
    const group = this.requireGroup(groupId);
    group.currentSkillId = skillId;
    return cloneGroup(group);
  }

  async addLiveChatUser(groupId: string, userId: string): Promise<GroupBotConfig> {
    const group = this.requireGroup(groupId);
    group.liveChatUserIds = Array.from(new Set([...group.liveChatUserIds, userId]));
    return cloneGroup(group);
  }

  async removeLiveChatUser(groupId: string, userId: string): Promise<GroupBotConfig> {
    const group = this.requireGroup(groupId);
    group.liveChatUserIds = group.liveChatUserIds.filter((item) => item !== userId);
    return cloneGroup(group);
  }

  async updateLiveChatDelay(groupId: string, delayMinutes: number): Promise<GroupBotConfig> {
    const group = this.requireGroup(groupId);
    group.liveChatDelayMinutes = delayMinutes;
    return cloneGroup(group);
  }

  async updateLiveChatDelaySeconds(groupId: string, delaySeconds: number): Promise<GroupBotConfig> {
    const group = this.requireGroup(groupId);
    group.liveChatDelaySeconds = delaySeconds;
    return cloneGroup(group);
  }

  async updateDailyReportEnabled(groupId: string, enabled: boolean): Promise<GroupBotConfig> {
    const group = this.requireGroup(groupId);
    group.dailyReportEnabled = enabled;
    return cloneGroup(group);
  }

  async updateDailyReportTime(groupId: string, time: string): Promise<GroupBotConfig> {
    const group = this.requireGroup(groupId);
    group.dailyReportTime = time;
    return cloneGroup(group);
  }

  async updateHolidayCountdownEnabled(groupId: string, enabled: boolean): Promise<GroupBotConfig> {
    const group = this.requireGroup(groupId);
    group.holidayCountdownEnabled = enabled;
    return cloneGroup(group);
  }

  async updateHolidayCountdownTime(groupId: string, time: string): Promise<GroupBotConfig> {
    const group = this.requireGroup(groupId);
    group.holidayCountdownTime = time;
    return cloneGroup(group);
  }

  async getSuperAdminUserIds(): Promise<string[]> {
    return [...this.superAdminUserIds];
  }

  async isSuperAdmin(userId: string): Promise<boolean> {
    return this.superAdminUserIds.includes(userId);
  }

  async addAdminUser(groupId: string, userId: string): Promise<GroupBotConfig> {
    const group = this.requireGroup(groupId);
    group.switcherUserIds = Array.from(new Set([...group.switcherUserIds, userId]));
    return cloneGroup(group);
  }

  async removeAdminUser(groupId: string, userId: string): Promise<GroupBotConfig> {
    const group = this.requireGroup(groupId);
    group.switcherUserIds = group.switcherUserIds.filter((item) => item !== userId);
    return cloneGroup(group);
  }

  private requireGroup(groupId: string): GroupBotConfig {
    const group = this.groups.find((item) => item.groupId === groupId);
    if (!group) {
      throw new Error("Group not found");
    }
    return group;
  }
}

class FakeSkillService {
  constructor(private readonly skills: SkillDefinition[]) {}

  async getSkill(skillId: string): Promise<SkillDefinition | undefined> {
    return this.skills.find((skill) => skill.id === skillId);
  }
}

class FakeConversationStore {
  turns: ConversationTurn[] = [];
  clearedGroups: string[] = [];

  async getTurns(): Promise<ConversationTurn[]> {
    return this.turns;
  }

  async appendDialogue(_groupId: string, turns: ConversationTurn[]): Promise<void> {
    this.turns = [...this.turns, ...turns];
  }

  async clearGroup(groupId: string): Promise<void> {
    this.clearedGroups.push(groupId);
    this.turns = [];
  }
}

class FakeAiService {
  calls: Array<{
    skill: SkillDefinition;
    history: ConversationTurn[];
    userInput: string;
    images?: Array<{ url?: string; file?: string; summary?: string }>;
  }> = [];

  constructor(private readonly responder: () => Promise<AiReply>) {}

  async generateReply(args: {
    skill: SkillDefinition;
    history: ConversationTurn[];
    userInput: string;
    images?: Array<{ url?: string; file?: string; summary?: string }>;
  }): Promise<AiReply> {
    this.calls.push(args);
    return this.responder();
  }

  async generateDailyReportInsights(): Promise<null> {
    return null;
  }

  async generateChatPeriodSummary(): Promise<string | null> {
    return null;
  }
}

class FakeTtsService {
  calls: Array<{ text: string; skill: SkillDefinition }> = [];

  constructor(
    private readonly responder: () => Promise<{
      filePath: string;
      recordFile: string;
      cleanup(): Promise<void>;
    }>,
  ) {}

  async synthesize(text: string, skill: SkillDefinition): Promise<{
    filePath: string;
    recordFile: string;
    cleanup(): Promise<void>;
  }> {
    this.calls.push({ text, skill });
    return this.responder();
  }
}

class FakeDailyReportService {
  recorded: Array<{ groupId: string; userId: string; userName: string; text: string }> = [];
  reports: Array<{ groupId: string; now: string }> = [];
  marked: Array<{ groupId: string; now: string }> = [];
  summaries: Array<{ groupId: string; label: string; now: string }> = [];

  constructor(
    private readonly shouldSend = async (_groupConfig?: GroupBotConfig, _now?: Date) => false,
    private readonly reportText = async (_groupConfig?: GroupBotConfig, _now?: Date) => "日报内容",
  ) {}

  async recordMessage(args: {
    groupId: string;
    userId: string;
    userName: string;
    text: string;
  }): Promise<void> {
    this.recorded.push(args);
  }

  async shouldSendScheduledReport(groupConfig: GroupBotConfig, now = new Date()): Promise<boolean> {
    return this.shouldSend(groupConfig, now);
  }

  async buildReport(groupConfig: GroupBotConfig, now = new Date()): Promise<string> {
    this.reports.push({ groupId: groupConfig.groupId, now: now.toISOString() });
    return this.reportText(groupConfig, now);
  }

  async buildChatSummary(args: {
    groupId: string;
    request: { label: string };
    now?: Date;
  }): Promise<string> {
    this.summaries.push({
      groupId: args.groupId,
      label: args.request.label,
      now: (args.now ?? new Date()).toISOString(),
    });
    return `${args.request.label}聊天总结`;
  }

  async markSent(groupId: string, now = new Date()): Promise<void> {
    this.marked.push({ groupId, now: now.toISOString() });
  }
}

class FakeHolidayCountdownService {
  marked: Array<{ groupId: string; now: string }> = [];

  constructor(
    private readonly shouldSend = async (_groupConfig?: GroupBotConfig, _now?: Date) => false,
    private readonly messageFactory = (_now?: Date) => "节假日倒计时",
  ) {}

  async shouldSendScheduledMessage(groupConfig: GroupBotConfig, now = new Date()): Promise<boolean> {
    return this.shouldSend(groupConfig, now);
  }

  buildCountdownMessage(now = new Date()): string {
    return this.messageFactory(now);
  }

  async markSent(groupId: string, now = new Date()): Promise<void> {
    this.marked.push({ groupId, now: now.toISOString() });
  }
}

const assistantSkill: SkillDefinition = {
  id: "assistant",
  name: "assistant",
  systemPrompt: "you are an assistant",
  styleRules: ["short answer"],
  knowledge: ["qq group chat"],
  temperature: 0.7,
  maxContextTurns: 12,
};

const teacherSkill: SkillDefinition = {
  ...assistantSkill,
  id: "teacher",
  name: "teacher",
};

function cloneGroup(group: GroupBotConfig): GroupBotConfig {
  return {
    ...group,
    allowedSkillIds: [...group.allowedSkillIds],
    switcherUserIds: [...group.switcherUserIds],
    liveChatUserIds: [...group.liveChatUserIds],
  };
}

async function withMockedNow<T>(value: number, run: () => Promise<T>): Promise<T> {
  const originalNow = Date.now;
  Date.now = () => value;
  try {
    return await run();
  } finally {
    Date.now = originalNow;
  }
}

function createEvent(
  message: NapcatGroupMessageEvent["message"],
  userId = 20001,
): NapcatGroupMessageEvent {
  return {
    post_type: "message",
    message_type: "group",
    self_id: 12345,
    group_id: 67890,
    user_id: userId,
    message_id: 1,
    raw_message: "",
    message,
    sender: {
      user_id: userId,
      nickname: "Tester",
      role: "member",
    },
  };
}

function createApp(options?: {
  groupConfigService?: FakeGroupConfigService;
  transport?: FakeTransport;
  aiService?: FakeAiService;
  conversationStore?: FakeConversationStore;
  ttsService?: FakeTtsService;
  dailyReportService?: FakeDailyReportService;
  holidayCountdownService?: FakeHolidayCountdownService;
  allowNapCatAiVoiceFallback?: boolean;
  skills?: SkillDefinition[];
}): {
  app: BotApplication;
  transport: FakeTransport;
  groupConfigService: FakeGroupConfigService;
  aiService: FakeAiService;
  conversationStore: FakeConversationStore;
  ttsService: FakeTtsService;
  dailyReportService: FakeDailyReportService;
  holidayCountdownService: FakeHolidayCountdownService;
} {
  const transport = options?.transport ?? new FakeTransport();
  const groupConfigService =
    options?.groupConfigService ??
    new FakeGroupConfigService([
      {
        groupId: "67890",
        currentSkillId: "assistant",
        allowedSkillIds: ["assistant", "teacher"],
        switcherUserIds: ["99999"],
        liveChatUserIds: [],
        liveChatDelayMinutes: 5,
        dailyReportEnabled: true,
        dailyReportTime: "18:00",
        dailyReportTopUserCount: 3,
        holidayCountdownEnabled: true,
        holidayCountdownTime: "09:00",
      },
    ]);
  const conversationStore = options?.conversationStore ?? new FakeConversationStore();
  const aiService =
    options?.aiService ??
    new FakeAiService(async () => ({
      text: "AI reply",
      model: "test-model",
      skillId: "assistant",
    }));
  const ttsService =
    options?.ttsService ??
    new FakeTtsService(async () => ({
      filePath: "tts.wav",
      recordFile: "base64://dHRz",
      async cleanup() {},
    }));
  const dailyReportService =
    options?.dailyReportService ?? new FakeDailyReportService(async () => false);
  const holidayCountdownService =
    options?.holidayCountdownService ?? new FakeHolidayCountdownService(async () => false);

  const app = new BotApplication(
    transport,
    groupConfigService as never,
    new FakeSkillService(options?.skills ?? [assistantSkill, teacherSkill]) as never,
    conversationStore as never,
    aiService as never,
    ttsService as never,
    dailyReportService as never,
    holidayCountdownService as never,
    new GroupLock(),
    new LiveChatService(),
    "12345",
    options?.allowNapCatAiVoiceFallback ?? false,
  );

  return {
    app,
    transport,
    groupConfigService,
    aiService,
    conversationStore,
    ttsService,
    dailyReportService,
    holidayCountdownService,
  };
}

test("responds to mentioned group message and stores dialogue", async () => {
  const { app, transport, aiService, conversationStore } = createApp();

  await app.handleGroupMessage(
    createEvent([
      { type: "at", data: { qq: "12345" } },
      { type: "text", data: { text: " summarize this " } },
    ]),
  );

  assert.equal(aiService.calls.length, 1);
  assert.equal(aiService.calls[0]?.userInput, "summarize this");
  assert.equal(transport.sent[0]?.text, "AI reply");
  assert.equal(conversationStore.turns.length, 2);
});

test("responds to mentioned image message and passes image urls to ai service", async () => {
  const { app, transport, aiService } = createApp({
    aiService: new FakeAiService(async () => ({
      text: "看到了，是一张测试图片",
      model: "test-model",
      skillId: "assistant",
    })),
  });

  await app.handleGroupMessage(
    createEvent([
      { type: "at", data: { qq: "12345" } },
      { type: "image", data: { url: "https://example.com/cat.png" } },
    ]),
  );

  assert.equal(aiService.calls.length, 1);
  assert.equal(aiService.calls[0]?.userInput, "[图片消息]");
  assert.equal(aiService.calls[0]?.images?.length, 1);
  assert.equal(aiService.calls[0]?.images?.[0]?.url, "https://example.com/cat.png");
  assert.equal(transport.sent[0]?.text, "看到了，是一张测试图片");
});

test("ignores non-mentioned messages for ai reply but still records daily stats", async () => {
  const { app, transport, aiService, dailyReportService } = createApp();

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "normal message" } }]));

  assert.equal(aiService.calls.length, 0);
  assert.equal(transport.sent.length, 0);
  assert.equal(dailyReportService.recorded.length, 1);
  assert.equal(dailyReportService.recorded[0]?.text, "normal message");
});

test("builds chat summary from stored records when mentioned with time range request", async () => {
  const { app, transport, aiService, dailyReportService } = createApp();

  await app.handleGroupMessage(
    createEvent([
      { type: "at", data: { qq: "12345" } },
      { type: "text", data: { text: "总结上午聊天信息" } },
    ]),
  );

  assert.equal(aiService.calls.length, 0);
  assert.equal(dailyReportService.recorded.length, 0);
  assert.equal(dailyReportService.summaries.length, 1);
  assert.equal(dailyReportService.summaries[0]?.label, "上午");
  assert.equal(transport.sent[0]?.text, "上午聊天总结");
});

test("lists available skills", async () => {
  const { app, transport } = createApp();

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#技能 列表" } }]));

  assert.match(transport.sent[0]?.text ?? "", /assistant/);
  assert.match(transport.sent[0]?.text ?? "", /teacher/);
});

test("shows feature list through help command", async () => {
  const { app, transport } = createApp();

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#功能" } }]));

  assert.match(transport.sent[0]?.text ?? "", /系统功能总览/);
  assert.match(transport.sent[0]?.text ?? "", /#技能 列表/);
  assert.match(transport.sent[0]?.text ?? "", /#管理员 列表/);
});

test("help aliases support 查看 and 列表 suffixes", async () => {
  const { app, transport } = createApp();

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#帮助 查看" } }]));
  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#命令 列表" } }]));

  assert.match(transport.sent[0]?.text ?? "", /系统功能总览/);
  assert.match(transport.sent[1]?.text ?? "", /系统功能总览/);
  assert.equal(transport.sent.length, 2);
});

test("help command supports category query", async () => {
  const { app, transport } = createApp();

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#功能 技能" } }]));
  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#帮助 管理员" } }]));

  assert.match(transport.sent[0]?.text ?? "", /帮助分类：技能/);
  assert.match(transport.sent[0]?.text ?? "", /#技能 切换 <skillId>/);
  assert.match(transport.sent[1]?.text ?? "", /帮助分类：管理员/);
  assert.match(transport.sent[1]?.text ?? "", /#管理员 添加 <QQ号>/);
});

test("help command reports unknown category and falls back to overview", async () => {
  const { app, transport } = createApp();

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#命令 火箭" } }]));

  assert.match(transport.sent[0]?.text ?? "", /没找到“火箭”这个帮助分类/);
  assert.match(transport.sent[0]?.text ?? "", /系统功能总览/);
});

test("denies unauthorized skill switch", async () => {
  const { app, transport } = createApp();

  await app.handleGroupMessage(
    createEvent([{ type: "text", data: { text: "#技能 切换 teacher" } }], 10000),
  );

  assert.equal(transport.sent.length, 1);
  assert.match(transport.sent[0]?.text ?? "", /权限/);
});

test("switches skill for authorized user and clears context", async () => {
  const groupConfigService = new FakeGroupConfigService([
    {
      groupId: "67890",
      currentSkillId: "assistant",
      allowedSkillIds: ["assistant", "teacher"],
      switcherUserIds: ["99999"],
      liveChatUserIds: [],
      liveChatDelayMinutes: 5,
      dailyReportEnabled: true,
      dailyReportTime: "18:00",
      dailyReportTopUserCount: 3,
    },
  ]);
  const conversationStore = new FakeConversationStore();
  const { app, transport } = createApp({
    groupConfigService,
    conversationStore,
  });

  await app.handleGroupMessage(
    createEvent([{ type: "text", data: { text: "#技能 切换 teacher" } }], 99999),
  );

  assert.equal(groupConfigService.groups[0]?.currentSkillId, "teacher");
  assert.deepEqual(conversationStore.clearedGroups, ["67890"]);
  assert.match(transport.sent[0]?.text ?? "", /teacher/);
});

test("super admin can add and remove group admins, while normal admin cannot", async () => {
  const groupConfigService = new FakeGroupConfigService(
    [
      {
        groupId: "67890",
        currentSkillId: "assistant",
        allowedSkillIds: ["assistant", "teacher"],
        switcherUserIds: ["99999"],
        liveChatUserIds: [],
        liveChatDelayMinutes: 5,
        dailyReportEnabled: true,
        dailyReportTime: "18:00",
        dailyReportTopUserCount: 3,
        holidayCountdownEnabled: true,
        holidayCountdownTime: "09:00",
      },
    ],
    ["88888"],
  );
  const { app, transport } = createApp({ groupConfigService });

  await app.handleGroupMessage(
    createEvent([{ type: "text", data: { text: "#管理员 添加 77777" } }], 99999),
  );
  await app.handleGroupMessage(
    createEvent([{ type: "text", data: { text: "#管理员 添加 77777" } }], 88888),
  );
  await app.handleGroupMessage(
    createEvent([{ type: "text", data: { text: "#管理员 列表" } }], 77777),
  );
  await app.handleGroupMessage(
    createEvent([{ type: "text", data: { text: "#管理员 移除 77777" } }], 88888),
  );

  assert.match(transport.sent[0]?.text ?? "", /没有管理管理员的权限/);
  assert.match(transport.sent[1]?.text ?? "", /已将 77777 设为本群管理员/);
  assert.match(transport.sent[2]?.text ?? "", /本群管理员/);
  assert.match(transport.sent[2]?.text ?? "", /超级管理员：88888/);
  assert.match(transport.sent[3]?.text ?? "", /已移除管理员 77777/);
});

test("super admin can use admin-only commands without being in group admin list", async () => {
  const groupConfigService = new FakeGroupConfigService(
    [
      {
        groupId: "67890",
        currentSkillId: "assistant",
        allowedSkillIds: ["assistant", "teacher"],
        switcherUserIds: ["99999"],
        liveChatUserIds: [],
        liveChatDelayMinutes: 5,
        dailyReportEnabled: true,
        dailyReportTime: "18:00",
        dailyReportTopUserCount: 3,
        holidayCountdownEnabled: true,
        holidayCountdownTime: "09:00",
      },
    ],
    ["88888"],
  );
  const { app, transport } = createApp({ groupConfigService });

  await app.handleGroupMessage(
    createEvent([{ type: "text", data: { text: "#技能 切换 teacher" } }], 88888),
  );

  assert.equal(groupConfigService.groups[0]?.currentSkillId, "teacher");
  assert.match(transport.sent[0]?.text ?? "", /teacher/);
});

test("sends voice reply for voice command", async () => {
  const { app, transport, aiService, ttsService } = createApp({
    aiService: new FakeAiService(async () => ({
      text: "这事可以做",
      model: "test-model",
      skillId: "assistant",
    })),
    ttsService: new FakeTtsService(async () => ({
      filePath: "D:/tmp/voice.wav",
      recordFile: "base64://dm9pY2U=",
      async cleanup() {},
    })),
  });

  await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "#语音 现在怎么做" } }]));

  assert.equal(aiService.calls[0]?.userInput, "现在怎么做");
  assert.equal(ttsService.calls[0]?.text, "这事可以做");
  assert.equal(transport.records[0]?.recordFile, "base64://dm9pY2U=");
  assert.equal(transport.sent.length, 0);
});

test("falls back to text when both tts and ai voice fail", async () => {
  const transport = new FakeTransport();
  transport.sendGroupAiRecord = async () => {
    throw new Error("ai voice failed");
  };

  const { app } = createApp({
    transport,
    aiService: new FakeAiService(async () => ({
      text: "先说结论，可以做",
      model: "test-model",
      skillId: "assistant",
    })),
    ttsService: new FakeTtsService(async () => {
      throw new Error("tts failed");
    }),
    allowNapCatAiVoiceFallback: true,
  });

  await app.handleGroupMessage(
    createEvent([
      { type: "at", data: { qq: "12345" } },
      { type: "text", data: { text: " 语音说 这事怎么做 " } },
    ]),
  );

  assert.equal(transport.records.length, 0);
  assert.equal(transport.aiRecords.length, 0);
  assert.equal(transport.sent[0]?.text, "语音发送失败，我先用文字回复你");
  assert.match(transport.sent[1]?.text ?? "", /先说结论/);
});

test("manages live chat users through commands", async () => {
  const groupConfigService = new FakeGroupConfigService([
    {
      groupId: "67890",
      currentSkillId: "assistant",
      allowedSkillIds: ["assistant"],
      switcherUserIds: ["99999"],
      liveChatUserIds: [],
      liveChatDelayMinutes: 5,
      dailyReportEnabled: true,
      dailyReportTime: "18:00",
      dailyReportTopUserCount: 3,
    },
  ]);
  const { app, transport } = createApp({ groupConfigService });

  await app.handleGroupMessage(
    createEvent([{ type: "text", data: { text: "#实时对话 添加 1569671790" } }], 99999),
  );
  await app.handleGroupMessage(
    createEvent([{ type: "text", data: { text: "#实时对话 列表" } }], 99999),
  );
  await app.handleGroupMessage(
    createEvent([{ type: "text", data: { text: "#实时对话 移除 1569671790" } }], 99999),
  );

  assert.deepEqual(groupConfigService.groups[0]?.liveChatUserIds, []);
  assert.match(transport.sent[0]?.text ?? "", /1569671790/);
  assert.match(transport.sent[1]?.text ?? "", /1569671790/);
  assert.match(transport.sent[2]?.text ?? "", /移除/);
});

test("buffers tracked users and replies during live chat tick when bot stayed silent", async () => {
  const { app, aiService, transport } = await withMockedNow(
    Date.parse("2026-04-13T02:00:00.000Z"),
    async () =>
      createApp({
        groupConfigService: new FakeGroupConfigService([
          {
            groupId: "67890",
            currentSkillId: "assistant",
            allowedSkillIds: ["assistant"],
            switcherUserIds: ["99999"],
            liveChatUserIds: ["20001"],
            liveChatDelayMinutes: 1,
            dailyReportEnabled: true,
            dailyReportTime: "18:00",
            dailyReportTopUserCount: 3,
          },
        ]),
        aiService: new FakeAiService(async () => ({
          text: "我接一句",
          model: "test-model",
          skillId: "assistant",
        })),
      }),
  );

  await withMockedNow(Date.parse("2026-04-13T02:00:00.000Z"), async () => {
    await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "第一句" } }], 20001));
  });
  await withMockedNow(Date.parse("2026-04-13T02:00:30.000Z"), async () => {
    await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "第二句" } }], 20001));
  });
  await withMockedNow(Date.parse("2026-04-13T02:01:05.000Z"), async () => {
    await (app as unknown as { runLiveChatTick(): Promise<void> }).runLiveChatTick();
  });

  assert.equal(aiService.calls.length, 1);
  assert.equal(aiService.calls[0]?.userInput, "1. 第一句\n2. 第二句");
  assert.equal(transport.sent.at(-1)?.text, "[CQ:at,qq=20001] 我接一句");
});

test("suppresses live chat tick when bot already spoke in the same window", async () => {
  const { app, aiService, transport } = await withMockedNow(
    Date.parse("2026-04-13T02:00:00.000Z"),
    async () =>
      createApp({
        groupConfigService: new FakeGroupConfigService([
          {
            groupId: "67890",
            currentSkillId: "assistant",
            allowedSkillIds: ["assistant"],
            switcherUserIds: ["99999"],
            liveChatUserIds: ["20001"],
            liveChatDelayMinutes: 1,
            dailyReportEnabled: true,
            dailyReportTime: "18:00",
            dailyReportTopUserCount: 3,
          },
        ]),
      }),
  );

  await withMockedNow(Date.parse("2026-04-13T02:00:00.000Z"), async () => {
    await app.handleGroupMessage(createEvent([{ type: "text", data: { text: "我先发一句" } }], 20001));
  });
  await withMockedNow(Date.parse("2026-04-13T02:00:30.000Z"), async () => {
    await app.handleGroupMessage(
      createEvent([
        { type: "at", data: { qq: "12345" } },
        { type: "text", data: { text: "正常问一句" } },
      ]),
    );
  });
  await withMockedNow(Date.parse("2026-04-13T02:01:05.000Z"), async () => {
    await (app as unknown as { runLiveChatTick(): Promise<void> }).runLiveChatTick();
  });

  assert.equal(aiService.calls.length, 1);
  assert.equal(aiService.calls[0]?.userInput, "正常问一句");
  assert.equal(transport.sent.length, 1);
  assert.equal(transport.sent[0]?.text, "AI reply");
});

test("updates live chat delay through command", async () => {
  const groupConfigService = new FakeGroupConfigService([
    {
      groupId: "67890",
      currentSkillId: "assistant",
      allowedSkillIds: ["assistant"],
      switcherUserIds: ["99999"],
      liveChatUserIds: [],
      liveChatDelayMinutes: 5,
      dailyReportEnabled: true,
      dailyReportTime: "18:00",
      dailyReportTopUserCount: 3,
    },
  ]);
  const { app, transport } = createApp({ groupConfigService });

  await app.handleGroupMessage(
    createEvent([{ type: "text", data: { text: "#实时对话 间隔 2" } }], 99999),
  );
  await app.handleGroupMessage(
    createEvent([{ type: "text", data: { text: "#实时对话 列表" } }], 99999),
  );

  assert.equal(groupConfigService.groups[0]?.liveChatDelayMinutes, 2);
  assert.match(transport.sent[0]?.text ?? "", /2 分钟/);
  assert.match(transport.sent[1]?.text ?? "", /2 分钟/);
});

test("mentions the targeted group member when user includes a real @ mention", async () => {
  const { app, transport } = createApp({
    aiService: new FakeAiService(async () => ({
      text: "我替你带到了",
      model: "test-model",
      skillId: "assistant",
    })),
  });

  await app.handleGroupMessage(
    createEvent([
      { type: "at", data: { qq: "12345" } },
      { type: "at", data: { qq: "67890" } },
      { type: "text", data: { text: " 你和他说今天别迟到" } },
    ]),
  );

  assert.equal(transport.sent[0]?.text, "[CQ:at,qq=67890] 我替你带到了");
});

test("mentions qq numbers found in plain text when replying", async () => {
  const { app, transport } = createApp({
    aiService: new FakeAiService(async () => ({
      text: "收到，我去说",
      model: "test-model",
      skillId: "assistant",
    })),
  });

  await app.handleGroupMessage(
    createEvent([
      { type: "at", data: { qq: "12345" } },
      { type: "text", data: { text: " 你和 55667788 说，他昨天把群文件删了" } },
    ]),
  );

  assert.equal(transport.sent[0]?.text, "[CQ:at,qq=55667788] 收到，我去说");
});

test("manages daily report settings through commands", async () => {
  const groupConfigService = new FakeGroupConfigService([
    {
      groupId: "67890",
      currentSkillId: "assistant",
      allowedSkillIds: ["assistant"],
      switcherUserIds: ["99999"],
      liveChatUserIds: [],
      liveChatDelayMinutes: 5,
      dailyReportEnabled: true,
      dailyReportTime: "18:00",
      dailyReportTopUserCount: 3,
    },
  ]);
  const { app, transport } = createApp({ groupConfigService });

  await app.handleGroupMessage(
    createEvent([{ type: "text", data: { text: "#日报 时间 19:30" } }], 99999),
  );
  await app.handleGroupMessage(
    createEvent([{ type: "text", data: { text: "#日报 关闭" } }], 99999),
  );
  await app.handleGroupMessage(
    createEvent([{ type: "text", data: { text: "#日报 状态" } }], 99999),
  );

  assert.equal(groupConfigService.groups[0]?.dailyReportTime, "19:30");
  assert.equal(groupConfigService.groups[0]?.dailyReportEnabled, false);
  assert.match(transport.sent[0]?.text ?? "", /19:30/);
  assert.match(transport.sent[1]?.text ?? "", /关闭/);
  assert.match(transport.sent[2]?.text ?? "", /19:30/);
});

test("sends scheduled daily report once tick condition is met", async () => {
  const dailyReportService = new FakeDailyReportService(
    async () => true,
    async () => "18:00 群聊日报\n今日消息 12 条",
  );
  const { app, transport } = createApp({
    groupConfigService: new FakeGroupConfigService([
      {
        groupId: "67890",
        currentSkillId: "assistant",
        allowedSkillIds: ["assistant"],
        switcherUserIds: ["99999"],
        liveChatUserIds: [],
        liveChatDelayMinutes: 5,
        dailyReportEnabled: true,
        dailyReportTime: "18:00",
        dailyReportTopUserCount: 3,
      },
    ]),
    dailyReportService,
  });

  await (app as unknown as { runDailyReportTick(now?: Date): Promise<void> }).runDailyReportTick(
    new Date("2026-04-15T10:00:00.000Z"),
  );

  assert.equal(transport.sent.at(-1)?.text, "18:00 群聊日报\n今日消息 12 条");
  assert.equal(dailyReportService.marked.length, 1);
});

test("manages holiday countdown settings through commands", async () => {
  const groupConfigService = new FakeGroupConfigService([
    {
      groupId: "67890",
      currentSkillId: "assistant",
      allowedSkillIds: ["assistant"],
      switcherUserIds: ["99999"],
      liveChatUserIds: [],
      liveChatDelayMinutes: 5,
      dailyReportEnabled: true,
      dailyReportTime: "18:00",
      dailyReportTopUserCount: 3,
      holidayCountdownEnabled: true,
      holidayCountdownTime: "09:00",
    },
  ]);
  const { app, transport } = createApp({ groupConfigService });

  await app.handleGroupMessage(
    createEvent([{ type: "text", data: { text: "#节假日 时间 08:30" } }], 99999),
  );
  await app.handleGroupMessage(
    createEvent([{ type: "text", data: { text: "#节假日 关闭" } }], 99999),
  );
  await app.handleGroupMessage(
    createEvent([{ type: "text", data: { text: "#节假日 状态" } }], 99999),
  );

  assert.equal(groupConfigService.groups[0]?.holidayCountdownTime, "08:30");
  assert.equal(groupConfigService.groups[0]?.holidayCountdownEnabled, false);
  assert.match(transport.sent[0]?.text ?? "", /08:30/);
  assert.match(transport.sent[1]?.text ?? "", /关闭/);
  assert.match(transport.sent[2]?.text ?? "", /节假日倒计时/);
});

test("sends scheduled holiday countdown once tick condition is met", async () => {
  const holidayCountdownService = new FakeHolidayCountdownService(
    async () => true,
    () => "节假日倒计时\n1. 劳动节：还有 16 天",
  );
  const { app, transport } = createApp({
    groupConfigService: new FakeGroupConfigService([
      {
        groupId: "67890",
        currentSkillId: "assistant",
        allowedSkillIds: ["assistant"],
        switcherUserIds: ["99999"],
        liveChatUserIds: [],
        liveChatDelayMinutes: 5,
        dailyReportEnabled: true,
        dailyReportTime: "18:00",
        dailyReportTopUserCount: 3,
        holidayCountdownEnabled: true,
        holidayCountdownTime: "09:00",
      },
    ]),
    holidayCountdownService,
  });

  await (
    app as unknown as { runHolidayCountdownTick(now?: Date): Promise<void> }
  ).runHolidayCountdownTick(new Date("2026-04-15T01:00:00.000Z"));

  assert.equal(transport.sent.at(-1)?.text, "节假日倒计时\n1. 劳动节：还有 16 天");
  assert.equal(holidayCountdownService.marked.length, 1);
});
