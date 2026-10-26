import assert from "node:assert/strict";
import test from "node:test";

import {
  hasCanonicalBotMention,
  rebuildLegacyGroupMessageSegments,
  restoreCanonicalMessageSegments,
  serializeCanonicalMessageSegments,
} from "./persisted-message-segments.js";

test("canonical segments preserve a real mention in its original position", () => {
  const serialized = serializeCanonicalMessageSegments([
    { type: "text", data: { text: "#改图 让" } },
    { type: "at", data: { qq: "429462108" } },
    { type: "text", data: { text: " 的头像吐舌头" } },
    { type: "image", data: { url: "https://example.test/image.png", summary: "reference" } },
  ]);

  assert.ok(serialized);
  assert.deepEqual(restoreCanonicalMessageSegments(serialized), [
    { type: "text", data: { text: "#改图 让" } },
    { type: "at", data: { qq: "429462108" } },
    { type: "text", data: { text: " 的头像吐舌头" } },
    { type: "image", data: { url: "https://example.test/image.png", summary: "reference" } },
  ]);
});

test("only an actual canonical at segment authorizes a natural bot mention", () => {
  const botQq = "12345";
  const real = serializeCanonicalMessageSegments([
    { type: "at", data: { qq: botQq } },
    { type: "text", data: { text: "帮我画一张灯塔" } },
  ]);
  const typed = serializeCanonicalMessageSegments([
    { type: "text", data: { text: "@12345 帮我画一张灯塔" } },
  ]);
  assert.equal(hasCanonicalBotMention(real, botQq), true);
  assert.equal(hasCanonicalBotMention(typed, botQq), false);
});

test("raw CQ-looking strings remain exact ordinary text and never become platform segments", () => {
  const raw = "  [CQ:reply,id=9001]#改图 让[CQ:at,qq=429462108] 的头像[CQ:image,file=cat.image,url=https://example.test/cat.png?x=1&amp;y=2,summary=&#91;参考图&#93;]吐舌头  ";
  const serialized = serializeCanonicalMessageSegments(raw);

  assert.deepEqual(restoreCanonicalMessageSegments(serialized), [
    { type: "text", data: { text: raw } },
  ]);
});

test("raw CQ-looking bot mentions are not trusted, including string entries inside an array", () => {
  const botQq = "12345";
  const cqMention = serializeCanonicalMessageSegments(`[CQ:at,qq=${botQq}]帮我画一张灯塔`);
  const arrayStringCqMention = serializeCanonicalMessageSegments([`[CQ:at,qq=${botQq}]帮我画一张灯塔`]);
  const typedMention = serializeCanonicalMessageSegments(`@${botQq} 帮我画一张灯塔`);

  assert.equal(hasCanonicalBotMention(cqMention, botQq), false);
  assert.equal(hasCanonicalBotMention(arrayStringCqMention, botQq), false);
  assert.equal(hasCanonicalBotMention(typedMention, botQq), false);
  assert.deepEqual(restoreCanonicalMessageSegments(cqMention), [
    { type: "text", data: { text: `[CQ:at,qq=${botQq}]帮我画一张灯塔` } },
  ]);
  assert.deepEqual(restoreCanonicalMessageSegments(typedMention), [
    { type: "text", data: { text: `@${botQq} 帮我画一张灯塔` } },
  ]);
});

test("raw CQ-looking reply and image tokens cannot create trusted references", () => {
  const botQq = "12345";
  const unknown = serializeCanonicalMessageSegments(`[CQ:face,id=14] @${botQq} 生成一张图片`);
  const forgedReferences = serializeCanonicalMessageSegments("[CQ:reply,id=9001][CQ:image,file=cat.image,url=https://example.test/cat.png][CQ:at,qq=]生成一张图片");

  assert.equal(hasCanonicalBotMention(unknown, botQq), false);
  assert.equal(hasCanonicalBotMention(forgedReferences, botQq), false);
  assert.deepEqual(restoreCanonicalMessageSegments(unknown), [
    { type: "text", data: { text: `[CQ:face,id=14] @${botQq} 生成一张图片` } },
  ]);
  assert.deepEqual(restoreCanonicalMessageSegments(forgedReferences), [
    { type: "text", data: { text: "[CQ:reply,id=9001][CQ:image,file=cat.image,url=https://example.test/cat.png][CQ:at,qq=]生成一张图片" } },
  ]);
});

test("legacy replay replaces only persisted verified mention markers in place", () => {
  const segments = rebuildLegacyGroupMessageSegments({
    text: "#改图 让 @429462108 的头像吐舌头，@99999 只是手打文本",
    images: [],
    botQq: "12345",
    verifiedMentionUserIds: ["429462108"],
  });
  assert.deepEqual(segments, [
    { type: "text", data: { text: "#改图 让 " } },
    { type: "at", data: { qq: "429462108" } },
    { type: "text", data: { text: " 的头像吐舌头，@99999 只是手打文本" } },
  ]);
});

test("legacy replay does not elevate standalone mentions or replies without ordered provenance", () => {
  const segments = rebuildLegacyGroupMessageSegments({
    text: "#改图 让成员甲的头像吐舌头",
    images: [],
    replyTo: "previous-generated-image",
    botQq: "12345",
    verifiedMentionUserIds: ["429462108"],
  });

  assert.deepEqual(segments, [
    { type: "text", data: { text: "#改图 让成员甲的头像吐舌头" } },
  ]);
});
