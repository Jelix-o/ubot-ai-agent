import assert from "node:assert/strict";
import test from "node:test";
import { parseMemeReply, memeReplyInstruction, allowsEntertainmentMeme, modelMemeTagSelector } from "./meme-reply-protocol.js";

test("meme metadata is removed, validated and never leaks from malformed or repeated markers", () => {
  assert.deepEqual(parseMemeReply("开饭啦\n[[meme:tag-happy]]"), { text: "开饭啦", memeTagId: "tag-happy" });
  assert.deepEqual(parseMemeReply("先摸鱼 [[meme:none]]"), { text: "先摸鱼" });
  assert.deepEqual(parseMemeReply("好 [[meme:!]]"), { text: "好" });
  assert.deepEqual(parseMemeReply("好 [[meme:tag-a]] [[meme:tag-b]]"), { text: "好" });
  assert.deepEqual(parseMemeReply("好 [[meme:unfinished"), { text: "好" });
  assert.deepEqual(parseMemeReply("来摸鱼 [[meme:摸鱼]]"), { text: "来摸鱼", memeTagId: "摸鱼" });
  const instruction = memeReplyInstruction([{ id: "6fef29a2-b789-4638-99d3-5c0c8a8a8db0", name: "happy", description: "开心" }]);
  assert.match(instruction, /"category":"happy"/);
  assert.doesNotMatch(instruction, /6fef29a2/);
  assert.match(instruction, /必须选一个/);
  assert.equal(modelMemeTagSelector({ id: "legacy-id", name: "表情!" }), "legacy-id");
});

test("serious help and management never attach entertainment memes", () => {
  for (const text of ["#表情 收藏 happy", "我想自杀，救救我", "帮我排查生产故障", "请不要发表情包", "管理员把他移出群"]) assert.equal(allowsEntertainmentMeme(text), false, text);
  assert.equal(allowsEntertainmentMeme("中午吃啥，好饿啊"), true);
});
