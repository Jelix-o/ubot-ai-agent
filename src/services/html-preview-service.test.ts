import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SharedDb } from "../shared/sqlite.js";
import { HTML_PREVIEW_RETENTION_MS } from "./html-preview-repository.js";
import {
  HTML_PREVIEW_PROVIDER_UNAVAILABLE_MESSAGE,
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

test("HTML publication validation preserves advanced SVG and browser features verbatim", () => {
  const page = '\uFEFF<!doctype html><html lang="zh-CN"><head><title>鹈鹕骑车</title><style>@keyframes pedal{to{transform:rotate(1turn)}}.wheel{animation:pedal 1s linear infinite}</style></head><body onclick="document.body.dataset.ready=\'yes\'"><canvas id="sky"></canvas><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360"><defs><linearGradient id="paint"><stop offset="0%" stop-color="color(display-p3 1 0.4 0)"></stop></linearGradient><filter id="blur"><feGaussianBlur stdDeviation=".25em"></feGaussianBlur></filter><clipPath id="clip"><circle cx="50%" cy="50%" r="4rem"></circle></clipPath></defs><g filter="url(#blur)" clip-path="url(#clip)"><use href="#bird"></use><path id="bird" d="M0,0 C1e2,-20 200,80 300,0" fill="url(#paint)"><animateTransform attributeName="transform" type="rotate" from="0 150 100" to="360 150 100" dur="2s" repeatCount="indefinite"></animateTransform></path><foreignObject x="1" y="2" width="3" height="4"><div>pedal</div></foreignObject></g></svg><script>document.querySelector(\'canvas\').getContext(\'2d\')</script></body></html>';
  const published = sanitizeStaticHtml(page);
  assert.equal(published, page.slice(1));
  assert.match(published, /<linearGradient/);
  assert.match(published, /<animateTransform/);
  assert.match(published, /onclick=/);
  assert.match(published, /color\(display-p3/);
});

test("HTML publication validation leaves outbound code intact for CSP enforcement", () => {
  const page = '<!doctype html><html><head><title>x</title><link rel="stylesheet" href="https://example.com/x.css"></head><body><img src="https://example.com/x.png"><iframe src="https://example.com"></iframe><form action="https://example.com"><button>go</button></form><script>fetch("https://example.com/api");window.open("https://example.com")</script></body></html>';
  assert.equal(sanitizeStaticHtml(page), page);
});

test("HTML publication validation rejects empty, oversized, and incomplete documents", () => {
  for (const page of ["", "<html><body>x</body></html>", "<!doctype html><html><head></head></html>"]) {
    assert.throws(
      () => sanitizeStaticHtml(page),
      (error: unknown) => error instanceof HtmlPreviewError,
    );
  }
  const oversized = `<!doctype html><html><body>${"x".repeat(512 * 1024)}</body></html>`;
  assert.throws(
    () => sanitizeStaticHtml(oversized),
    (error: unknown) => error instanceof HtmlPreviewError && error.code === "html_preview_too_large",
  );
});

test("provider unavailability creates the specific retry-later notice", async (t) => {
  const { db, service } = await createFixture(t);
  const queued = await service.enqueue({
    groupId: "provider-down",
    creatorUserId: "member-1",
    sourceMessageId: "provider-down-1",
    request: "生成网页",
  });
  const result = await service.processNext({
    id: queued.page.id,
    request: "生成网页",
    generate: async () => { throw new HtmlPreviewError("html_preview_provider_unavailable"); },
  });
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "html_preview_provider_unavailable");
  assert.equal(result.failureStage, "generation");
  assert.equal(typeof result.announcementOutboxId, "number");
  const outbox = db.db.prepare("SELECT text FROM outbox WHERE id = ?").get(result.announcementOutboxId!) as { text: string };
  assert.equal(outbox.text, HTML_PREVIEW_PROVIDER_UNAVAILABLE_MESSAGE);
});

test("repair request names the envelope failure without constraining HTML features", async (t) => {
  const { service } = await createFixture(t);
  const queued = await service.enqueue({
    groupId: "repair-svg",
    creatorUserId: "member-1",
    sourceMessageId: "repair-svg-1",
    request: "SVG 鹈鹕骑自行车",
  });
  const requests: string[] = [];
  const result = await service.processNext({
    id: queued.page.id,
    request: "SVG 鹈鹕骑自行车",
    generate: async (request) => {
      requests.push(request);
      if (requests.length === 1) {
        return JSON.stringify({ title: "bad", html: "<html><head><title>x</title></head><body>x</body></html>" });
      }
      return JSON.stringify({ title: "ok", html: SAFE_PAGE });
    },
  });
  assert.equal(result.status, "published");
  assert.equal(requests.length, 2);
  assert.match(requests[1] ?? "", /html_preview_document_invalid/);
  assert.match(requests[1] ?? "", /标准 HTML、SVG、CSS 和内联 JavaScript/);
  assert.doesNotMatch(requests[1] ?? "", /只可使用|不要输出 meta|动画只用/);
});

test("a final validation failure reports the repair stage without retaining model output", async (t) => {
  const { service } = await createFixture(t);
  const queued = await service.enqueue({
    groupId: "repair-failed",
    creatorUserId: "member-1",
    sourceMessageId: "repair-failed-1",
    request: "生成网页",
  });
  const result = await service.processNext({
    id: queued.page.id,
    request: "生成网页",
    generate: async () => JSON.stringify({ title: "bad", html: "<p>not a document</p>" }),
  });
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "html_preview_document_invalid");
  assert.equal(result.failureStage, "repair");
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
