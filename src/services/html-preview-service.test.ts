import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SharedDb } from "../shared/sqlite.js";
import { HTML_PREVIEW_RETENTION_MS } from "./html-preview-repository.js";
import {
  HtmlPreviewError,
  HtmlPreviewService,
  parseHtmlPreviewRequest,
  sanitizeStaticHtml,
} from "./html-preview-service.js";

const SAFE_PAGE = [
  "<!doctype html>",
  "<html>",
  "<head><title>任务看板</title><style>body { color: #222; }</style></head>",
  "<body><main id=\"main\"><button type=\"button\">开始</button><script>document.querySelector(\"button\").textContent = \"完成\";</script></main></body>",
  "</html>",
].join("");

async function createFixture(t: test.TestContext): Promise<{
  db: SharedDb;
  rootDir: string;
  service: HtmlPreviewService;
}> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "html-preview-service-"));
  const db = new SharedDb(path.join(dir, "bot-shared.db"));
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const rootDir = path.join(dir, "generated-pages");
  return {
    db,
    rootDir,
    service: new HtmlPreviewService({
      sharedDb: db,
      rootDir,
      publicBaseUrl: "https://preview.9958.uk",
      minFreeBytes: 0,
    }),
  };
}

async function publish(
  service: HtmlPreviewService,
  input: { sourceMessageId: string; now: number; expiresAt?: number },
): Promise<{ id: string; expiresAt: number }> {
  const queued = await service.enqueue({
    groupId: "group-1",
    creatorUserId: "member-1",
    sourceMessageId: input.sourceMessageId,
    request: "做一个任务看板",
    now: input.now,
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
  });
  const result = await service.processNext({
    id: queued.page.id,
    request: "做一个任务看板",
    now: input.now,
    generate: async () => JSON.stringify({ title: "任务看板", html: SAFE_PAGE }),
  });
  assert.equal(result.status, "published");
  assert.equal(result.page?.id, queued.page.id);
  assert.equal(result.previewUrl, `https://preview.9958.uk/p/${queued.page.id}/`);
  return { id: queued.page.id, expiresAt: queued.page.expiresAt ? Date.parse(queued.page.expiresAt) : input.expiresAt ?? input.now + HTML_PREVIEW_RETENTION_MS };
}

test("HTML preview requests require an explicit command or a direct page-generation mention", () => {
  assert.deepEqual(parseHtmlPreviewRequest("#网页 做一个任务看板", false), {
    request: "做一个任务看板",
    source: "command",
  });
  assert.deepEqual(parseHtmlPreviewRequest("#html make a landing page", false), {
    request: "make a landing page",
    source: "command",
  });
  assert.deepEqual(parseHtmlPreviewRequest("@会仙 请帮我生成一个静态页面，展示待办事项", true), {
    request: "请帮我生成一个静态页面，展示待办事项",
    source: "natural",
  });
  assert.equal(parseHtmlPreviewRequest("请生成一个静态页面，展示待办事项", false), undefined);
  assert.equal(parseHtmlPreviewRequest("@会仙 我喜欢这个网页的配色", true), undefined);
});

test("static HTML sanitizer rejects network access and event handlers", () => {
  assert.throws(
    () => sanitizeStaticHtml("<!doctype html><html><head><title>x</title></head><body><script>fetch('https://example.com')</script></body></html>"),
    (error: unknown) => error instanceof HtmlPreviewError && error.code === "html_preview_network_disallowed",
  );
  assert.throws(
    () => sanitizeStaticHtml("<!doctype html><html><head><title>x</title></head><body><button onclick=\"alert(1)\">x</button></body></html>"),
    (error: unknown) => error instanceof HtmlPreviewError && error.code === "html_preview_attribute_disallowed",
  );
});

test("HTML previews publish atomically, expire after thirty days, and can be deleted", async (t) => {
  const { db, rootDir, service } = await createFixture(t);
  const now = Date.UTC(2026, 7, 28, 12, 0, 0);
  const expiresAt = now + HTML_PREVIEW_RETENTION_MS;
  const first = await publish(service, { sourceMessageId: "preview-1", now, expiresAt });

  const firstDirectory = path.join(rootDir, "pages", first.id);
  const [index, content, temporaryEntries] = await Promise.all([
    readFile(path.join(firstDirectory, "index.html"), "utf8"),
    readFile(path.join(firstDirectory, "content.html"), "utf8"),
    readdir(path.join(rootDir, "tmp")),
  ]);
  assert.match(index, /<iframe[^>]+sandbox="allow-scripts"/);
  assert.match(index, /src="content\.html"/);
  assert.equal(content, SAFE_PAGE);
  assert.deepEqual(temporaryEntries, []);
  const stored = db.db.prepare("SELECT status, title, byte_size FROM html_previews WHERE id = ?").get(first.id) as {
    status: string;
    title: string;
    byte_size: number;
  };
  assert.equal(stored.status, "published");
  assert.equal(stored.title, "任务看板");
  assert.equal(stored.byte_size, Buffer.byteLength(SAFE_PAGE));

  const expired = await service.cleanup(expiresAt);
  assert.equal(expired.expired, 1);
  assert.equal((await service.get(first.id))?.status, "expired");
  await assert.rejects(access(firstDirectory));

  const second = await publish(service, { sourceMessageId: "preview-2", now: now + 1 });
  const secondDirectory = path.join(rootDir, "pages", second.id);
  assert.equal(await service.remove(second.id), true);
  assert.equal((await service.get(second.id))?.status, "deleted");
  await assert.rejects(access(secondDirectory));
});
