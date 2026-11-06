import assert from "node:assert/strict";
import test from "node:test";
import { WebSearchBackend } from "./web-search-backend.js";
import { RealtimeLookupService } from "./realtime-lookup-service.js";
import { ContextResolver } from "./context-resolver.js";
import { ReplyPolicyService } from "./reply-policy-service.js";
import { emptyConversationState } from "./conversation-state.js";
import { formatReplyMessages } from "../utils/reply-format.js";
import { RequestIntentRepository } from "./request-intent-repository.js";
import { SharedDb, type IngressMessageRow } from "../shared/sqlite.js";
import { retainRequestContext, validateRequestUnderstanding, type RequestUnderstandingInput } from "./request-understanding.js";

test("Google quota exhaustion immediately falls back, cools down and probes again after six hours", async () => {
  let now = Date.parse("2026-11-05T09:00:00Z"), apiCalls = 0;
  const calls: URL[] = [];
  const backend = new WebSearchBackend({ searchUrl: new URL("http://127.0.0.1:8088"), apiKey: "test-only", now: () => new Date(now),
    fetch: async (input, init) => {
      const url = new URL(input); calls.push(url);
      if (url.hostname === "google.serper.dev") {
        assert.equal(init?.redirect, "error");
        if (++apiCalls === 1) return Response.json({ message: "Not enough credits" }, { status: 400 });
        return Response.json({ organic: [{ title: "Official fixture", link: "https://example.test/fixture", snippet: "Schedule 2026" }] });
      }
      assert.equal(url.searchParams.has("categories"), false);
      assert.equal(url.searchParams.get("engines"), "google cse");
      return Response.json({ results: [{ title: "Free fixture", url: "https://example.test/free", content: "Schedule 2026" }] });
    } });
  const signal = new AbortController().signal;
  assert.equal((await backend.search("fixture", "general", false, false, signal)).fallbackReason, "api_quota_exhausted");
  assert.equal((await backend.search("fixture", "general", false, false, signal)).backend, "free_google");
  assert.equal(apiCalls, 1);
  now += 6 * 60 * 60_000;
  assert.equal((await backend.search("fixture", "general", false, false, signal)).backend, "serper_google");
  assert.equal(apiCalls, 2);
  assert.equal(calls.length, 4);
});

test("empty, invalid, limited and failed APIs fall back to explicitly selected free news", async () => {
  for (const failure of ["empty", "invalid", "limited", "network"]) {
    const backend = new WebSearchBackend({ searchUrl: new URL("http://127.0.0.1:8088"), apiKey: "test-only", now: () => new Date(),
      fetch: async input => {
        const url = new URL(input);
        if (url.hostname === "google.serper.dev") {
          if (failure === "network") throw new Error("connection failed");
          if (failure === "invalid") return new Response("invalid JSON");
          return Response.json(failure === "limited" ? { message: "Rate limited" } : { news: [] }, { status: failure === "limited" ? 429 : 200 });
        }
        assert.equal(url.searchParams.get("engines"), "bing news");
        assert.equal(url.searchParams.has("categories"), false);
        return Response.json({ results: [{ title: "New announcement", url: "https://example.test/news", content: "Court statement", publishedDate: "2026-11-05" }] });
      } });
    const result = await backend.search("Orion court", "news", true, false, new AbortController().signal);
    assert.equal(result.backend, "free_bing_news");
    assert.equal(result.results[0]?.publishedAt, "2026-11-05");
  }
});

test("only one request probes API recovery while concurrent callers retain free search", async () => {
  let now = 1, calls = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const backend = new WebSearchBackend({ searchUrl: new URL("http://127.0.0.1:8088"), apiKey: "test-only", now: () => new Date(now),
    fetch: async input => {
      if (new URL(input).hostname === "google.serper.dev") {
        if (++calls === 1) return Response.json({ message: "Quota exhausted" }, { status: 402 });
        await gate;
        return Response.json({ organic: [{ title: "Recovered", link: "https://example.test/recovered" }] });
      }
      return Response.json({ results: [{ title: "Free", url: "https://example.test/free" }] });
    } });
  const search = () => backend.search("fixture", "general", false, false, new AbortController().signal);
  await search(); now += 6 * 60 * 60_000;
  const probe = search();
  assert.equal((await search()).backend, "free_google");
  assert.equal(calls, 2); release();
  assert.equal((await probe).backend, "serper_google");
});

test("query planning and freshness reach search; outdated and off-topic documents cannot stop retries", async () => {
  const question = "Orion 半导体最新官司进展";
  const resolution = await new ContextResolver(async () => JSON.stringify({ intent: "lookup", relation: "new", resolvedInput: question,
    lookupRequired: true, lookupQuery: "Orion court latest", lookupSubject: "Orion", lookupAliases: ["欧瑞半导体"],
    lookupFreshness: "recent", lookupTopic: "news", lookupFallbackQueries: ["Orion court ruling", "Orion lawsuit"] })).resolve({ userId: "a", text: question, hasImages: false, candidates: [], messages: [] });
  const plan = new ReplyPolicyService().plan({ resolution, state: emptyConversationState() });
  let rounds = 0;
  const service = new RealtimeLookupService({ now: () => new Date("2026-11-05T09:00:00Z"), resolveDns: async () => [{ address: "127.0.0.1" }], fetch: async input => {
    const url = new URL(input);
    assert.equal(url.searchParams.has("categories"), false);
    return Response.json({ results: ++rounds === 1 ? [
      { title: "Orion lawsuit 2023", url: "https://example.test/old", content: "Old ruling", publishedDate: "2023-06-01" },
      { title: "Orion products", url: "https://example.test/product", content: "New devices" },
    ] : [{ title: "Orion court ruling", url: "https://example.test/new", content: "The court published an interim ruling on November 4. The ruling concerns company management; the merits hearing has not concluded and no final judgment is reported.", publishedDate: "2026-11-04" }] });
  } });
  const result = await service.lookup({ ...plan, intent: "web", text: plan.lookupQuery!, question });
  assert.equal(rounds, 2);
  assert.equal(result?.sources.some(source => source.url.endsWith("/old")), false);
  assert.match(result?.promptContext ?? "", /2026-11-04/);
  assert.match(result?.promptContext ?? "", /Actual search rounds: 2/);
});

test("consumed completed searches remain readable within author, group, recall and time boundaries", t => {
  const db = new SharedDb(":memory:"); t.after(() => db.close());
  const repo = new RequestIntentRepository(db);
  const add = (text: string, at: number, userId = "a", groupId = "g") => db.insertMessage({ groupId, userId, selfId: "bot", msgId: `${groupId}-${userId}-${at}`, msgTime: at, createdAt: at, text, imagesJson: "[]", hasAtBot: true, isBotMsg: false });
  const complete = (id: number) => {
    const claim = repo.claim(id, 1000); assert.equal(claim.state, "claimed");
    if (claim.state === "claimed") repo.complete(id, claim.token, { action: "web_lookup", relation: "new", sourceRowIds: [id], missingFields: [], modelId: "test", model: "test" }, 1001);
    repo.beginExecution(id); repo.finishExecution(id);
  };
  const old = add("Expired company", 1); complete(old);
  const own = add("Orion latest court case", 200000); complete(own);
  const other = add("Other company", 200001, "b"); complete(other);
  const cross = add("Cross group", 200002, "a", "other"); complete(cross);
  const recalled = add("Recalled company", 200003); complete(recalled); db.markRetracted("g", "g-a-200003", 200004);
  const current = add("对应的行业新闻总结一下", 650000); repo.consume(current, [own]);
  const row = db.db.prepare("SELECT * FROM messages WHERE id=?").get(current) as unknown as IngressMessageRow;
  assert.deepEqual(repo.lookupHistory(row).map(item => item.row.id), [own]);
  assert.deepEqual(repo.candidates(row), []);
  const input: RequestUnderstandingInput = { sourceRowId: current, sanitizedText: row.text,
    facts: { hasTrustedBotMention: true, hasTrustedReply: false, replyIsGeneratedImage: false, attachmentCount: 0 },
    candidates: [{ id: own, text: "Orion latest court case", attachmentCount: 0, readOnly: true, assistantReply: "Only industry material found" }] };
  const result = retainRequestContext({ action: "web_lookup", relation: "new", sourceRowIds: [current], missingFields: ["query"], modelId: "test", model: "test" }, input);
  assert.equal(result.relation, "follow_up"); assert.deepEqual(result.missingFields, []); assert.ok(result.sourceRowIds.includes(own));
  assert.throws(() => validateRequestUnderstanding({ action: "generate", relation: "follow_up", sourceRowIds: [own, current], missingFields: [] }, input), /readonly/);
});

test("a complete names-only list bypasses chat shortening and never splits an English team name", () => {
  const policy = new ReplyPolicyService();
  const plan = policy.plan({ resolution: { intent: "lookup", relation: "new", resolvedInput: "所有冠军只要队名，按逗号分隔", selectedMessageIds: [], mediaSourceMessageIds: [], needsMoreContext: false, source: "rules" }, state: emptyConversationState() });
  assert.equal(plan.lookupFreshness, "all_time");
  const budget = policy.replyFormatBudget({ id: "huixian" }, plan.resolvedInput, plan)!;
  const list = Array.from({ length: 25 }, (_, i) => `Example Gaming Team ${i}`).join("，");
  const skill = { id: "huixian", name: "test", systemPrompt: "", styleRules: [], knowledge: [], temperature: 0.7, maxContextTurns: 4 };
  assert.deepEqual(formatReplyMessages(skill, list, budget), [list]);
  const chunks = formatReplyMessages(skill, list, { ...budget, maxChars: 80, maxMessages: 20 });
  assert.equal(chunks.join(""), list);
  assert.ok(chunks.every(chunk => !chunk.startsWith("Gaming")));
  const yearlyBudget = policy.replyFormatBudget(skill, "按年份列出每届冠军，只要队名，逗号分隔", plan)!;
  assert.deepEqual(formatReplyMessages(skill, "Example Gaming，Example Gaming", yearlyBudget), ["Example Gaming，Example Gaming"]);
});

test("a schedule keeps its final fixture instead of spending the chat bubble budget", () => {
  const policy = new ReplyPolicyService();
  const plan = policy.plan({ resolution: { intent: "lookup", relation: "new", resolvedInput: "当前赛事后续赛程", selectedMessageIds: [], mediaSourceMessageIds: [], needsMoreContext: false, source: "rules" }, state: emptyConversationState() });
  const skill = { id: "huixian", name: "大肥鱼", systemPrompt: "", styleRules: [], knowledge: [], temperature: 0.7, maxContextTurns: 4 };
  const text = "已确认的赛程如下：\n11月7日四分之一决赛\n11月8日第一场半决赛\n11月9日第二场半决赛\n11月15日冠亚军决赛；部分对阵待定，以官方更新为准。";
  const messages = formatReplyMessages(skill, text, policy.replyFormatBudget(skill, plan.resolvedInput, plan));
  assert.equal(messages.length, 1);
  assert.match(messages[0]!, /11月15日冠亚军决赛/);
});
