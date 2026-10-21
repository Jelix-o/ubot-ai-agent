import assert from "node:assert/strict";
import test from "node:test";
import { ContextResolver } from "./context-resolver.js";
import { emptyConversationState } from "./conversation-state.js";
import { ReplyPolicyService } from "./reply-policy-service.js";
import { RealtimeLookupService } from "./realtime-lookup-service.js";

const input = { userId: "a", text: "Orion X2支持卫星通信吗", hasImages: false, messages: [], candidates: [] };

test("semantic lookup is independent of explanation intent and reaches web search without trigger words", async () => {
  const resolution = await new ContextResolver(async () => JSON.stringify({
    intent: "explain", resolvedInput: input.text, lookupRequired: true, lookupQuery: "Orion X2 卫星通信 官方规格",
  })).resolve(input);
  const plan = new ReplyPolicyService().plan({ resolution, state: emptyConversationState() });
  assert.equal(plan.explanation, "requested");
  assert.deepEqual(plan.toolNeeds, ["lookup"]);
  const urls: URL[] = [];
  const service = new RealtimeLookupService({
    fetch: async url => {
      urls.push(new URL(url));
      return Response.json({ results: [{ title: "Official specifications", url: "https://example.test/spec", content: "Supported since revision 2." }] });
    },
    resolveDns: async () => [{ address: "127.0.0.1" }],
  });
  const result = await service.lookup({ text: plan.lookupQuery!, intent: "web" });
  assert.equal(urls.length, 1);
  assert.equal(urls[0].searchParams.get("q"), plan.lookupQuery);
  assert.equal(result?.status, "ok");
  assert.match(result?.promptContext ?? "", /Supported since revision 2/);
});

test("a quoted factual question may add lookup without changing the authoritative quote or media", async () => {
  const resolution = await new ContextResolver(async () => JSON.stringify({
    intent: "chat", resolvedInput: "把远征4换成远征1", selectedMessageIds: [], clarification: "重发引用", lookupRequired: true, lookupQuery: "远征4 战役结局 官方资料",
  })).resolve({ ...input, text: "这款游戏的战役结局是什么", replyToMessageId: "quote", reference: {
    messageId: "quote", text: "讨论《远征4》", images: [],
  } });
  assert.equal(resolution.anchor?.kind, "explicit_reply");
  assert.deepEqual(resolution.selectedMessageIds, ["quote"]);
  assert.equal(resolution.resolvedInput, "这款游戏的战役结局是什么");
  assert.equal(resolution.clarification, undefined);
  assert.equal(resolution.lookupQuery, "远征4 战役结局 官方资料");
});

test("a factual challenge searches the quoted work and keeps unrelated context outside the query", async () => {
  const resolution = await new ContextResolver().resolve({ ...input, text: "不对，真的吗", reference: {
    messageId: "quote", text: "《远征4》的主线结果是双方停战", images: [],
  } });
  assert.equal(resolution.lookupRequired, true);
  assert.match(resolution.lookupQuery!, /远征4/);
});

test("a quoted product question without keywords gets a semantic lookup decision while pure image reading stays offline", async () => {
  let calls = 0;
  const resolver = new ContextResolver(async () => {
    calls++;
    return JSON.stringify({ intent: "confirm", resolvedInput: input.text, lookupRequired: true, lookupQuery: "Orion X2 卫星通信 官方规格" });
  });
  const resolution = await resolver.resolve({ ...input, text: "这个型号支持卫星通信吗", reference: { messageId: "phone", text: "Orion X2", images: [] } });
  assert.equal(resolution.lookupRequired, true);
  assert.match(resolution.lookupQuery!, /Orion X2/);
  assert.equal(resolution.anchor?.kind, "explicit_reply");
  const image = await resolver.resolve({ ...input, text: "图片上写的天气是什么", reference: { messageId: "weather", text: "", images: [{ url: "https://example.test/weather.png" }] } });
  assert.equal(calls, 1);
  const plan = new ReplyPolicyService().plan({ resolution: image, state: emptyConversationState() });
  assert.equal(plan.lookupRequired, false);
  assert.deepEqual(plan.toolNeeds, ["image"]);
});

test("malformed or failed semantic responses preserve work-question lookup and legacy lookup plans", async () => {
  for (const model of [async () => "invalid", async () => { throw new Error("timeout"); }]) {
    const resolution = await new ContextResolver(model).resolve({ ...input, text: "《远征4》核心作战主线结果是什么" });
    assert.equal(resolution.source, "rules");
    assert.equal(resolution.lookupRequired, true);
  }
  const legacy = { intent: "lookup" as const, relation: "new" as const, resolvedInput: input.text, selectedMessageIds: [], mediaSourceMessageIds: [], needsMoreContext: false, source: "model" as const };
  const plan = new ReplyPolicyService().plan({ resolution: JSON.parse(JSON.stringify(legacy)), state: emptyConversationState() });
  assert.equal(plan.lookupRequired, true);
  assert.equal(plan.lookupQuery, input.text);
});

test("semantic no-lookup survives incidental time words and translation requests", async () => {
  for (const text of ["今天辛苦了", "把今天的新闻翻译成中文"]) {
    const resolution = await new ContextResolver(async () => JSON.stringify({ intent: "chat", resolvedInput: text, lookupRequired: false })).resolve({ ...input, text });
    const plan = new ReplyPolicyService().plan({ resolution, state: emptyConversationState() });
    assert.equal(plan.lookupRequired, false);
    assert.deepEqual(plan.toolNeeds, []);
  }
});

test("forced web lookup distinguishes empty results and upstream failures without pretending facts were verified", async () => {
  for (const fail of [false, true]) {
    const service = new RealtimeLookupService({ fetch: async () => {
      if (fail) throw new Error("timeout");
      return Response.json({ results: [] });
    } });
    const result = await service.lookup({ text: input.text, intent: "web" });
    assert.equal(result?.status, "unavailable");
    assert.equal(result?.sources.length, 0);
    assert.equal(result?.failureReason, fail ? "lookup_failed:timeout" : "no_search_results");
  }
});
