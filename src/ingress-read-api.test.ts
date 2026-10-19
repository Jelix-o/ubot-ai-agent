import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { AddressInfo } from "node:net";
import test from "node:test";

import { IngressReadApi, IngressReadApiClient } from "./ingress-read-api.js";
import type { MessageImageInput } from "./types.js";

const READ_API_TOKEN = "test-ingress-read-token";

async function startReadApi(t: test.TestContext): Promise<{ baseUrl: string; rawServer: Server }> {
  const api = new IngressReadApi({
    async getHealthStatus() {
      return { ok: true, detail: "healthy" };
    },
    async listGroups() {
      return [{ group_id: 12345, group_name: "测试群" }];
    },
    async resolveImageInputs(images: MessageImageInput[]) {
      return images;
    },
  } as never, 0, READ_API_TOKEN);
  const rawServer = (api as unknown as { server: Server }).server;
  await api.start();
  const address = rawServer.address() as AddressInfo;
  t.after(() => api.close());
  return { baseUrl: `http://127.0.0.1:${address.port}`, rawServer };
}

test("strict group-member reads preserve an unavailable ingress error for the admin", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${READ_API_TOKEN}`);
    return new Response(JSON.stringify({ error: "NapCat unavailable" }), { status: 503 });
  };

  try {
    const client = new IngressReadApiClient("http://127.0.0.1:6198", READ_API_TOKEN);
    await assert.rejects(client.listGroupMembersStrict("67890"), /ingress_read_api_unavailable/);
    assert.deepEqual(await client.listGroupMembers("67890"), []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("strict group-member reads return a real member list", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${READ_API_TOKEN}`);
    return new Response(JSON.stringify({
      members: [{ user_id: 20001, nickname: "Tester", role: "member" }],
    }), { status: 200 });
  };

  try {
    const client = new IngressReadApiClient("http://127.0.0.1:6198", READ_API_TOKEN);
    assert.deepEqual(await client.listGroupMembersStrict("67890"), [
      { user_id: 20001, nickname: "Tester", role: "member" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("localhost ingress read API keeps health open but protects reads and limits request bodies", async (t) => {
  const { baseUrl, rawServer } = await startReadApi(t);
  assert.equal(rawServer.headersTimeout, 10_000);
  assert.equal(rawServer.requestTimeout, 15_000);

  const health = await fetch(`${baseUrl}/read/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, detail: "healthy" });

  const unauthorized = await fetch(`${baseUrl}/read/groups`);
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(await unauthorized.json(), { error: "unauthorized" });

  const wrongBearer = await fetch(`${baseUrl}/read/groups`, {
    headers: { Authorization: "Bearer wrong-ingress-read-token" },
  });
  assert.equal(wrongBearer.status, 401);
  assert.deepEqual(await wrongBearer.json(), { error: "unauthorized" });

  const groups = await fetch(`${baseUrl}/read/groups`, {
    headers: { Authorization: `Bearer ${READ_API_TOKEN}` },
  });
  assert.equal(groups.status, 200);
  assert.deepEqual(await groups.json(), { groups: [{ group_id: 12345, group_name: "测试群" }] });

  const oversized = await fetch(`${baseUrl}/read/images`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${READ_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ images: ["x".repeat(1024 * 1024)] }),
  });
  assert.equal(oversized.status, 413);
  assert.deepEqual(await oversized.json(), { error: "request_body_too_large" });
});

test("ingress read API rejects an occupied port before ingress reports startup success", async (t) => {
  const blocker = createServer();
  await new Promise<void>((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise<void>((resolve, reject) => blocker.close((error) => error ? reject(error) : resolve())));
  const port = (blocker.address() as AddressInfo).port;
  const api = new IngressReadApi({} as never, port, READ_API_TOKEN);

  await assert.rejects(api.start(), (error: unknown) => {
    assert.equal((error as NodeJS.ErrnoException).code, "EADDRINUSE");
    return true;
  });
});
