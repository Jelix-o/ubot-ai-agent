import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import { SharedDb } from "../shared/sqlite.js";
import { AiService } from "./ai-service.js";
import { HTML_PREVIEW_DEFAULT_LEASE_MS } from "./html-preview-repository.js";
import { HTML_PREVIEW_LEASE_RENEWAL_MS, HtmlPreviewService } from "./html-preview-service.js";
import { SystemSettingsStore } from "./system-settings-store.js";

const PAGE = JSON.stringify({ title: "test", html: "<!doctype html><html><body>test</body></html>" });

async function fixture(t: test.TestContext) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "html-budget-"));
  const db = new SharedDb(path.join(dir, "test.db"));
  const rootDir = path.join(dir, "previews");
  const service = new HtmlPreviewService({ sharedDb: db, rootDir, publicBaseUrl: "https://preview.invalid", minFreeBytes: 0 });
  t.after(async () => { db.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, db, rootDir, service };
}

test("HTML SDK and cancellation timer allow ten minutes despite a short chat timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  let sdkSignal: AbortSignal | undefined;
  let sdkTimeout: number | undefined;
  const service = new AiService("https://example.invalid/v1", "test-key", "preview-model", {
    create(_args: unknown, options: { signal: AbortSignal; timeout: number }) {
      sdkSignal = options.signal;
      sdkTimeout = options.timeout;
      return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
    },
  } as never, { timeoutMs: 45_000 });
  const pending = service.generateStaticHtml({ request: "SVG animation" });
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await nextTurn();
  assert.equal(sdkTimeout, 600_000);
  t.mock.timers.tick(300_000);
  assert.equal(sdkSignal?.aborted, false);
  t.mock.timers.tick(299_999);
  assert.equal(sdkSignal?.aborted, false);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(sdkSignal?.aborted, true);
});

test("long HTML generation renews its two-minute claim every thirty seconds", async (t) => {
  const { service } = await fixture(t);
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.now() });
  const queued = await service.enqueue({ groupId: "test", creatorUserId: "member", sourceMessageId: "long" });
  let finish!: (output: string) => void;
  let started!: () => void;
  const generating = new Promise<void>(resolve => { started = resolve; });
  const pending = service.processNext({ id: queued.page.id, request: "test", generate: async () => {
    started();
    return new Promise<string>(resolve => { finish = resolve; });
  } });
  await generating;
  for (let tick = 0; tick < 24; tick += 1) {
    t.mock.timers.tick(HTML_PREVIEW_LEASE_RENEWAL_MS);
    assert.equal(service.repository.get(queued.page.id)?.leaseExpiresAt, Date.now() + HTML_PREVIEW_DEFAULT_LEASE_MS);
    assert.equal(service.repository.claimNext({ id: queued.page.id }), undefined);
  }
  finish(PAGE);
  assert.equal((await pending).status, "published");
  const renewals = t.mock.method(service.repository, "renewLease");
  t.mock.timers.tick(HTML_PREVIEW_DEFAULT_LEASE_MS);
  assert.equal(renewals.mock.callCount(), 0);
});

test("removing an active page cancels generation without publishing or announcing", async (t) => {
  const { service, db, rootDir } = await fixture(t);
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.now() });
  const queued = await service.enqueue({ groupId: "test", creatorUserId: "member", sourceMessageId: "removed" });
  let started!: () => void;
  let aborted = false;
  const generating = new Promise<void>(resolve => { started = resolve; });
  const pending = service.processNext({ id: queued.page.id, request: "test", generate: async (_request, signal) => {
    started();
    return new Promise<string>((_resolve, reject) => signal!.addEventListener("abort", () => {
      aborted = true;
      reject(signal!.reason);
    }, { once: true }));
  } });
  await generating;
  await service.remove(queued.page.id);
  t.mock.timers.tick(HTML_PREVIEW_LEASE_RENEWAL_MS);
  assert.equal((await pending).errorCode, "html_preview_publish_lease_lost");
  assert.equal(aborted, true);
  assert.equal((await service.get(queued.page.id))?.status, "deleted");
  assert.equal((db.db.prepare("SELECT COUNT(*) AS count FROM outbox").get() as { count: number }).count, 0);
  await assert.rejects(access(path.join(rootDir, "pages", queued.page.id)));
});

test("expired claims cannot be renewed or extend a replacement claim", async (t) => {
  const { service } = await fixture(t);
  const now = Date.now();
  const queued = await service.enqueue({ groupId: "test", creatorUserId: "member", sourceMessageId: "reclaimed", now });
  const first = service.repository.claimNext({ id: queued.page.id, now })!;
  const expiredAt = now + HTML_PREVIEW_DEFAULT_LEASE_MS;
  assert.equal(service.repository.renewLease(queued.page.id, first.leaseToken, expiredAt), false);
  const second = service.repository.claimNext({ id: queued.page.id, now: expiredAt })!;
  assert.notEqual(second.leaseToken, first.leaseToken);
  assert.equal(service.repository.renewLease(queued.page.id, first.leaseToken, expiredAt + 1), false);
  assert.equal(service.repository.renewLease(queued.page.id, second.leaseToken, expiredAt + 1), true);
});

test("HTML settings round-trip twenty-minute totals and reject invalid limits", async (t) => {
  const { dir } = await fixture(t);
  const file = path.join(dir, "settings.json");
  const store = new SystemSettingsStore(file);
  const routing = (await store.get()).replyRouting!;
  assert.equal(routing.htmlAttemptTimeoutMs, 600_000);
  assert.equal(routing.htmlTotalTimeoutMs, 1_200_000);
  await store.update({ replyRouting: routing });
  assert.deepEqual((await new SystemSettingsStore(file).get()).replyRouting, routing);
  for (const [key, value] of [["htmlAttemptTimeoutMs", 600_001], ["htmlTotalTimeoutMs", 1_200_001], ["chatTotalTimeoutMs", 600_001]] as const) {
    await assert.rejects(store.update({ replyRouting: { ...routing, [key]: value } }), /invalid_reply_routing_timeout/);
  }
  await assert.rejects(store.update({ replyRouting: { ...routing, htmlTotalTimeoutMs: 599_999 } }), /invalid_reply_routing_timeout/);
});
