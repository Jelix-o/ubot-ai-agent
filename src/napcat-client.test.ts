import test from "node:test";
import assert from "node:assert/strict";

import { NapCatClient } from "./napcat-client.js";

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
