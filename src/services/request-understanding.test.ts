import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AiService } from "./ai-service.js";
import { SharedDb, type IngressMessageRow } from "../shared/sqlite.js";
import { RequestIntentRepository } from "./request-intent-repository.js";
import { clearLocalImageAction, requestExecutionText, validateRequestUnderstanding, type RequestUnderstanding, type RequestUnderstandingInput } from "./request-understanding.js";

const input: RequestUnderstandingInput = { sourceRowId: 3, sanitizedText: "[BOT_MENTION] 用电影反派的口吻做个图，台词：出场靠实力。", candidates: [{ id: 1, text: "", attachmentCount: 2 }, { id: 2, text: "不想聊了", attachmentCount: 0 }], facts: { hasTrustedBotMention: true, hasTrustedReply: false, replyIsGeneratedImage: false, attachmentCount: 0 } };

test("request tool uses a small native call and preserves a source-backed image request", async () => {
  let captured: any;
  const decision = { action: "generate", relation: "new", sourceRowIds: [3], missingFields: [] };
  const service = new AiService("https://example.invalid/v1", "test-key", "judge", { async create(args: any, options: any) {
    captured = { args, options };
    return { model: "judge-v2", choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ type: "function", function: { name: "route_request", arguments: JSON.stringify(decision) } }] } }] };
  } } as never, { imageIntentRouting: { enabled: true, timeoutMs: 4000, maxCompletionTokens: 512, requestProfile: "deepseek" }, providerCapabilities: { toolCalling: true } });
  const result = await service.classifyRequest(input);
  assert.equal(result.action, "generate");
  assert.equal(result.model, "judge-v2");
  assert.equal(captured.args.max_tokens, 512);
  assert.equal(captured.options.timeout, 4000);
  assert.deepEqual(captured.args.thinking, { type: "disabled" });
  assert.equal(captured.args.tool_choice.function.name, "route_request");
  assert.match(captured.args.messages[1].content, /出场靠实力/);
  assert.equal(captured.args.stream, false);
  assert.equal(captured.options.maxRetries, 0);
});

test("understanding rejects invented sources, prompts, commands and pending continuations", () => {
  const valid = { action: "vision", relation: "follow_up", sourceRowIds: [1, 2, 3], mediaSourceRowId: 1, missingFields: [] };
  assert.equal(validateRequestUnderstanding(valid, input).mediaSourceRowId, 1);
  for (const bad of [
    { ...valid, sourceRowIds: [99] }, { ...valid, mediaSourceRowId: 2 },
    { ...valid, input: "invented prompt" }, { ...valid, command: "#模型" },
    { ...valid, action: "admin" }, { ...valid, continuesPending: true },
    { ...valid, missingFields: ["password"] },
  ]) assert.throws(() => validateRequestUnderstanding(bad, input), /request_intent_invalid/);
});

test("a judge focusing on emotion cannot discard the unanswered image behind an empty mention", async () => {
  const service = new AiService("https://example.invalid/v1", "test-key", "judge", { async create() {
    return { model: "judge", choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ type: "function", function: { name: "route_request", arguments: JSON.stringify({ action: "chat", relation: "follow_up", sourceRowIds: [2, 3], missingFields: [] }) } }] } }] };
  } } as never, { providerCapabilities: { toolCalling: true } });
  const result = await service.classifyRequest({ ...input, sanitizedText: "[BOT_MENTION]" });
  assert.equal(result.action, "vision");
  assert.equal(result.mediaSourceRowId, 1);
  assert.ok([1, 2, 3].every(id => result.sourceRowIds.includes(id)));
  const independent = await service.classifyRequest({ ...input, sanitizedText: "今天星期几" });
  assert.equal(independent.action, "chat");
});

test("local outage fallback accepts concrete creation and excludes questions, negation and reported instructions", () => {
  for (const text of ["用电影反派的口吻做个图，台词：出场靠实力。", "帮我生成一张蓝鲸图片", "画一只戴帽子的猫"]) assert.equal(clearLocalImageAction(text), "generate", text);
  for (const text of ["不要生成图片", "你支持生图吗", "如何生成图片", "他说让我做个图", "不想聊了", "这个图怎么样", "帮我看看怎么做图"]) assert.equal(clearLocalImageAction(text), undefined, text);
});

test("execution keeps local URLs and numbers instead of opaque judge markers", () => {
  const raw = "把 https://example.test/page 做成网页，写上编号123456";
  assert.equal(requestExecutionText("[URL]", raw), raw);
  assert.equal(requestExecutionText("编号[NUMBER_S1_1]", raw), raw);
  assert.equal(requestExecutionText("做成网页", raw), "做成网页");
});

test("request leases, evidence consumption and recovery prevent a second implicit execution", t => {
  const root = mkdtempSync(path.join(os.tmpdir(), "request-understanding-"));
  const dbPath = path.join(root, "db.sqlite");
  let db = new SharedDb(dbPath);
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const add = (text: string, userId = "20001", groupId = "10001", createdAt = 1000) => db.insertMessage({ groupId, userId, selfId: "99999", msgId: String(Math.random()), msgTime: createdAt, createdAt, text, imagesJson: "[]", hasAtBot: false, isBotMsg: false });
  const source = add("不想聊了"), other = add("别人的话", "20002"), cross = add("别群", "20001", "10002"), expired = add("过期", "20001", "10001", 0), request = add("", "20001", "10001", 120001);
  const row = db.db.prepare("SELECT * FROM messages WHERE id=?").get(request) as unknown as IngressMessageRow;
  let repo = new RequestIntentRepository(db);
  assert.deepEqual(repo.candidates(row).map(item => item.id), [source]);
  assert.ok(!repo.candidates(row).some(item => [other, cross, expired].includes(item.id)));
  const claim = repo.claim(request, 1000); assert.equal(claim.state, "claimed");
  assert.equal(repo.claim(request, 1001).state, "busy");
  const decision: RequestUnderstanding = { action: "chat", relation: "follow_up", sourceRowIds: [source, request], missingFields: [], modelId: "judge", model: "judge" };
  assert.equal(repo.complete(request, "wrong-token", decision, 1002), false);
  assert.ok(claim.state === "claimed" && repo.complete(request, claim.token, decision, 1002));
  db.close(); db = new SharedDb(dbPath); repo = new RequestIntentRepository(db);
  assert.equal(repo.claim(request, 2000).state, "resolved");
  assert.deepEqual(repo.get(request)?.result, decision);
  const next = add("", "20001", "10001", 120002);
  assert.deepEqual(repo.candidates(db.db.prepare("SELECT * FROM messages WHERE id=?").get(next) as unknown as IngressMessageRow), []);
  const pending = repo.claim(next, 3000); assert.equal(pending.state, "claimed");
  assert.equal(repo.claim(next, 33000).state, "resolved");
  assert.equal(repo.get(next)?.errorCode, "result_unknown");
  assert.ok(pending.state === "claimed" && !repo.complete(next, pending.token, decision, 33001));
});

test("competing empty mentions reserve evidence once and an interrupted adapter cannot run twice", t => {
  const root = mkdtempSync(path.join(os.tmpdir(), "request-fence-"));
  const file = path.join(root, "state.db");
  const db = new SharedDb(file), other = new SharedDb(file);
  t.after(() => { other.close(); db.close(); rmSync(root, { recursive: true, force: true }); });
  const add = (text: string) => db.insertMessage({ groupId: "10001", userId: "20001", selfId: "99999", msgId: String(Math.random()), msgTime: 1000, createdAt: 1000, text, imagesJson: "[]", hasAtBot: false, isBotMsg: false });
  const evidence = add("生成一张蓝鲸图片"), a = add(""), b = add("");
  const first = new RequestIntentRepository(db), second = new RequestIntentRepository(other);
  const ca = first.claim(a, 1000), cb = second.claim(b, 1000);
  assert.equal(ca.state, "claimed"); assert.equal(cb.state, "claimed");
  const result: RequestUnderstanding = { action: "generate", relation: "follow_up", sourceRowIds: [evidence], missingFields: [], modelId: "judge", model: "judge" };
  assert.ok(ca.state === "claimed" && first.complete(a, ca.token, result, 1001));
  assert.ok(cb.state === "claimed" && second.complete(b, cb.token, result, 1001));
  assert.equal(second.get(b)?.result?.action, "chat");
  assert.equal(first.beginExecution(a), "started");
  assert.equal(second.beginExecution(a), "unknown", "recovery must not repeat a potentially committed side effect");
  assert.equal(first.beginExecution(a), "settled");
  assert.equal(second.beginExecution(b), "started");
  second.finishExecution(b);
  assert.equal(first.beginExecution(b), "settled");
});
