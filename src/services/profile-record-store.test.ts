import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ProfileRecordStore } from "./profile-record-store.js";

async function withStore<T>(run: (store: ProfileRecordStore) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "profile-record-store-"));
  try {
    return await run(new ProfileRecordStore(path.join(dir, "records.json")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("ProfileRecordStore creates share tokens and finds records by token", async () => {
  await withStore(async (store) => {
    const first = await store.create({
      groupId: "67890",
      userId: "20001",
      type: "overall",
      summary: "第一条画像",
    });
    const second = await store.create({
      groupId: "67890",
      userId: "20001",
      type: "yesterday",
      summary: "第二条画像",
    });

    assert.match(first.shareToken ?? "", /^[A-Za-z0-9_-]{32,}$/);
    assert.match(second.shareToken ?? "", /^[A-Za-z0-9_-]{32,}$/);
    assert.notEqual(first.shareToken, second.shareToken);
    assert.equal((await store.getByShareToken(first.shareToken ?? ""))?.summary, "第一条画像");
    assert.equal(await store.getByShareToken("invalid-token"), undefined);
  });
});

test("ProfileRecordStore preserves share token on update and old records without token stay private", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "profile-record-store-"));
  try {
    const filePath = path.join(dir, "records.json");
    await writeFile(filePath, JSON.stringify({
      records: [{
        id: "legacy-record",
        groupId: "67890",
        userId: "20001",
        type: "overall",
        summary: "旧格式画像",
        sourceMemoryCount: 0,
        generatedAt: "2026-06-01T00:00:00.000Z",
        createdAt: "2026-06-01T00:00:00.000Z",
        createdBy: "legacy",
      }],
    }), "utf8");
    const store = new ProfileRecordStore(filePath);
    assert.equal((await store.get("legacy-record"))?.shareToken, undefined);
    assert.equal(await store.getByShareToken("legacy-record"), undefined);

    const created = await store.create({
      groupId: "67890",
      userId: "20001",
      type: "overall",
      summary: "旧画像",
    });
    const updated = await store.update(created.id, { summary: "新画像" });

    assert.equal(updated?.shareToken, created.shareToken);
    assert.equal((await store.getByShareToken(created.shareToken ?? ""))?.summary, "新画像");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
