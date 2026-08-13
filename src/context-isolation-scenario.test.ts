import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildChatMessages } from "./services/ai-service.js";
import { ConversationContextRepository } from "./services/conversation-context-repository.js";
import { ConversationContextRouter } from "./services/conversation-context-router.js";
import { SharedDb } from "./shared/sqlite.js";
import type { ConversationTurn, SkillDefinition } from "./types.js";

test("screenshot scenario keeps marriage, company, and image conversations isolated", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "huixian-screenshot-context-"));
  const db = new SharedDb(path.join(dir, "bot-shared.db"));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const repository = new ConversationContextRepository(db);
  const router = new ConversationContextRouter(repository);
  const route = (sourceRowId: number, sourceMessageId: string, text: string, nowMs: number, options: {
    replyToMessageId?: string;
    hasImages?: boolean;
  } = {}) => router.resolve({
    sourceRowId,
    groupId: "group",
    userId: "same-user",
    sourceMessageId,
    text,
    nowMs,
    ...options,
  });

  const marriage = route(1, "marriage-user", "结婚和离婚数据怎么看", 1_000);
  const marriageAnswer = repository.appendAssistantTurn({
    topicId: marriage.topicId,
    branchId: marriage.branchId,
    parentTurnId: marriage.turnId,
    content: "婚姻数据回答",
    createdAt: 1_100,
  });
  repository.bindPlatformMessage({
    groupId: "group",
    platformMessageId: "marriage-bot",
    topicId: marriage.topicId,
    branchId: marriage.branchId,
    turnId: marriageAnswer.id,
    direction: "assistant",
    createdAt: 1_100,
  });

  const company = route(2, "company-user", "武汉公司是哪一家", 2_000);
  const companyAnswer = repository.appendAssistantTurn({
    topicId: company.topicId,
    branchId: company.branchId,
    parentTurnId: company.turnId,
    content: "公司信息回答",
    createdAt: 2_100,
  });
  repository.bindPlatformMessage({
    groupId: "group",
    platformMessageId: "company-bot",
    topicId: company.topicId,
    branchId: company.branchId,
    turnId: companyAnswer.id,
    direction: "assistant",
    createdAt: 2_100,
  });

  const image = route(3, "image-user", "", 3_000, { hasImages: true });
  const imageAnswer = repository.appendAssistantTurn({
    topicId: image.topicId,
    branchId: image.branchId,
    parentTurnId: image.turnId,
    content: "图片道具分析回答",
    createdAt: 3_100,
  });
  repository.bindPlatformMessage({
    groupId: "group",
    platformMessageId: "image-bot",
    topicId: image.topicId,
    branchId: image.branchId,
    turnId: imageAnswer.id,
    direction: "assistant",
    createdAt: 3_100,
  });

  const quotedImage = route(4, "image-follow-up", "你这个？", 3_200, {
    replyToMessageId: "image-bot",
  });
  const promptHistory = repository
    .getCausalTurnsBeforeTurn(quotedImage.branchId, quotedImage.turnId)
    .map((turn) => turn.content)
    .join("\n");
  const history: ConversationTurn[] = repository
    .getCausalTurnsBeforeTurn(quotedImage.branchId, quotedImage.turnId)
    .map((turn) => ({
      groupId: "group",
      role: turn.role,
      content: turn.content,
      ...(turn.userId ? { userId: turn.userId } : {}),
      timestamp: new Date(turn.createdAt).toISOString(),
    }));
  const skill: SkillDefinition = {
    id: "huixian",
    name: "会仙",
    systemPrompt: "只依据传入上下文回答",
    styleRules: [],
    knowledge: [],
    temperature: 0.5,
    maxContextTurns: 16,
  };
  const modelMessages = buildChatMessages(skill, history, "你这个？");
  const serializedPrompt = modelMessages.map((message) => String(message.content)).join("\n");

  assert.match(promptHistory, /图片道具分析回答/);
  assert.doesNotMatch(promptHistory, /婚姻|公司/);
  assert.match(serializedPrompt, /图片道具分析回答/);
  assert.doesNotMatch(serializedPrompt, /婚姻数据回答|公司信息回答/);
  assert.notEqual(marriage.branchId, company.branchId);
  assert.notEqual(company.branchId, image.branchId);
});
