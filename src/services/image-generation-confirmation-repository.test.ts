import assert from "node:assert/strict";
import test from "node:test";
import { SharedDb } from "../shared/sqlite.js";
import { ImageGenerationConfirmationRepository } from "./image-generation-confirmation-repository.js";

test("confirmation is scoped to group and member, expires, supersedes and is idempotent", () => {
  const db = new SharedDb(":memory:");
  const repo = new ImageGenerationConfirmationRepository(db);
  let sequence = 0;
  const insert = (groupId = "group", userId = "member") => db.insertMessage({
    groupId, userId, selfId: "bot", msgId: String(++sequence), msgTime: 1000, text: "request",
    imagesJson: "[]", hasAtBot: true, isBotMsg: false, createdAt: 1000,
  });
  try {
    const original = insert(); repo.request(original, 1000);
    assert.equal(repo.confirm(insert("other"), 1100), undefined);
    assert.equal(repo.confirm(insert("group", "other"), 1100), undefined);
    const confirmation = insert();
    assert.equal(repo.confirm(confirmation, 1200), original);
    assert.equal(repo.confirm(confirmation, 999999), original, "same inbound reuses consent after expiry");
    assert.equal(repo.confirm(insert(), 1300), undefined, "new message cannot consume again");
    const next = insert(); repo.request(next, 2000);
    assert.equal(repo.confirm(insert(), 122001), undefined);
    repo.request(next, 999999);
    assert.equal(repo.confirm(insert(), 999999), undefined, "replay cannot extend the question lifetime");
  } finally { db.close(); }
});
