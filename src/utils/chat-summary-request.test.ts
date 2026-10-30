import assert from "node:assert/strict";
import test from "node:test";

import { parseChatSummaryRequest } from "./chat-summary-request.js";

test("live report aliases default to today without capturing work reports or creative requests", () => {
  for (const text of ["看看群聊日报", "今天的群聊日报", "每日总结", "查看今日总结", "总结一下群聊", "总结一下今天群聊", "今天群里聊了什么"]) {
    const result = parseChatSummaryRequest(text);
    assert.ok(result, text);
    assert.equal(result.startMinute, 0);
    assert.equal(result.dayOffset, 0);
  }
  assert.equal(parseChatSummaryRequest("看看昨天的群聊日报")?.dayOffset, -1);
  for (const text of ["帮我写今天的工作日报", "我写完日报了", "画一张今天上午聊天总结的海报", "总结今天这篇论文"]) {
    assert.equal(parseChatSummaryRequest(text), null, text);
  }
  const now = new Date("2026-10-30T16:05:00Z");
  assert.equal(parseChatSummaryRequest("总结上面聊天", now)?.endMinute, 5);
});

test("parses named time period summary requests", () => {
  const request = parseChatSummaryRequest("@机器人 总结上午聊天信息");

  assert.deepEqual(request, {
    label: "上午",
    startMinute: 5 * 60,
    endMinute: 11 * 60 + 59,
    mode: "named_period",
    dayOffset: 0,
    startDayOffset: 0,
    endDayOffset: 0,
  });
});

test("parses yesterday evening summary requests in colloquial form", () => {
  const request = parseChatSummaryRequest("帮我总结一下昨晚群里都聊了啥");

  assert.deepEqual(request, {
    label: "昨晚",
    startMinute: 18 * 60,
    endMinute: 23 * 60 + 59,
    mode: "named_period",
    dayOffset: -1,
    startDayOffset: -1,
    endDayOffset: -1,
  });
});

test("parses custom range summary requests", () => {
  const request = parseChatSummaryRequest("帮我总结昨天 9点半到11:15 的聊天记录");

  assert.deepEqual(request, {
    label: "昨天09:30-11:15",
    startMinute: 9 * 60 + 30,
    endMinute: 11 * 60 + 15,
    mode: "custom_range",
    dayOffset: -1,
    startDayOffset: -1,
    endDayOffset: -1,
  });
});

test("parses cross-day range request", () => {
  const request = parseChatSummaryRequest("总结昨晚到今天上午的聊天");

  assert.deepEqual(request, {
    label: "昨天18:00到今天11:59",
    startMinute: 18 * 60,
    endMinute: 11 * 60 + 59,
    mode: "custom_range",
    dayOffset: -1,
    startDayOffset: -1,
    endDayOffset: 0,
  });
});

test("parses open-ended after-time summary requests with natural speech", () => {
  const request = parseChatSummaryRequest("总结一下今天下午三点后的聊天");

  assert.deepEqual(request, {
    label: "今天15:00之后",
    startMinute: 15 * 60,
    endMinute: 23 * 60 + 59,
    mode: "custom_range",
    dayOffset: 0,
    startDayOffset: 0,
    endDayOffset: 0,
  });
});

test("parses yesterday noon to afternoon range in natural speech", () => {
  const request = parseChatSummaryRequest("总结一下昨天中午到下午三点的聊天");

  assert.deepEqual(request, {
    label: "昨天12:00-15:00",
    startMinute: 12 * 60,
    endMinute: 15 * 60,
    mode: "custom_range",
    dayOffset: -1,
    startDayOffset: -1,
    endDayOffset: -1,
  });
});

test("parses yesterday afternoon after-time request", () => {
  const request = parseChatSummaryRequest("总结昨天下午三点后的聊天");

  assert.deepEqual(request, {
    label: "昨天15:00之后",
    startMinute: 15 * 60,
    endMinute: 23 * 60 + 59,
    mode: "custom_range",
    dayOffset: -1,
    startDayOffset: -1,
    endDayOffset: -1,
  });
});

test("parses recent half-hour summary request", () => {
  const request = parseChatSummaryRequest("总结最近半小时聊天");

  assert.deepEqual(request, {
    label: "最近半小时",
    startMinute: 0,
    endMinute: 0,
    mode: "relative_window",
    dayOffset: 0,
    startDayOffset: 0,
    endDayOffset: 0,
    relativeDurationMinutes: 30,
  });
});

test("parses past two hours summary request", () => {
  const request = parseChatSummaryRequest("帮我总结过去两小时的聊天");

  assert.deepEqual(request, {
    label: "过去两小时",
    startMinute: 0,
    endMinute: 0,
    mode: "relative_window",
    dayOffset: 0,
    startDayOffset: 0,
    endDayOffset: 0,
    relativeDurationMinutes: 120,
  });
});

test("parses recent two-day summary request", () => {
  const request = parseChatSummaryRequest("帮我总结最近两天的聊天");

  assert.deepEqual(request, {
    label: "最近两天",
    startMinute: 0,
    endMinute: 0,
    mode: "relative_window",
    dayOffset: 0,
    startDayOffset: 0,
    endDayOffset: 0,
    relativeDurationMinutes: 2 * 24 * 60,
  });
});

test("parses range ending at now", () => {
  const request = parseChatSummaryRequest(
    "总结今天下午三点到现在的聊天",
    new Date("2026-04-17T16:28:00"),
  );

  assert.deepEqual(request, {
    label: "今天15:00-16:28",
    startMinute: 15 * 60,
    endMinute: 16 * 60 + 28,
    mode: "custom_range",
    dayOffset: 0,
    startDayOffset: 0,
    endDayOffset: 0,
  });
});

test("parses recent above-message summary requests", () => {
  const request = parseChatSummaryRequest("总结一下上面聊天信息", new Date("2026-04-17T16:28:00"));

  assert.deepEqual(request, {
    label: "上面",
    startMinute: 0,
    endMinute: 16 * 60 + 28,
    mode: "recent",
    recentMessageCount: 60,
    dayOffset: 0,
    startDayOffset: 0,
    endDayOffset: 0,
  });
});

test("parses direct question about above messages without explicit summary keyword", () => {
  const request = parseChatSummaryRequest("上面聊了些什么呢", new Date("2026-04-17T16:28:00"));

  assert.deepEqual(request, {
    label: "上面",
    startMinute: 0,
    endMinute: 16 * 60 + 28,
    mode: "recent",
    recentMessageCount: 60,
    dayOffset: 0,
    startDayOffset: 0,
    endDayOffset: 0,
  });
});

test("parses more colloquial aliases like 今儿个 and 一上午", () => {
  const request = parseChatSummaryRequest("帮我总结今儿个一上午群里都聊了啥");

  assert.deepEqual(request, {
    label: "今天上午",
    startMinute: 5 * 60,
    endMinute: 11 * 60 + 59,
    mode: "named_period",
    dayOffset: 0,
    startDayOffset: 0,
    endDayOffset: 0,
  });
});

test("parses analysis wording and direct chat-history questions", () => {
  const analysisRequest = parseChatSummaryRequest("分析一下今天上午的聊天记录");
  const directQuestion = parseChatSummaryRequest("今天上午群里都聊了些什么");
  const wholeDayQuestion = parseChatSummaryRequest("今天群里都聊了什么");

  assert.deepEqual(analysisRequest, {
    label: "今天上午",
    startMinute: 5 * 60,
    endMinute: 11 * 60 + 59,
    mode: "named_period",
    dayOffset: 0,
    startDayOffset: 0,
    endDayOffset: 0,
  });

  assert.deepEqual(directQuestion, {
    label: "今天上午",
    startMinute: 5 * 60,
    endMinute: 11 * 60 + 59,
    mode: "named_period",
    dayOffset: 0,
    startDayOffset: 0,
    endDayOffset: 0,
  });

  assert.deepEqual(wholeDayQuestion, {
    label: "今天",
    startMinute: 0,
    endMinute: 23 * 60 + 59,
    mode: "custom_range",
    dayOffset: 0,
    startDayOffset: 0,
    endDayOffset: 0,
  });
});

test("parses colloquial noon expressions like 午休那会儿", () => {
  const request = parseChatSummaryRequest("总结昨儿午休那会儿的聊天");

  assert.deepEqual(request, {
    label: "昨天中午",
    startMinute: 12 * 60,
    endMinute: 13 * 60 + 59,
    mode: "named_period",
    dayOffset: -1,
    startDayOffset: -1,
    endDayOffset: -1,
  });
});

test("parses 白天 and 下班后 style requests", () => {
  const daytime = parseChatSummaryRequest("帮我总结白天群里说了啥");
  const afterWork = parseChatSummaryRequest("帮我总结一下今天下班后的聊天");

  assert.deepEqual(daytime, {
    label: "白天",
    startMinute: 6 * 60,
    endMinute: 17 * 60 + 59,
    mode: "named_period",
    dayOffset: 0,
    startDayOffset: 0,
    endDayOffset: 0,
  });

  assert.deepEqual(afterWork, {
    label: "今天下班后",
    startMinute: 18 * 60,
    endMinute: 23 * 60 + 59,
    mode: "named_period",
    dayOffset: 0,
    startDayOffset: 0,
    endDayOffset: 0,
  });
});

test("ignores unrelated text and invalid time", () => {
  assert.equal(parseChatSummaryRequest("今天上午聊得挺热闹"), null);
  assert.equal(parseChatSummaryRequest("总结 25点到26点"), null);
});
