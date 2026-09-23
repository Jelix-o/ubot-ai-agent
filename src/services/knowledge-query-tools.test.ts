import assert from "node:assert/strict";
import test from "node:test";

import type { KnowledgeBaseEntry } from "../types.js";
import type { AiToolCall } from "./ai-service.js";
import { createKnowledgeToolRuntime } from "./knowledge-query-tools.js";
import { loadPrivateEnterpriseRanking } from "./private-enterprise-ranking.js";

function toolCall(name: string, arguments_: Record<string, unknown>): AiToolCall {
  return {
    id: `call_${name}`,
    name,
    arguments: JSON.stringify(arguments_),
  };
}

function entry(overrides: Partial<KnowledgeBaseEntry> = {}): KnowledgeBaseEntry {
  return {
    id: "faq-1",
    groupId: "current-group",
    title: "报销流程",
    question: "如何报销？",
    answer: "在周五前提交报销单。",
    keywords: ["报销", "发票"],
    enabled: true,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

test("ranking tool returns a terminal, edition-scoped deterministic result", async () => {
  const runtime = createKnowledgeToolRuntime({
    groupId: "current-group",
    ranking: loadPrivateEnterpriseRanking(),
  });
  assert.ok(runtime);
  const schema = runtime.tools.find((tool) => tool.name === "query_private_enterprise_ranking")?.parameters as {
    additionalProperties?: boolean;
    properties?: Record<string, unknown>;
  };
  assert.equal(schema.additionalProperties, false);
  assert.ok(schema.properties?.edition);

  const answer = await runtime.execute(toolCall("query_private_enterprise_ranking", {
    operation: "company_lookup",
    company: "阿里",
    edition: 2026,
  }));
  assert.deepEqual(JSON.parse(answer.content), { status: "terminal", messageCount: 1 });
  assert.match(answer.finalMessages?.[0] ?? "", /阿里巴巴（中国）有限公司.*第2/);

  const otherYear = await runtime.execute(toolCall("query_private_enterprise_ranking", {
    operation: "company_lookup",
    company: "阿里",
    edition: 2025,
  }));
  assert.match(otherYear.finalMessages?.[0] ?? "", /仅收录2026|不能用这份榜单回答其他年份/);

  const range = await runtime.execute(toolCall("query_private_enterprise_ranking", {
    operation: "rank_range",
    edition: 2026,
    startRank: 10,
    endRank: 20,
  }));
  assert.deepEqual(JSON.parse(range.content), { status: "terminal", messageCount: 1 });
  assert.equal(range.finalMessages?.join("\n").match(/第\d+名 /g)?.length, 11);
  assert.match(range.finalMessages?.[0] ?? "", /第10至20名/);
});

test("ranking tool rejects injected and unknown arguments instead of silently broadening a query", async () => {
  const runtime = createKnowledgeToolRuntime({
    groupId: "current-group",
    ranking: loadPrivateEnterpriseRanking(),
  });
  assert.ok(runtime);

  const result = await runtime.execute(toolCall("query_private_enterprise_ranking", {
    operation: "national_count",
    groupId: "other-group",
  }));

  assert.deepEqual(JSON.parse(result.content), { status: "error", code: "invalid_ranking_query" });
  assert.match(result.finalMessages?.[0] ?? "", /参数无效/);

  const incompatible = await runtime.execute(toolCall("query_private_enterprise_ranking", {
    operation: "national_count",
    company: "阿里",
  }));
  assert.deepEqual(JSON.parse(incompatible.content), { status: "error", code: "invalid_ranking_query" });

  const invalidRange = await runtime.execute(toolCall("query_private_enterprise_ranking", {
    operation: "rank_range",
    startRank: 20,
    endRank: 10,
  }));
  assert.deepEqual(JSON.parse(invalidRange.content), { status: "error", code: "invalid_ranking_query" });
});

test("FAQ tool binds every read to the current group and terminates a matched answer", async () => {
  const requestedGroups: string[] = [];
  const store = {
    async search(groupId: string, query: string) {
      requestedGroups.push(`${groupId}:${query}`);
      return [{ entry: entry(), score: 10 }];
    },
    async listEnabledDirectory() {
      assert.fail("a matching FAQ query must not fall back to the directory");
    },
  };
  const runtime = createKnowledgeToolRuntime({
    groupId: "current-group",
    knowledgeBaseStore: store,
  });
  assert.ok(runtime);

  const result = await runtime.execute(toolCall("search_group_faq", { query: "报销" }));
  assert.deepEqual(requestedGroups, ["current-group:报销"]);
  assert.deepEqual(JSON.parse(result.content), { status: "terminal", messageCount: 1 });
  assert.deepEqual(result.finalMessages, ["在周五前提交报销单。"]);
  assert.equal(result.content.includes("在周五前提交报销单。"), false);

  const injectedGroup = await runtime.execute(toolCall("search_group_faq", {
    query: "报销",
    groupId: "other-group",
  }));
  assert.deepEqual(JSON.parse(injectedGroup.content), { status: "error", code: "invalid_faq_query" });
  assert.deepEqual(requestedGroups, ["current-group:报销"]);
});

test("FAQ tool terminates close matches with a deterministic clarification instead of combining answers", async () => {
  const runtime = createKnowledgeToolRuntime({
    groupId: "current-group",
    knowledgeBaseStore: {
      async search() {
        return [
          { entry: entry({ id: "faq-a", title: "报销流程", question: "如何报销？", answer: "报销答案。" }), score: 10 },
          { entry: entry({ id: "faq-b", title: "差旅报销", question: "差旅费用如何报销？", answer: "差旅答案。" }), score: 9 },
        ];
      },
      async listEnabledDirectory() {
        assert.fail("matched FAQ queries must not fall back to the directory");
      },
    },
  });
  assert.ok(runtime);

  const result = await runtime.execute(toolCall("search_group_faq", { query: "报销" }));

  assert.deepEqual(JSON.parse(result.content), { status: "terminal", messageCount: 1 });
  assert.match(result.finalMessages?.[0] ?? "", /多条接近内容/);
  assert.match(result.finalMessages?.[0] ?? "", /报销流程/);
  assert.match(result.finalMessages?.[0] ?? "", /差旅报销/);
  assert.equal(result.finalMessages?.[0]?.includes("报销答案。") ?? false, false);
  assert.equal(result.finalMessages?.[0]?.includes("差旅答案。") ?? false, false);
});

test("FAQ no-match returns a group-bound directory without leaking answers", async () => {
  const calls: Array<{ method: string; groupId: string; queryOrLimit: string | number }> = [];
  const store = {
    async search(groupId: string, query: string) {
      calls.push({ method: "search", groupId, queryOrLimit: query });
      return [];
    },
    async listEnabledDirectory(groupId: string, limit: number) {
      calls.push({ method: "directory", groupId, queryOrLimit: limit });
      return [entry({
        id: "faq-2",
        title: "会议制度",
        question: "会议怎么请假？",
        answer: "这条答案不应出现在目录里。",
        keywords: ["会议", "请假"],
      })];
    },
  };
  const runtime = createKnowledgeToolRuntime({
    groupId: "current-group",
    knowledgeBaseStore: store,
  });
  assert.ok(runtime);

  const result = await runtime.execute(toolCall("search_group_faq", { query: "请假" }));
  const payload = JSON.parse(result.content) as {
    status: string;
    entries: Array<Record<string, unknown>>;
    message?: string;
  };
  assert.deepEqual(calls, [
    { method: "search", groupId: "current-group", queryOrLimit: "请假" },
    { method: "directory", groupId: "current-group", queryOrLimit: 50 },
  ]);
  assert.equal(payload.status, "no_match");
  assert.match(payload.message ?? "", /未命中/);
  assert.match(result.finalMessages?.[0] ?? "", /未找到可核验/);
  assert.equal(payload.entries[0]?.title, "会议制度");
  assert.equal("answer" in (payload.entries[0] ?? {}), false);
  assert.equal("groupId" in (payload.entries[0] ?? {}), false);
});

test("FAQ tool keeps oversized matched answers out of the model tool payload", async () => {
  const runtime = createKnowledgeToolRuntime({
    groupId: "current-group",
    knowledgeBaseStore: {
      async search() {
        return [entry({
          answer: "答".repeat(1_200),
          question: "问".repeat(300),
          keywords: Array.from({ length: 30 }, () => "关键词".repeat(20)),
        })].map((item) => ({ entry: item, score: 10 }));
      },
      async listEnabledDirectory() { return []; },
    },
  });
  assert.ok(runtime);
  const result = await runtime.execute(toolCall("search_group_faq", { query: "报销" }));
  assert.ok(result.content.length <= 6_000);
  assert.deepEqual(JSON.parse(result.content), { status: "terminal", messageCount: 1 });
  assert.equal(result.content.includes("答".repeat(100)), false);
  assert.equal(result.finalMessages?.[0]?.length, 1_200);
});

test("explicit group FAQ requests can force only the current-group FAQ tool", () => {
  const runtime = createKnowledgeToolRuntime({
    groupId: "current-group",
    ranking: loadPrivateEnterpriseRanking(),
    knowledgeBaseStore: {
      async search() { return []; },
      async listEnabledDirectory() { return []; },
    },
    forceGroupFaqTool: true,
  });
  assert.equal(runtime?.forceToolName, "search_group_faq");
});
