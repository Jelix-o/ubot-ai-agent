import test from "node:test";
import assert from "node:assert/strict";

import { NapCatClient } from "./napcat-client.js";
import { NapCatActionRejectedError, NapCatActionOutcomeUnknownError } from "./napcat-action-errors.js";

test("HTTP forward API keeps literal content and never retries ambiguous requests", async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let mode = "ok", attempts = 0;
  const text = "[CQ:at,qq=all]\nmagnet:?xt=urn:btih:abc&dn=%E5%AE%8C%E6%95%B4&tr=udp%3A%2F%2Ftracker.test";
  globalThis.fetch = async (input, init) => {
    attempts++;
    assert.equal(String(input), "http://127.0.0.1:3001/send_group_forward_msg");
    assert.deepEqual(JSON.parse(String(init?.body)), { group_id: 67890, messages: [{ type: "node", data: {
      user_id: 12345, nickname: "会仙", content: [{ type: "text", data: { text } }],
    } }] });
    if (mode === "network") throw new Error("lost connection");
    if (mode === "404") return new Response("unsupported", { status: 404 });
    if (mode === "500") return new Response("unknown", { status: 500 });
    if (mode === "invalid") return new Response("invalid JSON", { status: 200 });
    return new Response(JSON.stringify({ status: mode.startsWith("rejected") ? "failed" : "ok", retcode: mode.startsWith("rejected") ? 1404 : 0, message: mode === "rejected-timeout" ? "send timeout" : "",
      data: mode === "ok" ? { message_id: 9002 } : {} }), { status: 200 });
  };
  const client = new NapCatClient({ wsUrl: "ws://127.0.0.1:3001/onebot/v11/ws" });
  const nodes = [{ senderId: "12345", senderName: "会仙", text }];
  assert.deepEqual(await client.sendGroupForwardMessage("67890", nodes), { messageId: "9002", platformMessageId: "9002" });
  for (const next of ["rejected", "rejected-timeout", "404", "500", "network", "invalid", "missing-id"]) {
    mode = next;
    await assert.rejects(client.sendGroupForwardMessage("67890", nodes), ["rejected", "404"].includes(next) ? NapCatActionRejectedError : NapCatActionOutcomeUnknownError);
  }
  assert.equal(attempts, 8);
});

test("falls back to HTTP send_group_msg when websocket is not open", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify({ data: { message_id: 7788 } }), { status: 200 });
  };

  try {
    const client = new NapCatClient({
      wsUrl: "ws://127.0.0.1:3001/onebot/v11/ws",
      accessToken: "secret",
    });

    const receipt = await client.sendGroupMessage("67890", "hello");

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "http://127.0.0.1:3001/send_group_msg");
    assert.match(String(calls[0]?.init?.body), /67890/);
    assert.deepEqual(receipt, { messageId: "7788", platformMessageId: "7788" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sends group images as OneBot image segments", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify({ data: { message_id: 7789 } }), { status: 200 });
  };

  try {
    const client = new NapCatClient({
      wsUrl: "ws://127.0.0.1:3001/onebot/v11/ws",
    });
    const imageFile = "base64://blacklisted-at-meme";
    const receipt = await client.sendGroupImage("67890", imageFile);

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "http://127.0.0.1:3001/send_group_msg");
    assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
      group_id: 67890,
      message: [{
        type: "image",
        data: { file: imageFile },
      }],
    });
    assert.deepEqual(receipt, { messageId: "7789", platformMessageId: "7789" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("deduplicates concurrent group-member loads and caches the result", async () => {
  let memberRequests = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    if (String(input).endsWith("/get_group_member_list")) {
      memberRequests += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return new Response(JSON.stringify({ data: [{ user_id: 20001, nickname: "Tester" }] }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  };

  try {
    const client = new NapCatClient({ wsUrl: "ws://127.0.0.1:3001/onebot/v11/ws" });
    const [first, second] = await Promise.all([client.listGroupMembers("67890"), client.listGroupMembers("67890")]);
    const cached = await client.listGroupMembers("67890");

    assert.equal(memberRequests, 1);
    assert.equal(first[0]?.nickname, "Tester");
    assert.equal(second[0]?.nickname, "Tester");
    assert.equal(cached[0]?.nickname, "Tester");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("emits groupMessage for group message events", async () => {
  const client = new NapCatClient({
    wsUrl: "ws://127.0.0.1:3001",
  });

  const eventPromise = new Promise<number>((resolve) => {
    client.once("groupMessage", (event) => resolve(event.group_id));
  });

  (client as any).handleMessage(
    JSON.stringify({
      post_type: "message",
      message_type: "group",
      self_id: 12345,
      group_id: 67890,
      user_id: 10001,
      message_id: 1,
      raw_message: "@bot hi",
      message: [
        { type: "at", data: { qq: "12345" } },
        { type: "text", data: { text: " hi" } },
      ],
    }),
  );

  assert.equal(await eventPromise, 67890);
});
