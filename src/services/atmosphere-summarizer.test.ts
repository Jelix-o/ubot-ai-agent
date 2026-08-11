import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { RecentGroupMessage } from "../types.js";
import {
  AtmosphereSummarizer,
  buildAtmosphereSummary,
  detectTopicHints,
  pickRepresentativeMessages,
  sanitizeMessageForAtmosphere,
} from "./atmosphere-summarizer.js";

function message(userId: string, text: string, minutesAgo: number, now: number): RecentGroupMessage {
  return {
    messageId: `${userId}-${text.slice(0, 4)}`,
    userId,
    text,
    timestamp: new Date(now - minutesAgo * 60_000).toISOString(),
  };
}

test("atmosphere summary strips names and desensitizes sensitive topics", () => {
  const now = Date.now();
  const messages = [
    message("10001", "老王说要裁前端了，气死我了", 2, now),
    message("10002", "真的假的，我们组也说要优化", 1, now),
  ];
  const hints = detectTopicHints(messages);
  assert.ok(hints.includes("岗位变化"), "裁员 must be desensitized to 岗位变化");
  const summary = buildAtmosphereSummary(messages, hints);
  assert.ok(!summary.includes("老王"), "summary must not contain names");
  assert.ok(summary.includes("岗位变化"), "summary uses the vague topic label");
});

test("sanitizeMessageForAtmosphere strips QQ numbers and mentions", () => {
  const sanitized = sanitizeMessageForAtmosphere({
    messageId: "x",
    userId: "20001",
    text: "@小明 12345678901 明天见",
    timestamp: new Date().toISOString(),
  });
  assert.ok(!sanitized.includes("12345678901"));
  assert.ok(!sanitized.includes("@小明"));
});

test("pickRepresentativeMessages samples evenly across the window", () => {
  const now = Date.now();
  const messages = Array.from({ length: 40 }, (_, i) =>
    message("u", `msg ${i}`, 40 - i, now),
  );
  const picked = pickRepresentativeMessages(messages, 8);
  assert.equal(picked.length, 8);
  assert.equal(picked[0]!.text, "msg 0");
  assert.equal(picked[7]!.text, "msg 39");
});

test("summarizer only produces new summaries after the interval", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "atm-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const summarizer = new AtmosphereSummarizer(dir, { summarizeIntervalMs: 10 * 60 * 1000, windowMs: 60 * 60 * 1000 });
  const now = Date.now();
  const messages = [message("10001", "今天天气不错", 5, now)];

  const first = summarizer.update("10001", messages, now);
  assert.ok(first, "first update must summarize");
  assert.equal(first!.summary.length > 0, true);

  const second = summarizer.update("10001", messages, now + 60_000);
  assert.equal(second, undefined, "no new summary within the interval");

  const third = summarizer.update("10001", messages, now + 11 * 60 * 1000);
  assert.ok(third, "new summary after the interval");
  assert.equal(summarizer.getSummary("10001")?.summary, third!.summary);
});

test("summaries persist across instances", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "atm-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const now = Date.now();
  const messages = [message("10001", "股票又跌了", 5, now)];

  const first = new AtmosphereSummarizer(dir, { summarizeIntervalMs: 0 });
  first.summarizeNow("10001", messages, now);

  const second = new AtmosphereSummarizer(dir, { summarizeIntervalMs: 0 });
  assert.equal(second.getSummary("10001")?.messageCount, 1);
});
