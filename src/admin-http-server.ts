import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { gzipSync } from "node:zlib";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";

import { ADMIN_APP_HTML_V2, ADMIN_CSS, LOGIN_HTML } from "./admin-ui.js";
import { ADMIN_APP_JS, LOGIN_JS } from "./admin-scripts.js";
import { logInfo, logWarn } from "./logger.js";
import type { TransportHealthStatus } from "./bot.js";
import type { AdminOperationLogService } from "./services/admin-operation-log-service.js";
import type { GroupConfigService } from "./services/group-config-service.js";
import type { GroupMemoryCandidateService } from "./services/group-memory-candidate-service.js";
import type { GroupMemoryStore } from "./services/group-memory-store.js";
import type { KnowledgeBaseStore } from "./services/knowledge-base-store.js";
import { buildGroupMemberProfiles, buildSubjectLabel } from "./services/member-profile-service.js";
import type { GroupBotConfig, GroupMemberProfile, GroupMemory, GroupMemoryCandidate, GroupMemoryCandidateStatus, GroupMemoryEvidence, GroupMemoryEvidencePreview, GroupMemoryType, NapcatGroupMember } from "./types.js";

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
type EvidenceResponseMode = "full" | "preview";

const ADMIN_EVIDENCE_SUMMARY_LIMIT = 2400;
const ADMIN_EVIDENCE_PREVIEW_LIMIT = 180;
const ADMIN_GZIP_MIN_BYTES = 1024;

export class AdminHttpServer {
  private readonly memberProfileCache = new Map<string, {
    expiresAt: number;
    groupConfig: GroupBotConfig;
    members: GroupMemberProfile[];
    includesNapcatMembers: boolean;
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

      if (req.method === "GET" && pathname === "/admin.css") {
        this.sendStaticText(res, ADMIN_CSS, "text/css; charset=utf-8");
        return;
      }

      if (req.method === "GET" && pathname === "/admin-login.js") {
        this.sendStaticText(res, LOGIN_JS, "application/javascript; charset=utf-8");
        return;
      }

      if (req.method === "GET" && pathname === "/admin-app.js") {
        this.sendStaticText(res, ADMIN_APP_JS, "application/javascript; charset=utf-8");
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
      const [groups, memoriesPage, candidatesPage, knowledgePage] = await Promise.all([
        this.options.groupConfigService.getAll(),
        this.options.groupMemoryStore.listPage({ groupId, page: 1, pageSize: 5 }),
        this.options.groupMemoryCandidateService.listPage({ groupId, status: "pending", page: 1, pageSize: 5 }),
        this.options.knowledgeBaseStore.listPage({ groupId, page: 1, pageSize: 5 }),
      ]);
      const transportHealth = this.options.getTransportHealthStatus
        ? await this.options.getTransportHealthStatus()
        : { ok: true, detail: "未配置传输层自检" };
      this.sendJson(res, {
        groups,
        groupId,
        stats: {
          groupCount: groups.length,
          memoryCount: memoriesPage.pagination.total,
          pendingCandidateCount: candidatesPage.pagination.total,
          knowledgeCount: knowledgePage.pagination.total,
        },
        recent: {
          candidates: await this.enrichCandidates(candidatesPage.items, groupId, "preview"),
          memories: await this.enrichMemories(memoriesPage.items, groupId, "preview"),
          knowledge: knowledgePage.items,
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
      await this.handleGroupMembers(res, membersRoute.groupId, url);
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

    if (pathname === "/api/memories/bulk" && req.method === "POST") {
      await this.handleBulkMemories(req, res);
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

    if (pathname === "/api/memory-candidates/bulk-approve" && req.method === "POST") {
      await this.handleBulkApproveCandidates(req, res);
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
      const evidenceMode = normalizeEvidenceMode(url.searchParams.get("evidence") ?? undefined);
      const pagination = paginationParams(url, 20, 100);
      const page = await this.options.groupMemoryStore.listPage({
        groupId,
        subjectUserId,
        type,
        enabled,
        query,
        ...pagination,
      });
      const memories = await this.enrichMemories(page.items, groupId, evidenceMode);
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
      const enriched = (await this.enrichMemories([memory], memory.groupId))[0];
      this.sendJson(res, enriched ?? memory, 201);
      return;
    }

    this.sendJson(res, { error: "method_not_allowed" }, 405);
  }

  private async handleMemoryItem(req: IncomingMessage, res: ServerResponse, params: RouteParams): Promise<void> {
    if (req.method === "GET") {
      const memory = await this.findMemory(params.id);
      const enriched = memory ? (await this.enrichMemories([memory], memory.groupId, "full"))[0] : undefined;
      this.sendJson(res, enriched ?? { error: "not_found" }, enriched ? 200 : 404);
      return;
    }

    if (req.method === "PUT") {
      const body = await readJsonBody(req);
      const memory = await this.options.groupMemoryStore.update(params.id, normalizeMemoryPatch(body));
      if (memory) {
        this.invalidateMemberProfileCache(memory.groupId);
      }
      const enriched = memory ? (await this.enrichMemories([memory], memory.groupId))[0] : undefined;
      this.sendJson(res, enriched ?? { error: "not_found" }, enriched ? 200 : 404);
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

  private async handleBulkMemories(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJsonBody(req);
    const ids = normalizeIds(body.ids);
    const action = typeof body.action === "string" ? body.action : "";
    if (ids.length === 0) {
      this.sendJson(res, { processed: [], skipped: [], processedCount: 0, skippedCount: 0 });
      return;
    }
    if (action !== "disable" && action !== "delete") {
      this.sendJson(res, { error: "invalid_action" }, 400);
      return;
    }

    const processed: Array<{ id: string; memory?: unknown }> = [];
    const skipped: Array<{ id: string; error: string }> = [];
    const changedGroupIds = new Set<string>();

    for (const id of ids) {
      const existing = await this.findMemory(id);
      if (!existing) {
        skipped.push({ id, error: "not_found" });
        continue;
      }

      if (action === "delete") {
        const removed = await this.options.groupMemoryStore.remove(id);
        if (!removed) {
          skipped.push({ id, error: "not_found" });
          continue;
        }
        processed.push({ id });
        changedGroupIds.add(existing.groupId);
        continue;
      }

      const memory = await this.options.groupMemoryStore.update(id, { enabled: false });
      if (!memory) {
        skipped.push({ id, error: "not_found" });
        continue;
      }
      processed.push({ id, memory: (await this.enrichMemories([memory], memory.groupId))[0] ?? memory });
      changedGroupIds.add(memory.groupId);
    }

    for (const groupId of changedGroupIds) {
      this.invalidateMemberProfileCache(groupId);
    }

    this.sendJson(res, {
      processed,
      skipped,
      processedCount: processed.length,
      skippedCount: skipped.length,
    });
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
    const evidenceMode = normalizeEvidenceMode(url.searchParams.get("evidence") ?? undefined);
    const pagination = paginationParams(url, 20, 100);
    const page = await this.options.groupMemoryCandidateService.listPage({
      groupId,
      ...(status ? { status } : {}),
      subjectUserId,
      type,
      query,
      ...pagination,
    });
    const candidates = await this.enrichCandidates(page.items, groupId, evidenceMode);
    this.sendJson(res, {
      candidates,
      pagination: page.pagination,
    });
  }

  private async handleBulkApproveCandidates(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJsonBody(req);
    const ids = normalizeIds(body.ids);
    if (ids.length === 0) {
      this.sendJson(res, { approved: [], skipped: [], approvedCount: 0, skippedCount: 0 });
      return;
    }

    const requestedCandidates = await Promise.all(ids.map(async (id) => [id, await this.findCandidate(id)] as const));
    const candidatesById = new Map(requestedCandidates);
    const approved: Array<NonNullable<Awaited<ReturnType<GroupMemoryCandidateService["approve"]>>>> = [];
    const skipped: Array<{ id: string; error: string }> = [];
    const changedGroupIds = new Set<string>();

    for (const id of ids) {
      const candidate = candidatesById.get(id);
      if (!candidate) {
        skipped.push({ id, error: "not_found" });
        continue;
      }
      if (candidate.type === "member_profile" && !candidate.subjectUserId) {
        skipped.push({ id, error: "member_profile_requires_subject_user_id" });
        continue;
      }
      const result = await this.options.groupMemoryCandidateService.approve(id);
      if (!result) {
        skipped.push({ id, error: "not_found" });
        continue;
      }
      approved.push(result);
      changedGroupIds.add(result.candidate.groupId);
    }

    for (const groupId of changedGroupIds) {
      this.invalidateMemberProfileCache(groupId);
    }

    this.sendJson(res, {
      approved,
      skipped,
      approvedCount: approved.length,
      skippedCount: skipped.length,
    });
  }

  private async handleCandidateItem(req: IncomingMessage, res: ServerResponse, params: RouteParams): Promise<void> {
    if (req.method === "GET") {
      const candidate = await this.findCandidate(params.id);
      const enriched = candidate ? (await this.enrichCandidates([candidate], candidate.groupId, "full"))[0] : undefined;
      this.sendJson(res, enriched ?? { error: "not_found" }, enriched ? 200 : 404);
      return;
    }

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

  private async handleGroupMembers(res: ServerResponse, groupId: string, url: URL): Promise<void> {
    const force = url.searchParams.get("refresh") === "1";
    const includeNapcatMembers = force || url.searchParams.get("includeNapcat") === "1";
    const profiles = await this.getCachedMemberProfileData(groupId, { force, includeNapcatMembers });
    if (!profiles) {
      this.sendJson(res, { error: "not_found" }, 404);
      return;
    }

    const query = normalizeSearchQuery(url.searchParams.get("q") ?? undefined);
    const returnAll = url.searchParams.get("all") === "1";
    const pagination = paginationParams(url, 24, 100);
    const filteredMembers = profiles.members.filter((member) => !query || memberMatchesQuery(member, query));
    if (returnAll) {
      this.sendJson(res, {
        members: filteredMembers,
        pagination: {
          page: 1,
          pageSize: Math.max(1, filteredMembers.length),
          total: filteredMembers.length,
          totalPages: 1,
        },
      });
      return;
    }
    const page = paginateItems(filteredMembers, pagination);
    this.sendJson(res, {
      members: page.items,
      pagination: page.pagination,
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
      const currentProfile = await this.getMemberProfile(route.groupId, route.userId);
      const group = await this.options.groupConfigService.updateManualIdentity(route.groupId, route.userId, {
        names: normalizeNames(body.names),
        note: optionalString(body.note),
      });
      this.invalidateMemberProfileCache(route.groupId);
      this.sendJson(res, { group, member: await this.buildUpdatedMemberProfile(route.groupId, route.userId, group, currentProfile) });
      return;
    }

    if (req.method === "DELETE") {
      const currentProfile = await this.getMemberProfile(route.groupId, route.userId);
      const group = await this.options.groupConfigService.removeManualIdentity(route.groupId, route.userId);
      this.invalidateMemberProfileCache(route.groupId);
      this.sendJson(res, { group, member: await this.buildUpdatedMemberProfile(route.groupId, route.userId, group, currentProfile) });
      return;
    }

    this.sendJson(res, { error: "method_not_allowed" }, 405);
  }

  private async enrichMemories(
    memories: GroupMemory[],
    preferredGroupId?: string,
    evidenceMode: EvidenceResponseMode = "full",
  ): Promise<Array<Omit<GroupMemory, "evidence"> & {
    evidence?: GroupMemoryEvidence | GroupMemoryEvidencePreview;
    subjectLabel: ReturnType<typeof buildSubjectLabel>;
  }>> {
    const groupsById = await this.loadGroupConfigsById(memories.map((memory) => memory.groupId), preferredGroupId);
    return memories.map((memory) => ({
      ...memory,
      ...(memory.evidence ? { evidence: formatEvidenceForResponse(memory.evidence, evidenceMode) } : {}),
      subjectLabel: buildSubjectLabel(
        groupsById.get(memory.groupId) ?? fallbackGroupConfig(memory.groupId),
        memory.subjectUserId,
        [],
        memory.type,
      ),
    }));
  }

  private async enrichCandidates(
    candidates: GroupMemoryCandidate[],
    preferredGroupId?: string,
    evidenceMode: EvidenceResponseMode = "full",
  ): Promise<Array<Omit<GroupMemoryCandidate, "evidence"> & {
    evidence?: GroupMemoryEvidence | GroupMemoryEvidencePreview;
    subjectLabel: ReturnType<typeof buildSubjectLabel>;
  }>> {
    const groupsById = await this.loadGroupConfigsById(candidates.map((candidate) => candidate.groupId), preferredGroupId);
    return candidates.map((candidate) => ({
      ...candidate,
      ...(candidate.evidence ? { evidence: formatEvidenceForResponse(candidate.evidence, evidenceMode) } : {}),
      subjectLabel: buildSubjectLabel(
        groupsById.get(candidate.groupId) ?? fallbackGroupConfig(candidate.groupId),
        candidate.subjectUserId,
        [],
        candidate.type,
      ),
    }));
  }

  private async loadGroupConfigsById(
    groupIds: string[],
    preferredGroupId?: string,
  ): Promise<Map<string, GroupBotConfig>> {
    const uniqueGroupIds = [...new Set([preferredGroupId, ...groupIds].filter((groupId): groupId is string => Boolean(groupId)))];
    const result = new Map<string, GroupBotConfig>();
    await Promise.all(uniqueGroupIds.map(async (groupId) => {
      const groupConfig = await this.options.groupConfigService.getGroup(groupId);
      if (!groupConfig) {
        return;
      }
      result.set(groupId, groupConfig);
    }));
    return result;
  }

  private async getCachedMemberProfileData(
    groupId: string,
    options: { force?: boolean; includeNapcatMembers?: boolean } = {},
  ): Promise<{ groupConfig: GroupBotConfig; members: GroupMemberProfile[] } | undefined> {
    const force = options.force === true;
    const includeNapcatMembers = options.includeNapcatMembers === true;
    const cached = this.memberProfileCache.get(groupId);
    if (!force && cached && cached.expiresAt > Date.now() && (!includeNapcatMembers || cached.includesNapcatMembers)) {
      return { groupConfig: cached.groupConfig, members: cached.members };
    }
    const inflightKey = memberProfileInflightKey(groupId, includeNapcatMembers);
    const inflight = this.memberProfileInflight.get(inflightKey);
    if (!force && inflight) {
      return inflight;
    }

    const loading = this.loadMemberProfileData(groupId, includeNapcatMembers);
    this.memberProfileInflight.set(inflightKey, loading);
    try {
      return await loading;
    } finally {
      if (this.memberProfileInflight.get(inflightKey) === loading) {
        this.memberProfileInflight.delete(inflightKey);
      }
    }
  }

  private async loadMemberProfileData(
    groupId: string,
    includeNapcatMembers: boolean,
  ): Promise<{ groupConfig: GroupBotConfig; members: GroupMemberProfile[] } | undefined> {
    const groupConfig = await this.options.groupConfigService.getGroup(groupId);
    if (!groupConfig) {
      this.memberProfileCache.delete(groupId);
      return undefined;
    }

    const [memoryCounts, pendingCandidateCounts, napcatMembers] = await Promise.all([
      this.options.groupMemoryStore.countBySubject(groupId),
      this.options.groupMemoryCandidateService.countPendingBySubject(groupId),
      includeNapcatMembers ? this.safeListGroupMembers(groupId) : Promise.resolve([]),
    ]);
    const data = {
      groupConfig,
      members: buildGroupMemberProfiles({ groupConfig, napcatMembers, memoryCounts, pendingCandidateCounts }),
    };
    this.memberProfileCache.set(groupId, {
      ...data,
      includesNapcatMembers: includeNapcatMembers,
      expiresAt: Date.now() + 30_000,
    });
    return data;
  }

  private invalidateMemberProfileCache(groupId?: string): void {
    if (groupId) {
      this.memberProfileCache.delete(groupId);
      this.memberProfileInflight.delete(memberProfileInflightKey(groupId, false));
      this.memberProfileInflight.delete(memberProfileInflightKey(groupId, true));
      return;
    }
    this.memberProfileCache.clear();
    this.memberProfileInflight.clear();
  }

  private async getMemberProfile(groupId: string, userId: string): Promise<GroupMemberProfile | undefined> {
    const profiles = await this.getCachedMemberProfileData(groupId);
    return profiles?.members.find((member) => member.userId === userId);
  }

  private async buildUpdatedMemberProfile(
    groupId: string,
    userId: string,
    groupConfig: GroupBotConfig,
    currentProfile?: GroupMemberProfile,
  ): Promise<GroupMemberProfile> {
    const [memoryCounts, pendingCandidateCounts] = await Promise.all([
      this.options.groupMemoryStore.countBySubject(groupId),
      this.options.groupMemoryCandidateService.countPendingBySubject(groupId),
    ]);
    const napcatMembers: NapcatGroupMember[] = currentProfile
      ? [{
          user_id: Number(userId),
          ...(currentProfile.card ? { card: currentProfile.card } : {}),
          ...(currentProfile.nickname ? { nickname: currentProfile.nickname } : {}),
          ...(currentProfile.role ? { role: currentProfile.role } : {}),
        }]
      : [];
    return buildGroupMemberProfiles({
      groupConfig,
      napcatMembers,
      memoryCounts,
      pendingCandidateCounts,
    }).find((member) => member.userId === userId) ?? {
      userId,
      displayName: userId,
      aliases: [],
      hasManualIdentity: false,
      memoryCount: 0,
      pendingCandidateCount: 0,
    };
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
    return this.options.groupMemoryCandidateService.get(id);
  }

  private async findMemory(id: string): Promise<GroupMemory | undefined> {
    return this.options.groupMemoryStore.get(id);
  }

  private async handleKnowledge(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (req.method === "GET") {
      const groupId = url.searchParams.get("groupId") ?? undefined;
      const query = normalizeSearchQuery(url.searchParams.get("q") ?? undefined);
      const pagination = paginationParams(url, 20, 100);
      const page = await this.options.knowledgeBaseStore.listPage({
        groupId,
        query,
        ...pagination,
      });
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
    this.sendText(res, JSON.stringify(data), "application/json; charset=utf-8", { statusCode });
  }

  private sendHtml(res: ServerResponse, html: string): void {
    this.sendText(res, html, "text/html; charset=utf-8");
  }

  private sendStaticText(res: ServerResponse, content: string, contentType: string): void {
    this.sendText(res, content, contentType, { cacheControl: "private, max-age=300" });
  }

  private sendText(
    res: ServerResponse,
    content: string,
    contentType: string,
    options: { statusCode?: number; cacheControl?: string } = {},
  ): void {
    const body = Buffer.from(content, "utf8");
    const request = res.req as IncomingMessage | undefined;
    const acceptsGzip = request?.headers["accept-encoding"]?.includes("gzip") ?? false;
    const shouldCompress = acceptsGzip && body.byteLength >= ADMIN_GZIP_MIN_BYTES;
    const payload = shouldCompress ? gzipSync(body) : body;
    res.statusCode = options.statusCode ?? 200;
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", payload.byteLength);
    res.setHeader("Vary", "Accept-Encoding");
    if (options.cacheControl) res.setHeader("Cache-Control", options.cacheControl);
    if (shouldCompress) res.setHeader("Content-Encoding", "gzip");
    res.end(payload);
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

function memberProfileInflightKey(groupId: string, includeNapcatMembers: boolean): string {
  return `${groupId}:${includeNapcatMembers ? "full" : "light"}`;
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

function normalizeEvidenceMode(value: string | undefined): EvidenceResponseMode {
  return value === "preview" ? "preview" : "full";
}

function formatEvidenceForResponse(
  evidence: GroupMemoryEvidence,
  mode: EvidenceResponseMode,
): GroupMemoryEvidence | GroupMemoryEvidencePreview {
  if (mode === "full") {
    return evidence;
  }

  return {
    startAt: evidence.startAt,
    endAt: evidence.endAt,
    messageCount: evidence.messageCount,
    speakerCount: evidence.speakers.length,
    summaryPreview: evidence.summary.length > ADMIN_EVIDENCE_PREVIEW_LIMIT
      ? `${evidence.summary.slice(0, ADMIN_EVIDENCE_PREVIEW_LIMIT)}...`
      : evidence.summary,
    hasFullEvidence: true,
  };
}

function memberMatchesQuery(member: GroupMemberProfile, query: string): boolean {
  return [
    member.userId,
    member.displayName,
    member.card,
    member.nickname,
    member.role,
    member.note,
    ...(member.aliases ?? []),
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

function normalizeIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(new Set(value.map((item) => String(item).trim()).filter(Boolean)));
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
  const summary = optionalString(evidence.summary)?.slice(0, ADMIN_EVIDENCE_SUMMARY_LIMIT);
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
