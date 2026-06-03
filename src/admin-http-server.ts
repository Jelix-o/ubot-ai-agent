import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";

import { ADMIN_APP_HTML_V2, LOGIN_HTML } from "./admin-ui.js";
import { logInfo, logWarn } from "./logger.js";
import type { TransportHealthStatus } from "./bot.js";
import type { AdminOperationLogService } from "./services/admin-operation-log-service.js";
import type { GroupConfigService } from "./services/group-config-service.js";
import type { GroupMemoryCandidateService } from "./services/group-memory-candidate-service.js";
import type { GroupMemoryStore } from "./services/group-memory-store.js";
import type { KnowledgeBaseStore } from "./services/knowledge-base-store.js";
import { buildGroupMemberProfiles, buildSubjectLabel } from "./services/member-profile-service.js";
import type { GroupBotConfig, GroupMemberProfile, GroupMemory, GroupMemoryCandidate, GroupMemoryCandidateStatus, GroupMemoryEvidence, GroupMemoryType, KnowledgeBaseEntry, NapcatGroupMember } from "./types.js";

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
  listGroupMembers?: (groupId: string) => Promise<NapcatGroupMember[]>;
}

type RouteParams = Record<string, string>;

export class AdminHttpServer {
  private readonly memberProfileCache = new Map<string, {
    expiresAt: number;
    groupConfig: GroupBotConfig;
    members: GroupMemberProfile[];
  }>();

  private readonly memberProfileInflight = new Map<string, Promise<{ groupConfig: GroupBotConfig; members: GroupMemberProfile[] } | undefined>>();

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
        this.sendHtml(res, this.isAuthenticated(req) ? ADMIN_APP_HTML_V2 : LOGIN_HTML);
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
      const groupId = url.searchParams.get("groupId") ?? undefined;
      const [groups, memories, candidates, knowledge] = await Promise.all([
        this.options.groupConfigService.getAll(),
        this.options.groupMemoryStore.list(groupId),
        this.options.groupMemoryCandidateService.list({ ...(groupId ? { groupId } : {}), status: "pending" }),
        this.options.knowledgeBaseStore.list(groupId),
      ]);
      const transportHealth = this.options.getTransportHealthStatus
        ? await this.options.getTransportHealthStatus()
        : { ok: true, detail: "未配置传输层自检" };
      this.sendJson(res, {
        groups,
        groupId,
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

    const membersRoute = matchGroupMemberRoute(pathname, /^\/api\/groups\/([^/]+)\/members$/);
    if (membersRoute && req.method === "GET") {
      await this.handleGroupMembers(res, membersRoute.groupId, url.searchParams.get("refresh") === "1");
      return;
    }

    const identityRoute = matchGroupMemberRoute(pathname, /^\/api\/groups\/([^/]+)\/members\/([^/]+)\/identity$/);
    if (identityRoute?.userId) {
      await this.handleMemberIdentity(req, res, { groupId: identityRoute.groupId, userId: identityRoute.userId });
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
      const patch = normalizeCandidatePatch(body);
      const current = await this.findCandidate(approveRoute.id);
      if (!current) {
        this.sendJson(res, { error: "not_found" }, 404);
        return;
      }
      const nextType = patch.type ?? current.type;
      const nextSubjectUserId = patch.subjectUserId === undefined ? current.subjectUserId : patch.subjectUserId;
      if (nextType === "member_profile" && !nextSubjectUserId) {
        this.sendJson(res, { error: "member_profile_requires_subject_user_id" }, 400);
        return;
      }
      const result = await this.options.groupMemoryCandidateService.approve(approveRoute.id, patch);
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
      this.sendHtml(res, ADMIN_APP_HTML_V2);
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
      const groupId = url.searchParams.get("groupId") ?? undefined;
      const subjectUserId = url.searchParams.get("subjectUserId") ?? undefined;
      const type = normalizeOptionalMemoryType(url.searchParams.get("type") ?? undefined);
      const enabled = normalizeOptionalBoolean(url.searchParams.get("enabled") ?? undefined);
      const query = normalizeSearchQuery(url.searchParams.get("q") ?? undefined);
      const pagination = paginationParams(url, 20, 100);
      const rawMemories = sortMemoriesNewestFirst(await this.options.groupMemoryStore.list(groupId))
        .filter((memory) => !subjectUserId || memory.subjectUserId === subjectUserId)
        .filter((memory) => !type || memory.type === type)
        .filter((memory) => enabled === undefined || memory.enabled === enabled)
        .filter((memory) => !query || memoryMatchesQuery(memory, query));
      const page = paginateItems(rawMemories, pagination);
      const memories = await this.enrichMemories(page.items, groupId);
      this.sendJson(res, {
        memories,
        pagination: page.pagination,
      });
      return;
    }

    if (req.method === "POST") {
      const body = await readJsonBody(req);
      const memory = await this.options.groupMemoryStore.create(normalizeMemoryInput(body));
      this.invalidateMemberProfileCache(memory.groupId);
      this.sendJson(res, memory, 201);
      return;
    }

    this.sendJson(res, { error: "method_not_allowed" }, 405);
  }

  private async handleMemoryItem(req: IncomingMessage, res: ServerResponse, params: RouteParams): Promise<void> {
    if (req.method === "PUT") {
      const body = await readJsonBody(req);
      const memory = await this.options.groupMemoryStore.update(params.id, normalizeMemoryPatch(body));
      if (memory) {
        this.invalidateMemberProfileCache(memory.groupId);
      }
      this.sendJson(res, memory ?? { error: "not_found" }, memory ? 200 : 404);
      return;
    }

    if (req.method === "DELETE") {
      const existing = await this.findMemory(params.id);
      const removed = await this.options.groupMemoryStore.remove(params.id);
      if (existing) {
        this.invalidateMemberProfileCache(existing.groupId);
      }
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
    const groupId = url.searchParams.get("groupId") ?? undefined;
    const type = normalizeOptionalMemoryType(url.searchParams.get("type") ?? undefined);
    const subjectUserId = url.searchParams.get("subjectUserId") ?? undefined;
    const query = normalizeSearchQuery(url.searchParams.get("q") ?? undefined);
    const pagination = paginationParams(url, 20, 100);
    const rawCandidates = await this.options.groupMemoryCandidateService.list({
      groupId,
      ...(status ? { status } : {}),
    });
    const filteredCandidates = rawCandidates
      .filter((candidate) => !type || candidate.type === type)
      .filter((candidate) => !subjectUserId || candidate.subjectUserId === subjectUserId)
      .filter((candidate) => !query || candidateMatchesQuery(candidate, query));
    const page = paginateItems(filteredCandidates, pagination);
    const candidates = await this.enrichCandidates(page.items, groupId);
    this.sendJson(res, {
      candidates,
      pagination: page.pagination,
    });
  }

  private async handleCandidateItem(req: IncomingMessage, res: ServerResponse, params: RouteParams): Promise<void> {
    if (req.method === "PUT") {
      const body = await readJsonBody(req);
      const candidate = await this.options.groupMemoryCandidateService.update(params.id, normalizeCandidatePatch(body));
      if (candidate) {
        this.invalidateMemberProfileCache(candidate.groupId);
      }
      this.sendJson(res, candidate ?? { error: "not_found" }, candidate ? 200 : 404);
      return;
    }

    if (req.method === "DELETE") {
      const existing = await this.findCandidate(params.id);
      const removed = await this.options.groupMemoryCandidateService.remove(params.id);
      if (existing) {
        this.invalidateMemberProfileCache(existing.groupId);
      }
      this.sendJson(res, { ok: removed }, removed ? 200 : 404);
      return;
    }

    this.sendJson(res, { error: "method_not_allowed" }, 405);
  }

  private async handleGroupMembers(res: ServerResponse, groupId: string, force = false): Promise<void> {
    const profiles = await this.getCachedMemberProfileData(groupId, force);
    if (!profiles) {
      this.sendJson(res, { error: "not_found" }, 404);
      return;
    }

    this.sendJson(res, {
      members: profiles.members,
    });
  }

  private async handleMemberIdentity(
    req: IncomingMessage,
    res: ServerResponse,
    route: { groupId: string; userId: string },
  ): Promise<void> {
    if (!/^\d+$/.test(route.userId)) {
      this.sendJson(res, { error: "invalid_user_id" }, 400);
      return;
    }

    if (req.method === "PUT") {
      const body = await readJsonBody(req);
      const group = await this.options.groupConfigService.updateManualIdentity(route.groupId, route.userId, {
        names: normalizeNames(body.names),
        note: optionalString(body.note),
      });
      this.invalidateMemberProfileCache(route.groupId);
      this.sendJson(res, { group });
      return;
    }

    if (req.method === "DELETE") {
      const group = await this.options.groupConfigService.removeManualIdentity(route.groupId, route.userId);
      this.invalidateMemberProfileCache(route.groupId);
      this.sendJson(res, { group });
      return;
    }

    this.sendJson(res, { error: "method_not_allowed" }, 405);
  }

  private async enrichMemories(
    memories: GroupMemory[],
    preferredGroupId?: string,
  ): Promise<Array<GroupMemory & { subjectLabel: ReturnType<typeof buildSubjectLabel> }>> {
    const membersByGroup = await this.loadMemberProfilesByGroup(memories.map((memory) => memory.groupId), preferredGroupId);
    return memories.map((memory) => ({
      ...memory,
      subjectLabel: buildSubjectLabel(
        membersByGroup.get(memory.groupId)?.groupConfig ?? fallbackGroupConfig(memory.groupId),
        memory.subjectUserId,
        membersByGroup.get(memory.groupId)?.members ?? [],
        memory.type,
      ),
    }));
  }

  private async enrichCandidates(
    candidates: GroupMemoryCandidate[],
    preferredGroupId?: string,
  ): Promise<Array<GroupMemoryCandidate & { subjectLabel: ReturnType<typeof buildSubjectLabel> }>> {
    const membersByGroup = await this.loadMemberProfilesByGroup(candidates.map((candidate) => candidate.groupId), preferredGroupId);
    return candidates.map((candidate) => ({
      ...candidate,
      subjectLabel: buildSubjectLabel(
        membersByGroup.get(candidate.groupId)?.groupConfig ?? fallbackGroupConfig(candidate.groupId),
        candidate.subjectUserId,
        membersByGroup.get(candidate.groupId)?.members ?? [],
        candidate.type,
      ),
    }));
  }

  private async loadMemberProfilesByGroup(
    groupIds: string[],
    preferredGroupId?: string,
  ): Promise<Map<string, { groupConfig: GroupBotConfig; members: GroupMemberProfile[] }>> {
    const uniqueGroupIds = [...new Set([preferredGroupId, ...groupIds].filter((groupId): groupId is string => Boolean(groupId)))];
    const result = new Map<string, { groupConfig: GroupBotConfig; members: GroupMemberProfile[] }>();
    await Promise.all(uniqueGroupIds.map(async (groupId) => {
      const profiles = await this.getCachedMemberProfileData(groupId);
      if (!profiles) {
        return;
      }
      result.set(groupId, profiles);
    }));
    return result;
  }

  private async getCachedMemberProfileData(
    groupId: string,
    force = false,
  ): Promise<{ groupConfig: GroupBotConfig; members: GroupMemberProfile[] } | undefined> {
    const cached = this.memberProfileCache.get(groupId);
    if (!force && cached && cached.expiresAt > Date.now()) {
      return { groupConfig: cached.groupConfig, members: cached.members };
    }
    const inflight = this.memberProfileInflight.get(groupId);
    if (!force && inflight) {
      return inflight;
    }

    const loading = this.loadMemberProfileData(groupId);
    this.memberProfileInflight.set(groupId, loading);
    try {
      return await loading;
    } finally {
      if (this.memberProfileInflight.get(groupId) === loading) {
        this.memberProfileInflight.delete(groupId);
      }
    }
  }

  private async loadMemberProfileData(groupId: string): Promise<{ groupConfig: GroupBotConfig; members: GroupMemberProfile[] } | undefined> {
    const groupConfig = await this.options.groupConfigService.getGroup(groupId);
    if (!groupConfig) {
      this.memberProfileCache.delete(groupId);
      return undefined;
    }

    const [memories, candidates, napcatMembers] = await Promise.all([
      this.options.groupMemoryStore.list(groupId),
      this.options.groupMemoryCandidateService.list({ groupId }),
      this.safeListGroupMembers(groupId),
    ]);
    const data = {
      groupConfig,
      members: buildGroupMemberProfiles({ groupConfig, napcatMembers, memories, candidates }),
    };
    this.memberProfileCache.set(groupId, {
      ...data,
      expiresAt: Date.now() + 30_000,
    });
    return data;
  }

  private invalidateMemberProfileCache(groupId?: string): void {
    if (groupId) {
      this.memberProfileCache.delete(groupId);
      this.memberProfileInflight.delete(groupId);
      return;
    }
    this.memberProfileCache.clear();
    this.memberProfileInflight.clear();
  }

  private async safeListGroupMembers(groupId: string): Promise<NapcatGroupMember[]> {
    if (!this.options.listGroupMembers) {
      return [];
    }
    try {
      return await this.options.listGroupMembers(groupId);
    } catch (error) {
      logWarn("Failed to list group members for admin.", {
        groupId,
        error: (error as Error).message,
      });
      return [];
    }
  }

  private async findCandidate(id: string): Promise<GroupMemoryCandidate | undefined> {
    const candidates = await this.options.groupMemoryCandidateService.list();
    return candidates.find((candidate) => candidate.id === id);
  }

  private async findMemory(id: string): Promise<GroupMemory | undefined> {
    const memories = await this.options.groupMemoryStore.list();
    return memories.find((memory) => memory.id === id);
  }

  private async handleKnowledge(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (req.method === "GET") {
      const groupId = url.searchParams.get("groupId") ?? undefined;
      const query = normalizeSearchQuery(url.searchParams.get("q") ?? undefined);
      const pagination = paginationParams(url, 20, 100);
      const entries = (await this.options.knowledgeBaseStore.list(groupId))
        .filter((entry) => !query || knowledgeEntryMatchesQuery(entry, query));
      const page = paginateItems(entries, pagination);
      this.sendJson(res, { entries: page.items, pagination: page.pagination });
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
    subjectUserId: subjectUserIdField(body),
    title: requiredString(body.title),
    content: requiredString(body.content),
    confidence: optionalNumber(body.confidence),
    source: optionalString(body.source) ?? "admin",
    enabled: optionalBoolean(body.enabled) ?? true,
    ...(body.evidence !== undefined ? { evidence: evidenceField(body.evidence) } : {}),
  };
}

function sortMemoriesNewestFirst(memories: GroupMemory[]): GroupMemory[] {
  return [...memories].sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt) ||
    right.updatedAt.localeCompare(left.updatedAt) ||
    right.id.localeCompare(left.id),
  );
}

function paginationParams(url: URL, defaultPageSize: number, maxPageSize: number): { page: number; pageSize: number } {
  const page = Math.max(1, Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
  const requestedPageSize = Number.parseInt(url.searchParams.get("pageSize") ?? String(defaultPageSize), 10) || defaultPageSize;
  const pageSize = Math.max(1, Math.min(maxPageSize, requestedPageSize));
  return { page, pageSize };
}

function paginateItems<T>(
  items: T[],
  pagination: { page: number; pageSize: number },
): { items: T[]; pagination: { page: number; pageSize: number; total: number; totalPages: number } } {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pagination.pageSize));
  const page = Math.min(Math.max(1, pagination.page), totalPages);
  const start = (page - 1) * pagination.pageSize;
  return {
    items: items.slice(start, start + pagination.pageSize),
    pagination: {
      page,
      pageSize: pagination.pageSize,
      total,
      totalPages,
    },
  };
}

function normalizeSearchQuery(value: string | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeOptionalBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  const normalized = value.toLowerCase();
  if (["1", "true", "yes", "enabled", "启用"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "disabled", "停用"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function memoryMatchesQuery(memory: GroupMemory, query: string): boolean {
  return [
    memory.id,
    memory.groupId,
    memory.type,
    memory.subjectUserId,
    memory.title,
    memory.content,
    memory.source,
    memory.evidence?.summary,
    ...(memory.evidence?.speakers.map((speaker) => `${speaker.userId} ${speaker.userName}`) ?? []),
  ].some((value) => String(value ?? "").toLowerCase().includes(query));
}

function candidateMatchesQuery(candidate: GroupMemoryCandidate, query: string): boolean {
  return [
    candidate.id,
    candidate.groupId,
    candidate.type,
    candidate.status,
    candidate.subjectUserId,
    candidate.title,
    candidate.content,
    candidate.source,
    candidate.evidence?.summary,
    ...(candidate.evidence?.speakers.map((speaker) => `${speaker.userId} ${speaker.userName}`) ?? []),
  ].some((value) => String(value ?? "").toLowerCase().includes(query));
}

function knowledgeEntryMatchesQuery(entry: KnowledgeBaseEntry, query: string): boolean {
  return [
    entry.id,
    entry.groupId,
    entry.title,
    entry.question,
    entry.answer,
    entry.keywords.join(" "),
    entry.enabled ? "enabled 启用" : "disabled 停用",
  ].some((value) => String(value ?? "").toLowerCase().includes(query));
}

function normalizeMemoryPatch(body: Record<string, unknown>) {
  const nextType = body.type !== undefined ? normalizeMemoryType(body.type) : undefined;
  return {
    ...(body.groupId !== undefined ? { groupId: requiredString(body.groupId) } : {}),
    ...(nextType !== undefined ? { type: nextType } : {}),
    ...(nextType === "group_fact"
      ? { subjectUserId: undefined }
      : body.subjectUserId !== undefined
        ? { subjectUserId: subjectUserIdField(body) }
        : {}),
    ...(body.title !== undefined ? { title: requiredString(body.title) } : {}),
    ...(body.content !== undefined ? { content: requiredString(body.content) } : {}),
    ...(body.confidence !== undefined ? { confidence: optionalNumber(body.confidence) } : {}),
    ...(body.source !== undefined ? { source: optionalString(body.source) ?? "admin" } : {}),
    ...(body.enabled !== undefined ? { enabled: optionalBoolean(body.enabled) ?? true } : {}),
    ...(body.evidence !== undefined ? { evidence: evidenceField(body.evidence) } : {}),
  };
}

function normalizeCandidatePatch(body: Record<string, unknown>) {
  return {
    ...(body.type !== undefined ? { type: normalizeMemoryType(body.type) } : {}),
    ...(body.subjectUserId !== undefined ? { subjectUserId: subjectUserIdField(body) } : {}),
    ...(body.title !== undefined ? { title: requiredString(body.title) } : {}),
    ...(body.content !== undefined ? { content: requiredString(body.content) } : {}),
    ...(body.confidence !== undefined ? { confidence: optionalNumber(body.confidence) } : {}),
    ...(body.status !== undefined ? { status: normalizeStatus(requiredString(body.status)) ?? "pending" } : {}),
    ...(body.evidence !== undefined ? { evidence: evidenceField(body.evidence) } : {}),
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

function normalizeOptionalMemoryType(value: string | undefined): GroupMemoryType | undefined {
  return value === "member_profile" || value === "group_fact" ? value : undefined;
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

function subjectUserIdField(body: Record<string, unknown>): string | undefined {
  if (body.subjectUserId === null || body.subjectUserId === "") {
    return undefined;
  }
  return optionalUserId(body.subjectUserId);
}

function normalizeNames(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[,\s，、]+/)
      : [];
  return Array.from(new Set(raw.map((item) => String(item).trim()).filter(Boolean)));
}

function optionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function evidenceField(value: unknown): GroupMemoryEvidence | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const evidence = value as Partial<GroupMemoryEvidence>;
  const startAt = optionalString(evidence.startAt);
  const endAt = optionalString(evidence.endAt);
  const summary = optionalString(evidence.summary)?.slice(0, 600);
  if (!startAt || !endAt || !summary) {
    return undefined;
  }

  const messageCount = optionalNumber(evidence.messageCount) ?? 0;
  const speakers = Array.isArray(evidence.speakers)
    ? evidence.speakers
        .map((speaker) => {
          const source = speaker as { userId?: unknown; userName?: unknown };
          return {
            userId: optionalUserId(source.userId) ?? "",
            userName: optionalString(source.userName)?.slice(0, 80) ?? "",
          };
        })
        .filter((speaker) => speaker.userId)
        .slice(0, 20)
    : [];

  return {
    startAt,
    endAt,
    messageCount: Math.max(0, Math.floor(messageCount)),
    speakers,
    summary,
  };
}

function matchRoute(pathname: string, regex: RegExp): RouteParams | undefined {
  const match = pathname.match(regex);
  return match?.[1] ? { id: decodeURIComponent(match[1]) } : undefined;
}

function matchGroupMemberRoute(pathname: string, regex: RegExp): { groupId: string; userId?: string } | undefined {
  const match = pathname.match(regex);
  if (!match?.[1]) {
    return undefined;
  }
  return match[2]
    ? { groupId: decodeURIComponent(match[1]), userId: decodeURIComponent(match[2]) }
    : { groupId: decodeURIComponent(match[1]) };
}

function fallbackGroupConfig(groupId: string): GroupBotConfig {
  return {
    groupId,
    currentSkillId: "",
    allowedSkillIds: [],
    switcherUserIds: [],
    liveChatUserIds: [],
  };
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
