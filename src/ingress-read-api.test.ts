import assert from "node:assert/strict";
import test from "node:test";

import { IngressReadApiClient } from "./ingress-read-api.js";

test("strict group-member reads preserve an unavailable ingress error for the admin", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "NapCat unavailable" }), { status: 503 });

  try {
    const client = new IngressReadApiClient("http://127.0.0.1:6198");
    await assert.rejects(client.listGroupMembersStrict("67890"), /ingress_read_api_unavailable/);
    assert.deepEqual(await client.listGroupMembers("67890"), []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("strict group-member reads return a real member list", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    members: [{ user_id: 20001, nickname: "Tester", role: "member" }],
  }), { status: 200 });

  try {
    const client = new IngressReadApiClient("http://127.0.0.1:6198");
    assert.deepEqual(await client.listGroupMembersStrict("67890"), [
      { user_id: 20001, nickname: "Tester", role: "member" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
