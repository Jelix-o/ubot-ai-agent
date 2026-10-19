import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { api, cancelAuthRecovery, registerReauthHandler, setCsrfToken } from "../admin/src/services/api.ts";

const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
const reply = (status, error) => Response.json({ error }, { status });
function setup() {
  cancelAuthRecovery();
  setCsrfToken("old");
  globalThis.window = { location: { pathname: "/settings", href: "/settings" } };
}
afterEach(() => { cancelAuthRecovery(); globalThis.fetch = originalFetch; globalThis.window = originalWindow; });

test("concurrent CSRF failures share one refresh and replay each rejected write once", async () => {
  setup();
  let refreshes = 0, writes = 0, committed = 0;
  globalThis.fetch = async (url, options) => {
    if (url === "/api/session") { refreshes++; return Response.json({ csrfToken: "stable" }); }
    writes++;
    if (options.headers.get("X-CSRF-Token") !== "stable") return reply(403, "csrf_required");
    committed++;
    return Response.json({ ok: true });
  };
  await Promise.all([api("/api/save", { method: "POST", body: "draft-a" }), api("/api/save", { method: "POST", body: "draft-b" })]);
  assert.deepEqual({ refreshes, writes, committed }, { refreshes: 1, writes: 4, committed: 2 });
});

test("concurrent step-up failures share a dialog, preserving bodies and submitting only after verification", async () => {
  setup();
  let verified = false, dialogs = 0, finish;
  const bodies = [];
  const dispose = registerReauthHandler(() => { dialogs++; return new Promise(resolve => { finish = () => { verified = true; resolve(); }; }); });
  globalThis.fetch = async (_url, options) => {
    if (!verified) return reply(403, "recent_reauth_required");
    bodies.push(options.body);
    return Response.json({ ok: true });
  };
  const pending = Promise.all([api("/api/a", { method: "PUT", body: "unsaved-a" }), api("/api/b", { method: "POST", body: "unsaved-b" })]);
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  assert.equal(dialogs, 1);
  assert.deepEqual(bodies, []);
  finish();
  await pending;
  assert.deepEqual(bodies.sort(), ["unsaved-a", "unsaved-b"]);
  dispose();
});

test("cancel, navigation, logout and caller abort terminate waiting operations without replay", async () => {
  for (const mode of ["cancel", "navigation", "logout", "abort"]) {
    setup();
    let finish, reject, calls = 0;
    const dispose = registerReauthHandler(() => new Promise((resolve, failure) => { finish = resolve; reject = failure; }));
    globalThis.fetch = async () => { calls++; return reply(403, "recent_reauth_required"); };
    const controller = new AbortController();
    const pending = api("/api/save", { method: "POST", body: "draft", signal: controller.signal });
    const rejected = assert.rejects(pending, /取消/);
    while (!finish) await new Promise(resolve => setImmediate(resolve));
    if (mode === "cancel") reject(new Error("操作已取消"));
    else if (mode === "abort") controller.abort();
    else cancelAuthRecovery();
    await rejected;
    finish();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1, mode);
    dispose();
  }
});

test("invalid origin, bad password, network and server errors never replay or redirect", async () => {
  setup();
  for (const [status, code] of [[403, "invalid_origin"], [401, "invalid_current_password"], [401, "invalid_credentials"], [500, "failure"]]) {
    let calls = 0;
    globalThis.fetch = async () => { calls++; return reply(status, code); };
    await assert.rejects(api("/api/save", { method: "POST" }), error => error.code === code);
    assert.equal(calls, 1);
    assert.equal(window.location.href, "/settings");
  }
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new TypeError("Failed to fetch"); };
  await assert.rejects(api("/api/save", { method: "POST" }), /网络连接失败/);
  assert.equal(calls, 1);
  assert.equal(window.location.href, "/settings");
  globalThis.fetch = async () => reply(401, "unauthorized");
  await assert.rejects(api("/api/save", { method: "POST" }), error => error.code === "unauthorized");
  assert.equal(window.location.href, "/login");
});

test("each explicit recovery has a one-retry limit", async () => {
  setup();
  let writes = 0, refreshes = 0;
  globalThis.fetch = async url => {
    if (url === "/api/session") { refreshes++; return Response.json({ csrfToken: "new" }); }
    writes++;
    return reply(403, "csrf_required");
  };
  await assert.rejects(api("/api/save", { method: "POST" }), error => error.code === "csrf_required");
  assert.deepEqual({ writes, refreshes }, { writes: 2, refreshes: 1 });
  let dialogs = 0;
  const dispose = registerReauthHandler(async () => { dialogs++; });
  writes = 0;
  globalThis.fetch = async () => { writes++; return reply(403, "recent_reauth_required"); };
  await assert.rejects(api("/api/save", { method: "POST" }), error => error.code === "recent_reauth_required");
  assert.deepEqual({ writes, dialogs }, { writes: 2, dialogs: 1 });
  dispose();
});
