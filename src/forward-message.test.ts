import assert from "node:assert/strict";
import test from "node:test";

import type { MessageTransport } from "./bot.js";
import { sendForwardOrFallback, type ForwardMessageNode } from "./forward-message.js";
import { NapCatActionOutcomeUnknownError, NapCatActionRejectedError } from "./napcat-action-errors.js";

const nodes: ForwardMessageNode[] = [{ senderId: "12345", senderName: "会仙", text: "literal magnet:?xt=urn:btih:abc&tr=udp" }];
const options = { autoRecall: { afterMs: 90_000, deadlineMs: 105_000 } };

function transport(overrides: Partial<MessageTransport> = {}): MessageTransport {
  return {
    async sendGroupMessage() { return { platformMessageId: "fallback-message" }; },
    async sendGroupImage() {},
    ...overrides,
  };
}

test("forward delivery reports the card receipt and passes recall metadata only to the forward transport", async () => {
  let passedOptions: unknown;
  const result = await sendForwardOrFallback(transport({
    async sendGroupForwardMessage(groupId, sentNodes, receivedOptions) {
      assert.equal(groupId, "67890");
      assert.equal(sentNodes, nodes);
      passedOptions = receivedOptions;
      return { platformMessageId: "card-message" };
    },
  }), "67890", nodes, "fallback", options);

  assert.deepEqual(passedOptions, options);
  assert.deepEqual(result, { kind: "forward", receipt: { platformMessageId: "card-message" } });
});

test("missing forward support or an explicit rejection reports fallback delivery", async () => {
  const missing = await sendForwardOrFallback(transport(), "67890", nodes, "fallback", options);
  assert.deepEqual(missing, { kind: "fallback", receipt: { platformMessageId: "fallback-message" } });

  const rejected = await sendForwardOrFallback(transport({
    async sendGroupForwardMessage() { throw new NapCatActionRejectedError("unsupported"); },
  }), "67890", nodes, "fallback", options);
  assert.deepEqual(rejected, { kind: "fallback", receipt: { platformMessageId: "fallback-message" } });
});

test("an ambiguous forward result is never converted to a fallback", async () => {
  await assert.rejects(
    sendForwardOrFallback(transport({
      async sendGroupForwardMessage() { throw new NapCatActionOutcomeUnknownError("timeout"); },
    }), "67890", nodes, "fallback", options),
    NapCatActionOutcomeUnknownError,
  );
});
