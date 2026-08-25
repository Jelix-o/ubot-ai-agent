import assert from "node:assert/strict";
import test from "node:test";

import { parseGroupMessage } from "./message-parser.js";

test("keeps plain-text nickname mentions separate from verified targets", () => {
  const parsed = parseGroupMessage("[CQ:at,qq=12345] @老张 你去提醒他", "12345");

  assert.equal(parsed.hasAtBot, true);
  assert.equal(parsed.text, "@老张 你去提醒他");
  assert.deepEqual(parsed.verifiedMentionUserIds, []);
  assert.deepEqual(parsed.plainTextMentionCandidates, ["老张"]);
});

test("keeps QQ numbers and plain-text names in non-authorizing candidates", () => {
  const parsed = parseGroupMessage(
    [
      { type: "at", data: { qq: "12345" } },
      { type: "text", data: { text: " @项目经理 和 55667788 都通知一下" } },
    ],
    "12345",
  );

  assert.equal(parsed.hasAtBot, true);
  assert.deepEqual(parsed.verifiedMentionUserIds, []);
  assert.deepEqual(parsed.plainTextMentionCandidates, ["55667788", "项目经理"]);
});
