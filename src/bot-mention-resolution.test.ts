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
  MessageImageInput,
  NapcatGroupMember,
  NapcatGroupMessageEvent,
  SkillDefinition,
} from "./types.js";

class MentionTransport implements MessageTransport {
  readonly sent: Array<{ groupId: string; text: string }> = [];

  constructor(private readonly members: NapcatGroupMember[]) {}

  async sendGroupMessage(groupId: string, text: string): Promise<void> {
    this.sent.push({ groupId, text });
  }

  async sendGroupImage(): Promise<void> {
    throw new Error("not used");
  }

  async sendGroupRecord(): Promise<void> {
    throw new Error("not used");
  }

  async sendGroupAiRecord(): Promise<void> {
    throw new Error("not used");
  }

  async resolveImageInputs(images: MessageImageInput[]): Promise<MessageImageInput[]> {
    return images;
  }

  async resolveMentionTargets(_groupId: string, candidates: string[]): Promise<string[]> {
    return resolveMentionTargetsFromMembers(this.members, candidates);
  }
}

class StaticGroupConfigService {
  constructor(private readonly group: GroupBotConfig) {}

  async getGroup(groupId: string): Promise<GroupBotConfig | undefined> {
    return groupId === this.group.groupId ? { ...this.group } : undefined;
  }

  async getAll(): Promise<GroupBotConfig[]> {
    return [{ ...this.group }];
  }

  async updateCurrentSkill(): Promise<GroupBotConfig> {
    return { ...this.group };
  }

  async addLiveChatUser(): Promise<GroupBotConfig> {
    return { ...this.group };
  }

  async removeLiveChatUser(): Promise<GroupBotConfig> {
    return { ...this.group };
  }

  async updateLiveChatDelay(): Promise<GroupBotConfig> {
    return { ...this.group };
  }

  async updateDailyReportEnabled(): Promise<GroupBotConfig> {
    return { ...this.group };
  }

  async updateDailyReportTime(): Promise<GroupBotConfig> {
    return { ...this.group };
  }

  async updateHolidayCountdownEnabled(): Promise<GroupBotConfig> {
    return { ...this.group };
  }

  async updateHolidayCountdownTime(): Promise<GroupBotConfig> {
    return { ...this.group };
  }

  async getSuperAdminUserIds(): Promise<string[]> {
    return [];
  }

  async isSuperAdmin(): Promise<boolean> {
    return false;
  }

  async addAdminUser(): Promise<GroupBotConfig> {
    return { ...this.group };
  }

  async removeAdminUser(): Promise<GroupBotConfig> {
    return { ...this.group };
  }
}

class StaticSkillService {
  constructor(private readonly skill: SkillDefinition) {}

  async getSkill(skillId: string): Promise<SkillDefinition | undefined> {
    return skillId === this.skill.id ? this.skill : undefined;
  }
}

class MemoryConversationStore {
  async getTurns(): Promise<ConversationTurn[]> {
    return [];
  }

  async appendDialogue(): Promise<void> {}

  async clearUser(): Promise<void> {}

  async clearGroup(): Promise<void> {}
}

class StaticAiService {
  constructor(private readonly text: string) {}

  async generateReply(): Promise<AiReply> {
    return {
      text: this.text,
      model: "test-model",
      skillId: "assistant",
    };
  }
}

class UnusedTtsService {
  async synthesize(): Promise<never> {
    throw new Error("not used");
  }
}

class DummyDailyReportService {
  async recordMessage(): Promise<void> {}
  async shouldSendScheduledReport(): Promise<boolean> {
    return false;
  }
  async buildReport(): Promise<string> {
    return "日报";
  }
  async markSent(): Promise<void> {}
}

class DummyHolidayCountdownService {
  async shouldSendScheduledMessage(): Promise<boolean> {
    return false;
  }
  buildCountdownMessage(): string {
    return "节假日倒计时";
  }
  async markSent(): Promise<void> {}
}

class DummyScheduledReminderService {
  parseCreateRequest(): undefined {
    return undefined;
  }
  async getDueTasks(): Promise<[]> {
    return [];
  }
}

class DummyAdminOperationLogService {
  async record(): Promise<void> {}
  async listRecent(): Promise<[]> {
    return [];
  }
}

const skill: SkillDefinition = {
  id: "assistant",
  name: "assistant",
  systemPrompt: "You are a helpful assistant",
  styleRules: ["brief"],
  knowledge: [],
  temperature: 0.7,
  maxContextTurns: 12,
};

function createApp(replyText: string, members: NapcatGroupMember[]): {
  app: BotApplication;
  transport: MentionTransport;
} {
  const transport = new MentionTransport(members);
  const app = new BotApplication(
    transport,
    new StaticGroupConfigService({
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
    }) as never,
    new StaticSkillService(skill) as never,
    new MemoryConversationStore() as never,
    new StaticAiService(replyText) as never,
    new UnusedTtsService() as never,
    new DummyDailyReportService() as never,
    new DummyHolidayCountdownService() as never,
    new DummyScheduledReminderService() as never,
    new DummyAdminOperationLogService() as never,
    new GroupLock(),
    new LiveChatService(),
    "12345",
    false,
  );

  return { app, transport };
}

function createEvent(text: string): NapcatGroupMessageEvent {
  return {
    post_type: "message",
    message_type: "group",
    self_id: 12345,
    group_id: 67890,
    user_id: 20001,
    message_id: 1,
    raw_message: text,
    message: [
      { type: "at", data: { qq: "12345" } },
      { type: "text", data: { text } },
    ],
    sender: {
      user_id: 20001,
      nickname: "Tester",
      card: "测试同学",
      role: "member",
    },
  };
}

test("does not at typed qq numbers in explicit bot conversations", async () => {
  const { app, transport } = createApp("收到，我去说", [
    { user_id: 55667788, nickname: "老张", card: "张三" },
  ]);

  await app.handleGroupMessage(createEvent(" 你和 55667788 说一声晚上开会 "));

  assert.equal(transport.sent[0]?.text, "收到，我去说");
});

test("does not at plain-text nicknames in explicit bot conversations", async () => {
  const { app, transport } = createApp("好，我去提醒他", [
    { user_id: 55667788, nickname: "老张", card: "张三" },
  ]);

  await app.handleGroupMessage(createEvent(" @老张 你跟他说别迟到 "));

  assert.equal(transport.sent[0]?.text, "好，我去提醒他");
});

test("does not at plain-text group cards in explicit bot conversations", async () => {
  const { app, transport } = createApp("收到，我去转达", [
    { user_id: 67890, nickname: "小王", card: "项目经理" },
  ]);

  await app.handleGroupMessage(createEvent(" @项目经理 你和他说今晚收尾 "));

  assert.equal(transport.sent[0]?.text, "收到，我去转达");
});

test("does not at unresolved names", async () => {
  const { app, transport } = createApp("我先记下了", [
    { user_id: 67890, nickname: "小王", card: "项目经理" },
  ]);

  await app.handleGroupMessage(createEvent(" @外星人 你和他说快上线 "));

  assert.equal(transport.sent[0]?.text, "我先记下了");
});
