import assert from "node:assert/strict";
import test from "node:test";

import { LlmSemaphore } from "./llm-semaphore.js";
import { CircuitOpenError, degradedMessage, GatewayProxy } from "./gateway-proxy.js";
import type { AiReply } from "../types.js";

/**
 * Regression test for R1+R2: the worker's combined gate (semaphore → breaker)
 * must degrade with fixed wording when the semaphore is saturated or the
 * circuit is open, without consuming any LLM quota.
 */
function degradedReply(tier: string): AiReply {
  return { text: degradedMessage(tier), model: "degraded", skillId: "degraded", promptChars: 0 };
}

test("combined gate degrades on semaphore saturation without calling the LLM", async () => {
  const semaphore = new LlmSemaphore(1, 20);
  const gateway = new GatewayProxy(undefined, undefined, { tripAfterFailures: 100, openMs: 10_000 });
  let llmCalls = 0;

  // Hold the single permit.
  const hold = semaphore.acquire().then((release) => release);

  const gate = async (task: () => Promise<AiReply>): Promise<AiReply> => {
    let release: (() => void) | undefined;
    try {
      release = await semaphore.acquire();
    } catch {
      return degradedReply("llm_semaphore_timeout");
    }
    try {
      return await gateway.call<AiReply>(async () => {
        llmCalls += 1;
        return task();
      });
    } finally {
      release();
    }
  };

  const result = await gate(async () => ({ text: "ok", model: "m", skillId: "s", promptChars: 0 }));
  assert.equal(result.text, degradedMessage("llm_semaphore_timeout"));
  assert.equal(llmCalls, 0, "no LLM quota consumed on semaphore timeout");
  await hold;
});

test("combined gate degrades on open circuit without calling the LLM", async () => {
  const semaphore = new LlmSemaphore(4, 500);
  const gateway = new GatewayProxy(undefined, undefined, { tripAfterFailures: 2, openMs: 60_000 });
  let llmCalls = 0;

  // Trip the breaker.
  await gateway.call<AiReply>(async () => { throw new Error("boom"); }).catch(() => undefined);
  await gateway.call<AiReply>(async () => { throw new Error("boom"); }).catch(() => undefined);
  assert.equal(gateway.stateName, "open");

  const gate = async (task: () => Promise<AiReply>): Promise<AiReply> => {
    const release = await semaphore.acquire();
    try {
      return await gateway.call<AiReply>(async () => {
        llmCalls += 1;
        return task();
      });
    } catch (error) {
      if (error instanceof CircuitOpenError) {
        return degradedReply("circuit_open");
      }
      throw error;
    } finally {
      release();
    }
  };

  const result = await gate(async () => ({ text: "ok", model: "m", skillId: "s", promptChars: 0 }));
  assert.equal(result.text, degradedMessage("circuit_open"));
  assert.equal(llmCalls, 0, "no LLM quota consumed while circuit is open");
});
