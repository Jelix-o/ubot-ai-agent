import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { URL } from "node:url";

import { ADMIN_APP_HTML_V2, ADMIN_CSS, LOGIN_HTML } from "./admin-ui.js";
import { ADMIN_APP_JS, LOGIN_JS } from "./admin-scripts.js";
import {
  formatEvidenceForResponse,
  memberMatchesQuery,
  normalizeEvidenceMode,
  normalizeSearchQuery,
  paginateItems,
  paginationParams,
  type EvidenceResponseMode,
} from "./admin-http-utils.js";
import { logInfo, logWarn } from "./logger.js";
import { GroupConfigValidationError } from "./services/group-config-service.js";
import type { TransportHealthStatus } from "./bot.js";
import type { AdminOperationLogService } from "./services/admin-operation-log-service.js";
import type { AdminTaskStore } from "./services/admin-task-store.js";
import type { GroupConfigService } from "./services/group-config-service.js";
import type { GroupMemoryCandidateService } from "./services/group-memory-candidate-service.js";
import {
  GroupMemoryDeduplicateService,
  normalizeMemoryDedupDecision,
  type MemoryDedupDecision,
} from "./services/group-memory-deduplicate-service.js";
import type { GroupMemoryStore } from "./services/group-memory-store.js";
import type { KnowledgeBaseStore } from "./services/knowledge-base-store.js";
import type { MemorySemanticJudgeInput, MemorySemanticJudgeResult } from "./services/ai-service.js";
import type { ScheduledReminderService } from "./services/scheduled-reminder-service.js";
import type { SkillService } from "./services/skill-service.js";
import type { SystemSettingsStore } from "./services/system-settings-store.js";
import type { ProfileRecordStore } from "./services/profile-record-store.js";
import type { ModelHealthHistoryStore, ModelHealthHistoryEntry } from "./services/model-health-history-store.js";
import { getServerStatusSnapshot, probeSystemModel } from "./services/model-probe-service.js";
import { getYesterdayDateKey, type DailyProfileReviewService } from "./services/daily-profile-review-service.js";
import { buildGroupMemberProfiles, buildSubjectLabel } from "./services/member-profile-service.js";
import { isScheduleDateRuleMatched } from "./utils/schedule-date-rule.js";
import type { AdminSession, AdminTaskStatus, AdminTaskType, AiHealthStatus, GroupBotConfig, GroupMemberProfile, GroupMemory, GroupMemoryCandidate, GroupMemoryCandidateStatus, GroupMemoryEvidence, GroupMemoryEvidencePreview, GroupMemoryType, NapcatGroupInfo, NapcatGroupMember, ProfileRecord, ProfileRecordType, ScheduleDateRule, SkillDefinition, SystemCommandConfig, SystemModelPurpose, SystemSettings } from "./types.js";

interface AdminHttpServerOptions {
  host: string;
  port: number;
  publicBaseUrl: string;
  username: string;
  password: string;
  groupPassword?: string;
  sessionSecret: string;
  groupConfigService: GroupConfigService;
  groupMemoryStore: GroupMemoryStore;
  groupMemoryCandidateService: GroupMemoryCandidateService;
  dailyProfileReviewService?: DailyProfileReviewService;
  knowledgeBaseStore: KnowledgeBaseStore;
  scheduledReminderService?: ScheduledReminderService;
  skillService?: SkillService;
  systemSettingsStore?: SystemSettingsStore;
  profileRecordStore?: ProfileRecordStore;
  adminTaskStore?: AdminTaskStore;
  modelHealthHistoryStore?: ModelHealthHistoryStore;
  adminOperationLogService: AdminOperationLogService;
  getTransportHealthStatus?: () => Promise<TransportHealthStatus>;
  getProfileAiHealthStatus?: (options?: { refresh?: boolean }) => Promise<AiHealthStatus>;
  judgeMemorySemanticRelation?: (args: MemorySemanticJudgeInput) => Promise<MemorySemanticJudgeResult | null>;
  listGroupMembers?: (groupId: string) => Promise<NapcatGroupMember[]>;
  listGroups?: () => Promise<NapcatGroupInfo[]>;
}

type RouteParams = Record<string, string>;

interface KnowledgeCandidate {
  title: string;
  question: string;
  answer: string;
  keywords: string[];
}

interface KnowledgeImportSkippedItem {
  question: string;
  title: string;
  reason: "duplicate_question" | "duplicate_title";
  existingId: string;
}

interface GeneratedProfileRecordResponse {
  groupId: string;
  userId: string;
  type: ProfileRecordType;
  subjectLabel: ReturnType<typeof buildSubjectLabel>;
  summary: string;
  generatedAt: string;
  memoryCount: number;
  sourceMemoryCount: number;
  cached: boolean;
  record?: unknown;
}

type HealthStatusResponse = {
  ok: boolean;
  detail: string;
  model?: string;
  baseUrl?: string;
  checkedAt?: string;
  latencyMs?: number;
  cached?: boolean;
  probeType?: "chat" | "tts";
  upstreamStatusCode?: number;
  failureKind?: AiHealthStatus["failureKind"];
};

type ModelHealthStatus = AiHealthStatus & {
  id: string;
  purpose: SystemModelPurpose;
  name: string;
  shortName: string;
  selected: boolean;
};

class ProfileRecordGenerationError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number,
  ) {
    super(code);
  }
}

class AdminRequestBodyError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number,
  ) {
    super(code);
  }
}

const ADMIN_EVIDENCE_SUMMARY_LIMIT = 2400;
const ADMIN_GZIP_MIN_BYTES = 1024;
const ADMIN_LOGIN_WINDOW_MS = 10 * 60 * 1000;
const ADMIN_LOGIN_MAX_FAILURES = 5;
const ADMIN_LOGIN_LOCK_MS = 15 * 60 * 1000;
const ADMIN_STATIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "admin");
const ADMIN_STATIC_INDEX = path.join(ADMIN_STATIC_DIR, "index.html");
const STATIC_CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

export class AdminHttpServer {
  private readonly memberProfileCache = new Map<string, {
    expiresAt: number;
    groupConfig: GroupBotConfig;
    members: GroupMemberProfile[];
    includesNapcatMembers: boolean;
  }>();

  private readonly memberProfileInflight = new Map<string, Promise<{ groupConfig: GroupBotConfig; members: GroupMemberProfile[] } | undefined>>();

  private readonly modelHealthCache = new Map<string, {
    expiresAt: number;
    status: ModelHealthStatus;
  }>();
  private readonly loginAttempts = new Map<string, {
    failures: number;
    firstFailureAt: number;
    lockedUntil?: number;
  }>();

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

      const publicProfileRoute = matchRoute(pathname, /^\/profile\/([^/]+)$/);
      if (req.method === "GET" && publicProfileRoute) {
        await this.handlePublicProfilePage(res, publicProfileRoute.id);
        return;
      }

      if (req.method === "POST" && pathname === "/api/login") {
        await this.handleLogin(req, res);
        return;
      }

      const session = this.getSession(req);
      if (pathname.startsWith("/api/") && !session) {
        this.sendJson(res, { error: "unauthorized" }, 401);
        return;
      }

      if (pathname.startsWith("/api/") && session && isStateChangingMethod(req.method) && !this.isValidCsrf(req, session)) {
        this.sendJson(res, { error: "csrf_required" }, 403);
        return;
      }

      if (!pathname.startsWith("/api/") && req.method === "GET") {
        await this.handleStaticApp(res, pathname);
        return;
      }

      await this.handleApi(req, res, pathname, url, session);
    } catch (error) {
      logWarn("Admin HTTP request failed.", {
        method: req.method,
        url: req.url,
        error: (error as Error).message,
      });
      if (error instanceof AdminRequestBodyError) {
        this.sendJson(res, { error: error.code }, error.statusCode);
        return;
      }
      this.sendJson(res, { error: "internal_error" }, 500);
    }
  }

  private async handleApi(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
    url: URL,
    session?: AdminSession,
  ): Promise<void> {
    if (!session) {
      this.sendJson(res, { error: "unauthorized" }, 401);
      return;
    }

    if (req.method === "POST" && pathname === "/api/logout") {
      this.setSessionCookie(res, "", new Date(0));
      this.sendJson(res, { ok: true });
      return;
    }

    if (req.method === "GET" && pathname === "/api/session") {
      this.sendJson(res, this.publicSession(session));
      return;
    }

    if (req.method === "GET" && pathname === "/api/overview") {
      const requestedGroupId = url.searchParams.get("groupId") ?? undefined;
      const groupId = requestedGroupId && await this.canAccessGroup(session, requestedGroupId) ? requestedGroupId : undefined;
      if (requestedGroupId && !groupId) {
        this.sendJson(res, { error: "forbidden" }, 403);
        return;
      }
      const visibleGroups = await this.visibleGroups(session);
      const visibleGroupIds = new Set(visibleGroups.map((group) => group.groupId));
      const [groups, memoriesPage, candidatesPage, knowledgePage, allMemories, allPendingCandidates, allKnowledge] = await Promise.all([
        Promise.resolve(visibleGroups),
        this.options.groupMemoryStore.listPage({ groupId, page: 1, pageSize: 5 }),
        this.options.groupMemoryCandidateService.listPage({ groupId, status: "pending", page: 1, pageSize: 5 }),
        this.options.knowledgeBaseStore.listPage({ groupId, page: 1, pageSize: 5 }),
        groupId ? Promise.resolve([]) : this.options.groupMemoryStore.list(),
        groupId ? Promise.resolve([]) : this.options.groupMemoryCandidateService.list({ status: "pending" }),
        groupId ? Promise.resolve([]) : this.options.knowledgeBaseStore.list(),
      ]);
      const visibleMemoryCount = groupId
        ? memoriesPage.pagination.total
        : allMemories.filter((item) => visibleGroupIds.has(item.groupId)).length;
      const visiblePendingCandidateCount = groupId
        ? candidatesPage.pagination.total
        : allPendingCandidates.filter((item) => visibleGroupIds.has(item.groupId)).length;
      const visibleKnowledgeCount = groupId
        ? knowledgePage.pagination.total
        : allKnowledge.filter((item) => visibleGroupIds.has(item.groupId)).length;
      const canViewDiagnostics = session.role === "super_admin";
      const rawTransportHealth = this.options.getTransportHealthStatus
        ? await this.options.getTransportHealthStatus()
        : { ok: true, detail: "未配置传输层自检" };
      const transportHealth = canViewDiagnostics
        ? sanitizeHealthStatus(rawTransportHealth)
        : publicHealthStatus(rawTransportHealth);
      const profileAiHealth = canViewDiagnostics
        ? sanitizeHealthStatus(await this.getProfileAiHealthStatus())
        : restrictedHealthStatus();
      const modelStatuses = canViewDiagnostics ? await this.getModelHealthStatuses() : [];
      const abnormalModelStatuses = modelStatuses.filter(isAbnormalModelStatus);
      this.sendJson(res, {
        groups,
        groupId,
        stats: {
          groupCount: groups.length,
          memoryCount: visibleMemoryCount,
          pendingCandidateCount: visiblePendingCandidateCount,
          knowledgeCount: visibleKnowledgeCount,
        },
        recent: {
          candidates: await this.enrichCandidates(candidatesPage.items.filter((item) => visibleGroupIds.has(item.groupId)), groupId, "preview"),
          memories: await this.enrichMemories(memoriesPage.items.filter((item) => visibleGroupIds.has(item.groupId)), groupId, "preview"),
          knowledge: knowledgePage.items.filter((item) => visibleGroupIds.has(item.groupId)),
        },
        transportHealth,
        profileAiHealth,
        modelStatuses,
        abnormalModelStatuses,
        modelStatusSummary: {
          total: modelStatuses.length,
          abnormal: abnormalModelStatuses.length,
          checkedAt: new Date().toISOString(),
        },
      });
      return;
    }

    if (req.method === "GET" && pathname === "/api/groups") {
      const includeDisabled = session.role === "super_admin" && url.searchParams.get("includeDisabled") === "1";
      this.sendJson(res, { groups: await this.visibleGroups(session, { includeDisabled }) });
      return;
    }

    if (req.method === "GET" && pathname === "/api/search") {
      await this.handleGlobalSearch(res, url, session);
      return;
    }

    if (pathname === "/api/tasks") {
      await this.handleTasks(req, res, url, session);
      return;
    }

    const taskRoute = matchRoute(pathname, /^\/api\/tasks\/([^/]+)$/);
    if (taskRoute && req.method === "GET") {
      await this.handleTaskItem(res, taskRoute.id, session);
      return;
    }

    const groupConfigRoute = matchRoute(pathname, /^\/api\/groups\/([^/]+)\/config$/);
    if (groupConfigRoute) {
      if (!(await this.canAccessGroup(session, groupConfigRoute.id))) {
        this.sendJson(res, { error: "forbidden" }, 403);
        return;
      }
      await this.handleGroupConfig(req, res, groupConfigRoute);
      return;
    }

    const membersRoute = matchGroupMemberRoute(pathname, /^\/api\/groups\/([^/]+)\/members$/);
    if (membersRoute && req.method === "GET") {
      if (!(await this.canAccessGroup(session, membersRoute.groupId))) {
        this.sendJson(res, { error: "forbidden" }, 403);
        return;
      }
      await this.handleGroupMembers(res, membersRoute.groupId, url);
      return;
    }

    const identityRoute = matchGroupMemberRoute(pathname, /^\/api\/groups\/([^/]+)\/members\/([^/]+)\/identity$/);
    if (identityRoute?.userId) {
      if (!(await this.canAccessGroup(session, identityRoute.groupId))) {
        this.sendJson(res, { error: "forbidden" }, 403);
        return;
      }
      await this.handleMemberIdentity(req, res, { groupId: identityRoute.groupId, userId: identityRoute.userId });
      return;
    }

    const profileSummaryRoute = matchGroupMemberRoute(pathname, /^\/api\/groups\/([^/]+)\/members\/([^/]+)\/profile-summary$/);
    if (profileSummaryRoute?.userId && req.method === "GET") {
      if (!(await this.canAccessGroup(session, profileSummaryRoute.groupId))) {
        this.sendJson(res, { error: "forbidden" }, 403);
        return;
      }
      await this.handleMemberProfileSummary(res, { groupId: profileSummaryRoute.groupId, userId: profileSummaryRoute.userId }, url, session);
      return;
    }

    if (req.method === "GET" && pathname === "/api/notifications") {
      await this.handleNotifications(res, session);
      return;
    }

    if (pathname === "/api/system-settings") {
      if (!this.requireSuperAdmin(session, res)) return;
      await this.handleSystemSettings(req, res);
      return;
    }

    if (pathname === "/api/system-settings/admin-secret" || pathname === "/api/system-settings/group-admin-secret") {
      if (!this.requireSuperAdmin(session, res)) return;
      await this.handleAdminSecretReset(req, res, pathname);
      return;
    }

    if (req.method === "POST" && pathname === "/api/models/test-all") {
      if (!this.requireSuperAdmin(session, res)) return;
      await this.handleAllModelConnectionTest(res, session);
      return;
    }

    const modelTestRoute = matchRoute(pathname, /^\/api\/models\/([^/]+)\/test$/);
    if (modelTestRoute && req.method === "POST") {
      if (!this.requireSuperAdmin(session, res)) return;
      await this.handleModelConnectionTest(res, modelTestRoute.id, session);
      return;
    }

    if (req.method === "GET" && pathname === "/api/model-options") {
      await this.handleModelOptions(res, session);
      return;
    }

    if (req.method === "GET" && pathname === "/api/model-health-history") {
      if (!this.requireSuperAdmin(session, res)) return;
      this.sendJson(res, {
        models: this.options.modelHealthHistoryStore ? await this.options.modelHealthHistoryStore.list() : [],
      });
      return;
    }

    if (req.method === "GET" && pathname === "/api/skill-options") {
      await this.handleSkillOptions(res);
      return;
    }

    if (req.method === "POST" && pathname === "/api/groups/sync") {
      if (!this.requireSuperAdmin(session, res)) return;
      await this.handleGroupSync(res);
      return;
    }

    const remindersRoute = matchRoute(pathname, /^\/api\/groups\/([^/]+)\/reminders$/);
    if (remindersRoute) {
      if (!(await this.canAccessGroup(session, remindersRoute.id))) {
        this.sendJson(res, { error: "forbidden" }, 403);
        return;
      }
      await this.handleGroupReminders(req, res, remindersRoute.id, session);
      return;
    }

    const reminderItemRoute = matchGroupItemRoute(pathname, /^\/api\/groups\/([^/]+)\/reminders\/([^/]+)$/);
    if (reminderItemRoute) {
      if (!(await this.canAccessGroup(session, reminderItemRoute.groupId))) {
        this.sendJson(res, { error: "forbidden" }, 403);
        return;
      }
      await this.handleGroupReminderItem(req, res, reminderItemRoute.groupId, reminderItemRoute.id);
      return;
    }

    const schedulePreviewRoute = matchRoute(pathname, /^\/api\/groups\/([^/]+)\/schedule-preview$/);
    if (schedulePreviewRoute && req.method === "GET") {
      if (!(await this.canAccessGroup(session, schedulePreviewRoute.id))) {
        this.sendJson(res, { error: "forbidden" }, 403);
        return;
      }
      await this.handleSchedulePreview(res, schedulePreviewRoute.id, url);
      return;
    }

    const profileRecordShareRoute = matchRoute(pathname, /^\/api\/profile-records\/([^/]+)\/share$/);
    if (profileRecordShareRoute) {
      await this.handleProfileRecordShare(req, res, profileRecordShareRoute.id, session);
      return;
    }

    if (pathname === "/api/profile-records") {
      await this.handleProfileRecords(req, res, url, session);
      return;
    }

    const profileRecordRoute = matchRoute(pathname, /^\/api\/profile-records\/([^/]+)$/);
    if (profileRecordRoute) {
      await this.handleProfileRecordItem(req, res, profileRecordRoute.id, session);
      return;
    }

    if (
      pathname === "/api/skills" ||
      pathname === "/api/skills/import" ||
      pathname === "/api/skills/export" ||
      pathname === "/api/skills/backup" ||
      pathname === "/api/skills/backups" ||
      /^\/api\/skills\/backups\/[^/]+\/restore$/.test(pathname) ||
      /^\/api\/skills\/[^/]+$/.test(pathname)
    ) {
      if (!this.requireSuperAdmin(session, res)) return;
      await this.handleSkills(req, res, pathname, url);
      return;
    }

    if (pathname === "/api/commands") {
      if (!this.requireSuperAdmin(session, res)) return;
      await this.handleCommands(req, res);
      return;
    }

    if (req.method === "GET" && pathname === "/api/health") {
      const canViewDiagnostics = session.role === "super_admin";
      const refresh = canViewDiagnostics && url.searchParams.get("refresh") === "1";
      const rawTransportHealth = this.options.getTransportHealthStatus
        ? await this.options.getTransportHealthStatus()
        : { ok: true, detail: "未配置传输层自检" };
      const transportHealth = canViewDiagnostics
        ? sanitizeHealthStatus(rawTransportHealth)
        : publicHealthStatus(rawTransportHealth);
      const profileAiHealth = canViewDiagnostics
        ? sanitizeHealthStatus(await this.getProfileAiHealthStatus({ refresh }))
        : restrictedHealthStatus();
      const modelStatuses = canViewDiagnostics ? await this.getModelHealthStatuses({ refresh }) : [];
      const abnormalModelStatuses = modelStatuses.filter(isAbnormalModelStatus);
      const memory = process.memoryUsage();
      const environmentStatus = {
        transportHealth,
        node: {
          ok: true,
          detail: canViewDiagnostics ? `${process.version} / PID ${process.pid}` : process.version,
          checkedAt: `uptime ${Math.floor(process.uptime())}s`,
          latencyMs: 0,
        },
        memory: {
          ok: true,
          detail: `RSS ${Math.round(memory.rss / 1024 / 1024)}MB，堆内存 ${Math.round(memory.heapUsed / 1024 / 1024)}MB`,
          checkedAt: new Date().toISOString(),
          latencyMs: 0,
        },
      };
      this.sendJson(res, {
        transportHealth,
        profileAiHealth,
        environmentStatus,
        modelStatuses,
        abnormalModelStatuses,
        modelStatusSummary: {
          total: modelStatuses.length,
          abnormal: abnormalModelStatuses.length,
          checkedAt: new Date().toISOString(),
        },
        uptimeSeconds: Math.floor(process.uptime()),
        nodeVersion: process.version,
        ...(canViewDiagnostics
          ? { serverStatus: getServerStatusSnapshot(), pid: process.pid, memory }
          : { memory: { rss: memory.rss, heapUsed: memory.heapUsed } }),
      });
      return;
    }

    if (req.method === "GET" && pathname === "/api/logs") {
      const groupId = url.searchParams.get("groupId") ?? "";
      if (groupId && !(await this.canAccessGroup(session, groupId))) {
        this.sendJson(res, { error: "forbidden" }, 403);
        return;
      }
      if (!groupId && session.role !== "super_admin") {
        this.sendJson(res, { error: "group_id_required" }, 400);
        return;
      }
      this.sendJson(res, {
        entries: await this.options.adminOperationLogService.list({
          ...(groupId ? { groupId } : {}),
          action: url.searchParams.get("action") ?? undefined,
          q: url.searchParams.get("q") ?? undefined,
          limit: normalizeLogLimit(url.searchParams.get("limit") ?? undefined),
        }),
      });
      return;
    }

    if (pathname === "/api/memories") {
      await this.handleMemories(req, res, url, session);
      return;
    }

    if (pathname === "/api/memories/bulk" && req.method === "POST") {
      await this.handleBulkMemories(req, res, session);
      return;
    }

    if (pathname === "/api/memories/deduplicate/preview" && req.method === "POST") {
      await this.handleMemoryDeduplicatePreview(req, res, session);
      return;
    }

    if (pathname === "/api/memories/deduplicate/apply" && req.method === "POST") {
      await this.handleMemoryDeduplicateApply(req, res, session);
      return;
    }

    const memoryRoute = matchRoute(pathname, /^\/api\/memories\/([^/]+)$/);
    if (memoryRoute) {
      await this.handleMemoryItem(req, res, memoryRoute, session);
      return;
    }

    if (pathname === "/api/memory-candidates") {
      await this.handleCandidates(req, res, url, session);
      return;
    }

    if (pathname === "/api/memory-candidates/bulk-approve" && req.method === "POST") {
      await this.handleBulkApproveCandidates(req, res, session);
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
      if (!(await this.canAccessGroup(session, current.groupId))) {
        this.sendJson(res, { error: "forbidden" }, 403);
        return;
      }
      const nextType = patch.type ?? current.type;
      const nextSubjectUserId = patch.subjectUserId === undefined ? current.subjectUserId : patch.subjectUserId;
      if (nextType === "member_profile" && !nextSubjectUserId) {
        this.sendJson(res, { error: "member_profile_requires_subject_user_id" }, 400);
        return;
      }
      const result = await this.options.groupMemoryCandidateService.approveDirect(approveRoute.id, patch);
      this.sendJson(res, result ?? { error: "not_found" }, result ? 200 : 404);
      return;
    }

    const rejectRoute = matchRoute(pathname, /^\/api\/memory-candidates\/([^/]+)\/reject$/);
    if (rejectRoute && req.method === "POST") {
      const current = await this.findCandidate(rejectRoute.id);
      if (!current) {
        this.sendJson(res, { error: "not_found" }, 404);
        return;
      }
      if (!(await this.canAccessGroup(session, current.groupId))) {
        this.sendJson(res, { error: "forbidden" }, 403);
        return;
      }
      const candidate = await this.options.groupMemoryCandidateService.reject(rejectRoute.id);
      this.sendJson(res, candidate ?? { error: "not_found" }, candidate ? 200 : 404);
      return;
    }

    const candidateRoute = matchRoute(pathname, /^\/api\/memory-candidates\/([^/]+)$/);
    if (candidateRoute) {
      await this.handleCandidateItem(req, res, candidateRoute, session);
      return;
    }

    if (pathname === "/api/knowledge") {
      await this.handleKnowledge(req, res, url, session);
      return;
    }

    if (pathname === "/api/knowledge/import/preview" && req.method === "POST") {
      await this.handleKnowledgeImportPreview(req, res, session);
      return;
    }

    if (pathname === "/api/knowledge/import/apply" && req.method === "POST") {
      await this.handleKnowledgeImportApply(req, res, session);
      return;
    }

    const knowledgeRoute = matchRoute(pathname, /^\/api\/knowledge\/([^/]+)$/);
    if (knowledgeRoute) {
      await this.handleKnowledgeItem(req, res, knowledgeRoute, session);
      return;
    }

    this.sendJson(res, { error: "not_found" }, 404);
  }

  private async handleStaticApp(res: ServerResponse, pathname: string): Promise<void> {
    const staticFile = resolveAdminStaticFile(pathname);
    if (staticFile && await this.trySendAdminStaticFile(res, staticFile)) {
      return;
    }

    const authenticated = this.isAuthenticated(res.req as IncomingMessage);
    if (!authenticated) {
      if (pathname === "" || pathname === "/login") {
        await this.sendAdminStaticFile(res, ADMIN_STATIC_INDEX, "text/html; charset=utf-8", LOGIN_HTML);
        return;
      }
      this.sendRedirect(res, "/login");
      return;
    }

    await this.sendAdminStaticFile(res, ADMIN_STATIC_INDEX, "text/html; charset=utf-8", ADMIN_APP_HTML_V2);
  }

  private async handlePublicProfilePage(res: ServerResponse, shareToken: string): Promise<void> {
    const record = this.options.profileRecordStore
      ? await this.options.profileRecordStore.getByShareToken(shareToken)
      : undefined;
    if (!record) {
      this.sendText(res, publicProfileNotFoundHtml(), "text/html; charset=utf-8", {
        statusCode: 404,
        cacheControl: "no-store",
      });
      return;
    }
    if (!isProfileSharePublic(record)) {
      this.sendText(res, publicProfileNotFoundHtml(), "text/html; charset=utf-8", {
        statusCode: 404,
        cacheControl: "no-store",
      });
      return;
    }
    await this.options.profileRecordStore?.recordShareAccess(record.id);
    this.sendText(res, publicProfileHtml(record.summary), "text/html; charset=utf-8", {
      cacheControl: "private, no-store",
    });
  }

  private async trySendAdminStaticFile(res: ServerResponse, filePath: string): Promise<boolean> {
    try {
      await this.sendAdminStaticFile(res, filePath, contentTypeFor(filePath));
      return true;
    } catch (error) {
      const known = error as NodeJS.ErrnoException;
      if (known.code === "ENOENT" || known.code === "EISDIR") {
        return false;
      }
      throw error;
    }
  }

  private async sendAdminStaticFile(res: ServerResponse, filePath: string, contentType: string, fallback?: string): Promise<void> {
    try {
      const body = await readFile(filePath);
      this.sendBuffer(res, body, contentType, {
        cacheControl: contentType.includes("text/html") ? "no-cache" : "public, max-age=31536000, immutable",
      });
    } catch (error) {
      if (fallback !== undefined) {
        this.sendText(res, fallback, contentType, { cacheControl: "no-cache" });
        return;
      }
      throw error;
    }
  }

  private async handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJsonBody(req);
    const username = typeof body.username === "string" ? body.username : "";
    const password = typeof body.password === "string" ? body.password : "";
    const loginKey = this.loginAttemptKey(req, username);
    if (this.isLoginLocked(loginKey)) {
      this.sendJson(res, { error: "too_many_login_attempts" }, 429);
      return;
    }
    const session = await this.buildLoginSession(username, password);
    if (!session) {
      this.recordFailedLogin(loginKey);
      this.sendJson(res, { error: "invalid_credentials" }, 401);
      return;
    }

    this.clearLoginAttempts(loginKey);
    const expires = new Date(Date.now() + 12 * 60 * 60 * 1000);
    const nextSession: AdminSession = { ...session, csrfToken: randomBytes(32).toString("base64url"), expiresAt: expires.toISOString() };
    this.setSessionCookie(res, this.signSession(nextSession), expires);
    this.sendJson(res, { ok: true, session: this.publicSession(nextSession) });
  }

  private async handleTasks(req: IncomingMessage, res: ServerResponse, url: URL, session: AdminSession): Promise<void> {
    if (!this.options.adminTaskStore) {
      this.sendJson(res, { error: "tasks_unavailable" }, 503);
      return;
    }
    if (req.method !== "GET") {
      this.sendJson(res, { error: "method_not_allowed" }, 405);
      return;
    }
    const requestedGroupId = url.searchParams.get("groupId") ?? undefined;
    const groupId = await this.normalizeAccessibleGroupId(session, requestedGroupId);
    if (groupId === false) {
      this.sendJson(res, { error: "forbidden" }, 403);
      return;
    }
    const effectiveGroupId = session.role === "super_admin" ? groupId : groupId ?? session.allowedGroupIds[0];
    const visibleGroupIds = (await this.visibleGroups(session)).map((group) => group.groupId);
    const page = await this.options.adminTaskStore.listPage({
      groupId: effectiveGroupId,
      visibleGroupIds: session.role === "super_admin" ? undefined : visibleGroupIds,
      includeSystemTasks: session.role === "super_admin",
      type: normalizeTaskType(url.searchParams.get("type") ?? undefined),
      status: normalizeTaskStatus(url.searchParams.get("status") ?? undefined),
      q: normalizeSearchQuery(url.searchParams.get("q") ?? undefined),
      ...paginationParams(url, 20, 100),
    });
    this.sendJson(res, {
      tasks: page.tasks,
      pagination: page.pagination,
    });
  }

  private async handleTaskItem(res: ServerResponse, id: string, session: AdminSession): Promise<void> {
    if (!this.options.adminTaskStore) {
      this.sendJson(res, { error: "tasks_unavailable" }, 503);
      return;
    }
    const task = await this.options.adminTaskStore.get(id);
    if (!task) {
      this.sendJson(res, { error: "not_found" }, 404);
      return;
    }
    if (task.groupId && !(await this.canAccessGroup(session, task.groupId))) {
      this.sendJson(res, { error: "forbidden" }, 403);
      return;
    }
    if (!task.groupId && session.role !== "super_admin") {
      this.sendJson(res, { error: "forbidden" }, 403);
      return;
    }
    this.sendJson(res, task);
  }

  private async handleMemories(req: IncomingMessage, res: ServerResponse, url: URL, session: AdminSession): Promise<void> {
    if (req.method === "GET") {
      const groupId = await this.normalizeAccessibleGroupId(session, url.searchParams.get("groupId") ?? undefined);
      if (groupId === false) {
        this.sendJson(res, { error: "forbidden" }, 403);
        return;
      }
      const subjectUserId = url.searchParams.get("subjectUserId") ?? undefined;
      const type = normalizeOptionalMemoryType(url.searchParams.get("type") ?? undefined);
      const enabled = normalizeOptionalBoolean(url.searchParams.get("enabled") ?? undefined);
      const query = normalizeSearchQuery(url.searchParams.get("q") ?? undefined);
      const evidenceMode = normalizeEvidenceMode(url.searchParams.get("evidence") ?? undefined);
      const excludeProfileRecords = url.searchParams.get("excludeProfileRecords") !== "0";
      const pagination = paginationParams(url, 20, 100);
      const page = await this.options.groupMemoryStore.listPage({
        groupId,
        subjectUserId,
        type,
        enabled,
        query,
        excludeProfileRecords,
        ...pagination,
      });
      const memories = await this.enrichMemories(await this.filterGroupItems(session, page.items), groupId, evidenceMode);
      this.sendJson(res, {
        memories,
        pagination: page.pagination,
      });
      return;
    }

    if (req.method === "POST") {
      const body = await readJsonBody(req);
      const input = normalizeMemoryInput(body);
      if (!(await this.canAccessGroup(session, input.groupId))) {
        this.sendJson(res, { error: "forbidden" }, 403);
        return;
      }
      const memory = await this.options.groupMemoryStore.create(input);
      this.invalidateMemberProfileCache(memory.groupId);
      const enriched = (await this.enrichMemories([memory], memory.groupId))[0];
      this.sendJson(res, enriched ?? memory, 201);
      return;
    }

    this.sendJson(res, { error: "method_not_allowed" }, 405);
  }

  private async handleMemoryItem(req: IncomingMessage, res: ServerResponse, params: RouteParams, session: AdminSession): Promise<void> {
    if (req.method === "GET") {
      const memory = await this.findMemory(params.id);
      if (memory && !(await this.canAccessGroup(session, memory.groupId))) {
        this.sendJson(res, { error: "forbidden" }, 403);
        return;
      }
      const enriched = memory ? (await this.enrichMemories([memory], memory.groupId, "full"))[0] : undefined;
      this.sendJson(res, enriched ?? { error: "not_found" }, enriched ? 200 : 404);
      return;
    }

    if (req.method === "PUT") {
      const existing = await this.findMemory(params.id);
      if (existing && !(await this.canAccessGroup(session, existing.groupId))) {
        this.sendJson(res, { error: "forbidden" }, 403);
        return;
      }
      const body = await readJsonBody(req);
      const patch = normalizeMemoryPatch(body);
      if (patch.groupId && !(await this.canAccessGroup(session, patch.groupId))) {
        this.sendJson(res, { error: "forbidden" }, 403);
        return;
      }
      const memory = await this.options.groupMemoryStore.update(params.id, patch);
      if (memory) {
        this.invalidateMemberProfileCache(memory.groupId);
      }
      const enriched = memory ? (await this.enrichMemories([memory], memory.groupId))[0] : undefined;
      this.sendJson(res, enriched ?? { error: "not_found" }, enriched ? 200 : 404);
      return;
    }

    if (req.method === "DELETE") {
      const existing = await this.findMemory(params.id);
      if (existing && !(await this.canAccessGroup(session, existing.groupId))) {
        this.sendJson(res, { error: "forbidden" }, 403);
        return;
      }
      const removed = await this.options.groupMemoryStore.remove(params.id);
      if (existing) {
        this.invalidateMemberProfileCache(existing.groupId);
      }
      this.sendJson(res, { ok: removed }, removed ? 200 : 404);
      return;
    }

    this.sendJson(res, { error: "method_not_allowed" }, 405);
  }

  private async handleBulkMemories(req: IncomingMessage, res: ServerResponse, session: AdminSession): Promise<void> {
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
      if (!(await this.canAccessGroup(session, existing.groupId))) {
        skipped.push({ id, error: "forbidden" });
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

  private async handleMemoryDeduplicatePreview(req: IncomingMessage, res: ServerResponse, session: AdminSession): Promise<void> {
    const body = await readJsonBody(req);
    const groupId = optionalString(body.groupId);
    if (!groupId || !(await this.canAccessGroup(session, groupId))) {
      this.sendJson(res, { error: groupId ? "forbidden" : "invalid_group_id" }, groupId ? 403 : 400);
      return;
    }
    const subjectUserId = optionalUserId(body.subjectUserId);
    if (!subjectUserId) {
      this.sendJson(res, { error: "subject_user_id_required" }, 400);
      return;
    }
    const service = new GroupMemoryDeduplicateService(this.options.groupMemoryStore, this.options.judgeMemorySemanticRelation);
    const dedupPreview = await service.previewGroup(groupId, {
      subjectUserId,
      ...(body.type === "member_profile" || body.type === "group_fact" ? { type: body.type } : {}),
      semanticMode: "member",
      useSemanticJudge: false,
    });
    this.sendJson(res, {
      groupId,
      subjectUserId,
      decisionCount: dedupPreview.decisions.length,
      decisions: dedupPreview.decisions,
      semanticStats: dedupPreview.semanticStats,
    });
  }

  private async handleMemoryDeduplicateApply(req: IncomingMessage, res: ServerResponse, session: AdminSession): Promise<void> {
    const body = await readJsonBody(req);
    const groupId = optionalString(body.groupId);
    if (!groupId || !(await this.canAccessGroup(session, groupId))) {
      this.sendJson(res, { error: groupId ? "forbidden" : "invalid_group_id" }, groupId ? 403 : 400);
      return;
    }
    const subjectUserId = optionalUserId(body.subjectUserId);
    if (!subjectUserId) {
      this.sendJson(res, { error: "subject_user_id_required" }, 400);
      return;
    }
    const incoming = Array.isArray(body.decisions) ? body.decisions : [];
    const service = new GroupMemoryDeduplicateService(this.options.groupMemoryStore, this.options.judgeMemorySemanticRelation);
    const decisions = incoming.length > 0
      ? incoming.map(normalizeMemoryDedupDecision).filter((item): item is MemoryDedupDecision => Boolean(item))
      : (await service.previewGroup(groupId, {
          subjectUserId: subjectUserId!,
          semanticMode: "member",
          useSemanticJudge: false,
        })).decisions;
    const wrapped = this.options.adminTaskStore
      ? await this.options.adminTaskStore.run({
          type: "memory-dedup",
          title: `记忆去重 ${subjectUserId}`,
          groupId,
          subjectUserId,
          operatorUserId: session.userId ?? session.username,
          detail: `${decisions.length} decisions`,
        }, () => service.apply(groupId, decisions))
      : { result: await service.apply(groupId, decisions), task: undefined };
    const result = wrapped.result;
    this.invalidateMemberProfileCache(groupId);
    await this.recordOperation({
      session,
      groupId,
      action: "memory_dedup_apply",
      target: subjectUserId,
      detail: `applied=${result.appliedCount}; skipped=${result.skippedCount}`,
    });
    this.sendJson(res, {
      ...result,
      ...(wrapped.task ? { task: wrapped.task } : {}),
    });
  }

  private async handleCandidates(req: IncomingMessage, res: ServerResponse, url: URL, session: AdminSession): Promise<void> {
    if (req.method !== "GET") {
      this.sendJson(res, { error: "method_not_allowed" }, 405);
      return;
    }

    const status = normalizeStatus(url.searchParams.get("status") ?? undefined);
    const groupId = await this.normalizeAccessibleGroupId(session, url.searchParams.get("groupId") ?? undefined);
    if (groupId === false) {
      this.sendJson(res, { error: "forbidden" }, 403);
      return;
    }
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
    const [pendingPage, approvedPage, rejectedPage] = await Promise.all([
      this.options.groupMemoryCandidateService.listPage({ groupId, status: "pending", subjectUserId, type, query, page: 1, pageSize: 1 }),
      this.options.groupMemoryCandidateService.listPage({ groupId, status: "approved", subjectUserId, type, query, page: 1, pageSize: 1 }),
      this.options.groupMemoryCandidateService.listPage({ groupId, status: "rejected", subjectUserId, type, query, page: 1, pageSize: 1 }),
    ]);
    const candidates = await this.enrichCandidates(await this.filterGroupItems(session, page.items), groupId, evidenceMode);
    this.sendJson(res, {
      candidates,
      pagination: page.pagination,
      statusCounts: {
        pending: pendingPage.pagination.total,
        approved: approvedPage.pagination.total,
        rejected: rejectedPage.pagination.total,
      },
    });
  }

  private async handleBulkApproveCandidates(req: IncomingMessage, res: ServerResponse, session: AdminSession): Promise<void> {
    const body = await readJsonBody(req);
    const ids = normalizeIds(body.ids);
    if (ids.length === 0) {
      this.sendJson(res, {
        approved: [],
        alreadyApproved: [],
        skipped: [],
        errors: [],
        approvedCount: 0,
        alreadyApprovedCount: 0,
        skippedCount: 0,
        errorCount: 0,
      });
      return;
    }

    const requestedCandidates = await Promise.all(ids.map(async (id) => [id, await this.findCandidate(id)] as const));
    const candidatesById = new Map(requestedCandidates);
    const candidateGroupIds = Array.from(new Set(requestedCandidates
      .map(([, candidate]) => candidate?.groupId)
      .filter((groupId): groupId is string => Boolean(groupId))));
    const task = this.options.adminTaskStore
      ? await this.options.adminTaskStore.create({
          type: "bulk-review",
          title: `批量审核 ${ids.length} 条候选记忆`,
          ...(candidateGroupIds.length === 1 ? { groupId: candidateGroupIds[0] } : {}),
          operatorUserId: session.userId ?? session.username,
          detail: ids.join(",").slice(0, 500),
        })
      : undefined;
    if (task) {
      await this.options.adminTaskStore?.update(task.id, { status: "running", progress: 10, startedAt: new Date().toISOString() });
    }
    const approved: Array<NonNullable<Awaited<ReturnType<GroupMemoryCandidateService["approve"]>>>> = [];
    const alreadyApproved: Array<{ id: string; candidate: GroupMemoryCandidate }> = [];
    const skipped: Array<{ id: string; error: string }> = [];
    const errors: Array<{ id: string; error: string }> = [];
    const changedGroupIds = new Set<string>();

    for (const id of ids) {
      const candidate = candidatesById.get(id);
      if (!candidate) {
        skipped.push({ id, error: "not_found" });
        continue;
      }
      if (!(await this.canAccessGroup(session, candidate.groupId))) {
        skipped.push({ id, error: "forbidden" });
        continue;
      }
      if (candidate.status === "approved") {
        alreadyApproved.push({ id, candidate });
        continue;
      }
      if (candidate.status !== "pending") {
        skipped.push({ id, error: `status_${candidate.status}` });
        continue;
      }
      if (candidate.type === "member_profile" && !candidate.subjectUserId) {
        skipped.push({ id, error: "member_profile_requires_subject_user_id" });
        continue;
      }
      try {
        const result = await this.options.groupMemoryCandidateService.approveDirect(id);
        if (!result) {
          const latest = await this.findCandidate(id);
          if (latest?.status === "approved") {
            alreadyApproved.push({ id, candidate: latest });
          } else {
            skipped.push({ id, error: latest ? `status_${latest.status}` : "not_found" });
          }
          continue;
        }
        approved.push(result);
        changedGroupIds.add(result.candidate.groupId);
      } catch (error) {
        errors.push({ id, error: (error as Error).message || "approve_failed" });
      }
    }

    for (const groupId of changedGroupIds) {
      this.invalidateMemberProfileCache(groupId);
    }

    const result = {
      approved,
      alreadyApproved,
      skipped,
      errors,
      approvedCount: approved.length,
      alreadyApprovedCount: alreadyApproved.length,
      skippedCount: skipped.length,
      errorCount: errors.length,
    };
    const finishedTask = task
      ? await this.options.adminTaskStore?.update(task.id, {
          status: errors.length > 0 ? "failed" : "succeeded",
          progress: 100,
          result,
          finishedAt: new Date().toISOString(),
          error: errors.length > 0 ? `${errors.length} candidates failed` : undefined,
        })
      : undefined;
    for (const groupId of changedGroupIds) {
      await this.recordOperation({
        session,
        groupId,
        action: "candidate_bulk_approve",
        detail: `approved=${approved.length}; skipped=${skipped.length}; errors=${errors.length}`,
      });
    }
    this.sendJson(res, {
      ...result,
      ...(finishedTask ? { task: finishedTask } : {}),
    });
  }

  private async handleCandidateItem(req: IncomingMessage, res: ServerResponse, params: RouteParams, session: AdminSession): Promise<void> {
    if (req.method === "GET") {
      const candidate = await this.findCandidate(params.id);
      if (candidate && !(await this.canAccessGroup(session, candidate.groupId))) {
        this.sendJson(res, { error: "forbidden" }, 403);
        return;
      }
      const enriched = candidate ? (await this.enrichCandidates([candidate], candidate.groupId, "full"))[0] : undefined;
      this.sendJson(res, enriched ?? { error: "not_found" }, enriched ? 200 : 404);
      return;
    }

    if (req.method === "PUT") {
      const existing = await this.findCandidate(params.id);
      if (existing && !(await this.canAccessGroup(session, existing.groupId))) {
        this.sendJson(res, { error: "forbidden" }, 403);
        return;
      }
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
      if (existing && !(await this.canAccessGroup(session, existing.groupId))) {
        this.sendJson(res, { error: "forbidden" }, 403);
        return;
      }
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
    const includeNapcatMembers =
      force ||
      url.searchParams.get("includeNapcat") === "1" ||
      url.searchParams.get("includeNapcatMembers") === "1";
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

  private async handleMemberProfileSummary(
    res: ServerResponse,
    route: { groupId: string; userId: string },
    url: URL,
    session: AdminSession,
  ): Promise<void> {
    const type = url.searchParams.get("type") === "yesterday" ? "yesterday" : "overall";
    const refresh = url.searchParams.get("refresh") === "1";
    try {
      const generated = await this.generateProfileRecordResponse({
        groupId: route.groupId,
        userId: route.userId,
        type,
        refresh,
        createdBy: session.username,
      });
      this.sendJson(res, generated);
    } catch (error) {
      this.sendProfileRecordGenerationError(res, error);
    }
  }

  private async handleGroupConfig(req: IncomingMessage, res: ServerResponse, params: RouteParams): Promise<void> {
    if (req.method === "GET") {
      const group = await this.options.groupConfigService.getGroup(params.id);
      this.sendJson(res, group ?? { error: "not_found" }, group ? 200 : 404);
      return;
    }

    if (req.method === "PUT") {
      const body = await readJsonBody(req);
      try {
        const group = await this.options.groupConfigService.updateGroupConfig(params.id, body);
        this.invalidateMemberProfileCache(params.id);
        this.sendJson(res, group);
      } catch (error) {
        if (error instanceof GroupConfigValidationError) {
          this.sendJson(res, { error: error.code }, 400);
          return;
        }
        if ((error as Error).message.includes("is not configured")) {
          this.sendJson(res, { error: "not_found" }, 404);
          return;
        }
        throw error;
      }
      return;
    }

    this.sendJson(res, { error: "method_not_allowed" }, 405);
  }

  private async handleNotifications(res: ServerResponse, session: AdminSession): Promise<void> {
    const groups = await this.visibleGroups(session);
    const groupIds = new Set(groups.map((group) => group.groupId));
    const allPending = await this.options.groupMemoryCandidateService.list({ status: "pending" });
    const candidates = allPending
      .filter((candidate) => groupIds.has(candidate.groupId))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.createdAt.localeCompare(left.createdAt));
    this.sendJson(res, {
      pendingCandidateCount: candidates.length,
      latestCandidates: await this.enrichCandidates(candidates.slice(0, 10), undefined, "preview"),
    });
  }

  private async handleSkillOptions(res: ServerResponse): Promise<void> {
    if (!this.options.skillService) {
      this.sendJson(res, { skills: [] });
      return;
    }
    const skills = await this.options.skillService.getAllSkills();
    this.sendJson(res, {
      skills: skills.map((skill) => ({ id: skill.id, name: skill.name })),
    });
  }

  private async handleSystemSettings(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.options.systemSettingsStore) {
      this.sendJson(res, { error: "system_settings_unavailable" }, 503);
      return;
    }
    if (req.method === "GET") {
      this.sendJson(res, await this.options.systemSettingsStore.get());
      return;
    }
    if (req.method === "PUT") {
      const body = await readJsonBody(req);
      try {
        this.sendJson(res, await this.options.systemSettingsStore.update(body as Partial<SystemSettings>));
      } catch (error) {
        if ((error as Error).message === "invalid_time") {
          this.sendJson(res, { error: "invalid_time" }, 400);
          return;
        }
        throw error;
      }
      return;
    }
    this.sendJson(res, { error: "method_not_allowed" }, 405);
  }

  private async handleAdminSecretReset(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    if (!this.options.systemSettingsStore) {
      this.sendJson(res, { error: "system_settings_unavailable" }, 503);
      return;
    }
    if (req.method !== "POST") {
      this.sendJson(res, { error: "method_not_allowed" }, 405);
      return;
    }
    const body = await readJsonBody(req);
    const secret = requiredString(body.secret).trim();
    try {
      const settings = pathname.endsWith("/group-admin-secret")
        ? await this.options.systemSettingsStore.resetGroupAdminSecret(secret)
        : await this.options.systemSettingsStore.resetAdminSecret(secret);
      this.sendJson(res, settings);
    } catch (error) {
      if ((error as Error).message === "secret_too_short") {
        this.sendJson(res, { error: "secret_too_short" }, 400);
        return;
      }
      throw error;
    }
  }

  private async handleModelConnectionTest(res: ServerResponse, modelId: string, session: AdminSession): Promise<void> {
    if (!this.options.systemSettingsStore) {
      this.sendJson(res, { error: "system_settings_unavailable" }, 503);
      return;
    }
    const settings = await this.options.systemSettingsStore.getInternal();
    const model = settings.models.find((item) => item.id === modelId);
    if (!model) {
      this.sendJson(res, { error: "not_found" }, 404);
      return;
    }
    const runCheck = async () => {
      const status = await this.buildModelHealthStatus(model, settings);
      await this.recordModelHealth(status, "manual");
      return status;
    };
    try {
      const wrapped = this.options.adminTaskStore
        ? await this.options.adminTaskStore.run({
            type: "model-check",
            title: `模型检测 ${model.name}`,
            operatorUserId: session.userId ?? session.username,
            detail: model.id,
          }, runCheck)
        : { result: await runCheck(), task: undefined };
      await this.recordOperation({
        session,
        groupId: "system",
        action: "model_check",
        target: model.id,
        detail: wrapped.result.ok ? `ok ${wrapped.result.latencyMs}ms` : wrapped.result.detail,
      });
      this.sendJson(res, {
        ...wrapped.result,
        ...(wrapped.task ? { task: wrapped.task } : {}),
      });
    } catch (error) {
      const status = this.buildModelHealthFailureStatus(model, settings, redactSensitiveText((error as Error).message));
      await this.recordModelHealth(status, "manual");
      this.sendJson(res, status);
    }
  }

  private async handleAllModelConnectionTest(res: ServerResponse, session: AdminSession): Promise<void> {
    if (!this.options.systemSettingsStore) {
      this.sendJson(res, { error: "system_settings_unavailable" }, 503);
      return;
    }
    const runCheck = async () => {
      const statuses = await this.getModelHealthStatuses({ refresh: true, source: "manual" });
      return {
        statuses,
        summary: {
          total: statuses.length,
          abnormal: statuses.filter(isAbnormalModelStatus).length,
          checkedAt: new Date().toISOString(),
        },
      };
    };
    const wrapped = this.options.adminTaskStore
      ? await this.options.adminTaskStore.run({
          type: "model-check",
          title: "全部模型检测",
          operatorUserId: session.userId ?? session.username,
          detail: "all",
        }, runCheck)
      : { result: await runCheck(), task: undefined };
    await this.recordOperation({
      session,
      groupId: "system",
      action: "model_check_all",
      target: "all",
      detail: `${wrapped.result.summary.total - wrapped.result.summary.abnormal}/${wrapped.result.summary.total} ok`,
    });
    this.sendJson(res, {
      ...wrapped.result,
      ...(wrapped.task ? { task: wrapped.task } : {}),
    });
  }

  private async handleModelOptions(res: ServerResponse, session: AdminSession): Promise<void> {
    if (!this.options.systemSettingsStore) {
      this.sendJson(res, {
        replyModels: [
          { id: "gpt", label: "GPT", purpose: "reply", enabled: true, hasApiKey: true },
        ],
      });
      return;
    }

    const settings = await this.options.systemSettingsStore.get();
    const models = settings.models.map((model) => ({
      id: model.id,
      label: formatModelOptionLabel(model.id, model.shortName || model.name),
      name: model.name,
      shortName: model.shortName,
      purpose: model.purpose,
      enabled: model.enabled,
      hasApiKey: model.hasApiKey,
      baseUrl: model.baseUrl,
      model: model.model,
    }));
    this.sendJson(res, {
      ...(session.role === "super_admin" ? { models } : {}),
      replyModels: models.filter((model) => (
        model.enabled &&
        model.hasApiKey &&
        model.purpose === "reply"
      )),
    });
  }

  private async handleGroupSync(res: ServerResponse): Promise<void> {
    if (!this.options.listGroups) {
      this.sendJson(res, { syncedCount: 0, groups: await this.options.groupConfigService.getAll(), detail: "list_groups_unavailable" });
      return;
    }
    const napcatGroups = await this.options.listGroups();
    const groups = await this.options.groupConfigService.upsertGroupsFromNapcat(napcatGroups.map((group) => ({
      groupId: String(group.group_id),
      ...(group.group_name ? { groupName: group.group_name } : {}),
    })));
    this.invalidateMemberProfileCache();
    this.sendJson(res, { syncedCount: napcatGroups.length, groups });
  }

  private async handleGroupReminders(req: IncomingMessage, res: ServerResponse, groupId: string, session: AdminSession): Promise<void> {
    if (!this.options.scheduledReminderService) {
      this.sendJson(res, { error: "scheduled_reminders_unavailable" }, 503);
      return;
    }
    if (req.method === "GET") {
      this.sendJson(res, { reminders: await this.options.scheduledReminderService.listGroupTasks(groupId, { includeDisabled: true }) });
      return;
    }
    if (req.method === "POST") {
      const body = await readJsonBody(req);
      const executionStartTime = normalizeReminderTime(body.executionStartTime ?? body.scheduledTime) ?? "09:00";
      const executionEndTime = normalizeReminderTime(body.executionEndTime ?? body.scheduledTime) ?? executionStartTime;
      const executionIntervalMinutes = normalizeReminderInterval(body.executionIntervalMinutes ?? body.intervalMinutes ?? body.advanceMinutes ?? 60);
      const scheduledTime = normalizeReminderTime(body.scheduledTime);
      const advanceMinutes = normalizeReminderAdvanceMinutes(body.advanceMinutes);
      const topic = requiredString(body.topic).slice(0, 80);
      const reminder = await this.options.scheduledReminderService.createTask({
        groupId,
        creatorUserId: session.userId ?? session.username,
        request: {
          intervalMinutes: executionIntervalMinutes,
          topic,
          executionStartTime,
          executionEndTime,
          executionIntervalMinutes,
          scheduledTime,
          advanceMinutes,
          dateRule: normalizeReminderDateRule(body.dateRule),
          weekdays: normalizeReminderWeekdays(body.weekdays),
        },
        enabled: optionalBoolean(body.enabled) ?? true,
      });
      this.sendJson(res, reminder, 201);
      return;
    }
    this.sendJson(res, { error: "method_not_allowed" }, 405);
  }

  private async handleGroupReminderItem(req: IncomingMessage, res: ServerResponse, groupId: string, taskId: string): Promise<void> {
    if (!this.options.scheduledReminderService) {
      this.sendJson(res, { error: "scheduled_reminders_unavailable" }, 503);
      return;
    }
    if (req.method === "PUT") {
      const body = await readJsonBody(req);
      const existing = (await this.options.scheduledReminderService.listGroupTasks(groupId, { includeDisabled: true })).find((task) => task.id === taskId);
      if (!existing) {
        this.sendJson(res, { error: "not_found" }, 404);
        return;
      }
      const reminder = await this.options.scheduledReminderService.updateTask(taskId, {
        ...(body.intervalMinutes !== undefined ? { intervalMinutes: normalizeReminderInterval(body.intervalMinutes) } : {}),
        ...(body.executionIntervalMinutes !== undefined ? { intervalMinutes: normalizeReminderInterval(body.executionIntervalMinutes), executionIntervalMinutes: normalizeReminderInterval(body.executionIntervalMinutes) } : {}),
        ...(body.topic !== undefined ? { topic: requiredString(body.topic).slice(0, 80) } : {}),
        ...(body.executionStartTime !== undefined ? { executionStartTime: normalizeReminderTime(body.executionStartTime) } : {}),
        ...(body.executionEndTime !== undefined ? { executionEndTime: normalizeReminderTime(body.executionEndTime) } : {}),
        ...(body.scheduledTime !== undefined ? { scheduledTime: normalizeReminderTime(body.scheduledTime) } : {}),
        ...(body.advanceMinutes !== undefined ? { advanceMinutes: normalizeReminderAdvanceMinutes(body.advanceMinutes) } : {}),
        ...(body.enabled !== undefined ? { enabled: optionalBoolean(body.enabled) ?? true } : {}),
        ...(body.dateRule !== undefined ? { dateRule: normalizeReminderDateRule(body.dateRule) } : {}),
        ...(body.weekdays !== undefined ? { weekdays: normalizeReminderWeekdays(body.weekdays) } : {}),
      });
      this.sendJson(res, reminder ?? { error: "not_found" }, reminder ? 200 : 404);
      return;
    }
    if (req.method === "DELETE") {
      const removed = await this.options.scheduledReminderService.removeGroupTask(groupId, taskId);
      this.sendJson(res, { ok: removed }, removed ? 200 : 404);
      return;
    }
    this.sendJson(res, { error: "method_not_allowed" }, 405);
  }

  private async handleSchedulePreview(res: ServerResponse, groupId: string, url: URL): Promise<void> {
    const groupConfig = await this.options.groupConfigService.getGroup(groupId);
    if (!groupConfig) {
      this.sendJson(res, { error: "not_found" }, 404);
      return;
    }
    const days = Math.max(1, Math.min(14, Number(url.searchParams.get("days") ?? 7) || 7));
    const reminders = this.options.scheduledReminderService
      ? await this.options.scheduledReminderService.listGroupTasks(groupId, { includeDisabled: true })
      : [];
    const previews = buildSchedulePreview(groupConfig, reminders, days);
    this.sendJson(res, { groupId, days, previews });
  }

  private async handleProfileRecords(req: IncomingMessage, res: ServerResponse, url: URL, session: AdminSession): Promise<void> {
    if (!this.options.profileRecordStore) {
      this.sendJson(res, { error: "profile_records_unavailable" }, 503);
      return;
    }
    if (req.method === "GET") {
      const groupId = await this.normalizeAccessibleGroupId(session, url.searchParams.get("groupId") ?? undefined);
      if (groupId === false) {
        this.sendJson(res, { error: "forbidden" }, 403);
        return;
      }
      const page = await this.options.profileRecordStore.listPage({
        groupId,
        userId: url.searchParams.get("userId") ?? undefined,
        type: normalizeProfileRecordType(url.searchParams.get("type") ?? undefined),
        query: normalizeSearchQuery(url.searchParams.get("q") ?? undefined),
        ...paginationParams(url, 20, 100),
      });
      this.sendJson(res, { records: this.withProfileShareUrls(await this.filterGroupItems(session, page.items)), pagination: page.pagination });
      return;
    }
    if (req.method === "POST") {
      const body = await readJsonBody(req);
      const groupId = optionalString(body.groupId);
      const userId = optionalUserId(body.userId);
      const type = body.type === "yesterday" ? "yesterday" : "overall";
      if (!groupId || !userId) {
        this.sendJson(res, { error: groupId ? "invalid_user_id" : "invalid_group_id" }, 400);
        return;
      }
      if (!(await this.canAccessGroup(session, groupId))) {
        this.sendJson(res, { error: "forbidden" }, 403);
        return;
      }
      try {
        const wrapped = this.options.adminTaskStore
          ? await this.options.adminTaskStore.run({
              type: "profile-generate",
              title: `画像生成 ${userId}`,
              groupId,
              subjectUserId: userId,
              operatorUserId: session.userId ?? session.username,
              detail: type,
            }, () => this.generateProfileRecordResponse({
              groupId,
              userId,
              type,
              refresh: true,
              createdBy: session.username,
            }))
          : { result: await this.generateProfileRecordResponse({
              groupId,
              userId,
              type,
              refresh: true,
              createdBy: session.username,
            }), task: undefined };
        await this.recordOperation({
          session,
          groupId,
          action: "profile_generate",
          target: userId,
          detail: type,
        });
        this.sendJson(res, {
          ...wrapped.result,
          ...(wrapped.task ? { task: wrapped.task } : {}),
        }, 201);
      } catch (error) {
        this.sendProfileRecordGenerationError(res, error);
      }
      return;
    }
    this.sendJson(res, { error: "method_not_allowed" }, 405);
  }

  private async handleProfileRecordItem(req: IncomingMessage, res: ServerResponse, id: string, session: AdminSession): Promise<void> {
    if (!this.options.profileRecordStore) {
      this.sendJson(res, { error: "profile_records_unavailable" }, 503);
      return;
    }
    const record = await this.options.profileRecordStore.get(id);
    if (!record) {
      this.sendJson(res, { error: "not_found" }, 404);
      return;
    }
    if (!(await this.canAccessGroup(session, record.groupId))) {
      this.sendJson(res, { error: "forbidden" }, 403);
      return;
    }
    if (req.method === "GET") {
      this.sendJson(res, this.withProfileShareUrl(record));
      return;
    }
    if (req.method === "PUT") {
      if (!/^\d+$/.test(record.userId)) {
        this.sendJson(res, { error: "invalid_user_id" }, 400);
        return;
      }
      try {
        const wrapped = this.options.adminTaskStore
          ? await this.options.adminTaskStore.run({
              type: "profile-generate",
              title: `画像刷新 ${record.userId}`,
              groupId: record.groupId,
              subjectUserId: record.userId,
              operatorUserId: session.userId ?? session.username,
              detail: record.type,
            }, () => this.generateProfileRecordResponse({
              groupId: record.groupId,
              userId: record.userId,
              type: record.type,
              refresh: true,
              createdBy: session.username,
              replaceRecordId: record.id,
            }))
          : { result: await this.generateProfileRecordResponse({
              groupId: record.groupId,
              userId: record.userId,
              type: record.type,
              refresh: true,
              createdBy: session.username,
              replaceRecordId: record.id,
            }), task: undefined };
        await this.recordOperation({
          session,
          groupId: record.groupId,
          action: "profile_refresh",
          target: record.userId,
          detail: record.type,
        });
        this.sendJson(res, {
          ...wrapped.result,
          ...(wrapped.task ? { task: wrapped.task } : {}),
        });
      } catch (error) {
        this.sendProfileRecordGenerationError(res, error);
      }
      return;
    }
    if (req.method === "DELETE") {
      this.sendJson(res, { ok: await this.options.profileRecordStore.remove(id) });
      return;
    }
    this.sendJson(res, { error: "method_not_allowed" }, 405);
  }

  private async handleProfileRecordShare(req: IncomingMessage, res: ServerResponse, id: string, session: AdminSession): Promise<void> {
    if (!this.options.profileRecordStore) {
      this.sendJson(res, { error: "profile_records_unavailable" }, 503);
      return;
    }
    const record = await this.options.profileRecordStore.get(id);
    if (!record) {
      this.sendJson(res, { error: "not_found" }, 404);
      return;
    }
    if (!(await this.canAccessGroup(session, record.groupId))) {
      this.sendJson(res, { error: "forbidden" }, 403);
      return;
    }
    if (req.method !== "PUT") {
      this.sendJson(res, { error: "method_not_allowed" }, 405);
      return;
    }
    const body = await readJsonBody(req);
    const publicEnabled = optionalBoolean(body.publicEnabled);
    const expiresAt = body.expiresAt === null ? null : normalizeOptionalIso(body.expiresAt);
    const revokedAt = publicEnabled === false ? new Date().toISOString() : body.revokedAt === null ? null : normalizeOptionalIso(body.revokedAt);
    const updated = await this.options.profileRecordStore.updateShareState(id, {
      ...(publicEnabled !== undefined ? { publicEnabled } : {}),
      ...(body.expiresAt !== undefined ? { expiresAt } : {}),
      ...(publicEnabled === false || body.revokedAt !== undefined ? { revokedAt } : {}),
    });
    await this.recordOperation({
      session,
      groupId: record.groupId,
      action: publicEnabled === false ? "profile_share_revoke" : "profile_share_update",
      target: id,
      detail: publicEnabled === false ? "revoked public profile link" : "updated public profile link",
    });
    this.sendJson(res, updated ? this.withProfileShareUrl(updated) : { error: "not_found" }, updated ? 200 : 404);
  }

  private async generateProfileRecordResponse(args: {
    groupId: string;
    userId: string;
    type: ProfileRecordType;
    refresh: boolean;
    createdBy: string;
    replaceRecordId?: string;
  }): Promise<GeneratedProfileRecordResponse> {
    if (!/^\d+$/.test(args.userId)) {
      throw new ProfileRecordGenerationError("invalid_user_id", 400);
    }
    if (!this.options.dailyProfileReviewService) {
      throw new ProfileRecordGenerationError("profile_review_unavailable", 503);
    }
    const groupConfig = await this.options.groupConfigService.getGroup(args.groupId);
    if (!groupConfig) {
      throw new ProfileRecordGenerationError("not_found", 404);
    }
    const profiles = await this.getCachedMemberProfileData(args.groupId);
    const members = profiles?.members ?? [];
    if (!args.refresh && this.options.profileRecordStore) {
      const latest = await this.options.profileRecordStore.getLatest({
        groupId: args.groupId,
        userId: args.userId,
        type: args.type,
      });
      if (latest) {
        return {
          groupId: args.groupId,
          userId: args.userId,
          type: args.type,
          subjectLabel: buildSubjectLabel(groupConfig, args.userId, members, "member_profile"),
          summary: latest.summary,
          generatedAt: latest.generatedAt,
          memoryCount: latest.sourceMemoryCount,
          sourceMemoryCount: latest.sourceMemoryCount,
          cached: true,
          record: latest,
        };
      }
    }
    const result = args.type === "yesterday"
      ? await this.options.dailyProfileReviewService.getYesterdaySummaryDetail({
          groupConfig,
          userId: args.userId,
          dateKey: getYesterdayDateKey(new Date()),
          members,
        })
      : await this.options.dailyProfileReviewService.summarizeOverallProfileDetail({
          groupConfig,
          userId: args.userId,
          members,
        });
    if (!result) {
      throw new ProfileRecordGenerationError("profile_summary_empty", 404);
    }
    const recordInput = {
      groupId: args.groupId,
      userId: args.userId,
      type: args.type,
      summary: result.summary,
      sourceMemoryCount: result.memoryCount,
      generatedAt: result.generatedAt,
      createdBy: args.createdBy,
    };
    const record = this.options.profileRecordStore
      ? args.replaceRecordId
        ? await this.options.profileRecordStore.update(args.replaceRecordId, recordInput)
        : await this.options.profileRecordStore.create(recordInput)
      : undefined;
    return {
      groupId: args.groupId,
      userId: args.userId,
      type: args.type,
      subjectLabel: buildSubjectLabel(groupConfig, args.userId, members, "member_profile"),
      summary: result.summary,
      generatedAt: result.generatedAt,
      memoryCount: result.memoryCount,
      sourceMemoryCount: result.memoryCount,
      cached: result.cached ?? false,
      ...(record ? { record } : {}),
    };
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

  private async handleSkills(req: IncomingMessage, res: ServerResponse, pathname: string, url: URL): Promise<void> {
    if (!this.options.skillService) {
      this.sendJson(res, { error: "skills_unavailable" }, 503);
      return;
    }

    try {
      if (pathname === "/api/skills" && req.method === "GET") {
        this.sendJson(res, { skills: await this.options.skillService.getAllSkills() });
        return;
      }
      if (pathname === "/api/skills" && req.method === "POST") {
        const skill = await this.options.skillService.createSkill(await readJsonBody(req) as unknown as SkillDefinition);
        this.sendJson(res, skill, 201);
        return;
      }
      if (pathname === "/api/skills/import" && req.method === "POST") {
        const body = await readJsonBody(req);
        const raw = typeof body.raw === "string" ? body.raw : JSON.stringify(body.skill ?? body);
        this.sendJson(res, await this.options.skillService.importSkill(raw), 201);
        return;
      }
      if (pathname === "/api/skills/export" && req.method === "GET") {
        const skillId = url.searchParams.get("id") ?? "";
        const raw = skillId ? await this.options.skillService.exportSkill(skillId) : undefined;
        this.sendJson(res, raw ? { id: skillId, raw } : { error: "not_found" }, raw ? 200 : 404);
        return;
      }
      if (pathname === "/api/skills/backup" && req.method === "POST") {
        this.sendJson(res, await this.options.skillService.backupSkills());
        return;
      }
      if (pathname === "/api/skills/backups" && req.method === "GET") {
        this.sendJson(res, { backups: await this.options.skillService.listBackups() });
        return;
      }
      const restoreRoute = matchRoute(pathname, /^\/api\/skills\/backups\/([^/]+)\/restore$/);
      if (restoreRoute && req.method === "POST") {
        this.sendJson(res, await this.options.skillService.restoreBackup(restoreRoute.id));
        return;
      }

      const route = matchRoute(pathname, /^\/api\/skills\/([^/]+)$/);
      if (route && req.method === "GET") {
        const skill = await this.options.skillService.getSkill(route.id);
        this.sendJson(res, skill ?? { error: "not_found" }, skill ? 200 : 404);
        return;
      }
      if (route && req.method === "PUT") {
        const skill = await this.options.skillService.updateSkill(route.id, await readJsonBody(req) as Partial<SkillDefinition>);
        this.sendJson(res, skill ?? { error: "not_found" }, skill ? 200 : 404);
        return;
      }
      if (route && req.method === "DELETE") {
        const ok = await this.options.skillService.removeSkill(route.id);
        this.sendJson(res, { ok }, ok ? 200 : 404);
        return;
      }
    } catch (error) {
      this.sendSkillServiceError(res, error);
      return;
    }

    this.sendJson(res, { error: "method_not_allowed" }, 405);
  }

  private async handleCommands(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.options.systemSettingsStore) {
      this.sendJson(res, { error: "system_settings_unavailable" }, 503);
      return;
    }
    const settings = await this.options.systemSettingsStore.get();
    if (req.method === "GET") {
      this.sendJson(res, { commands: settings.commands });
      return;
    }
    if (req.method === "PUT") {
      const body = await readJsonBody(req);
      const commands = normalizeCommandConfigList(body.commands ?? body, settings.commands);
      const next = await this.options.systemSettingsStore.update({ commands });
      this.sendJson(res, { commands: next.commands });
      return;
    }
    this.sendJson(res, { error: "method_not_allowed" }, 405);
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

  private async getProfileAiHealthStatus(options: { refresh?: boolean } = {}): Promise<AiHealthStatus> {
    if (!this.options.getProfileAiHealthStatus) {
      return {
        ok: true,
        detail: "未配置模型检测",
        model: "unknown",
        baseUrl: "",
        checkedAt: new Date().toISOString(),
        latencyMs: 0,
        cached: false,
      };
    }

    return this.options.getProfileAiHealthStatus(options);
  }

  private async getModelHealthStatuses(options: { refresh?: boolean; source?: ModelHealthHistoryEntry["source"] } = {}): Promise<ModelHealthStatus[]> {
    if (!this.options.systemSettingsStore) {
      return [];
    }
    const settings = await this.options.systemSettingsStore.getInternal();
    const source = options.source ?? (options.refresh ? "health" : "overview");
    const statuses = await Promise.all(settings.models.map(async (model) => {
      const cached = this.modelHealthCache.get(model.id);
      if (!options.refresh && cached && cached.expiresAt > Date.now()) {
        return cached.status;
      }
      const status = await this.buildModelHealthStatus(model, settings);
      this.modelHealthCache.set(model.id, { expiresAt: Date.now() + 60 * 60 * 1000, status });
      await this.recordModelHealth(status, source);
      return status;
    }));
    return statuses;
  }

  private async buildModelHealthStatus(model: SystemSettings["models"][number], settings: SystemSettings): Promise<ModelHealthStatus> {
    if (!model.enabled) {
      return this.buildModelHealthSkippedStatus(model, settings);
    }
    if (!model.hasApiKey || !model.apiKey?.trim()) {
      return this.buildModelHealthFailureStatus(model, settings, "模型未配置 API Key。");
    }
    const startedAt = Date.now();
    try {
      const health = await probeSystemModel(model);
      return {
        ...this.buildModelHealthBase(model, settings),
        ok: health.ok,
        detail: redactSensitiveText(health.detail),
        model: health.model || model.model,
        baseUrl: health.baseUrl || model.baseUrl,
        checkedAt: health.checkedAt || new Date().toISOString(),
        latencyMs: health.latencyMs || Date.now() - startedAt,
        cached: false,
        probeType: health.probeType,
        ...(health.upstreamStatusCode ? { upstreamStatusCode: health.upstreamStatusCode } : {}),
        ...(health.failureKind ? { failureKind: health.failureKind } : {}),
      };
    } catch (error) {
      return this.buildModelHealthFailureStatus(model, settings, redactSensitiveText((error as Error).message), Date.now() - startedAt);
    }
  }

  private buildModelHealthFailureStatus(
    model: SystemSettings["models"][number],
    settings: SystemSettings,
    detail: string,
    latencyMs = 0,
  ): ModelHealthStatus {
    return {
      ...this.buildModelHealthBase(model, settings),
      ok: false,
      detail,
      model: model.model,
      baseUrl: model.baseUrl,
      checkedAt: new Date().toISOString(),
      latencyMs,
      cached: false,
      failureKind: detail.includes("API Key") ? "auth" : "unknown",
    };
  }

  private buildModelHealthSkippedStatus(
    model: SystemSettings["models"][number],
    settings: SystemSettings,
  ): ModelHealthStatus {
    return {
      ...this.buildModelHealthBase(model, settings),
      ok: true,
      detail: "模型已停用，已跳过检测。",
      model: model.model,
      baseUrl: model.baseUrl,
      checkedAt: new Date().toISOString(),
      latencyMs: 0,
      cached: false,
      skipped: true,
    };
  }

  private buildModelHealthBase(model: SystemSettings["models"][number], settings: SystemSettings): Pick<ModelHealthStatus, "id" | "purpose" | "name" | "shortName" | "selected"> {
    return {
      id: model.id,
      purpose: model.purpose,
      name: model.name,
      shortName: model.shortName,
      selected: settings.selectedModelIds?.[model.purpose] === model.id,
    };
  }

  private async recordModelHealth(
    status: ModelHealthStatus,
    source: ModelHealthHistoryEntry["source"],
  ): Promise<void> {
    if (!this.options.modelHealthHistoryStore) return;
    const sanitizedStatus = sanitizeHealthStatus(status);
    await this.options.modelHealthHistoryStore.record({
      ...sanitizedStatus,
      purpose: normalizeModelPurpose(sanitizedStatus.purpose),
      source,
    });
  }

  private async findCandidate(id: string): Promise<GroupMemoryCandidate | undefined> {
    return this.options.groupMemoryCandidateService.get(id);
  }

  private async findMemory(id: string): Promise<GroupMemory | undefined> {
    return this.options.groupMemoryStore.get(id);
  }

  private async handleKnowledge(req: IncomingMessage, res: ServerResponse, url: URL, session: AdminSession): Promise<void> {
    if (req.method === "GET") {
      const groupId = await this.normalizeAccessibleGroupId(session, url.searchParams.get("groupId") ?? undefined);
      if (groupId === false) {
        this.sendJson(res, { error: "forbidden" }, 403);
        return;
      }
      const query = normalizeSearchQuery(url.searchParams.get("q") ?? undefined);
      const pagination = paginationParams(url, 20, 100);
      const page = await this.options.knowledgeBaseStore.listPage({
        groupId,
        query,
        ...pagination,
      });
      this.sendJson(res, { entries: await this.filterGroupItems(session, page.items), pagination: page.pagination });
      return;
    }

    if (req.method === "POST") {
      const body = await readJsonBody(req);
      const input = normalizeKnowledgeInput(body);
      if (!(await this.canAccessGroup(session, input.groupId))) {
        this.sendJson(res, { error: "forbidden" }, 403);
        return;
      }
      const entry = await this.options.knowledgeBaseStore.create(input);
      this.sendJson(res, entry, 201);
      return;
    }

    this.sendJson(res, { error: "method_not_allowed" }, 405);
  }

  private async handleKnowledgeItem(req: IncomingMessage, res: ServerResponse, params: RouteParams, session: AdminSession): Promise<void> {
    if (req.method === "PUT") {
      const existing = await this.options.knowledgeBaseStore.get(params.id);
      if (!existing) {
        this.sendJson(res, { error: "not_found" }, 404);
        return;
      }
      if (!(await this.canAccessGroup(session, existing.groupId))) {
        this.sendJson(res, { error: "forbidden" }, 403);
        return;
      }
      const body = await readJsonBody(req);
      const patch = normalizeKnowledgePatch(body);
      if (patch.groupId && !(await this.canAccessGroup(session, patch.groupId))) {
        this.sendJson(res, { error: "forbidden" }, 403);
        return;
      }
      const entry = await this.options.knowledgeBaseStore.update(params.id, patch);
      this.sendJson(res, entry ?? { error: "not_found" }, entry ? 200 : 404);
      return;
    }

    if (req.method === "DELETE") {
      const existing = await this.options.knowledgeBaseStore.get(params.id);
      if (existing && !(await this.canAccessGroup(session, existing.groupId))) {
        this.sendJson(res, { error: "forbidden" }, 403);
        return;
      }
      const removed = await this.options.knowledgeBaseStore.remove(params.id);
      this.sendJson(res, { ok: removed }, removed ? 200 : 404);
      return;
    }

    this.sendJson(res, { error: "method_not_allowed" }, 405);
  }

  private async handleKnowledgeImportPreview(req: IncomingMessage, res: ServerResponse, session: AdminSession): Promise<void> {
    const body = await readJsonBody(req);
    const groupId = optionalString(body.groupId);
    if (!groupId || !(await this.canAccessGroup(session, groupId))) {
      this.sendJson(res, { error: groupId ? "forbidden" : "invalid_group_id" }, groupId ? 403 : 400);
      return;
    }
    const text = requiredString(body.text);
    const candidates = buildKnowledgeImportCandidates(text);
    this.sendJson(res, { groupId, candidates, candidateCount: candidates.length });
  }

  private async handleKnowledgeImportApply(req: IncomingMessage, res: ServerResponse, session: AdminSession): Promise<void> {
    const body = await readJsonBody(req);
    const groupId = optionalString(body.groupId);
    if (!groupId || !(await this.canAccessGroup(session, groupId))) {
      this.sendJson(res, { error: groupId ? "forbidden" : "invalid_group_id" }, groupId ? 403 : 400);
      return;
    }
    const candidates = Array.isArray(body.candidates)
      ? body.candidates.map(normalizeKnowledgeCandidate).filter((item): item is KnowledgeCandidate => Boolean(item))
      : buildKnowledgeImportCandidates(requiredString(body.text));
    const created = [];
    const skipped: KnowledgeImportSkippedItem[] = [];
    for (const candidate of candidates.slice(0, 50)) {
      const duplicate = await this.options.knowledgeBaseStore.findDuplicate({
        groupId,
        title: candidate.title,
        question: candidate.question,
      });
      if (duplicate) {
        skipped.push({
          question: candidate.question,
          title: candidate.title,
          reason: duplicate.field === "question" ? "duplicate_question" : "duplicate_title",
          existingId: duplicate.entry.id,
        });
        continue;
      }
      created.push(await this.options.knowledgeBaseStore.create({
        groupId,
        title: candidate.title,
        question: candidate.question,
        answer: candidate.answer,
        keywords: candidate.keywords,
        enabled: true,
      }));
    }
    this.sendJson(res, { entries: created, createdCount: created.length, skipped, skippedCount: skipped.length }, 201);
  }

  private isAuthenticated(req: IncomingMessage): boolean {
    return Boolean(this.getSession(req));
  }

  private getSession(req: IncomingMessage): AdminSession | undefined {
    const cookie = parseCookies(req.headers.cookie ?? "").admin_session;
    if (!cookie) {
      return undefined;
    }

    const session = this.verifySession(cookie);
    return session && new Date(session.expiresAt).getTime() > Date.now() ? session : undefined;
  }

  private async buildLoginSession(username: string, password: string): Promise<Omit<AdminSession, "csrfToken" | "expiresAt"> | undefined> {
    const superAdminSecretValid = this.options.systemSettingsStore
      ? await this.options.systemSettingsStore.verifyAdminSecret(password, this.options.password)
      : password === this.options.password;
    if (username === this.options.username && superAdminSecretValid) {
      return {
        role: "super_admin",
        username,
        allowedGroupIds: [],
      };
    }
    const groupPassword = this.options.groupPassword;
    const groupAdminSecretValid = this.options.systemSettingsStore
      ? await this.options.systemSettingsStore.verifyGroupAdminSecret(password, groupPassword)
      : Boolean(groupPassword) && password === groupPassword;
    if (!groupAdminSecretValid || !/^\d+$/.test(username)) {
      return undefined;
    }
    const groups = await this.options.groupConfigService.getAll();
    const allowedGroupIds = groups
      .filter((group) => group.enabled !== false && group.switcherUserIds.includes(username))
      .map((group) => group.groupId);
    if (allowedGroupIds.length === 0) {
      return undefined;
    }
    return {
      role: "group_admin",
      username,
      userId: username,
      allowedGroupIds,
    };
  }

  private publicSession(session: AdminSession): Omit<AdminSession, "expiresAt"> & { publicBaseUrl: string } {
    return {
      role: session.role,
      username: session.username,
      ...(session.userId ? { userId: session.userId } : {}),
      allowedGroupIds: session.allowedGroupIds,
      csrfToken: session.csrfToken,
      publicBaseUrl: this.options.publicBaseUrl,
    };
  }

  private async handleGlobalSearch(res: ServerResponse, url: URL, session: AdminSession): Promise<void> {
    const query = normalizeSearchQuery(url.searchParams.get("q") ?? undefined);
    if (!query) {
      this.sendJson(res, { results: [] });
      return;
    }
    const groups = await this.visibleGroups(session);
    const groupIds = new Set(groups.map((group) => group.groupId));
    const requestedGroupId = url.searchParams.get("groupId") ?? undefined;
    const searchGroups = requestedGroupId && groupIds.has(requestedGroupId)
      ? groups.filter((group) => group.groupId === requestedGroupId)
      : groups;
    const [memories, candidates, knowledge, profileRecordsPage] = await Promise.all([
      this.options.groupMemoryStore.list(),
      this.options.groupMemoryCandidateService.list({}),
      this.options.knowledgeBaseStore.list(),
      this.options.profileRecordStore
        ? this.options.profileRecordStore.listPage({ query, page: 1, pageSize: 20 })
        : Promise.resolve({ items: [], pagination: { page: 1, pageSize: 20, total: 0, totalPages: 1 } }),
    ]);
    const resultItems: Array<{ type: string; title: string; subtitle: string; path: string; groupId: string }> = [];
    for (const group of groups) {
      if (`${group.groupName || ""} ${group.groupId}`.toLowerCase().includes(query.toLowerCase())) {
        resultItems.push({ type: "group", title: group.groupName || `群 ${group.groupId}`, subtitle: group.groupId, path: "/groups", groupId: group.groupId });
      }
    }
    for (const group of searchGroups) {
      const profiles = await this.getCachedMemberProfileData(group.groupId, { includeNapcatMembers: true });
      for (const member of (profiles?.members ?? []).slice(0, 500)) {
        if (memberMatchesQuery(member, query)) {
          resultItems.push({
            type: "member",
            title: member.displayName || member.userId,
            subtitle: `${group.groupName || group.groupId} · ${member.userId}${member.note ? ` · ${member.note}` : ""}`,
            path: `/members?q=${encodeURIComponent(query)}`,
            groupId: group.groupId,
          });
        }
      }
    }
    for (const memory of memories.filter((item) => groupIds.has(item.groupId)).slice(0, 500)) {
      if (`${memory.title} ${memory.content} ${memory.source} ${memory.subjectUserId || ""}`.toLowerCase().includes(query.toLowerCase())) {
        resultItems.push({ type: "memory", title: memory.title, subtitle: memory.content.slice(0, 90), path: `/memories?q=${encodeURIComponent(query)}`, groupId: memory.groupId });
      }
    }
    for (const candidate of candidates.filter((item) => groupIds.has(item.groupId)).slice(0, 500)) {
      if (`${candidate.title} ${candidate.content} ${candidate.source} ${candidate.subjectUserId || ""}`.toLowerCase().includes(query.toLowerCase())) {
        resultItems.push({ type: "candidate", title: candidate.title, subtitle: candidate.content.slice(0, 90), path: `/candidates?q=${encodeURIComponent(query)}`, groupId: candidate.groupId });
      }
    }
    for (const entry of knowledge.filter((item) => groupIds.has(item.groupId)).slice(0, 500)) {
      if (`${entry.title} ${entry.question} ${entry.answer} ${entry.keywords.join(" ")}`.toLowerCase().includes(query.toLowerCase())) {
        resultItems.push({ type: "knowledge", title: entry.title, subtitle: entry.question, path: `/knowledge?q=${encodeURIComponent(query)}`, groupId: entry.groupId });
      }
    }
    for (const record of profileRecordsPage.items.filter((item) => groupIds.has(item.groupId))) {
      resultItems.push({
        type: "profile",
        title: record.type === "yesterday" ? "昨日画像" : "群聊画像",
        subtitle: `${record.userId} · ${record.summary.slice(0, 90)}`,
        path: `/profiles?q=${encodeURIComponent(query)}`,
        groupId: record.groupId,
      });
    }
    this.sendJson(res, { results: resultItems.slice(0, 30) });
  }

  private withProfileShareUrls<T extends { shareToken?: string }>(records: T[]): Array<T & { shareUrl?: string }> {
    return records.map((record) => this.withProfileShareUrl(record));
  }

  private withProfileShareUrl<T extends { shareToken?: string }>(record: T): T & { shareUrl?: string } {
    return {
      ...record,
      ...(record.shareToken ? { shareUrl: buildProfileShareUrl(this.options.publicBaseUrl, record.shareToken) } : {}),
    };
  }

  private async visibleGroups(session: AdminSession, options: { includeDisabled?: boolean } = {}): Promise<GroupBotConfig[]> {
    const groups = await this.options.groupConfigService.getAll();
    if (session.role === "super_admin") {
      return options.includeDisabled ? groups : groups.filter((group) => group.enabled !== false);
    }
    const allowed = new Set(session.allowedGroupIds);
    return groups.filter((group) => (
      group.enabled !== false &&
      allowed.has(group.groupId) &&
      session.userId !== undefined &&
      group.switcherUserIds.includes(session.userId)
    ));
  }

  private async canAccessGroup(session: AdminSession, groupId: string): Promise<boolean> {
    if (session.role === "super_admin") {
      return true;
    }
    const group = await this.options.groupConfigService.getGroup(groupId);
    return Boolean(group && group.enabled !== false && session.userId && group.switcherUserIds.includes(session.userId));
  }

  private requireSuperAdmin(session: AdminSession, res: ServerResponse): boolean {
    if (session.role === "super_admin") {
      return true;
    }
    this.sendJson(res, { error: "forbidden" }, 403);
    return false;
  }

  private async recordOperation(args: {
    session: AdminSession;
    groupId: string;
    action: string;
    target?: string;
    detail?: string;
  }): Promise<void> {
    await this.options.adminOperationLogService.record({
      groupId: args.groupId,
      operatorUserId: args.session.userId ?? args.session.username,
      action: args.action,
      ...(args.target ? { target: args.target } : {}),
      ...(args.detail ? { detail: args.detail } : {}),
    });
  }

  private isValidCsrf(req: IncomingMessage, session: AdminSession): boolean {
    const token = req.headers["x-csrf-token"];
    const value = Array.isArray(token) ? token[0] : token;
    return typeof value === "string" && safeEqual(value, session.csrfToken);
  }

  private loginAttemptKey(req: IncomingMessage, username: string): string {
    const forwarded = req.headers["x-forwarded-for"];
    const forwardedText = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const ip = (forwardedText?.split(",")[0] || req.socket.remoteAddress || "unknown").trim();
    return `${ip}:${username.trim().toLowerCase() || "unknown"}`;
  }

  private isLoginLocked(key: string): boolean {
    const attempt = this.loginAttempts.get(key);
    if (!attempt?.lockedUntil) {
      return false;
    }
    if (attempt.lockedUntil > Date.now()) {
      return true;
    }
    this.loginAttempts.delete(key);
    return false;
  }

  private recordFailedLogin(key: string): void {
    const now = Date.now();
    const current = this.loginAttempts.get(key);
    const inWindow = current && now - current.firstFailureAt <= ADMIN_LOGIN_WINDOW_MS;
    const next = {
      failures: inWindow ? current.failures + 1 : 1,
      firstFailureAt: inWindow ? current.firstFailureAt : now,
      ...(current?.lockedUntil && current.lockedUntil > now ? { lockedUntil: current.lockedUntil } : {}),
    };
    if (next.failures >= ADMIN_LOGIN_MAX_FAILURES) {
      next.lockedUntil = now + ADMIN_LOGIN_LOCK_MS;
    }
    this.loginAttempts.set(key, next);
  }

  private clearLoginAttempts(key: string): void {
    this.loginAttempts.delete(key);
  }

  private async normalizeAccessibleGroupId(session: AdminSession, groupId: string | undefined): Promise<string | undefined | false> {
    if (groupId) {
      return await this.canAccessGroup(session, groupId) ? groupId : false;
    }
    if (session.role === "super_admin") {
      return undefined;
    }
    const groups = await this.visibleGroups(session);
    return groups[0]?.groupId ?? false;
  }

  private async filterGroupItems<T extends { groupId: string }>(session: AdminSession, items: T[]): Promise<T[]> {
    if (session.role === "super_admin") {
      return items;
    }
    const allowed = new Set((await this.visibleGroups(session)).map((group) => group.groupId));
    return items.filter((item) => allowed.has(item.groupId));
  }

  private signSession(payload: AdminSession): string {
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = createHmac("sha256", this.options.sessionSecret).update(body).digest("base64url");
    return `${body}.${signature}`;
  }

  private verifySession(value: string): AdminSession | undefined {
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
        role?: string;
        userId?: string;
        allowedGroupIds?: unknown;
        csrfToken?: string;
        expiresAt?: string;
      };
      const role = parsed.role === "group_admin" ? "group_admin" : "super_admin";
      return typeof parsed.username === "string" && typeof parsed.csrfToken === "string" && typeof parsed.expiresAt === "string"
        ? {
            role,
            username: parsed.username,
            ...(typeof parsed.userId === "string" ? { userId: parsed.userId } : {}),
            allowedGroupIds: Array.isArray(parsed.allowedGroupIds) ? parsed.allowedGroupIds.map(String) : [],
            csrfToken: parsed.csrfToken,
            expiresAt: parsed.expiresAt,
          }
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

  private sendProfileRecordGenerationError(res: ServerResponse, error: unknown): void {
    if (error instanceof ProfileRecordGenerationError) {
      this.sendJson(res, { error: error.code }, error.statusCode);
      return;
    }
    throw error;
  }

  private sendSkillServiceError(res: ServerResponse, error: unknown): void {
    if (error instanceof SyntaxError) {
      this.sendJson(res, { error: "invalid_skill_json" }, 400);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (message === "invalid_skill_id" || message === "invalid_skill" || message === "skill_exists") {
      this.sendJson(res, { error: message }, 400);
      return;
    }
    throw error;
  }

  private sendHtml(res: ServerResponse, html: string): void {
    this.sendText(res, html, "text/html; charset=utf-8");
  }

  private sendStaticText(res: ServerResponse, content: string, contentType: string): void {
    this.sendText(res, content, contentType, { cacheControl: "private, max-age=300" });
  }

  private sendBuffer(
    res: ServerResponse,
    content: Buffer,
    contentType: string,
    options: { statusCode?: number; cacheControl?: string } = {},
  ): void {
    res.statusCode = options.statusCode ?? 200;
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", content.byteLength);
    if (options.cacheControl) res.setHeader("Cache-Control", options.cacheControl);
    res.end(content);
  }

  private sendRedirect(res: ServerResponse, location: string): void {
    res.writeHead(302, { Location: location });
    res.end();
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

function resolveAdminStaticFile(pathname: string): string | undefined {
  if (pathname === "" || pathname === "/" || pathname === "/login") {
    return undefined;
  }
  const decoded = decodeURIComponent(pathname);
  const resolved = path.resolve(ADMIN_STATIC_DIR, `.${decoded}`);
  if (resolved === ADMIN_STATIC_DIR || !resolved.startsWith(`${ADMIN_STATIC_DIR}${path.sep}`)) {
    return undefined;
  }
  return resolved;
}

function contentTypeFor(filePath: string): string {
  return STATIC_CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

function publicProfileHtml(summary: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex,nofollow">
  <title>画像</title>
  <style>
    body { margin: 0; background: #f6fbfa; color: #102027; font-family: "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif; line-height: 1.8; }
    main { max-width: 820px; margin: 0 auto; padding: 32px 18px; }
    pre { margin: 0; white-space: pre-wrap; word-break: break-word; font: inherit; }
  </style>
</head>
<body>
  <main><pre>${escapeHtml(summary)}</pre></main>
</body>
</html>`;
}

function publicProfileNotFoundHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex,nofollow">
  <title>画像不存在</title>
</head>
<body>画像不存在或已失效</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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

function memberProfileInflightKey(groupId: string, includeNapcatMembers: boolean): string {
  return `${groupId}:${includeNapcatMembers ? "full" : "light"}`;
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
      throw new AdminRequestBodyError("request_body_too_large", 413);
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return {};
  }

  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new AdminRequestBodyError("invalid_json_body", 400);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof AdminRequestBodyError) throw error;
    throw new AdminRequestBodyError("invalid_json", 400);
  }
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

function normalizeProfileRecordType(value: string | undefined): ProfileRecordType | undefined {
  return value === "overall" || value === "yesterday" ? value : undefined;
}

function normalizeReminderInterval(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("invalid_interval_minutes");
  }
  return Math.max(1, Math.min(24 * 60, parsed));
}

function normalizeReminderTime(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error("invalid_time");
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) throw new Error("invalid_time");
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error("invalid_time");
  }
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function normalizeReminderAdvanceMinutes(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error("invalid_advance_minutes");
  }
  return Math.min(parsed, 24 * 60);
}

function normalizeReminderDateRule(value: unknown): "all" | "workday" | "holiday" | "custom" {
  return value === "workday" || value === "holiday" || value === "custom" ? value : "all";
}

function normalizeReminderWeekdays(value: unknown): number[] {
  const raw = Array.isArray(value) ? value : [];
  return Array.from(new Set(raw
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item >= 0 && item <= 6)))
    .sort((left, right) => left - right);
}

function normalizeTaskType(value: string | undefined): AdminTaskType | undefined {
  return value === "memory-dedup" || value === "profile-generate" || value === "model-check" || value === "bulk-review"
    ? value
    : undefined;
}

function normalizeTaskStatus(value: string | undefined): AdminTaskStatus | undefined {
  return value === "queued" || value === "running" || value === "succeeded" || value === "failed" || value === "cancelled"
    ? value
    : undefined;
}

function normalizeModelPurpose(value: string): SystemModelPurpose {
  return value === "reply" ||
    value === "profile" ||
    value === "memory" ||
    value === "dedup" ||
    value === "summary" ||
    value === "knowledge" ||
    value === "tts" ||
    value === "custom"
    ? value
    : "custom";
}

function normalizeLogLimit(value: string | undefined): number {
  const parsed = value ? Number(value) : 50;
  return Number.isInteger(parsed) ? Math.max(1, Math.min(200, parsed)) : 50;
}

function isStateChangingMethod(method: string | undefined): boolean {
  const normalized = (method ?? "GET").toUpperCase();
  return normalized !== "GET" && normalized !== "HEAD" && normalized !== "OPTIONS";
}

function normalizeOptionalIso(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string") return undefined;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

function isProfileSharePublic(record: ProfileRecord): boolean {
  if (record.publicEnabled === false || record.revokedAt) {
    return false;
  }
  if (record.expiresAt && new Date(record.expiresAt).getTime() <= Date.now()) {
    return false;
  }
  return Boolean(record.shareToken);
}

function buildSchedulePreview(groupConfig: GroupBotConfig, reminders: Array<{
  id: string;
  topic: string;
  enabled: boolean;
  executionStartTime?: string;
  executionEndTime?: string;
  executionIntervalMinutes?: number;
  scheduledTime?: string;
  intervalMinutes: number;
  dateRule?: ScheduleDateRule;
  weekdays?: number[];
}>, days: number): Array<{
  date: string;
  items: Array<{ type: "daily_report" | "holiday_countdown" | "scheduled_reminder"; title: string; time: string; enabled: boolean; taskId?: string }>;
}> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const previews = [];
  for (let offset = 0; offset < days; offset += 1) {
    const day = new Date(today);
    day.setDate(today.getDate() + offset);
    const items: Array<{ type: "daily_report" | "holiday_countdown" | "scheduled_reminder"; title: string; time: string; enabled: boolean; taskId?: string }> = [];
    if (groupConfig.dailyReportTime && isScheduleDateRuleMatched(groupConfig.dailyReportDateRule, groupConfig.dailyReportWeekdays, day)) {
      items.push({
        type: "daily_report",
        title: "日报",
        time: groupConfig.dailyReportTime,
        enabled: groupConfig.dailyReportEnabled === true,
      });
    }
    if (groupConfig.holidayCountdownTime && isScheduleDateRuleMatched(groupConfig.holidayCountdownDateRule, groupConfig.holidayCountdownWeekdays, day)) {
      items.push({
        type: "holiday_countdown",
        title: "节日倒计时",
        time: groupConfig.holidayCountdownTime,
        enabled: groupConfig.holidayCountdownEnabled === true,
      });
    }
    for (const reminder of reminders) {
      if (!isScheduleDateRuleMatched(reminder.dateRule, reminder.weekdays, day)) {
        continue;
      }
      for (const time of buildReminderPreviewTimes(reminder)) {
        items.push({
          type: "scheduled_reminder",
          title: reminder.topic,
          time,
          enabled: reminder.enabled,
          taskId: reminder.id,
        });
      }
    }
    previews.push({
      date: formatLocalDateKey(day),
      items: items.sort((left, right) => left.time.localeCompare(right.time)),
    });
  }
  return previews;
}

function formatLocalDateKey(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function buildReminderPreviewTimes(reminder: {
  executionStartTime?: string;
  executionEndTime?: string;
  executionIntervalMinutes?: number;
  scheduledTime?: string;
  intervalMinutes: number;
}): string[] {
  if (!reminder.executionStartTime) {
    return reminder.scheduledTime ? [reminder.scheduledTime] : [];
  }
  const start = timeToMinutes(reminder.executionStartTime);
  const end = Math.max(start, timeToMinutes(reminder.executionEndTime ?? reminder.executionStartTime));
  const interval = Math.max(1, Math.min(24 * 60, reminder.executionIntervalMinutes ?? reminder.intervalMinutes));
  const times: string[] = [];
  for (let value = start; value <= end && times.length < 24; value += interval) {
    times.push(minutesToTime(value));
  }
  return times;
}

function timeToMinutes(value: string): number {
  const [hour = "0", minute = "0"] = value.split(":");
  const parsedHour = Number(hour);
  const parsedMinute = Number(minute);
  if (!Number.isInteger(parsedHour) || !Number.isInteger(parsedMinute)) {
    return 0;
  }
  return Math.max(0, Math.min(24 * 60 - 1, parsedHour * 60 + parsedMinute));
}

function minutesToTime(value: number): string {
  const normalized = Math.max(0, Math.min(24 * 60 - 1, Math.floor(value)));
  return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
}

function normalizeCommandConfigList(value: unknown, current: SystemCommandConfig[]): SystemCommandConfig[] {
  const currentById = new Map(current.map((command) => [command.id, command]));
  const raw = Array.isArray(value) ? value : [];
  return raw
    .map((item) => {
      const record = item as Partial<SystemCommandConfig>;
      const id = String(record.id ?? "").trim();
      const existing = currentById.get(id);
      if (!existing) {
        return undefined;
      }
      return {
        ...existing,
        title: typeof record.title === "string" && record.title.trim() ? record.title.trim().slice(0, 80) : existing.title,
        primary: typeof record.primary === "string" && record.primary.trim() ? record.primary.trim().slice(0, 40) : existing.primary,
        aliases: normalizeNames(record.aliases).slice(0, 12),
        enabled: record.enabled !== false,
        help: typeof record.help === "string" ? record.help.trim().slice(0, 400) : existing.help,
        updatedAt: new Date().toISOString(),
      };
    })
    .filter((item): item is SystemCommandConfig => Boolean(item));
}

function buildKnowledgeImportCandidates(text: string): KnowledgeCandidate[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\[[^\]]+\]\s*/, "").replace(/^\d{4}-\d{2}-\d{2}[^:：]*[:：]\s*/, "").trim())
    .filter((line) => line.length >= 6)
    .slice(0, 300);
  const candidates: KnowledgeCandidate[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const explicit = line.match(/(?:Q|A|问题|问|提问|question)[:：]\s*(.+?)(?:\s+(?:A|答|回答|answer)[:：]\s*(.+))?$/i);
    const answerLine = lines[index + 1] ?? "";
    const answerMatch = answerLine.match(/^(?:A|答|回答|answer)[:：]\s*(.+)$/i);
    if (explicit?.[1]) {
      const question = explicit[1].trim();
      const answer = (explicit[2] ?? answerMatch?.[1] ?? "").trim();
      if (question && answer) {
        candidates.push(normalizeKnowledgeCandidate({ title: question, question, answer, keywords: extractKnowledgeKeywords(question) })!);
        if (answerMatch) index += 1;
      }
      continue;
    }
    if (/[?？]$/.test(line) && answerLine && !/[?？]$/.test(answerLine)) {
      candidates.push(normalizeKnowledgeCandidate({
        title: line,
        question: line,
        answer: answerLine,
        keywords: extractKnowledgeKeywords(line),
      })!);
      index += 1;
    }
  }
  const byQuestion = new Map<string, KnowledgeCandidate>();
  for (const candidate of candidates) {
    if (!byQuestion.has(candidate.question)) byQuestion.set(candidate.question, candidate);
  }
  return [...byQuestion.values()].slice(0, 50);
}

function normalizeKnowledgeCandidate(value: unknown): KnowledgeCandidate | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Partial<KnowledgeCandidate>;
  const question = optionalString(record.question)?.slice(0, 300);
  const answer = optionalString(record.answer)?.slice(0, 1200);
  if (!question || !answer) return undefined;
  return {
    title: (optionalString(record.title) ?? question).slice(0, 100),
    question,
    answer,
    keywords: normalizeKeywords(record.keywords).slice(0, 30),
  };
}

function extractKnowledgeKeywords(question: string): string[] {
  const cjk = Array.from(question.matchAll(/[\u4e00-\u9fa5]{2,6}/g)).map((match) => match[0]);
  const ascii = question.match(/[a-z0-9]{2,}/gi) ?? [];
  return Array.from(new Set([...cjk, ...ascii])).slice(0, 8);
}

function normalizeKeywords(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(/[,，、\s]+/).map((item) => item.trim()).filter(Boolean);
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
      ? value.split(/[,，、\s]+/)
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

function matchGroupItemRoute(pathname: string, regex: RegExp): { groupId: string; id: string } | undefined {
  const match = pathname.match(regex);
  if (!match?.[1] || !match[2]) {
    return undefined;
  }
  return { groupId: decodeURIComponent(match[1]), id: decodeURIComponent(match[2]) };
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

function formatModelOptionLabel(id: string, name: string): string {
  if (id === "gpt") return `GPT (${name})`;
  if (id === "mimo") return `Mimo (${name})`;
  return `${name} (${id})`;
}

function sanitizeHealthStatus<T extends HealthStatusResponse>(status: T): T {
  return {
    ...status,
    detail: redactSensitiveText(status.detail),
  };
}

function publicHealthStatus(status: HealthStatusResponse): HealthStatusResponse {
  return {
    ok: status.ok,
    detail: redactSensitiveText(status.detail),
    checkedAt: status.checkedAt,
    latencyMs: status.latencyMs,
    cached: status.cached,
  };
}

function restrictedHealthStatus(): HealthStatusResponse {
  return {
    ok: true,
    detail: "restricted",
    checkedAt: new Date().toISOString(),
    latencyMs: 0,
    cached: true,
  };
}

function isAbnormalModelStatus(status: ModelHealthStatus): boolean {
  return !status.ok && status.skipped !== true;
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/((?:api[-_ ]?key|access[-_ ]?token|secret|password|token)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/(sk-[A-Za-z0-9_-]{8,})/g, "[REDACTED]")
    .slice(0, 500);
}

function buildProfileShareUrl(publicBaseUrl: string, shareToken: string): string {
  return `${publicBaseUrl.replace(/\/+$/, "")}/profile/${encodeURIComponent(shareToken)}`;
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
