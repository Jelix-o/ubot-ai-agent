import assert from "node:assert/strict";
import test from "node:test";

import type { MessageSegment } from "../types.js";
import { imageIntentText, restoreImageIntentTarget } from "./image-intent-text.js";

test("image intent text hides URLs and carries real mention targets as opaque source markers", () => {
  const segments: MessageSegment[] = [
    { type: "at", data: { qq: "12345" } },
    { type: "text", data: { text: " 用" } },
    { type: "at", data: { qq: "54321" } },
    { type: "text", data: { text: "的头像加顶帽子，参考 https://example.test/a.png，编号 998877" } },
  ];

  const result = imageIntentText(segments, "12345");

  assert.equal(
    result.text,
    "[BOT_MENTION] 用[MEMBER_MENTION_1]的头像加顶帽子，参考 [URL]，编号 [NUMBER_1]",
  );
  assert.equal(restoreImageIntentTarget("[MEMBER_MENTION_1]", result.targets), "@54321");
  assert.equal(restoreImageIntentTarget("[NUMBER_1]", result.targets), "998877");
  assert.equal(restoreImageIntentTarget("我本人", result.targets), "我");
  assert.equal(restoreImageIntentTarget("[MEMBER_MENTION_2]", result.targets), undefined);
  assert.equal(restoreImageIntentTarget("[URL]", result.targets), undefined);
});

test("target markers stay bound to one source across pending messages", () => {
  const first = imageIntentText([{ type: "at", data: { qq: "54321" } }], "12345", 1);
  const second = imageIntentText([{ type: "at", data: { qq: "67890" } }], "12345", 2);
  assert.equal(first.text, "[MEMBER_MENTION_S1_1]");
  assert.equal(second.text, "[MEMBER_MENTION_S2_1]");
  assert.equal(restoreImageIntentTarget(first.text, second.targets), undefined);
  assert.equal(restoreImageIntentTarget(first.text, first.targets), "@54321");
});
