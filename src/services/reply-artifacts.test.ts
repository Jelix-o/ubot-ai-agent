import assert from "node:assert/strict";
import test from "node:test";
import { cleanReplyArtifacts, cleanReplyHistory, cleanReplyMessageParts, hasUnsafeReplyArtifacts, observeReplyArtifacts } from "./reply-artifacts.js";
import { cleanConversationReply, ConversationReplyEnvelopeError, parseConversationReply } from "./conversation-state.js";

test("recognized suffixes are removed without losing prose or meme selection", () => {
  for (const suffix of ['{"oops":""}', '{ "text" : ... }', '{"text":…}', '{"text":……}', '{"stateUpdate":{"coveredPoints":["a } brace"]},"review":{"reasksKnown":false}}']) {
    const result = cleanReplyArtifacts(`第一句。\n第二句 ${suffix} [[meme:work]]`);
    assert.equal(result.text, "第一句。\n第二句 [[meme:work]]");
    assert.equal(result.removed.length, 1);
    assert.equal(result.ambiguous, false);
  }
  const consecutive = cleanReplyArtifacts('正文 {"text":...} {"oops":""}');
  assert.equal(consecutive.text, "正文");
  assert.equal(consecutive.removed.length, 2);
});

test("the scanner preserves code, inline examples, quotations and requested JSON", () => {
  for (const example of [
    '示例：`{"oops":""}`', '```json\n{"oops":""}\n```', '``示例 ` {"text":...}``',
    '> {"oops":""}', '示例：“{"text":...}”', `示例：'{"oops":""}'`, '数学中的 {x} 和集合 {y}',
  ]) {
    assert.equal(cleanReplyArtifacts(example).text, example);
    assert.equal(hasUnsafeReplyArtifacts(example), false);
  }
  for (const userInput of ['输出 JSON', '讲解对象的语法', '解释这段代码', '请原样引用 {"oops":""}']) {
    const example = '{"oops":""}';
    assert.equal(cleanConversationReply({ text: example }, { userInput }).text, example);
    assert.equal(hasUnsafeReplyArtifacts(example, userInput), false);
  }
  assert.equal(cleanReplyArtifacts('示例 `{"a":1}`\n正文 {"oops":""}').text, '示例 `{"a":1}`\n正文');
  assert.equal(hasUnsafeReplyArtifacts('原样是 {"review":{}}', '解释这个 {"review":{}}'), false);
  assert.equal(parseConversationReply('```json\n{"text":...}\n```', { userInput: '展示 JSON 示例' }).text, '```json\n{"text":...}\n```');
  assert.equal(cleanReplyArtifacts('正文 {"oops":""}', { userInput: '不要 JSON，正常说话' }).text, '正文');
  assert.equal(parseConversationReply('{"review":{}}', { userInput: '输出 JSON 示例' }).text, '{"review":{}}');
});

test("unknown, broken and protocol-only objects are blocked without guessed deletion", () => {
  for (const example of ['正文 {"a":1}', '正文 {"oops":"meaningful"}', '正文 {"text":', '正文","text":...}', '正文","oops":""}', '正文 {"stateUpdate":{"unknown":1}}', '{"oops":""}']) {
    assert.equal(cleanReplyArtifacts(example).ambiguous, true);
    assert.throws(() => cleanConversationReply({ text: example }), ConversationReplyEnvelopeError);
  }
});

test("complete envelopes and suffixes inside or outside their text are normalized", () => {
  const envelope = JSON.stringify({ text: '正常正文 {"oops":""}', stateUpdate: { coveredPoints: ["a"] } });
  const parsed = parseConversationReply(envelope + ' {"text":...}');
  assert.equal(parsed.text, "正常正文");
  assert.deepEqual(parsed.update, { coveredPoints: ["a"] });
  assert.throws(() => parseConversationReply(JSON.stringify({ text: '正文 {"other":true}', stateUpdate: {} })), ConversationReplyEnvelopeError);
  assert.equal(parseConversationReply(JSON.stringify({ text: '```json\n{"review":{}}\n```', stateUpdate: {} })).text, '```json\n{"review":{}}\n```');
});

test("multi-message cleanup preserves boundaries and removes an object-only last bubble", () => {
  const parts = cleanReplyMessageParts(['第一句', '第二句', '{"text":...} [[meme:work]]']);
  assert.deepEqual(parts.messages, ['第一句', '第二句 [[meme:work]]']);
  const reply = cleanConversationReply({ text: '第一句\n第二句 {"oops":""}', messages: ['第一句', '第二句 {"oops":""}'] });
  assert.deepEqual(reply.messages, ['第一句', '第二句']);
  assert.equal(reply.text, '第一句\n第二句');
});

test("observations contain only bounded artifact names and counters", () => {
  const events: string[] = [];
  const stop = observeReplyArtifacts(metric => events.push(metric));
  try {
    cleanReplyArtifacts('private prose {"oops":""}', { history: true });
    cleanReplyArtifacts('private prose {"unknown":1}');
    hasUnsafeReplyArtifacts('private prose {"oops":""}');
  } finally { stop(); }
  assert.deepEqual(events, ['reply_artifact_history_cleaned_oops_placeholder', 'reply_artifact_blocked']);
});

test("history cleanup is an immutable assistant-only projection with original request protection", () => {
  const turns = [
    { role: "user", content: '普通问题 {"oops":""}' },
    { role: "assistant", content: '正常答案 {"text":...}' },
    { role: "user", content: '输出 JSON' },
    { role: "assistant", content: '{"oops":""}' },
  ];
  const before = JSON.stringify(turns);
  const cleaned = cleanReplyHistory(turns);
  assert.equal(cleaned[0], turns[0]);
  assert.equal(cleaned[1]?.content, '正常答案');
  assert.equal(cleaned[3], turns[3]);
  assert.equal(JSON.stringify(turns), before);
});
