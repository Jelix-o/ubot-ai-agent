import assert from "node:assert/strict";
import test from "node:test";

import type { ParsedGroupMessage } from "../utils/message-parser.js";
import {
  parseNaturalImageRequest,
  type NaturalImageRequestInput,
} from "./natural-image-request.js";

const IMAGE = { url: "https://example.test/reference.png" };

function parsed(text: string, options: Partial<ParsedGroupMessage> = {}): ParsedGroupMessage {
  return {
    hasAtBot: false,
    text,
    images: [],
    verifiedMentionUserIds: [],
    plainTextMentionCandidates: [],
    ...options,
  };
}

function request(
  text: string,
  options: Partial<NaturalImageRequestInput> = {},
) {
  return parseNaturalImageRequest({
    message: parsed(text),
    hasTrustedBotMention: false,
    hasTrustedReply: false,
    replyIsGeneratedImage: false,
    ...options,
  });
}

test("natural generation requires a caller-verified real bot mention", () => {
  const message = parsed("生成一张雨后城市", { hasAtBot: true });
  assert.equal(parseNaturalImageRequest({
    message,
    hasTrustedBotMention: false,
    hasTrustedReply: false,
    replyIsGeneratedImage: false,
  }), undefined, "legacy or textual @ facts must not authorize generation");

  assert.deepEqual(parseNaturalImageRequest({
    message,
    hasTrustedBotMention: true,
    hasTrustedReply: false,
    replyIsGeneratedImage: false,
  }), {
    kind: "generate",
    prompt: "雨后城市",
  });
});

test("natural generation recognizes a bounded imperative and supported ratio", () => {
  assert.deepEqual(request("帮我画一张 9:16の縦長 夜晚的城市", {
    hasTrustedBotMention: true,
  }), {
    kind: "generate",
    prompt: "9:16の縦長 夜晚的城市",
    size: "864x1536",
  });
  assert.deepEqual(request("生成一张 --比例 16:9 湖边日落", {
    hasTrustedBotMention: true,
  }), {
    kind: "generate",
    prompt: "湖边日落",
    size: "1536x864",
  });
  assert.deepEqual(request("生成一张产品说明书封面", {
    hasTrustedBotMention: true,
  }), {
    kind: "generate",
    prompt: "产品说明书封面",
  });
  assert.deepEqual(request("生成一张新手教程海报", {
    hasTrustedBotMention: true,
  }), {
    kind: "generate",
    prompt: "新手教程海报",
  });
});

test("ordinary @bot requests with generic verbs do not consume image generation", () => {
  for (const text of ["帮我做一个表格", "创建一个日程", "来一个笑话"]) {
    assert.equal(request(text, { hasTrustedBotMention: true }), undefined, text);
  }

  assert.deepEqual(request("帮我制作一张海报 夏日音乐节", {
    hasTrustedBotMention: true,
  }), {
    kind: "generate",
    prompt: "夏日音乐节",
  });
});

test("attached image generation wording asks for an explicit edit instead", () => {
  assert.deepEqual(request("生成一张海边照片", {
    hasTrustedBotMention: true,
    message: parsed("生成一张海边照片", { images: [IMAGE] }),
  }), {
    kind: "clarification",
    reason: "reference_requires_edit_instruction",
  });

  assert.deepEqual(request("把天空改成晚霞", {
    hasTrustedBotMention: true,
    message: parsed("把天空改成晚霞", { images: [IMAGE] }),
  }), {
    kind: "edit",
    prompt: "把天空改成晚霞",
    referenceSource: "attachment",
  });
});

test("natural edits need a trusted mention or a confirmed generated-image reply", () => {
  assert.equal(request("把天空改成晚霞", {
    message: parsed("把天空改成晚霞", { images: [IMAGE] }),
  }), undefined);

  assert.deepEqual(request("把天空改成晚霞", {
    hasTrustedBotMention: true,
  }), {
    kind: "clarification",
    reason: "missing_reference",
  });

  const reply = parsed("再加一只飞鸟", { replyMessageId: "generated-1" });
  assert.equal(parseNaturalImageRequest({
    message: reply,
    hasTrustedBotMention: false,
    hasTrustedReply: true,
    replyIsGeneratedImage: false,
  }), undefined);
  assert.deepEqual(parseNaturalImageRequest({
    message: reply,
    hasTrustedBotMention: false,
    hasTrustedReply: true,
    replyIsGeneratedImage: true,
  }), {
    kind: "edit",
    prompt: "再加一只飞鸟",
    referenceSource: "reply",
  });
});

test("a real direct mention may edit a trusted ordinary reply, while reply-only editing stays generated-output-only", () => {
  const reply = parsed("把天空改成晚霞", { replyMessageId: "ordinary-group-image" });
  assert.deepEqual(parseNaturalImageRequest({
    message: reply,
    hasTrustedBotMention: true,
    hasTrustedReply: true,
    replyIsGeneratedImage: false,
  }), {
    kind: "edit",
    prompt: "把天空改成晚霞",
    referenceSource: "reply",
  });
  assert.equal(parseNaturalImageRequest({
    message: reply,
    hasTrustedBotMention: false,
    hasTrustedReply: true,
    replyIsGeneratedImage: false,
  }), undefined);
});

test("natural avatar editing is direct-mention only and keeps target resolution outside the parser", () => {
  const message = parsed("让@40001的头像吐舌头", { verifiedMentionUserIds: ["40001"] });
  assert.equal(parseNaturalImageRequest({
    message,
    hasTrustedBotMention: false,
    hasTrustedReply: false,
    replyIsGeneratedImage: true,
  }), undefined);
  assert.deepEqual(parseNaturalImageRequest({
    message,
    hasTrustedBotMention: true,
    hasTrustedReply: false,
    replyIsGeneratedImage: false,
  }), {
    kind: "avatar_edit",
    request: { targetText: "@40001", action: "吐舌头", hasExplicitAvatarWord: true },
    prompt: "吐舌头",
  });
});

test("questions, explicit negative requests, commands, and ordinary chat do not become image work", () => {
  for (const text of [
    "能帮我画一张海报吗？",
    "帮我画一张风景可以吗",
    "给我画张图好吗",
    "怎么改图",
    "画一张图的教程",
    "画得真好看",
    "这张图能不能改成晚霞",
    "不要生成图片",
    "不需要生成图片",
    "#生图 山水",
    "我喜欢这张图的配色",
  ]) {
    assert.equal(request(text, {
      hasTrustedBotMention: true,
      message: parsed(text, { images: [IMAGE], replyMessageId: "generated-1" }),
      replyIsGeneratedImage: true,
    }), undefined, text);
  }
  assert.equal(request("画一张山水", {
    hasTrustedBotMention: true,
    isExplicitCommand: true,
  }), undefined);
});

test("direct image-like but incomplete requests receive a controlled clarification", () => {
  assert.deepEqual(request("", { hasTrustedBotMention: true }), {
    kind: "clarification",
    reason: "unrecognized_intent",
  });
  assert.deepEqual(request("生成一张", { hasTrustedBotMention: true }), {
    kind: "clarification",
    reason: "missing_prompt",
  });
  assert.deepEqual(request("让成员甲头像", { hasTrustedBotMention: true }), {
    kind: "clarification",
    reason: "avatar_syntax",
  });
  assert.deepEqual(request("帮我生图", { hasTrustedBotMention: true }), {
    kind: "clarification",
    reason: "unrecognized_intent",
  });
  assert.deepEqual(request("生成一张 --比例 4:5 风景", { hasTrustedBotMention: true }), {
    kind: "clarification",
    reason: "invalid_ratio",
  });
});
