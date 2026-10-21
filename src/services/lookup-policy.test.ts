import assert from "node:assert/strict";
import test from "node:test";
import { lookupByRules, resolveLookupDecision } from "./lookup-policy.js";

test("fresh work facts survive a missing semantic decision without requiring search keywords", () => {
  const query = "《远征4》中双方作战的核心主线结果是什么";
  assert.deepEqual(lookupByRules(query), { lookupRequired: true, lookupQuery: query });
  assert.equal(resolveLookupDecision(query, { lookupRequired: false }).lookupRequired, true);
  assert.equal(resolveLookupDecision("Orion X2支持卫星通信吗", { lookupRequired: true }).lookupRequired, true);
  assert.deepEqual(lookupByRules("勾股定理怎么证明"), {});
});

test("transformations stay offline even if supplied text contains fresh-data words or a model requests lookup", () => {
  for (const text of ["把今天的股票新闻翻译成中文", "帮我写一段游戏主线剧情", "润色这段最新产品发布会文案"]) {
    assert.deepEqual(resolveLookupDecision(text, { lookupRequired: true, lookupQuery: "错误检索" }), { lookupRequired: false });
  }
  assert.deepEqual(resolveLookupDecision("今天辛苦了", { lookupRequired: false }), { lookupRequired: false });
});
