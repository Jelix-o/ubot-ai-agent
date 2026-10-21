import assert from "node:assert/strict";
import test from "node:test";
import { ContextResolver } from "./context-resolver.js";
import { emptyConversationState } from "./conversation-state.js";
import { ReplyPolicyService } from "./reply-policy-service.js";
import { RealtimeLookupService } from "./realtime-lookup-service.js";
import { planWebQueries } from "./web-search-policy.js";
import { buildSystemPrompt } from "./ai-service.js";
import type { SkillDefinition } from "../types.js";

const question = "《远征4》中双方作战的核心主线结果是什么";
const request = { text: question, intent: "web" as const, lookupSubject: "远征4", lookupFallbackQueries: ["远征4 剧情", "远征4"] };
const official = { title: "远征4 官方战役", url: "https://www.playstation.com/test-campaign", content: "双方达成停战，主线结束。" };

test("semantic query alternatives survive persistence and reply planning without changing the quoted anchor", async () => {
  const resolution = await new ContextResolver(async () => JSON.stringify({ intent: "explain", resolvedInput: question,
    lookupRequired: true, lookupQuery: "远征4 作战 结局", lookupSubject: "远征4", lookupFallbackQueries: ["远征4 剧情", "远征4"] })).resolve({
    userId: "a", text: "这款作品的主线结果是什么", hasImages: false, candidates: [], messages: [],
    reference: { messageId: "quote", text: "讨论《远征4》", images: [] },
  });
  const plan = new ReplyPolicyService().plan({ resolution: JSON.parse(JSON.stringify(resolution)), state: emptyConversationState() });
  assert.equal(plan.lookupSubject, "远征4");
  assert.deepEqual(plan.lookupFallbackQueries, ["远征4 剧情", "远征4"]);
  assert.equal(plan.anchor?.kind, "explicit_reply");
  assert.deepEqual(plan.selectedMessageIds, ["quote"]);
  assert.equal(plan.resolvedInput, "这款作品的主线结果是什么");
});

test("empty search retries short keywords, rejects another version and spam, and keeps official evidence despite engine errors", async () => {
  const queries: string[] = [];
  const service = new RealtimeLookupService({ resolveDns: async () => [{ address: "93.184.216.34" }], fetch: async input => {
    const url = new URL(input);
    if (url.hostname === "127.0.0.1") {
      queries.push(url.searchParams.get("q")!);
      return Response.json({ unresponsive_engines: [["engine-a", "CAPTCHA"]], results: queries.length === 1 ? [] : [
        { title: "远征1 结局", url: "https://example.test/old", content: "推荐另一个游戏远征4" },
        { title: "软件下载大全", url: "https://example.test/spam", content: "无关广告" },
        official, { ...official, url: official.url + "#duplicate" },
      ] });
    }
    assert.equal(url.hostname, "www.playstation.com");
    return new Response("<html><body>远征4 官方战役：双方达成停战，主线结束。</body></html>", { headers: { "content-type": "text/html" } });
  } });
  const result = await service.lookup(request);
  assert.equal(result?.status, "ok");
  assert.deepEqual(queries, [question, "远征4 剧情"]);
  assert.equal(result?.sources.length, 1);
  assert.equal(result?.searchDiagnostics?.attempts, 2);
  assert.equal(result?.searchDiagnostics?.engineErrors, 2);
  assert.match(result?.promptContext ?? "", /双方达成停战/);
  assert.doesNotMatch(result?.promptContext ?? "", /远征1|无关广告/);
});

test("unrelated results exhaust at most three queries and the answer prompt reports missing evidence rather than unavailable internet", async () => {
  const service = new RealtimeLookupService({ fetch: async () => Response.json({ results: [{ title: "另一个作品", url: "https://example.test/other", content: "旧作资料" }] }) });
  const result = await service.lookup(request);
  assert.equal(result?.failureReason, "no_relevant_results");
  assert.equal(result?.searchDiagnostics?.attempts, 3);
  assert.equal(result?.sources.length, 0);
  const prompt = buildSystemPrompt({ id: "test", name: "test", systemPrompt: "test", styleRules: [], knowledge: [], exampleExchanges: [], temperature: 0.7, maxContextTurns: 12 } as SkillDefinition,
    { groupId: "g", currentUserId: "u", realtimeLookup: result });
  assert.match(prompt, /no relevant evidence was found/);
  assert.doesNotMatch(prompt, /Say the source is temporarily unavailable/);
});

test("a shared deadline cancels stalled web lookups within the total budget", async () => {
  const start = Date.now();
  const service = new RealtimeLookupService({ webBudgetMs: 40, fetch: async (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  }) });
  const result = await service.lookup(request);
  assert.equal(result?.failureReason, "search_timeout");
  assert.equal(result?.searchDiagnostics?.attempts, 1);
  assert.ok(Date.now() - start < 1000);
});

test("zero results with engine challenges are distinct from a network failure", async () => {
  const service = new RealtimeLookupService({ fetch: async () => Response.json({ results: [], unresponsive_engines: [["engine-a", "too many requests"], ["engine-b", "CAPTCHA"]] }) });
  const result = await service.lookup(request);
  assert.equal(result?.failureReason, "search_engines_degraded");
  assert.equal(result?.searchDiagnostics?.engineErrors, 6);
  assert.match(result?.promptContext ?? "", /no matching information/);
});

test("rumors remain explicitly untrusted and do not authorize a verified ending", async () => {
  const service = new RealtimeLookupService({ resolveDns: async () => [{ address: "127.0.0.1" }], fetch: async () => Response.json({ results: [
    { title: "远征4 爆料：可能停战", url: "https://example.test/rumor", content: "这是未经证实的传闻，结局未公布。" },
  ] }) });
  const result = await service.lookup(request);
  assert.equal(result?.status, "ok");
  assert.match(result?.promptContext ?? "", /未经证实的传闻/);
  assert.match(result?.promptContext ?? "", /specific remaining gap/);
  assert.match(result?.promptContext ?? "", /Distinguish official information/);
});

test("rule fallback extracts original titles and refuses semantic version substitutions", () => {
  const plan = planWebQueries("远征：终章4中 双方作战的主线结果是什么", { lookupQuery: "远征：终章1 剧情", lookupSubject: "远征：终章1", lookupFallbackQueries: ["远征：终章1"] });
  assert.equal(plan.lookupSubject, "远征：终章4");
  assert.deepEqual(plan.lookupFallbackQueries, ["远征：终章4 剧情", "远征：终章4"]);
  assert.match(plan.lookupQuery!, /终章4/);
});
