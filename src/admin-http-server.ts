import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";

import { logInfo, logWarn } from "./logger.js";
import type { TransportHealthStatus } from "./bot.js";
import type { AdminOperationLogService } from "./services/admin-operation-log-service.js";
import type { GroupConfigService } from "./services/group-config-service.js";
import type { GroupMemoryCandidateService } from "./services/group-memory-candidate-service.js";
import type { GroupMemoryStore } from "./services/group-memory-store.js";
import type { KnowledgeBaseStore } from "./services/knowledge-base-store.js";
import type { GroupMemoryCandidateStatus, GroupMemoryType } from "./types.js";

interface AdminHttpServerOptions {
  host: string;
  port: number;
  publicBaseUrl: string;
  username: string;
  password: string;
  sessionSecret: string;
  groupConfigService: GroupConfigService;
  groupMemoryStore: GroupMemoryStore;
  groupMemoryCandidateService: GroupMemoryCandidateService;
  knowledgeBaseStore: KnowledgeBaseStore;
  adminOperationLogService: AdminOperationLogService;
  getTransportHealthStatus?: () => Promise<TransportHealthStatus>;
}

type RouteParams = Record<string, string>;

export class AdminHttpServer {
  private readonly server = createServer((req, res) => {
    void this.handleRequest(req, res);
  });

  constructor(private readonly options: AdminHttpServerOptions) {}

  start(): void {
    this.server.listen(this.options.port, this.options.host, () => {
      logInfo("Admin HTTP server listening.", {
        host: this.options.host,
        port: this.options.port,
        publicBaseUrl: this.options.publicBaseUrl,
      });
    });
  }

  close(): void {
    this.server.close();
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const pathname = trimTrailingSlash(url.pathname);

      if (req.method === "GET" && (pathname === "" || pathname === "/login")) {
        this.sendHtml(res, this.isAuthenticated(req) ? ADMIN_APP_HTML : LOGIN_HTML);
        return;
      }

      if (req.method === "POST" && pathname === "/api/login") {
        await this.handleLogin(req, res);
        return;
      }

      if (req.method === "POST" && pathname === "/api/logout") {
        this.setSessionCookie(res, "", new Date(0));
        this.sendJson(res, { ok: true });
        return;
      }

      if (pathname.startsWith("/api/") && !this.isAuthenticated(req)) {
        this.sendJson(res, { error: "unauthorized" }, 401);
        return;
      }

      await this.handleApi(req, res, pathname, url);
    } catch (error) {
      logWarn("Admin HTTP request failed.", {
        method: req.method,
        url: req.url,
        error: (error as Error).message,
      });
      this.sendJson(res, { error: "internal_error" }, 500);
    }
  }

  private async handleApi(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
    url: URL,
  ): Promise<void> {
    if (req.method === "GET" && pathname === "/api/session") {
      this.sendJson(res, { username: this.options.username, publicBaseUrl: this.options.publicBaseUrl });
      return;
    }

    if (req.method === "GET" && pathname === "/api/overview") {
      const [groups, memories, candidates, knowledge] = await Promise.all([
        this.options.groupConfigService.getAll(),
        this.options.groupMemoryStore.list(),
        this.options.groupMemoryCandidateService.list({ status: "pending" }),
        this.options.knowledgeBaseStore.list(),
      ]);
      const transportHealth = this.options.getTransportHealthStatus
        ? await this.options.getTransportHealthStatus()
        : { ok: true, detail: "未配置传输层自检" };
      this.sendJson(res, {
        groups,
        stats: {
          groupCount: groups.length,
          memoryCount: memories.length,
          pendingCandidateCount: candidates.length,
          knowledgeCount: knowledge.length,
        },
        transportHealth,
      });
      return;
    }

    if (req.method === "GET" && pathname === "/api/groups") {
      this.sendJson(res, { groups: await this.options.groupConfigService.getAll() });
      return;
    }

    if (req.method === "GET" && pathname === "/api/health") {
      const transportHealth = this.options.getTransportHealthStatus
        ? await this.options.getTransportHealthStatus()
        : { ok: true, detail: "未配置传输层自检" };
      this.sendJson(res, {
        transportHealth,
        uptimeSeconds: Math.floor(process.uptime()),
        nodeVersion: process.version,
        pid: process.pid,
        memory: process.memoryUsage(),
      });
      return;
    }

    if (req.method === "GET" && pathname === "/api/logs") {
      const groupId = url.searchParams.get("groupId") ?? "";
      this.sendJson(res, {
        entries: groupId ? await this.options.adminOperationLogService.listRecent(groupId, 20) : [],
      });
      return;
    }

    if (pathname === "/api/memories") {
      await this.handleMemories(req, res, url);
      return;
    }

    const memoryRoute = matchRoute(pathname, /^\/api\/memories\/([^/]+)$/);
    if (memoryRoute) {
      await this.handleMemoryItem(req, res, memoryRoute);
      return;
    }

    if (pathname === "/api/memory-candidates") {
      await this.handleCandidates(req, res, url);
      return;
    }

    const approveRoute = matchRoute(pathname, /^\/api\/memory-candidates\/([^/]+)\/approve$/);
    if (approveRoute && req.method === "POST") {
      const body = await readJsonBody(req);
      const result = await this.options.groupMemoryCandidateService.approve(approveRoute.id, normalizeCandidatePatch(body));
      this.sendJson(res, result ?? { error: "not_found" }, result ? 200 : 404);
      return;
    }

    const rejectRoute = matchRoute(pathname, /^\/api\/memory-candidates\/([^/]+)\/reject$/);
    if (rejectRoute && req.method === "POST") {
      const candidate = await this.options.groupMemoryCandidateService.reject(rejectRoute.id);
      this.sendJson(res, candidate ?? { error: "not_found" }, candidate ? 200 : 404);
      return;
    }

    const candidateRoute = matchRoute(pathname, /^\/api\/memory-candidates\/([^/]+)$/);
    if (candidateRoute) {
      await this.handleCandidateItem(req, res, candidateRoute);
      return;
    }

    if (pathname === "/api/knowledge") {
      await this.handleKnowledge(req, res, url);
      return;
    }

    const knowledgeRoute = matchRoute(pathname, /^\/api\/knowledge\/([^/]+)$/);
    if (knowledgeRoute) {
      await this.handleKnowledgeItem(req, res, knowledgeRoute);
      return;
    }

    if (req.method === "GET") {
      this.sendHtml(res, ADMIN_APP_HTML);
      return;
    }

    this.sendJson(res, { error: "not_found" }, 404);
  }

  private async handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJsonBody(req);
    const username = typeof body.username === "string" ? body.username : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (username !== this.options.username || password !== this.options.password) {
      this.sendJson(res, { error: "invalid_credentials" }, 401);
      return;
    }

    const expires = new Date(Date.now() + 12 * 60 * 60 * 1000);
    this.setSessionCookie(res, this.signSession({ username, expiresAt: expires.toISOString() }), expires);
    this.sendJson(res, { ok: true });
  }

  private async handleMemories(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (req.method === "GET") {
      this.sendJson(res, { memories: await this.options.groupMemoryStore.list(url.searchParams.get("groupId") ?? undefined) });
      return;
    }

    if (req.method === "POST") {
      const body = await readJsonBody(req);
      const memory = await this.options.groupMemoryStore.create(normalizeMemoryInput(body));
      this.sendJson(res, memory, 201);
      return;
    }

    this.sendJson(res, { error: "method_not_allowed" }, 405);
  }

  private async handleMemoryItem(req: IncomingMessage, res: ServerResponse, params: RouteParams): Promise<void> {
    if (req.method === "PUT") {
      const body = await readJsonBody(req);
      const memory = await this.options.groupMemoryStore.update(params.id, normalizeMemoryPatch(body));
      this.sendJson(res, memory ?? { error: "not_found" }, memory ? 200 : 404);
      return;
    }

    if (req.method === "DELETE") {
      const removed = await this.options.groupMemoryStore.remove(params.id);
      this.sendJson(res, { ok: removed }, removed ? 200 : 404);
      return;
    }

    this.sendJson(res, { error: "method_not_allowed" }, 405);
  }

  private async handleCandidates(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (req.method !== "GET") {
      this.sendJson(res, { error: "method_not_allowed" }, 405);
      return;
    }

    const status = normalizeStatus(url.searchParams.get("status") ?? undefined);
    this.sendJson(res, {
      candidates: await this.options.groupMemoryCandidateService.list({
        groupId: url.searchParams.get("groupId") ?? undefined,
        ...(status ? { status } : {}),
      }),
    });
  }

  private async handleCandidateItem(req: IncomingMessage, res: ServerResponse, params: RouteParams): Promise<void> {
    if (req.method === "PUT") {
      const body = await readJsonBody(req);
      const candidate = await this.options.groupMemoryCandidateService.update(params.id, normalizeCandidatePatch(body));
      this.sendJson(res, candidate ?? { error: "not_found" }, candidate ? 200 : 404);
      return;
    }

    if (req.method === "DELETE") {
      const removed = await this.options.groupMemoryCandidateService.remove(params.id);
      this.sendJson(res, { ok: removed }, removed ? 200 : 404);
      return;
    }

    this.sendJson(res, { error: "method_not_allowed" }, 405);
  }

  private async handleKnowledge(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (req.method === "GET") {
      this.sendJson(res, { entries: await this.options.knowledgeBaseStore.list(url.searchParams.get("groupId") ?? undefined) });
      return;
    }

    if (req.method === "POST") {
      const body = await readJsonBody(req);
      const entry = await this.options.knowledgeBaseStore.create(normalizeKnowledgeInput(body));
      this.sendJson(res, entry, 201);
      return;
    }

    this.sendJson(res, { error: "method_not_allowed" }, 405);
  }

  private async handleKnowledgeItem(req: IncomingMessage, res: ServerResponse, params: RouteParams): Promise<void> {
    if (req.method === "PUT") {
      const body = await readJsonBody(req);
      const entry = await this.options.knowledgeBaseStore.update(params.id, normalizeKnowledgePatch(body));
      this.sendJson(res, entry ?? { error: "not_found" }, entry ? 200 : 404);
      return;
    }

    if (req.method === "DELETE") {
      const removed = await this.options.knowledgeBaseStore.remove(params.id);
      this.sendJson(res, { ok: removed }, removed ? 200 : 404);
      return;
    }

    this.sendJson(res, { error: "method_not_allowed" }, 405);
  }

  private isAuthenticated(req: IncomingMessage): boolean {
    const cookie = parseCookies(req.headers.cookie ?? "").admin_session;
    if (!cookie) {
      return false;
    }

    const session = this.verifySession(cookie);
    return Boolean(session && session.username === this.options.username && new Date(session.expiresAt).getTime() > Date.now());
  }

  private signSession(payload: { username: string; expiresAt: string }): string {
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = createHmac("sha256", this.options.sessionSecret).update(body).digest("base64url");
    return `${body}.${signature}`;
  }

  private verifySession(value: string): { username: string; expiresAt: string } | undefined {
    const [body, signature] = value.split(".");
    if (!body || !signature) {
      return undefined;
    }

    const expected = createHmac("sha256", this.options.sessionSecret).update(body).digest("base64url");
    if (!safeEqual(signature, expected)) {
      return undefined;
    }

    try {
      const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as {
        username?: string;
        expiresAt?: string;
      };
      return typeof parsed.username === "string" && typeof parsed.expiresAt === "string"
        ? { username: parsed.username, expiresAt: parsed.expiresAt }
        : undefined;
    } catch {
      return undefined;
    }
  }

  private setSessionCookie(res: ServerResponse, value: string, expires: Date): void {
    const secure = this.options.publicBaseUrl.startsWith("https://");
    res.setHeader(
      "Set-Cookie",
      [
        `admin_session=${value}`,
        "Path=/",
        "HttpOnly",
        "SameSite=Lax",
        secure ? "Secure" : "",
        `Expires=${expires.toUTCString()}`,
      ].filter(Boolean).join("; "),
    );
  }

  private sendJson(res: ServerResponse, data: unknown, statusCode = 200): void {
    res.statusCode = statusCode;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(data));
  }

  private sendHtml(res: ServerResponse, html: string): void {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(html);
  }
}

function normalizeMemoryInput(body: Record<string, unknown>) {
  return {
    groupId: requiredString(body.groupId),
    type: normalizeMemoryType(body.type),
    subjectUserId: optionalUserId(body.subjectUserId),
    title: requiredString(body.title),
    content: requiredString(body.content),
    confidence: optionalNumber(body.confidence),
    source: optionalString(body.source) ?? "admin",
    enabled: optionalBoolean(body.enabled) ?? true,
  };
}

function normalizeMemoryPatch(body: Record<string, unknown>) {
  return {
    ...(body.groupId !== undefined ? { groupId: requiredString(body.groupId) } : {}),
    ...(body.type !== undefined ? { type: normalizeMemoryType(body.type) } : {}),
    ...(body.subjectUserId !== undefined ? { subjectUserId: optionalUserId(body.subjectUserId) } : {}),
    ...(body.title !== undefined ? { title: requiredString(body.title) } : {}),
    ...(body.content !== undefined ? { content: requiredString(body.content) } : {}),
    ...(body.confidence !== undefined ? { confidence: optionalNumber(body.confidence) } : {}),
    ...(body.source !== undefined ? { source: optionalString(body.source) ?? "admin" } : {}),
    ...(body.enabled !== undefined ? { enabled: optionalBoolean(body.enabled) ?? true } : {}),
  };
}

function normalizeCandidatePatch(body: Record<string, unknown>) {
  return {
    ...(body.type !== undefined ? { type: normalizeMemoryType(body.type) } : {}),
    ...(body.subjectUserId !== undefined ? { subjectUserId: optionalUserId(body.subjectUserId) } : {}),
    ...(body.title !== undefined ? { title: requiredString(body.title) } : {}),
    ...(body.content !== undefined ? { content: requiredString(body.content) } : {}),
    ...(body.confidence !== undefined ? { confidence: optionalNumber(body.confidence) } : {}),
    ...(body.status !== undefined ? { status: normalizeStatus(requiredString(body.status)) ?? "pending" } : {}),
  };
}

function normalizeKnowledgeInput(body: Record<string, unknown>) {
  return {
    groupId: requiredString(body.groupId),
    title: requiredString(body.title),
    question: requiredString(body.question),
    answer: requiredString(body.answer),
    keywords: normalizeKeywords(body.keywords),
    enabled: optionalBoolean(body.enabled) ?? true,
  };
}

function normalizeKnowledgePatch(body: Record<string, unknown>) {
  return {
    ...(body.groupId !== undefined ? { groupId: requiredString(body.groupId) } : {}),
    ...(body.title !== undefined ? { title: requiredString(body.title) } : {}),
    ...(body.question !== undefined ? { question: requiredString(body.question) } : {}),
    ...(body.answer !== undefined ? { answer: requiredString(body.answer) } : {}),
    ...(body.keywords !== undefined ? { keywords: normalizeKeywords(body.keywords) } : {}),
    ...(body.enabled !== undefined ? { enabled: optionalBoolean(body.enabled) ?? true } : {}),
  };
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > 1024 * 1024) {
      throw new Error("Request body too large.");
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function normalizeMemoryType(value: unknown): GroupMemoryType {
  return value === "member_profile" ? "member_profile" : "group_fact";
}

function normalizeStatus(value: string | undefined): GroupMemoryCandidateStatus | undefined {
  return value === "approved" || value === "rejected" || value === "pending" ? value : undefined;
}

function normalizeKeywords(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(/[,\s，、]+/).map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function requiredString(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    throw new Error("Missing required string.");
  }
  return normalized;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalUserId(value: unknown): string | undefined {
  const normalized = optionalString(value);
  return normalized && /^\d+$/.test(normalized) ? normalized : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function matchRoute(pathname: string, regex: RegExp): RouteParams | undefined {
  const match = pathname.match(regex);
  return match?.[1] ? { id: decodeURIComponent(match[1]) } : undefined;
}

function trimTrailingSlash(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname === "/" ? "" : pathname;
}

function parseCookies(raw: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of raw.split(";")) {
    const [key, ...valueParts] = part.trim().split("=");
    if (key) {
      cookies[key] = valueParts.join("=");
    }
  }
  return cookies;
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function createAdminSessionSecret(): string {
  return randomBytes(32).toString("base64url");
}

const ADMIN_CSS = `
:root { color-scheme: light; --ink: oklch(22% 0.012 238); --muted: oklch(50% 0.012 238); --line: oklch(86% 0.012 238); --paper: oklch(98% 0.006 238); --panel: oklch(96% 0.008 238); --accent: oklch(55% 0.16 168); --accent-soft: oklch(92% 0.045 168); --danger: oklch(52% 0.16 28); }
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.5 Inter, "Segoe UI", system-ui, sans-serif; color: var(--ink); background: var(--paper); }
button, input, select { font: inherit; }
button { min-height: 36px; border: 1px solid var(--accent); background: var(--accent); color: oklch(98% 0.006 168); padding: 0 14px; border-radius: 6px; cursor: pointer; }
button.ghost { background: transparent; color: var(--ink); border-color: var(--line); }
.login-page { min-height: 100vh; display: grid; place-items: center; }
.login-shell { width: min(420px, calc(100vw - 32px)); }
.login-panel { border: 1px solid var(--line); background: var(--panel); padding: 28px; border-radius: 8px; }
.eyebrow { margin: 0 0 6px; color: var(--muted); text-transform: uppercase; letter-spacing: .08em; font-size: 12px; }
h1, h2 { margin: 0; letter-spacing: 0; }
h1 { font-size: 28px; }
h2 { font-size: 18px; margin-bottom: 14px; }
.stack { display: grid; gap: 14px; margin-top: 22px; }
label { display: grid; gap: 6px; color: var(--muted); }
input, select { min-height: 36px; border: 1px solid var(--line); border-radius: 6px; padding: 0 10px; background: oklch(99% 0.004 238); color: var(--ink); }
.message { min-height: 20px; color: var(--danger); }
.app-shell { min-height: 100vh; display: grid; grid-template-columns: 240px 1fr; }
aside { border-right: 1px solid var(--line); background: oklch(94% 0.012 238); padding: 18px; display: grid; grid-template-rows: auto 1fr auto; gap: 24px; }
.brand { display: flex; align-items: center; gap: 10px; }
.brand span { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 6px; background: var(--accent-soft); color: oklch(38% 0.14 168); font-weight: 700; }
nav { display: grid; align-content: start; gap: 8px; }
nav button { text-align: left; background: transparent; color: var(--ink); border-color: transparent; }
nav button.active { background: var(--accent-soft); border-color: oklch(82% 0.07 168); }
main { padding: 24px; min-width: 0; }
header { display: flex; align-items: end; justify-content: space-between; gap: 16px; margin-bottom: 22px; }
header select { width: 180px; }
.metric-row { display: grid; grid-template-columns: repeat(4, minmax(120px, 1fr)); gap: 12px; margin-bottom: 14px; }
.metric-row div { border: 1px solid var(--line); background: var(--panel); padding: 18px; border-radius: 8px; display: grid; gap: 4px; }
.metric-row b { font-size: 26px; line-height: 1; }
.metric-row span { color: var(--muted); }
.panel { border: 1px solid var(--line); background: oklch(99% 0.004 238); padding: 18px; border-radius: 8px; }
.list { display: grid; gap: 10px; }
article { border: 1px solid var(--line); border-radius: 8px; padding: 14px; display: grid; gap: 8px; }
article span { color: var(--muted); overflow-wrap: anywhere; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; }
.grid-form { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)) auto; gap: 8px; margin-bottom: 14px; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; }
@media (max-width: 860px) { .app-shell { grid-template-columns: 1fr; } aside { position: static; border-right: 0; border-bottom: 1px solid var(--line); } nav { grid-template-columns: repeat(2, 1fr); } .metric-row, .grid-form { grid-template-columns: 1fr; } header { align-items: start; flex-direction: column; } header select { width: 100%; } }
`;

const LOGIN_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AI-Project Bot Admin</title>
  <style>${ADMIN_CSS}</style>
</head>
<body class="login-page">
  <main class="login-shell">
    <section class="login-panel">
      <p class="eyebrow">AI-Project</p>
      <h1>Bot Admin</h1>
      <form id="loginForm" class="stack">
        <label>账号<input name="username" autocomplete="username" required></label>
        <label>密码<input name="password" type="password" autocomplete="current-password" required></label>
        <button type="submit">登录</button>
        <p id="message" class="message"></p>
      </form>
    </section>
  </main>
  <script>
    document.querySelector('#loginForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(event.target).entries());
      const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
      if (res.ok) location.href = '/';
      else document.querySelector('#message').textContent = '账号或密码错误';
    });
  </script>
</body>
</html>`;

const ADMIN_APP_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AI-Project Bot Admin</title>
  <style>${ADMIN_CSS}</style>
</head>
<body>
  <div class="app-shell">
    <aside>
      <div class="brand"><span>AI</span><strong>Bot Admin</strong></div>
      <nav>
        <button data-view="overview" class="active">总览</button>
        <button data-view="groups">群配置</button>
        <button data-view="candidates">候选记忆</button>
        <button data-view="memories">长期记忆</button>
        <button data-view="knowledge">知识库</button>
        <button data-view="health">健康状态</button>
      </nav>
      <button id="logout" class="ghost">退出</button>
    </aside>
    <main>
      <header>
        <div>
          <p class="eyebrow">Public console</p>
          <h1 id="viewTitle">总览</h1>
        </div>
        <select id="groupFilter"></select>
      </header>
      <section id="content"></section>
    </main>
  </div>
  <script>
    const state = { view: 'overview', groups: [], groupId: '' };
    const titleByView = { overview: '总览', groups: '群配置', candidates: '候选记忆', memories: '长期记忆', knowledge: '知识库', health: '健康状态' };
    const api = async (url, options = {}) => {
      const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
      if (res.status === 401) location.href = '/login';
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    };
    const el = (html) => html;
    async function loadGroups() {
      const data = await api('/api/groups');
      state.groups = data.groups || [];
      state.groupId = state.groupId || state.groups[0]?.groupId || '';
      document.querySelector('#groupFilter').innerHTML = state.groups.map(g => '<option value="' + g.groupId + '">' + g.groupId + '</option>').join('');
      document.querySelector('#groupFilter').value = state.groupId;
    }
    async function render() {
      document.querySelector('#viewTitle').textContent = titleByView[state.view];
      document.querySelectorAll('nav button').forEach(btn => btn.classList.toggle('active', btn.dataset.view === state.view));
      if (state.view === 'overview') return renderOverview();
      if (state.view === 'groups') return renderGroups();
      if (state.view === 'candidates') return renderCandidates();
      if (state.view === 'memories') return renderMemories();
      if (state.view === 'knowledge') return renderKnowledge();
      return renderHealth();
    }
    async function renderOverview() {
      const data = await api('/api/overview');
      document.querySelector('#content').innerHTML = el('<div class="metric-row"><div><b>' + data.stats.groupCount + '</b><span>群</span></div><div><b>' + data.stats.pendingCandidateCount + '</b><span>待审记忆</span></div><div><b>' + data.stats.memoryCount + '</b><span>长期记忆</span></div><div><b>' + data.stats.knowledgeCount + '</b><span>FAQ</span></div></div><section class="panel"><h2>连接状态</h2><p>' + data.transportHealth.detail + '</p></section>');
    }
    async function renderGroups() {
      await loadGroups();
      document.querySelector('#content').innerHTML = '<section class="panel"><h2>群配置</h2><div class="list">' + state.groups.map(g => '<article><b>' + g.groupId + '</b><span>skill ' + g.currentSkillId + '，管理员 ' + g.switcherUserIds.length + '，实时对话 ' + g.liveChatUserIds.length + '</span></article>').join('') + '</div></section>';
    }
    async function renderCandidates() {
      const data = await api('/api/memory-candidates?status=pending&groupId=' + encodeURIComponent(state.groupId));
      document.querySelector('#content').innerHTML = '<section class="panel"><h2>待审核候选</h2><div class="list">' + (data.candidates || []).map(c => rowCandidate(c)).join('') + '</div></section>';
    }
    function rowCandidate(c) {
      return '<article><b>' + c.title + '</b><span>' + c.type + ' · ' + c.content + '</span><div class="actions"><button data-approve="' + c.id + '">批准</button><button data-reject="' + c.id + '" class="ghost">拒绝</button></div></article>';
    }
    async function renderMemories() {
      const data = await api('/api/memories?groupId=' + encodeURIComponent(state.groupId));
      document.querySelector('#content').innerHTML = '<section class="panel"><h2>长期记忆</h2>' + memoryForm() + '<div class="list">' + (data.memories || []).map(m => '<article><b>' + m.title + '</b><span>' + (m.enabled ? '启用' : '停用') + ' · ' + m.type + ' · ' + m.content + '</span><div class="actions"><button data-toggle-memory="' + m.id + '" data-enabled="' + (!m.enabled) + '">' + (m.enabled ? '停用' : '启用') + '</button><button data-delete-memory="' + m.id + '" class="ghost">删除</button></div></article>').join('') + '</div></section>';
    }
    function memoryForm() {
      return '<form id="memoryForm" class="grid-form"><input name="title" placeholder="标题"><input name="content" placeholder="内容"><select name="type"><option value="group_fact">群事实</option><option value="member_profile">成员画像</option></select><button>新增</button></form>';
    }
    async function renderKnowledge() {
      const data = await api('/api/knowledge?groupId=' + encodeURIComponent(state.groupId));
      document.querySelector('#content').innerHTML = '<section class="panel"><h2>文本 FAQ</h2>' + knowledgeForm() + '<div class="list">' + (data.entries || []).map(k => '<article><b>' + k.title + '</b><span>问：' + k.question + '<br>答：' + k.answer + '<br>关键词：' + k.keywords.join('、') + '</span><div class="actions"><button data-toggle-knowledge="' + k.id + '" data-enabled="' + (!k.enabled) + '">' + (k.enabled ? '停用' : '启用') + '</button><button data-delete-knowledge="' + k.id + '" class="ghost">删除</button></div></article>').join('') + '</div></section>';
    }
    function knowledgeForm() {
      return '<form id="knowledgeForm" class="grid-form"><input name="title" placeholder="标题"><input name="question" placeholder="问题"><input name="answer" placeholder="答案"><input name="keywords" placeholder="关键词，用逗号分隔"><button>新增</button></form>';
    }
    async function renderHealth() {
      const data = await api('/api/health');
      document.querySelector('#content').innerHTML = '<section class="panel"><h2>健康状态</h2><pre>' + JSON.stringify(data, null, 2) + '</pre></section>';
    }
    document.addEventListener('click', async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLButtonElement)) return;
      if (target.dataset.view) { state.view = target.dataset.view; await render(); }
      if (target.dataset.approve) { await api('/api/memory-candidates/' + target.dataset.approve + '/approve', { method: 'POST', body: '{}' }); await render(); }
      if (target.dataset.reject) { await api('/api/memory-candidates/' + target.dataset.reject + '/reject', { method: 'POST', body: '{}' }); await render(); }
      if (target.dataset.toggleMemory) { await api('/api/memories/' + target.dataset.toggleMemory, { method: 'PUT', body: JSON.stringify({ enabled: target.dataset.enabled === 'true' }) }); await render(); }
      if (target.dataset.deleteMemory && confirm('确认删除这条记忆？')) { await api('/api/memories/' + target.dataset.deleteMemory, { method: 'DELETE' }); await render(); }
      if (target.dataset.toggleKnowledge) { await api('/api/knowledge/' + target.dataset.toggleKnowledge, { method: 'PUT', body: JSON.stringify({ enabled: target.dataset.enabled === 'true' }) }); await render(); }
      if (target.dataset.deleteKnowledge && confirm('确认删除这条 FAQ？')) { await api('/api/knowledge/' + target.dataset.deleteKnowledge, { method: 'DELETE' }); await render(); }
    });
    document.addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(event.target).entries());
      if (event.target.id === 'memoryForm') await api('/api/memories', { method: 'POST', body: JSON.stringify({ ...data, groupId: state.groupId }) });
      if (event.target.id === 'knowledgeForm') await api('/api/knowledge', { method: 'POST', body: JSON.stringify({ ...data, groupId: state.groupId, keywords: String(data.keywords || '').split(/[，,]/) }) });
      await render();
    });
    document.querySelector('#groupFilter').addEventListener('change', async (event) => { state.groupId = event.target.value; await render(); });
    document.querySelector('#logout').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }); location.href = '/login'; });
    loadGroups().then(render);
  </script>
</body>
</html>`;
