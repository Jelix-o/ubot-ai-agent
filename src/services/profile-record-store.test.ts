import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
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

test("ProfileRecordStore refreshes records after an external write", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "profile-record-store-refresh-"));
  const filePath = path.join(dir, "records.json");
  try {
    const reader = new ProfileRecordStore(filePath);
    const writer = new ProfileRecordStore(filePath);
    await writer.create({ groupId: "67890", userId: "20001", type: "overall", summary: "第一条画像" });
    assert.equal((await reader.listPage({ page: 1, pageSize: 10 })).items.length, 1);

    const raw = JSON.parse(await readFile(filePath, "utf8")) as { records: unknown[] };
    raw.records.push({
      id: "external-profile",
      groupId: "67890",
      userId: "20002",
      type: "overall",
      summary: "后台生成的画像",
      sourceMemoryCount: 0,
      generatedAt: "2026-08-24T00:00:00.000Z",
      createdAt: "2026-08-24T00:00:00.000Z",
      createdBy: "admin",
    });
    await writeFile(filePath, JSON.stringify(raw), "utf8");
    const metadata = await stat(filePath);
    await utimes(filePath, metadata.atime, new Date(metadata.mtimeMs + 1_000));

    assert.equal((await reader.listPage({ page: 1, pageSize: 10 })).items.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ProfileRecordStore creates records without public bearer-link fields", async () => {
  await withStore(async (store) => {
    const record = await store.create({
      groupId: "67890",
      userId: "20001",
      type: "overall",
      summary: "第一条画像",
    });

    assert.deepEqual(Object.keys(record).sort(), [
      "createdAt",
      "createdBy",
      "generatedAt",
      "groupId",
      "id",
      "sourceMemoryCount",
      "summary",
      "type",
      "userId",
    ]);
  });
});

test("ProfileRecordStore excludes opted-out subjects before pagination and total calculation", async () => {
  await withStore(async (store) => {
    await store.create({ groupId: "67890", userId: "20001", type: "overall", summary: "private profile" });
    const visible = await store.create({ groupId: "67890", userId: "20002", type: "overall", summary: "visible profile" });

    const page = await store.listPage({
      page: 1,
      pageSize: 10,
      excludedSubjectKeys: new Set(["67890:20001"]),
    });

    assert.equal(page.pagination.total, 1);
    assert.deepEqual(page.items.map((record) => record.id), [visible.id]);
  });
});

test("ProfileRecordStore drops legacy public-link fields during normalization", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "profile-record-store-legacy-"));
  try {
    const filePath = path.join(dir, "records.json");
    await writeFile(filePath, JSON.stringify({
      records: [{
        id: "legacy-record",
        groupId: "67890",
        userId: "20001",
        type: "overall",
        summary: "旧格式画像",
        shareToken: "x".repeat(32),
        publicEnabled: true,
        expiresAt: "2026-12-01T00:00:00.000Z",
        accessCount: 5,
        sourceMemoryCount: 0,
        generatedAt: "2026-06-01T00:00:00.000Z",
        createdAt: "2026-06-01T00:00:00.000Z",
        createdBy: "legacy",
      }],
    }), "utf8");

    const record = await new ProfileRecordStore(filePath).get("legacy-record");
    assert.deepEqual(record, {
      id: "legacy-record",
      groupId: "67890",
      userId: "20001",
      type: "overall",
      summary: "旧格式画像",
      sourceMemoryCount: 0,
      generatedAt: "2026-06-01T00:00:00.000Z",
      createdAt: "2026-06-01T00:00:00.000Z",
      createdBy: "legacy",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
