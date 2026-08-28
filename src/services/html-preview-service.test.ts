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

test("static HTML sanitizer accepts bounded inline SVG with CSS animation", () => {
  const page = '<!doctype html><html><head><title>鹈鹕骑车</title><style>@keyframes pedal{to{transform:rotate(360deg)}}.wheel{animation:pedal 1s linear infinite;transform-origin:center}</style></head><body><svg viewBox="0 0 640 360" width="640" height="360" aria-label="鹈鹕骑自行车"><g transform="translate(20 10)"><circle class="wheel" cx="160" cy="260" r="64" fill="none" stroke="#234" stroke-width="8"></circle><path d="M 160 260 L 260 160 L 360 260 Z" fill="none" stroke="currentColor" stroke-width="6"></path><text x="250" y="80" text-anchor="middle">鹈鹕</text></g></svg></body></html>';
  const sanitized = sanitizeStaticHtml(page);
  assert.match(sanitized, /<svg viewBox="0 0 640 360"/);
  assert.match(sanitized, /@keyframes pedal/);
  assert.match(sanitized, /<path d="M 160 260 L 260 160 L 360 260 Z"/);
});

test("static HTML sanitizer removes only the inert default inline SVG namespace", () => {
  const page = '<!doctype html><html><head><title>x</title></head><body><svg viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg"><circle cx="5" cy="5" r="4"></circle></svg></body></html>';
  const sanitized = sanitizeStaticHtml(page);
  assert.match(sanitized, /<svg viewBox="0 0 10 10">/);
  assert.doesNotMatch(sanitized, /xmlns/i);
  assert.throws(
    () => sanitizeStaticHtml('<!doctype html><html><head><title>x</title></head><body><svg xmlns="urn:custom" viewBox="0 0 10 10"></svg></body></html>'),
    (error: unknown) => error instanceof HtmlPreviewError && error.code === "html_preview_attribute_disallowed",
  );
});

test("static HTML sanitizer accepts safe SVG typography and presentation attributes", () => {
  const page = '<!doctype html><html><head><title>x</title></head><body><svg viewBox="0 0 200 100"><g fill="#fff" fill-opacity="0.8" stroke="#234" stroke-miterlimit="4" vector-effect="non-scaling-stroke"><text x="100" y="50" font-size="28" font-weight="700" font-family="Arial, sans-serif" letter-spacing="1px" text-anchor="middle">鹈鹕</text></g></svg></body></html>';
  const sanitized = sanitizeStaticHtml(page);
  assert.match(sanitized, /font-size="28"/);
  assert.match(sanitized, /font-weight="700"/);
  assert.match(sanitized, /fill-opacity="0.8"/);
  assert.match(sanitized, /vector-effect="non-scaling-stroke"/);
  assert.throws(
    () => sanitizeStaticHtml('<!doctype html><html><head><title>x</title></head><body><svg viewBox="0 0 10 10"><text x="1" y="2" font-family="url(evil)">x</text></svg></body></html>'),
    (error: unknown) => error instanceof HtmlPreviewError,
  );
});

test("static HTML sanitizer permits passive SVG attributes without an exhaustive drawing whitelist", () => {
  const page = '<!doctype html><html><head><title>x</title></head><body><svg viewBox="0 0 20 20"><path d="M0 0L20 20" transform-origin="center" stroke-alignment="center" font-variant="small-caps"></path></svg></body></html>';
  const sanitized = sanitizeStaticHtml(page);
  assert.match(sanitized, /transform-origin="center"/);
  assert.match(sanitized, /stroke-alignment="center"/);
  assert.throws(
    () => sanitizeStaticHtml('<!doctype html><html><head><title>x</title></head><body><svg viewBox="0 0 10 10"><path d="M0 0L1 1" href="#external"></path></svg></body></html>'),
    (error: unknown) => error instanceof HtmlPreviewError && error.code === "html_preview_attribute_disallowed",
  );
});

test("static HTML sanitizer permits passive HTML attributes while blocking active capabilities", () => {
  const page = '<!doctype html><html lang="zh-CN"><head><title>x</title><style type="text/css">body{margin:0}</style></head><body><main aria-hidden="false" inert><div popover="manual">x</div></main></body></html>';
  const sanitized = sanitizeStaticHtml(page);
  assert.match(sanitized, /<style type="text\/css">/);
  assert.match(sanitized, /aria-hidden="false"/);
  assert.match(sanitized, /popover="manual"/);
  assert.throws(
    () => sanitizeStaticHtml('<!doctype html><html><head><title>x</title></head><body><div src="https://example.com/x">x</div></body></html>'),
    (error: unknown) => error instanceof HtmlPreviewError,
  );
});

test("static HTML sanitizer rejects active and externally-referenced SVG features", () => {
  for (const fragment of [
    '<svg viewBox="0 0 10 10"><image href="https://example.com/p.png"></image></svg>',
    '<svg viewBox="0 0 10 10"><use href="#shape"></use></svg>',
    '<svg viewBox="0 0 10 10"><foreignObject><div>x</div></foreignObject></svg>',
    '<svg viewBox="0 0 10 10"><animateTransform attributeName="transform"></animateTransform></svg>',
    '<svg xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10"></svg>',
    '<svg viewBox="0 0 10 10"><path d="M0 0L1 1" fill="url(#paint)"></path></svg>',
  ]) {
    assert.throws(
      () => sanitizeStaticHtml(`<!doctype html><html><head><title>x</title></head><body>${fragment}</body></html>`),
      (error: unknown) => error instanceof HtmlPreviewError,
    );
  }
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
  assert.equal(typeof result.announcementOutboxId, "number");
  const outbox = db.db.prepare("SELECT text FROM outbox WHERE id = ?").get(result.announcementOutboxId!) as { text: string };
  assert.equal(outbox.text, HTML_PREVIEW_PROVIDER_UNAVAILABLE_MESSAGE);
});

test("repair request names the failed safety rule and constrains SVG output", async (t) => {
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
        return JSON.stringify({ title: "bad", html: "<!doctype html><html><head><meta charset=\"utf-8\"><title>x</title></head><body>x</body></html>" });
      }
      return JSON.stringify({ title: "ok", html: SAFE_PAGE });
    },
  });
  assert.equal(result.status, "published");
  assert.equal(requests.length, 2);
  assert.match(requests[1] ?? "", /html_preview_tag_disallowed/);
  assert.match(requests[1] ?? "", /不要输出 meta 或 xmlns/);
  assert.match(requests[1] ?? "", /动画只用 CSS @keyframes/);
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
