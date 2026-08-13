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
  turns: ConversationTurn[] = [];

  async getTurns(): Promise<ConversationTurn[]> {
    return [];
  }

  async appendDialogue(_groupId: string, _userId: string, turns: ConversationTurn[]): Promise<void> {
    this.turns.push(...turns);
  }

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

test("strips third-party mention echoes when explicit bot conversations do not at them", async () => {
  const transport = new MentionTransport([
    { user_id: 2236352543, nickname: "季博常", card: "季博常" },
  ]);
  const conversationStore = new MemoryConversationStore();
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
    conversationStore as never,
    new StaticAiService("@2236352543 这B 晚上怎么说 一起洗脚去 别装死") as never,
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

  await app.handleGroupMessage(createEvent(" @一下 2236352543 ，让他今晚一起去洗脚 "));

  assert.equal(transport.sent[0]?.text, "2236352543 这B 晚上怎么说 一起洗脚去 别装死");
  assert.deepEqual(conversationStore.turns, []);
});
