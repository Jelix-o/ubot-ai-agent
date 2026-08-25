import test from "node:test";
import assert from "node:assert/strict";

import { parseGroupMessage } from "./message-parser.js";

test("parseGroupMessage extracts reply segment ids without changing trigger rules", () => {
  const result = parseGroupMessage(
    [
      { type: "reply", data: { id: "987654" } },
      { type: "text", data: { text: " referenced only " } },
    ],
    "12345",
  );

  assert.equal(result.hasAtBot, false);
  assert.equal(result.text, "referenced only");
  assert.equal(result.replyMessageId, "987654");
});

test("parseGroupMessage extracts CQ reply ids from string messages", () => {
  const result = parseGroupMessage("[CQ:reply,id=987654][CQ:at,qq=12345] hello", "12345");

  assert.equal(result.hasAtBot, true);
  assert.equal(result.text, "hello");
  assert.equal(result.replyMessageId, "987654");
  assert.deepEqual(result.verifiedMentionUserIds, []);
  assert.deepEqual(result.plainTextMentionCandidates, []);
});

test("parseGroupMessage extracts text when bot is mentioned", () => {
  const result = parseGroupMessage(
    [
      { type: "at", data: { qq: "12345" } },
      { type: "text", data: { text: " 你好，帮我总结一下 " } },
    ],
    "12345",
  );

  assert.equal(result.hasAtBot, true);
  assert.equal(result.text, "你好，帮我总结一下");
  assert.deepEqual(result.verifiedMentionUserIds, []);
});

test("parseGroupMessage ignores text when bot is not mentioned", () => {
  const result = parseGroupMessage(
    [{ type: "text", data: { text: "普通群消息" } }],
    "12345",
  );

  assert.equal(result.hasAtBot, false);
  assert.equal(result.text, "普通群消息");
  assert.deepEqual(result.verifiedMentionUserIds, []);
});

test("parseGroupMessage handles numeric at qq", () => {
  const result = parseGroupMessage(
    [
      { type: "at", data: ({ qq: 12345 } as unknown as Record<string, string>) },
      { type: "text", data: { text: " test number qq " } },
    ],
    "12345",
  );

  assert.equal(result.hasAtBot, true);
  assert.equal(result.text, "test number qq");
  assert.deepEqual(result.verifiedMentionUserIds, []);
});

test("parseGroupMessage handles CQ at string format", () => {
  const result = parseGroupMessage("[CQ:at,qq=12345] hello world", "12345");

  assert.equal(result.hasAtBot, true);
  assert.equal(result.text, "hello world");
  assert.deepEqual(result.images, []);
  assert.deepEqual(result.verifiedMentionUserIds, []);
});

test("parseGroupMessage extracts image urls", () => {
  const result = parseGroupMessage(
    [
      { type: "at", data: { qq: "12345" } },
      { type: "image", data: { url: "https://example.com/test.png" } },
      { type: "text", data: { text: "这图是啥" } },
    ],
    "12345",
  );

  assert.equal(result.hasAtBot, true);
  assert.equal(result.text, "这图是啥");
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0]?.url, "https://example.com/test.png");
  assert.deepEqual(result.verifiedMentionUserIds, []);
});

test("parseGroupMessage keeps image file identifiers when url is absent", () => {
  const result = parseGroupMessage(
    [
      { type: "at", data: { qq: "12345" } },
      { type: "image", data: { file: "7f0000011234567890.image", summary: "[图片]" } },
    ],
    "12345",
  );

  assert.equal(result.hasAtBot, true);
  assert.equal(result.text, "");
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0]?.file, "7f0000011234567890.image");
  assert.equal(result.images[0]?.summary, "[图片]");
  assert.deepEqual(result.verifiedMentionUserIds, []);
});

test("parseGroupMessage keeps non-bot mentions as text and targets", () => {
  const result = parseGroupMessage(
    [
      { type: "at", data: { qq: "12345" } },
      { type: "at", data: { qq: "67890" } },
      { type: "text", data: { text: " 你去和他说一下 " } },
    ],
    "12345",
  );

  assert.equal(result.hasAtBot, true);
  assert.equal(result.text, "@67890 你去和他说一下");
  assert.deepEqual(result.verifiedMentionUserIds, ["67890"]);
  assert.deepEqual(result.plainTextMentionCandidates, []);
});

test("parseGroupMessage keeps plain-text QQ numbers separate from verified targets", () => {
  const result = parseGroupMessage("[CQ:at,qq=12345] 你去和 67890 还有 55667788 说一声", "12345");

  assert.equal(result.hasAtBot, true);
  assert.equal(result.text, "你去和 67890 还有 55667788 说一声");
  assert.deepEqual(result.verifiedMentionUserIds, []);
  assert.deepEqual(result.plainTextMentionCandidates, ["67890", "55667788"]);
});

test("parseGroupMessage identifies non-bot CQ at segments as verified targets", () => {
  const result = parseGroupMessage("[CQ:at,qq=12345][CQ:at,qq=67890] 请提醒他", "12345");

  assert.equal(result.hasAtBot, true);
  assert.equal(result.text, "@67890 请提醒他");
  assert.deepEqual(result.verifiedMentionUserIds, ["67890"]);
  assert.deepEqual(result.plainTextMentionCandidates, []);
});
