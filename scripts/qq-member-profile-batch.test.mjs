import assert from "node:assert/strict";
import test from "node:test";

import {
  buildEvidencePacket,
  buildManifest,
  extractOwnText,
  formatPerth,
  parseCsv,
  renderProfile,
  sanitizeText,
  selectStratified,
  validateProfile,
} from "./qq-member-profile-batch.mjs";
import { validateManifest } from "./import-qq-profile-memories.mjs";

function makeRecord(overrides = {}) {
  const messages = overrides.messages ?? [{
    id: "m1", groupId: "735653114", groupName: "测试群", timestamp: Date.parse("2026-09-01T00:00:00Z"),
    type: "text", recalled: false, name: "测试者", nickname: "测试者", text: "先看结论", safeText: "先看结论", resources: [],
  }];
  return {
    qq: "123456789",
    currentNickname: "测试者",
    historicalNames: ["测试者"],
    membershipGroups: ["735653114"],
    messages,
    usableMessages: messages,
    sampledMessages: messages,
    totalMessages: messages.length,
    usableTextCount: messages.length,
    recalledCount: 0,
    groupCounts: { "735653114": messages.length },
    mediaCounts: {},
    typeCounts: { text: messages.length },
    firstAt: messages[0]?.timestamp,
    lastAt: messages.at(-1)?.timestamp,
    tier: messages.length === 0 ? "0" : messages.length < 10 ? "1-9" : messages.length < 50 ? "10-49" : "50+",
    expectedConfidence: messages.length < 10 ? "低" : messages.length < 50 ? "中低" : "高",
    groupLabels: ["测试群"],
    knownQq: ["123456789", "987654321"],
    ...overrides,
  };
}

test("CSV parser preserves quoted fields and QQ strings", () => {
  const rows = parseCsv("group_id,qq,note\r\n735653114,00123,\"a,b\"\r\n");
  assert.deepEqual(rows, [{ group_id: "735653114", qq: "00123", note: "a,b" }]);
});

test("reply extraction excludes quoted content and keeps the new reply", () => {
  const text = extractOwnText({
    type: "reply",
    content: { elements: [
      { type: "reply", data: { content: "别人的旧话" } },
      { type: "at", data: { name: "群友" } },
      { type: "text", data: { text: " 我只回应这一句" } },
    ] },
  });
  assert.equal(text, "@群友 我只回应这一句");
  assert.equal(extractOwnText({ type: "text", recalled: true, content: { text: "已撤回" } }), "");
  assert.equal(extractOwnText({ type: "text", content: { text: "[图片:a.jpg]", elements: [{ type: "image", data: {} }] } }), "");
  assert.equal(extractOwnText({ type: "forward", content: { text: "他人转发观点" } }), "");
});

test("sanitization keeps only the target QQ and removes direct identifiers", () => {
  const sanitized = sanitizeText("目标 123456789 他人 987654321 电话 13800138000 https://example.com", "123456789");
  assert.match(sanitized, /123456789/u);
  assert.doesNotMatch(sanitized, /987654321|13800138000|https:\/\//u);
});

test("Perth formatter applies UTC+8", () => {
  assert.equal(formatPerth(Date.parse("2026-09-01T16:30:00Z")), "2026-09-02 00:30");
});

test("stratified selection is deterministic and bounded", () => {
  const messages = Array.from({ length: 900 }, (_, index) => ({
    id: `m${index}`, groupId: index % 2 ? "1" : "2", timestamp: Date.parse("2025-01-01T00:00:00Z") + index * 86400000,
    type: index % 3 ? "text" : "reply",
  }));
  const first = selectStratified(messages, 800);
  const second = selectStratified(messages, 800);
  assert.equal(first.length, 800);
  assert.deepEqual(first.map((item) => item.id), second.map((item) => item.id));
  assert.deepEqual(new Set(first.map((item) => item.groupId)), new Set(["1", "2"]));
});

test("zero-message profile has all sections and no invented traits", () => {
  const record = makeRecord({ messages: [], usableMessages: [], sampledMessages: [], totalMessages: 0, usableTextCount: 0, groupCounts: {}, typeCounts: {}, firstAt: undefined, lastAt: undefined, tier: "0", expectedConfidence: "低" });
  const content = renderProfile(record, {});
  assert.equal(validateProfile(record, content).length, 0);
  assert.match(content, /无可分析记录/u);
  assert.doesNotMatch(content, /QQ：|数据概况/u);
  assert.ok(content.length <= 1800);
});

test("rendered nonzero profile is a metadata-free neutral description", () => {
  const record = makeRecord();
  const packet = buildEvidencePacket(record);
  assert.equal(packet.sampledMessages[0].id, "m1");
  const content = renderProfile(record, { description: "从现有发言能确认的是，他倾向使用短句直接回应当前问题，表达重点通常放在当下任务。由于可确认内容有限，不适合据此概括稳定性格。与其交流时可直接回答，并明确区分事实与推测，不额外补充未经确认的背景。" });
  assert.equal(validateProfile(record, content).length, 0);
  assert.doesNotMatch(content, /QQ：|昵称|数据概况|消息总数/u);
  assert.ok(content.length <= 1800);
});

test("manifest contains three identical enabled copies for every nonzero member", async () => {
  const records = Array.from({ length: 76 }, (_, index) => makeRecord({ qq: String(100000000 + index) }));
  const description = "从现有发言能确认的是，他倾向使用短句直接回应当前问题，表达重点通常放在当下任务。由于可确认内容有限，不适合据此概括稳定性格。与其交流时可直接回答，并明确区分事实与推测，不额外补充未经确认的背景。";
  const contents = new Map(records.map((record) => [record.qq, renderProfile(record, { description })]));
  const manifest = buildManifest(records, contents);
  assert.equal(manifest.memories.length, 228);
  assert.deepEqual(await validateManifest(manifest), []);
  for (const record of records) {
    const copies = manifest.memories.filter((memory) => memory.subjectUserId === record.qq);
    assert.equal(copies.length, 3);
    assert.equal(new Set(copies.map((memory) => memory.contentSha256)).size, 1);
    assert.ok(copies.every((memory) => memory.enabled && memory.source === "admin"));
  }
});
