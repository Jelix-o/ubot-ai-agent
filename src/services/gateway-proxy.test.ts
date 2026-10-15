import assert from "node:assert/strict";
import test from "node:test";

import { CircuitOpenError, degradedMessage, GatewayProxy } from "./gateway-proxy.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("breaker stays closed on success and recovers failures", async () => {
  const proxy = new GatewayProxy(async () => "ok", undefined, { tripAfterFailures: 3, openMs: 50 });
  assert.equal(await proxy.call(), "ok");
  assert.equal(proxy.stateName, "closed");
});

test("breaker opens after tripAfterFailures consecutive failures and rejects without executing", async () => {
  let executions = 0;
  const proxy = new GatewayProxy(
    async () => {
      executions += 1;
      throw new Error("upstream down");
    },
    undefined,
    { tripAfterFailures: 3, openMs: 50 },
  );

  for (let i = 0; i < 3; i += 1) {
    await assert.rejects(() => proxy.call());
  }
  assert.equal(proxy.stateName, "open");
  const before = executions;

  // While open, calls are rejected without touching the upstream.
  await assert.rejects(() => proxy.call(), CircuitOpenError);
  assert.equal(executions, before, "no LLM quota consumed while open");
});

test("breaker half-opens after openMs and recovers when the upstream heals", async () => {
  let fail = true;
  const proxy = new GatewayProxy(
    async () => {
      if (fail) {
        throw new Error("boom");
      }
      return "recovered";
    },
    undefined,
    { tripAfterFailures: 2, openMs: 50 },
  );
  await assert.rejects(() => proxy.call());
  await assert.rejects(() => proxy.call());
  assert.equal(proxy.stateName, "open");

  await sleep(60);
  assert.equal(proxy.stateName, "half_open");
  fail = false;
  assert.equal(await proxy.call(), "recovered");
  assert.equal(proxy.stateName, "closed");
});

test("degraded messages are fixed per tier", () => {
  assert.equal(degradedMessage("circuit_open"), "我这会儿有点忙，稍后回你哈");
  assert.equal(degradedMessage("image_unavailable"), "那张图我这边没打开，方便重发或者简单说下内容吗？");
  assert.equal(degradedMessage("unknown_tier"), degradedMessage("unavailable"), "unknown tiers fall back");
});

test("call respects external abort signal", async () => {
  const proxy = new GatewayProxy(undefined);
  const controller = new AbortController();
  const promise = proxy.call(async (signal) => {
    await new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
  }, { signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(() => promise, /aborted/);
});

test("call enforces its internal timeout when it is the only active handle", async () => {
  const proxy = new GatewayProxy(undefined);
  const promise = proxy.call(async (signal) => {
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("timed out")), { once: true });
    });
    return "unreachable";
  }, { timeoutMs: 20 });

  await assert.rejects(() => promise, /timed out/);
});

test("slow successes never trip the breaker and cancelled calls do not poison it", async () => {
  const proxy = new GatewayProxy(undefined, undefined, { slowThresholdMs: 0, slowSampleMin: 1, tripAfterFailures: 1 });
  for (let i = 0; i < 25; i++) await proxy.call(async () => { await sleep(1); return "ok"; });
  assert.equal(proxy.stateName, "closed");
  const controller = new AbortController();
  const pending = proxy.call(async () => new Promise(() => undefined), { signal: controller.signal }); controller.abort();
  await assert.rejects(() => pending); assert.equal(proxy.stateName, "closed");
});

test("only one half-open probe runs; a healthy probe clears old failures", async () => {
  const proxy = new GatewayProxy(undefined, undefined, { tripAfterFailures: 1, openMs: 10 });
  await assert.rejects(() => proxy.call(async () => { throw new Error("down"); })); await sleep(15);
  let resolve!: (value: string) => void;
  const probe = proxy.call(() => new Promise<string>(done => { resolve = done; }));
  await assert.rejects(() => proxy.call(async () => "duplicate"), CircuitOpenError);
  resolve("ok"); assert.equal(await probe, "ok"); assert.equal(proxy.stateName, "closed");
});
