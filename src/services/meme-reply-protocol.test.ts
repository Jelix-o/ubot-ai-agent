import assert from "node:assert/strict";
import test from "node:test";
import { parseMemeReply, memeReplyInstruction, allowsEntertainmentMeme } from "./meme-reply-protocol.js";

test("meme metadata is removed, validated and never leaks from malformed or repeated markers", () => {
  assert.deepEqual(parseMemeReply("开饭啦\n[[meme:tag-happy]]"), { text: "开饭啦", memeTagId: "tag-happy" });
  assert.deepEqual(parseMemeReply("先摸鱼 [[meme:none]]"), { text: "先摸鱼" });
  assert.deepEqual(parseMemeReply("好 [[meme:x]]"), { text: "好" });
  assert.deepEqual(parseMemeReply("好 [[meme:tag-a]] [[meme:tag-b]]"), { text: "好" });
  assert.deepEqual(parseMemeReply("好 [[meme:unfinished"), { text: "好" });
  assert.ok(memeReplyInstruction([{ id: "tag-happy", name: "happy", description: "开心" }]).includes("tag-happy"));
});

test("serious help and management never attach entertainment memes", () => {
  for (const text of ["#表情 收藏 happy", "我想自杀，救救我", "帮我排查生产故障", "请不要发表情包", "管理员把他移出群"]) assert.equal(allowsEntertainmentMeme(text), false, text);
  assert.equal(allowsEntertainmentMeme("中午吃啥，好饿啊"), true);
});
