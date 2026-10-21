import assert from "node:assert/strict";
import test from "node:test";
import { ContextResolver, isDeicticImageReference, isDirectedFollowUp, isMediaReference, resolveContextByRules } from "./context-resolver.js";
import { ConversationReplyEnvelopeError, emptyConversationState, hasConversationReplyEnvelopeMarker, parseConversationReply, sanitizeConversationUpdate, type ContextResolution } from "./conversation-state.js";
import { ReplyPolicyService } from "./reply-policy-service.js";
import type { AmbientGroupContextMessage } from "../types.js";

const replyPolicy = new ReplyPolicyService();
const buildReplyPlan = (resolution: ContextResolution) => replyPolicy.plan({ resolution, state: emptyConversationState(), userId: "a" });

const messages: AmbientGroupContextMessage[] = [
  { role: "member", userId: "a", messageId: "game", text: "我只有打游戏才紧张，喝水已经成习惯了", timestamp: new Date(1).toISOString() },
  { role: "bot", messageId: "answer", text: "先改掉顺手拿水喝的动作", timestamp: new Date(2).toISOString() },
  { role: "member", userId: "b", messageId: "fish", text: "熬夜钓鱼睡过头了", timestamp: new Date(3).toISOString() },
];
const candidates = [
  { id: "games", topicId: "t-game", ownerUserId: "a", title: "游戏紧张", lastUserInput: messages[0].text, lastReply: messages[1].text, updatedAt: 1 },
  { id: "fishing", topicId: "t-fish", ownerUserId: "b", title: "熬夜钓鱼", lastUserInput: messages[2].text, lastReply: "", updatedAt: 3 },
];

test("semantic context returns to the relevant topic and rejects invented ids", async () => {
  let supplied = "";
  const resolver = new ContextResolver(async (_instruction, data) => {
    supplied = data;
    return JSON.stringify({ intent: "confirm", relation: "follow_up", resolvedInput: "打游戏紧张是因为太认真了吗", topicCandidateId: "games", selectedMessageIds: ["game", "answer", "private-other-group"], needsMoreContext: false });
  });
  const result = await resolver.resolve({ userId: "a", text: "是太认真了吗", hasImages: false, messages, candidates });
  assert.equal(result.topicCandidateId, "games");
  assert.deepEqual(result.selectedMessageIds, ["game", "answer"]);
  assert.match(supplied, /熬夜钓鱼/);
  assert.equal(buildReplyPlan(result).explanation, "on_request");
});

test("a readable explicit reply is an authority anchor for short reactions and never calls the auxiliary resolver", async () => {
  let modelCalls = 0;
  const resolver = new ContextResolver(async () => {
    modelCalls += 1;
    return JSON.stringify({ intent: "chat", relation: "new", resolvedInput: "错误的旧话题", needsMoreContext: true, clarification: "把引用内容再说一遍" });
  });
  const result = await resolver.resolve({
    userId: "a", text: "？？？？", hasImages: false, replyToMessageId: "bot-answer",
    reference: { messageId: "bot-answer", text: "刚才机器人的回答", images: [] },
    messages, candidates,
  });

  assert.equal(modelCalls, 0);
  assert.equal(result.needsMoreContext, false);
  assert.equal(result.clarification, undefined);
  assert.deepEqual(result.selectedMessageIds, ["bot-answer"]);
  assert.deepEqual(result.anchor, { kind: "explicit_reply", messageIds: ["bot-answer"] });
  const plan = buildReplyPlan(result);
  assert.equal(plan.anchor?.kind, "explicit_reply");
  assert.match(replyPolicy.instruction(plan, emptyConversationState()), /已恢复引用消息/);
});

test("deictic person questions are media references without swallowing named identity queries", () => {
  for (const text of ["这是哪位", "这是谁", "图里是谁", "图中的这个人是谁", "这个人是谁", "她是谁"]) {
    assert.equal(isDeicticImageReference(text), true, text);
  }
  for (const text of ["这是哪位", "这是谁", "图里是谁", "图中的这个人是谁", "这个人是谁"]) assert.equal(isMediaReference(text), true, text);
  assert.equal(isMediaReference("她是谁"), false);
  assert.equal(isMediaReference("她是谁", { includeDeictic: true }), true);
  for (const text of ["鸡哥是谁", "成员甲是哪位", "谁是鸡哥", "认识鸡哥吗"]) {
    assert.equal(isDeicticImageReference(text), false, text);
    assert.equal(isMediaReference(text), false, text);
  }
  const imageReply = resolveContextByRules({
    userId: "a", text: "这是哪位", hasImages: false, replyToMessageId: "photo",
    reference: { messageId: "photo", text: "", images: [{ url: "https://example.test/photo.png" }] },
    messages: [], candidates: [],
  });
  assert.equal(imageReply.intent, "image");
  assert.equal(imageReply.relation, "supplement");
  assert.deepEqual(imageReply.mediaSourceMessageIds, ["photo"]);
});

test("lookup ellipsis is resolved before tools see it and explicit ambiguity stays specific", async () => {
  const resolver = new ContextResolver(async () => JSON.stringify({ intent: "lookup", relation: "follow_up", resolvedInput: "杭州今天的天气", selectedMessageIds: ["game"] }));
  const resolved = await resolver.resolve({ userId: "a", text: "杭州", hasImages: false, messages, candidates });
  assert.equal(buildReplyPlan(resolved).resolvedInput, "杭州今天的天气");
  const ambiguous = await new ContextResolver(async () => JSON.stringify({ intent: "opinion", relation: "new", resolvedInput: "你来说说", topicCandidateId: "invented", selectedMessageIds: [], clarification: "你说游戏紧张那段，还是钓鱼那段？" }))
    .resolve({ userId: "a", text: "结合上面说说", hasImages: false, messages, candidates });
  assert.equal(ambiguous.topicCandidateId, undefined);
  assert.equal(buildReplyPlan(ambiguous).action, "clarify");
  assert.match(ambiguous.clarification!, /游戏.*钓鱼/);
});

test("unavailable semantic selection keeps the bounded shared discussion, including bot replies", async () => {
  const input = { userId: "a", text: "常工与中正比如何", hasImages: false, messages, candidates };
  const fallback = await new ContextResolver(async () => "malformed").resolve(input);
  assert.equal(fallback.source, "rules");
  assert.deepEqual(fallback.selectedMessageIds, ["game", "answer", "fish"]);
  const ordinary = resolveContextByRules({ ...input, text: "这有风险吗" });
  assert.equal(buildReplyPlan(ordinary).explanation, "on_request");
  assert.match(replyPolicy.instruction(buildReplyPlan(ordinary), emptyConversationState()), /本轮直接回应当前问题/);
  assert.equal(isDirectedFollowUp("那你觉得呢"), true);
  assert.equal(isDirectedFollowUp("所以正常吗"), false);
});

test("a timed-out semantic resolver keeps a selected old branch out of unrelated ambient evidence", async () => {
  const result = await new ContextResolver(async () => {
    throw new Error("context timeout");
  }).resolve({ userId: "a", text: "游戏紧张为什么还会这样", hasImages: false, messages, candidates });

  assert.equal(result.source, "rules");
  assert.equal(result.topicCandidateId, "games");
  assert.equal(result.anchor?.kind, "explicit_follow_up");
  assert.deepEqual(result.selectedMessageIds, []);
});

test("state attribution rejects another person's condition and unknown evidence", () => {
  const update = sanitizeConversationUpdate({
    knownFacts: [
      { userId: "a", text: "只在游戏时紧张", sourceMessageIds: ["game"] },
      { userId: "b", text: "喝水成习惯了", sourceMessageIds: ["game"] },
      { userId: "a", text: "不存在的病史", sourceMessageIds: ["invented"] },
    ], questions: [{ key: "x", userId: "outsider", text: "问谁", status: "answered" }],
    conclusion: { text: "当前判断", evidenceIds: ["game", "unknown"] },
  }, new Map([["game", "a"], ["fish", "b"]]));
  assert.equal(update.knownFacts.length, 1);
  assert.equal(update.questions.length, 0);
  assert.deepEqual(update.conclusion?.evidenceIds, ["game"]);
});

test("reply envelopes expose only natural text and never leak truncated metadata", () => {
  const parsed = parseConversationReply('{"text":"行，队里的大腿是吧😂","stateUpdate":{"coveredPoints":[]},"review":{"reasksKnown":false}}');
  assert.equal(parsed.text, "行，队里的大腿是吧😂");
  assert.deepEqual(parsed.check, { repeatsAnswered: false, reasksKnown: false, unsupportedReversal: false });
  assert.throws(() => parseConversationReply('{"text":"answer","stateUpdate":{'), ConversationReplyEnvelopeError);
  assert.throws(() => parseConversationReply('{"stateUpdate":{}}'), ConversationReplyEnvelopeError);
  assert.throws(
    () => parseConversationReply('先把眼前这一下打好","stateUpdate":{"coveredPoints":["旧建议"]},"review":{"repeatsAnswered":false}}'),
    ConversationReplyEnvelopeError,
  );
  assert.throws(
    () => parseConversationReply('行，先缓一缓。\n"review":{"reasksKnown":false}'),
    ConversationReplyEnvelopeError,
  );
  for (const field of [
    "knownFacts", "coveredPoints", "questions", "conclusion", "mediaObservations",
    "repeatsAnswered", "reasksKnown", "unsupportedReversal",
  ]) {
    assert.equal(hasConversationReplyEnvelopeMarker(`正文，"${field}":[]`), true);
    assert.throws(() => parseConversationReply(`正文，"${field}":[]`), ConversationReplyEnvelopeError);
  }
  assert.throws(() => parseConversationReply('{"coveredPoints":[]}'), ConversationReplyEnvelopeError);
  assert.equal(hasConversationReplyEnvelopeMarker('正常说法："标题": "问题"'), false);
  assert.equal(parseConversationReply("自然回复").text, "自然回复");
});

test("expanded candidates stay within the auxiliary JSON budget and preserve the newest discussion", async () => {
  const expanded = Array.from({ length: 200 }, (_, index) => ({ ...messages[0], messageId: `m-${index}`, text: "长内容".repeat(170) }));
  let received: any;
  await new ContextResolver(async (_instruction, data) => {
    assert.ok(data.length <= 75_000);
    received = JSON.parse(data);
    return JSON.stringify({ intent: "opinion", relation: "new", resolvedInput: "评价刚才的讨论", selectedMessageIds: ["m-199"] });
  }).resolve({ userId: "a", text: "结合上面说说", hasImages: false, messages: expanded, candidates });
  assert.equal(received.messages.at(-1).messageId, "m-199");
  assert.ok(received.messages.length < 200);
});
