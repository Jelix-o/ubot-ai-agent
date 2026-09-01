import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { URL } from "node:url";

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
import type { SharedDb } from "./shared/sqlite.js";
import {
  AdminAuthError,
  AdminAuthService,
  type AdminAuthSession,
  type AdminAuthServiceOptions,
} from "./services/admin-auth-service.js";
import {
  GroupMemoryDeduplicateService,
  type MemoryDedupProgressEvent,
  normalizeMemoryDedupDecision,
  type MemoryDedupDecision,
} from "./services/group-memory-deduplicate-service.js";
import type { GroupMemoryStore } from "./services/group-memory-store.js";
import type { KnowledgeBaseStore } from "./services/knowledge-base-store.js";
import type { MemorySemanticJudgeInput, MemorySemanticJudgeResult } from "./services/ai-service.js";
import type { ScheduledReminderService } from "./services/scheduled-reminder-service.js";
import type { CharacterProfileService } from "./services/character-profile-service.js";
import type { SystemSettingsStore } from "./services/system-settings-store.js";
import type { ModelHealthHistoryStore, ModelHealthHistoryEntry } from "./services/model-health-history-store.js";
import { getServerStatusSnapshot, probeSystemModel } from "./services/model-probe-service.js";
import { buildGroupMemberProfiles, buildSubjectLabel } from "./services/member-profile-service.js";
import { isScheduleDateRuleMatched } from "./utils/schedule-date-rule.js";
import type { AdminSession, AdminTaskStatus, AdminTaskType, AiHealthStatus, CharacterProfile, GroupBotConfig, GroupMemberProfile, GroupMemory, GroupMemoryEvidence, GroupMemoryEvidencePreview, GroupMemoryType, NapcatGroupInfo, NapcatGroupMember, ScheduleDateRule, SystemCommandConfig, SystemModelPurpose, SystemSettings } from "./types.js";

interface AdminHttpServerOptions {
  host: string;
  port: number;
  publicBaseUrl: string;
  /** Legacy bootstrap credentials are read once into SQLite when no account exists. */
  username?: string;
  password?: string;
  stateEncryptionKey?: string;
  authService?: AdminAuthService;
  groupConfigService: GroupConfigService;
  groupMemoryStore: GroupMemoryStore;
  knowledgeBaseStore: KnowledgeBaseStore;
  scheduledReminderService?: ScheduledReminderService;
  characterProfileService?: CharacterProfileService;
  systemSettingsStore?: SystemSettingsStore;
  adminTaskStore?: AdminTaskStore;
  modelHealthHistoryStore?: ModelHealthHistoryStore;
  /**
   * Optional so an admin process stays runnable during rolling upgrades.
   * Preview routes fail closed until the durable publisher is wired in.
   */
  htmlPreviewService?: HtmlPreviewAdminService;
  adminOperationLogService: AdminOperationLogService;
  getTransportHealthStatus?: () => Promise<TransportHealthStatus>;
  judgeMemorySemanticRelation?: (args: MemorySemanticJudgeInput) => Promise<MemorySemanticJudgeResult | null>;
  listGroupMembers?: (groupId: string) => Promise<NapcatGroupMember[]>;
  listGroups?: () => Promise<NapcatGroupInfo[]>;
  sharedDb?: SharedDb;
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

type RuntimeSystemModelConfig = SystemSettings["models"][number] & {
  purpose: SystemModelPurpose;
};

class AdminRequestBodyError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number,
  ) {
    super(code);
  }
}

/**
 * Admin-facing structural contract. It contains metadata only: generated HTML
 * stays on the isolated preview origin and never enters admin JSON responses.
 */
interface HtmlPreviewAdminMetadata {
  id: string;
  groupId: string;
  creatorUserId?: string;
  title: string;
  previewUrl: string;
  status: string;
  createdAt: string;
  expiresAt: string;
  deletedAt?: string;
  byteSize?: number;
}

interface HtmlPreviewAdminService {
  listPage(args: {
    groupId?: string;
    visibleGroupIds?: string[];
    page?: number;
    pageSize?: number;
    status?: "pending" | "published" | "failed" | "expired" | "deleted";
  }): Promise<{
    items: HtmlPreviewAdminMetadata[];
    pagination: { page: number; pageSize: number; total: number; totalPages: number };
  }>;
  get(id: string): Promise<HtmlPreviewAdminMetadata | undefined>;
  remove(id: string): Promise<boolean>;
}

class MemberDirectoryUnavailableError extends Error {
  constructor() {
    super("napcat_members_unavailable");
  }
}

const ADMIN_EVIDENCE_SUMMARY_LIMIT = 2400;
const ADMIN_GZIP_MIN_BYTES = 1024;
const ADMIN_STATIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "admin");
const ADMIN_STATIC_INDEX = path.join(ADMIN_STATIC_DIR, "index.html");
const ADMIN_HTML_CACHE_CONTROL = "private, no-store";
const ADMIN_API_CACHE_CONTROL = "private, no-store";
const ADMIN_SPECULATION_RULES_PATH = "/admin-speculation-rules.json";
const ADMIN_SPECULATION_RULES = JSON.stringify({ prefetch: [] });
const ADMIN_SESSION_COOKIE = "__Host-ubot_admin_session";
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
  private readonly auth: AdminAuthService;

  private readonly server = createServer((req, res) => {
    void this.handleRequest(req, res);
  });

  constructor(private readonly options: AdminHttpServerOptions) {
    if (options.authService) {
      this.auth = options.authService;
      return;
    }
    if (!options.sharedDb || !options.stateEncryptionKey) {
      throw new Error("AdminHttpServer requires SharedDb and UBOT_STATE_ENCRYPTION_KEY-backed stateEncryptionKey.");
    }
    const authOptions: AdminAuthServiceOptions = {
      stateEncryptionKey: options.stateEncryptionKey,
      ...(options.username && options.password ? { bootstrap: { username: options.username, password: options.password } } : {}),
    };
    this.auth = new AdminAuthService(options.sharedDb, authOptions);
  }

  start(): void {
    // Bootstrap is deliberately performed before the listener opens.  This
    // consumes legacy environment credentials exactly once when the account
    // table is empty, rather than deferring that security transition until the
    // first unauthenticated browser request.
    void this.auth.ensureInitialized()
      .then(() => {
        this.server.listen(this.options.port, this.options.host, () => {
          logInfo("Admin HTTP server listening.", {
            host: this.options.host,
            port: this.options.port,
            publicBaseUrl: this.options.publicBaseUrl,
          });
        });
      })
      .catch((error: unknown) => {
        logWarn("Admin HTTP server bootstrap failed; listener was not opened.", {
          error: error instanceof Error ? error.message : String(error),
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

      if (req.method === "GET" && pathname === ADMIN_SPECULATION_RULES_PATH) {
        this.sendText(res, ADMIN_SPECULATION_RULES, "application/speculationrules+json; charset=utf-8", {
          cacheControl: ADMIN_HTML_CACHE_CONTROL,
        });
        return;
      }

      const publicProfileRoute = matchRoute(pathname, /^\/profile\/([^/]+)$/);
      if (req.method === "GET" && publicProfileRoute) {
        this.sendText(res, "profile_viewer_retired", "text/plain; charset=utf-8", {
          statusCode: 410,
          cacheControl: "no-store",
        });
        return;
      }

      if (req.method === "POST" && pathname.startsWith("/api/auth/")) {
        if (!this.isTrustedRequestOrigin(req)) {
          this.sendJson(res, { error: "invalid_origin" }, 403);
          return;
        }
        if (await this.handlePublicAuth(req, res, pathname)) {
          return;
        }
      }

      if (req.method === "POST" && pathname === "/api/login") {
        this.sendJson(res, { error: "login_endpoint_retired" }, 410);
        return;
      }

      const session = this.getSession(req);
      if (pathname.startsWith("/api/") && !session) {
        this.sendJson(res, { error: "unauthorized" }, 401);
        return;
      }

      if (pathname.startsWith("/api/") && session && isStateChangingMethod(req.method) &&
        (!this.isTrustedRequestOrigin(req) || !this.isValidCsrf(req, session))) {
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

    if (req.method === "POST" && pathname === "/api/auth/logout") {
      const authSession = session as AdminAuthSession;
      this.auth.revokeSession(authSession.sessionId, "logout");
      this.clearSessionCookie(res);
      this.sendJson(res, { ok: true });
      return;
    }

    if (req.method === "GET" && pathname === "/api/session") {
      const csrfToken = this.auth.rotateCsrfToken(session as AdminAuthSession);
      this.sendJson(res, this.publicSession({ ...session, csrfToken }));
      return;
    }

    if (req.method === "POST" && pathname === "/api/auth/reauth") {
      const body = await readJsonBody(req);
      if (!this.auth.completeSessionReauth(session as AdminAuthSession, requiredString(body.code), this.authRequestMeta(req))) {
        this.sendJson(res, { error: "invalid_totp" }, 401);
        return;
      }
      this.sendJson(res, { ok: true });
      return;
    }

    if (req.method === "POST" && pathname === "/api/auth/recovery-codes") {
      const codes = await this.auth.regenerateRecoveryCodes(session as AdminAuthSession, this.authRequestMeta(req));
      if (!codes) {
        this.sendJson(res, { error: "recent_mfa_required" }, 403);
        return;
      }
      this.sendJson(res, { recoveryCodes: codes });
      return;
    }

    if (req.method === "POST" && pathname === "/api/auth/password/change") {
      const body = await readJsonBody(req);
      const result = await this.auth.changePassword({
        session: session as AdminAuthSession,
        currentPassword: requiredString(body.currentPassword),
        nextPassword: requiredString(body.nextPassword),
        meta: this.authRequestMeta(req),
      });
      if (result !== "ok") {
        this.sendJson(res, { error: result }, result === "recent_mfa_required" ? 403 : 401);
        return;
      }
      this.sendJson(res, { ok: true });
      return;
    }

    if (req.method === "POST" && pathname === "/api/auth/totp/reset") {
      const result = this.auth.beginTotpReset(session as AdminAuthSession, this.authRequestMeta(req));
      if (!result) {
        this.sendJson(res, { error: "recent_mfa_required" }, 403);
        return;
      }
      this.sendJson(res, { status: "totp_enrollment_required", ...result });
      return;
    }

    if (pathname === "/api/admin-accounts") {
      if (!this.requireSuperAdmin(session, res)) return;
      if (req.method !== "GET") {
        this.sendJson(res, { error: "method_not_allowed" }, 405);
        return;
      }
      this.sendJson(res, { accounts: this.auth.listAccounts() });
      return;
    }

    if (req.method === "GET" && pathname === "/api/admin-accounts/invites") {
      if (!this.requireSuperAdmin(session, res)) return;
      this.sendJson(res, { invites: this.auth.listInvites() });
      return;
    }

    if (req.method === "GET" && pathname === "/api/admin-auth-audit") {
      if (!this.requireSuperAdmin(session, res)) return;
      this.sendJson(res, { entries: this.auth.listAuthAudit(normalizeLogLimit(url.searchParams.get("limit") ?? undefined)) });
      return;
    }

    if (req.method === "POST" && pathname === "/api/admin-accounts/invites") {
      if (!this.requireRecentSuperAdminMfa(session, res)) return;
      const body = await readJsonBody(req);
      const role = body.role === "group_admin" ? "group_admin" : body.role === "super_admin" ? "super_admin" : undefined;
      if (!role) {
        this.sendJson(res, { error: "invalid_role" }, 400);
        return;
      }
      const groupIds = normalizeStringList(body.groupIds);
      const expiresHours = normalizeInviteExpiryHours(body.expiresHours);
      try {
        const result = this.auth.createInvite({
          role,
          groupIds,
          expiresAt: Date.now() + expiresHours * 60 * 60 * 1_000,
          actorAccountId: session.userId!,
        });
        this.sendJson(res, { ...result, inviteUrl: `${this.options.publicBaseUrl.replace(/\/$/, "")}/login?invite=${encodeURIComponent(result.token)}` }, 201);
      } catch (error) {
        this.sendAuthError(res, error);
      }
      return;
    }

    const revokeInviteRoute = matchRoute(pathname, /^\/api\/admin-accounts\/invites\/([^/]+)\/revoke$/);
    if (revokeInviteRoute && req.method === "POST") {
      if (!this.requireRecentSuperAdminMfa(session, res)) return;
      try {
        this.auth.revokeInvite(revokeInviteRoute.id, session.userId!);
        this.sendJson(res, { ok: true });
      } catch (error) {
        this.sendAuthError(res, error);
      }
      return;
    }

    const accountActionMatch = /^\/api\/admin-accounts\/([^/]+)\/(disable|enable|revoke-sessions|grants)$/.exec(pathname);
    if (accountActionMatch && req.method === "POST") {
      if (!this.requireRecentSuperAdminMfa(session, res)) return;
      try {
        const accountId = decodeURIComponent(accountActionMatch[1]!);
        const action = accountActionMatch[2]!;
        if (action === "disable") {
          this.auth.disableAccount(accountId, session.userId!);
        } else if (action === "enable") {
          this.auth.enableAccount(accountId, session.userId!);
        } else if (action === "revoke-sessions") {
          this.auth.revokeAllSessions(accountId, session.userId!);
        } else {
          const body = await readJsonBody(req);
          this.auth.setGroupGrants(accountId, normalizeStringList(body.groupIds), session.userId!);
        }
        this.sendJson(res, { ok: true, accounts: this.auth.listAccounts() });
      } catch (error) {
        this.sendAuthError(res, error);
      }
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
      const [groups, memoriesPage, knowledgePage, allMemories, allKnowledge] = await Promise.all([
        Promise.resolve(visibleGroups),
        this.options.groupMemoryStore.listPage({ groupId, page: 1, pageSize: 5 }),
        this.options.knowledgeBaseStore.listPage({ groupId, page: 1, pageSize: 5 }),
        groupId ? Promise.resolve([]) : this.options.groupMemoryStore.list(),
        groupId ? Promise.resolve([]) : this.options.knowledgeBaseStore.list(),
      ]);
      const visibleMemoryCount = groupId
        ? memoriesPage.pagination.total
        : allMemories.filter((item) => visibleGroupIds.has(item.groupId)).length;
      const visibleKnowledgeCount = groupId
        ? knowledgePage.pagination.total
        : allKnowledge.filter((item) => visibleGroupIds.has(item.groupId)).length;
      const canViewDiagnostics = session.role === "super_admin";
      const rawTransportHealth = canViewDiagnostics && this.options.getTransportHealthStatus
        ? await this.options.getTransportHealthStatus()
        : undefined;
      const transportHealth = rawTransportHealth
        ? sanitizeHealthStatus(rawTransportHealth)
        : undefined;
      const modelStatuses = canViewDiagnostics ? await this.getModelHealthStatuses() : [];
      const abnormalModelStatuses = modelStatuses.filter(isAbnormalModelStatus);
      this.sendJson(res, {
        groups,
        groupId,
        stats: {
          groupCount: groups.length,
          memoryCount: visibleMemoryCount,
          knowledgeCount: visibleKnowledgeCount,
        },
        recent: {
          memories: await this.enrichMemories(memoriesPage.items.filter((item) => visibleGroupIds.has(item.groupId)), groupId, "preview"),
          knowledge: knowledgePage.items.filter((item) => visibleGroupIds.has(item.groupId)),
        },
        ...(canViewDiagnostics ? {
          ...(transportHealth ? { transportHealth } : {}),
          modelStatuses,
          abnormalModelStatuses,
          modelStatusSummary: {
            total: modelStatuses.length,
            abnormal: abnormalModelStatuses.length,
            checkedAt: new Date().toISOString(),
          },
        } : {}),
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
      await this.handleGroupConfig(req, res, groupConfigRoute, session);
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

    const membersRefreshRoute = matchGroupMemberRoute(pathname, /^\/api\/groups\/([^/]+)\/members\/refresh$/);
    if (membersRefreshRoute) {
      if (!(await this.canAccessGroup(session, membersRefreshRoute.groupId))) {
        this.sendJson(res, { error: "forbidden" }, 403);
        return;
      }
      if (req.method !== "POST") {
        this.sendJson(res, { error: "method_not_allowed" }, 405);
        return;
      }
      await this.handleGroupMembersRefresh(res, membersRefreshRoute.groupId, url);
      return;
    }

    const identityRoute = matchGroupMemberRoute(pathname, /^\/api\/groups\/([^/]+)\/members\/([^/]+)\/identity$/);
    if (identityRoute?.userId) {
      if (!(await this.canAccessGroup(session, identityRoute.groupId))) {
        this.sendJson(res, { error: "forbidden" }, 403);
        return;
      }
      await this.handleMemberIdentity(req, res, { groupId: identityRoute.groupId, userId: identityRoute.userId }, session);
      return;
    }

    const profileSummaryRoute = matchGroupMemberRoute(pathname, /^\/api\/groups\/([^/]+)\/members\/([^/]+)\/profile-summary$/);
    if (profileSummaryRoute?.userId && req.method === "GET") {
      this.sendJson(res, { error: "profile_api_retired" }, 410);
      return;
    }

    if (pathname === "/api/system-settings") {
      if (req.method === "PUT" && !this.requireRecentSuperAdminMfa(session, res)) return;
      if (!this.requireSuperAdmin(session, res)) return;
      await this.handleSystemSettings(req, res);
      return;
    }

    if (pathname === "/api/system-settings/admin-secret" || pathname === "/api/system-settings/group-admin-secret") {
      this.sendJson(res, { error: "shared_admin_secret_retired" }, 410);
      return;
    }

    const privacyOptOutRoute = matchGroupMemberRoute(pathname, /^\/api\/groups\/([^/]+)\/members\/([^/]+)\/privacy-opt-out$/);
    if (privacyOptOutRoute?.userId) {
      if (!(await this.canAccessGroup(session, privacyOptOutRoute.groupId))) {
        this.sendJson(res, { error: "forbidden" }, 403);
        return;
      }
      await this.handleMemberPrivacyOptOut(req, res, {
        groupId: privacyOptOutRoute.groupId,
        userId: privacyOptOutRoute.userId,
      }, session);
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
      this.sendJson(res, { error: "profile_api_retired" }, 410);
      return;
    }

    if (pathname === "/api/profile-records") {
      this.sendJson(res, { error: "profile_api_retired" }, 410);
      return;
    }

    const profileRecordRoute = matchRoute(pathname, /^\/api\/profile-records\/([^/]+)$/);
    if (profileRecordRoute) {
      this.sendJson(res, { error: "profile_api_retired" }, 410);
      return;
    }

    if (pathname === "/api/persona/huixian") {
      if (req.method === "PUT" && !this.requireRecentSuperAdminMfa(session, res)) return;
      if (!this.requireSuperAdmin(session, res)) return;
      await this.handleHuixianPersona(req, res);
      return;
    }

    if (pathname.startsWith("/api/skills") || pathname === "/api/skill-options") {
      this.sendJson(res, { error: "not_found" }, 404);
      return;
    }

    if (pathname === "/api/commands") {
      if (req.method === "PUT" && !this.requireRecentSuperAdminMfa(session, res)) return;
      if (!this.requireSuperAdmin(session, res)) return;
      await this.handleCommands(req, res);
      return;
    }

    if (req.method === "GET" && pathname === "/api/health") {
      if (!this.requireSuperAdmin(session, res)) return;
      if (url.searchParams.has("refresh")) {
        this.sendJson(res, { error: "health_probe_requires_post" }, 405);
        return;
      }
      this.sendJson(res, await this.buildHealthResponse(session));
      return;
    }

    if (req.method === "POST" && pathname === "/api/health/probe") {
      if (!this.requireSuperAdmin(session, res)) return;
      const health = await this.buildHealthResponse(session, { refresh: true });
      await this.recordOperation({
        session,
        groupId: "system",
        action: "health_probe",
        target: "all",
        detail: "manual",
      });
      this.sendJson(res, health);
      return;
    }

    if (req.method === "GET" && pathname === "/api/participation-decisions") {
      if (!this.options.sharedDb) {
        this.sendJson(res, { error: "participation_decisions_unavailable" }, 503);
        return;
      }
      const groupId = url.searchParams.get("groupId") ?? undefined;
      if (groupId && !(await this.canAccessGroup(session, groupId))) {
        this.sendJson(res, { error: "forbidden" }, 403);
        return;
      }
      if (!groupId && session.role !== "super_admin") {
        this.sendJson(res, { error: "group_id_required" }, 400);
        return;
      }
      const decisions = this.options.sharedDb.listParticipationDecisions({
        ...(groupId ? { groupId } : {}),
        limit: Math.max(1, Math.min(200, Number(url.searchParams.get("limit") ?? 50) || 50)),
      }).map((decision) => ({
        id: decision.id,
        sourceRowId: decision.source_row_id,
        groupId: decision.group_id,
        userId: decision.user_id,
        action: decision.action,
        reason: decision.reason,
        score: decision.score,
        policyVersion: decision.policy_version,
        signals: safeJsonObject(decision.signals_json),
        createdAt: new Date(decision.created_at).toISOString(),
      }));
      this.sendJson(res, { decisions });
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

    const qqBindingMatch = /^\/api\/admin-accounts\/([^/]+)\/qq-binding$/.exec(pathname);
    if (qqBindingMatch && (req.method === "POST" || req.method === "DELETE")) {
      if (!this.requireRecentSuperAdminMfa(session, res)) return;
      try {
        const accountId = decodeURIComponent(qqBindingMatch[1]!);
        if (req.method === "POST") {
          const body = await readJsonBody(req);
          this.auth.setQqBinding(accountId, String(body.qqUserId ?? ""), session.userId!);
        } else {
          this.auth.removeQqBinding(accountId, session.userId!);
        }
        this.sendJson(res, { ok: true, accounts: this.auth.listAccounts() });
      } catch (error) {
        this.sendAuthError(res, error);
      }
      return;
    }

    if (pathname === "/api/html-previews") {
      await this.handleHtmlPreviews(req, res, url, session);
      return;
    }

    const htmlPreviewRoute = matchRoute(pathname, /^\/api\/html-previews\/([^/]+)$/);
    if (htmlPreviewRoute) {
      await this.handleHtmlPreviewItem(req, res, htmlPreviewRoute.id, session);
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

    if (pathname === "/api/memories/summarize" && req.method === "POST") {
      this.sendJson(res, { error: "memory_compaction_retired" }, 410);
      return;
    }

    const memoryRoute = matchRoute(pathname, /^\/api\/memories\/([^/]+)$/);
    if (memoryRoute) {
      await this.handleMemoryItem(req, res, memoryRoute, session);
      return;
    }

    if (pathname.startsWith("/api/memory-candidates")) {
      this.sendJson(res, { error: "memory_candidates_retired" }, 410);
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
    if (isAdminAssetPath(pathname)) {
      this.sendText(res, "asset_not_found", "text/plain; charset=utf-8", {
        statusCode: 404,
        cacheControl: "no-store",
      });
      return;
    }

    const authenticated = this.isAuthenticated(res.req as IncomingMessage);
    if (!authenticated) {
      if (pathname === "" || pathname === "/login") {
        await this.sendAdminStaticFile(res, ADMIN_STATIC_INDEX, "text/html; charset=utf-8");
        return;
      }
      this.sendRedirect(res, "/login");
      return;
    }

    await this.sendAdminStaticFile(res, ADMIN_STATIC_INDEX, "text/html; charset=utf-8");
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
        cacheControl: cacheControlForAdminStatic(contentType),
      });
    } catch (error) {
      if (fallback !== undefined) {
        this.sendText(res, fallback, contentType, { cacheControl: cacheControlForAdminStatic(contentType) });
        return;
      }
      throw error;
    }
  }

  /** Handles the intentionally small unauthenticated authentication surface. */
  private async handlePublicAuth(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
    const publicAuthPaths = new Set([
      "/api/auth/password",
      "/api/auth/totp",
      "/api/auth/totp/enroll",
      "/api/auth/recovery",
      "/api/auth/invites/accept",
    ]);
    if (!publicAuthPaths.has(pathname)) {
      return false;
    }
    const body = await readJsonBody(req);
    const meta = this.authRequestMeta(req);
    if (pathname === "/api/auth/password") {
      const username = typeof body.username === "string" ? body.username : "";
      const password = typeof body.password === "string" ? body.password : "";
      const result = await this.auth.beginPasswordLogin({
        username,
        password,
        loginKey: this.loginAttemptKey(req, username),
        meta,
      });
      if (result.kind === "invalid_credentials") {
        this.sendJson(res, { error: "invalid_credentials" }, 401);
      } else if (result.kind === "locked") {
        this.sendJson(res, { error: "too_many_login_attempts", retryAfterSeconds: result.retryAfterSeconds }, 429);
      } else if (result.kind === "totp_required") {
        this.sendJson(res, { status: "totp_required", loginToken: result.loginToken, username: result.username });
      } else {
        this.sendJson(res, {
          status: "totp_enrollment_required",
          enrollmentToken: result.enrollmentToken,
          username: result.username,
          totpSecret: result.totpSecret,
          totpUri: result.totpUri,
        });
      }
      return true;
    }

    if (pathname === "/api/auth/totp") {
      const result = await this.auth.completeTotpLogin({
        loginToken: requiredString(body.loginToken),
        code: requiredString(body.code),
        meta,
      });
      this.sendAuthCompletion(res, result);
      return true;
    }

    if (pathname === "/api/auth/totp/enroll") {
      const result = await this.auth.completeTotpEnrollment({
        enrollmentToken: requiredString(body.enrollmentToken),
        code: requiredString(body.code),
        meta,
      });
      this.sendAuthCompletion(res, result);
      return true;
    }

    if (pathname === "/api/auth/recovery") {
      const username = typeof body.username === "string" ? body.username : "";
      const result = await this.auth.completeRecoveryLogin({
        username,
        password: typeof body.password === "string" ? body.password : "",
        recoveryCode: typeof body.recoveryCode === "string" ? body.recoveryCode : "",
        loginKey: this.loginAttemptKey(req, username),
        meta,
      });
      if (result.kind === "totp_enrollment_required") {
        this.sendJson(res, {
          status: "totp_enrollment_required",
          enrollmentToken: result.enrollmentToken,
          username: result.username,
          totpSecret: result.totpSecret,
          totpUri: result.totpUri,
        });
      } else if (result.kind === "locked") {
        this.sendJson(res, { error: "too_many_login_attempts", retryAfterSeconds: result.retryAfterSeconds }, 429);
      } else {
        this.sendJson(res, { error: result.kind }, result.kind === "disabled" ? 403 : 401);
      }
      return true;
    }

    if (pathname === "/api/auth/invites/accept") {
      const result = await this.auth.acceptInvite({
        inviteToken: requiredString(body.inviteToken),
        username: requiredString(body.username),
        password: requiredString(body.password),
        meta,
      });
      if (result.kind === "totp_enrollment_required") {
        this.sendJson(res, {
          status: "totp_enrollment_required",
          enrollmentToken: result.enrollmentToken,
          username: result.username,
          totpSecret: result.totpSecret,
          totpUri: result.totpUri,
        });
      } else {
        this.sendJson(res, { error: result.kind }, result.kind === "username_taken" ? 409 : 400);
      }
      return true;
    }
    return false;
  }

  private sendAuthCompletion(
    res: ServerResponse,
    result: Awaited<ReturnType<AdminAuthService["completeTotpLogin"]>>,
  ): void {
    if (result.kind === "success") {
      this.setSessionCookie(res, result.session.opaqueToken, new Date(result.session.expiresAt));
      this.sendJson(res, {
        ok: true,
        session: this.publicSession(result.session),
        ...(result.recoveryCodes ? { recoveryCodes: result.recoveryCodes } : {}),
      });
      return;
    }
    const status = result.kind === "disabled" ? 403 : result.kind === "invalid_challenge" ? 400 : 401;
    this.sendJson(res, { error: result.kind }, status);
  }

  private async handleHtmlPreviews(req: IncomingMessage, res: ServerResponse, url: URL, session: AdminSession): Promise<void> {
    const service = this.options.htmlPreviewService;
    if (!service) {
      this.sendJson(res, { error: "html_previews_unavailable" }, 503);
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
    const status = normalizeHtmlPreviewStatus(url.searchParams.get("status") ?? undefined);
    if ((url.searchParams.get("status") ?? "") && !status) {
      this.sendJson(res, { error: "invalid_html_preview_status" }, 400);
      return;
    }

    const visibleGroupIds = session.role === "super_admin"
      ? undefined
      : (await this.visibleGroups(session)).map((group) => group.groupId);
    const page = await service.listPage({
      ...(groupId ? { groupId } : {}),
      ...(visibleGroupIds ? { visibleGroupIds } : {}),
      ...(status ? { status } : {}),
      ...paginationParams(url, 20, 100),
    });
    // Do not spread repository records. Its internal data may contain source
    // ids or disk hashes, but the admin surface intentionally returns only
    // user-visible metadata.
    this.sendJson(res, {
      previews: page.items.map(formatHtmlPreviewForAdmin),
      pagination: page.pagination,
    });
  }

  private async handleHtmlPreviewItem(req: IncomingMessage, res: ServerResponse, id: string, session: AdminSession): Promise<void> {
    const service = this.options.htmlPreviewService;
    if (!service) {
      this.sendJson(res, { error: "html_previews_unavailable" }, 503);
      return;
    }
    if (req.method !== "DELETE") {
      this.sendJson(res, { error: "method_not_allowed" }, 405);
      return;
    }

    const preview = await service.get(id);
    if (!preview) {
      this.sendJson(res, { error: "not_found" }, 404);
      return;
    }
    if (!(await this.canAccessGroup(session, preview.groupId))) {
      this.sendJson(res, { error: "forbidden" }, 403);
      return;
    }
    const removed = await service.remove(id);
    if (!removed) {
      this.sendJson(res, { error: "not_found" }, 404);
      return;
    }
    await this.recordOperation({
      session,
      groupId: preview.groupId,
      action: "html_preview_delete",
      target: preview.id,
      detail: "manual_delete",
    });
    this.sendJson(res, { ok: true });
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
      const pagination = paginationParams(url, 20, 100);
      const page = await this.options.groupMemoryStore.listPage({
        groupId,
        subjectUserId,
        type,
        enabled,
        query,
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
      if (containsSensitiveMemoryCredential(input.content)) {
        this.sendJson(res, { error: "memory_secret_not_allowed" }, 400);
        return;
      }
      if (!(await this.canAccessGroup(session, input.groupId))) {
        this.sendJson(res, { error: "forbidden" }, 403);
        return;
      }
      const memory = await this.options.groupMemoryStore.create(input);
      this.invalidateMemberProfileCache(memory.groupId);
      await this.recordOperation({
        session,
        groupId: memory.groupId,
        action: "memory_create",
        target: memory.id,
        detail: `type=${memory.type}; subject=${memory.subjectUserId ?? "group"}`,
      });
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
      if (patch.content && containsSensitiveMemoryCredential(patch.content)) {
        this.sendJson(res, { error: "memory_secret_not_allowed" }, 400);
        return;
      }
      if (patch.groupId && !(await this.canAccessGroup(session, patch.groupId))) {
        this.sendJson(res, { error: "forbidden" }, 403);
        return;
      }
      const memory = await this.options.groupMemoryStore.update(params.id, patch);
      if (memory) {
        this.invalidateMemberProfileCache(memory.groupId);
        await this.recordOperation({
          session,
          groupId: memory.groupId,
          action: "memory_update",
          target: memory.id,
          detail: Object.keys(patch).sort().join(",").slice(0, 200),
        });
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
      if (existing && removed) {
        this.invalidateMemberProfileCache(existing.groupId);
        await this.recordOperation({
          session,
          groupId: existing.groupId,
          action: "memory_delete",
          target: existing.id,
          detail: "single",
        });
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
    const type = body.type === "member_profile" || body.type === "group_fact" ? body.type : undefined;
    const groupConfig = await this.options.groupConfigService.getGroup(groupId);
    if (!groupConfig) {
      this.sendJson(res, { error: "group_not_found" }, 404);
      return;
    }
    if (type !== "group_fact" && (groupConfig.memoryDisabledUserIds ?? []).includes(subjectUserId)) {
      this.sendJson(res, { error: "memory_collection_disabled" }, 403);
      return;
    }
    const service = new GroupMemoryDeduplicateService(this.options.groupMemoryStore, this.options.judgeMemorySemanticRelation);
    const semanticTimeoutMs = 10 * 60 * 1000;
    const mode = body.mode === "deep" ? "deep" : "fast";
    const previewSemanticTimeoutMs = mode === "deep" ? Math.min(semanticTimeoutMs, 30 * 1000) : semanticTimeoutMs;
    const runPreview = async (updateTaskProgress?: (event: MemoryDedupProgressEvent) => Promise<void>) => {
      const dedupPreview = await service.previewGroup(groupId, {
        subjectUserId,
        ...(type ? { type } : {}),
        semanticMode: "member",
        useSemanticJudge: mode === "deep",
        semanticTimeoutMs: previewSemanticTimeoutMs,
        excludedSubjectUserIds: groupConfig.memoryDisabledUserIds,
        ...(updateTaskProgress ? { onProgress: updateTaskProgress } : {}),
      });
      return {
        groupId,
        subjectUserId,
        mode,
        decisionCount: dedupPreview.decisions.length,
        decisions: dedupPreview.decisions,
        semanticStats: dedupPreview.semanticStats,
      };
    };
    if (this.options.adminTaskStore) {
      const task = await this.options.adminTaskStore.start({
        type: "memory-dedup",
        title: `记忆去重检测 ${subjectUserId}`,
        groupId,
        subjectUserId,
        operatorUserId: session.userId ?? session.username,
        detail: `preview; mode=${mode}; semanticJudge=${mode === "deep"}; timeoutMs=${previewSemanticTimeoutMs}`,
      }, async (_task, updateProgress) => runPreview(async (event) => {
        await updateProgress(
          progressForMemoryDedupEvent(event, mode),
          detailForMemoryDedupEvent(event, mode, previewSemanticTimeoutMs),
        );
      }));
      this.sendJson(res, {
        groupId,
        subjectUserId,
        mode,
        queued: true,
        taskId: task.id,
        task,
      }, 202);
      return;
    }
    this.sendJson(res, await runPreview());
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
    const type = body.type === "member_profile" || body.type === "group_fact" ? body.type : undefined;
    const groupConfig = await this.options.groupConfigService.getGroup(groupId);
    if (!groupConfig) {
      this.sendJson(res, { error: "group_not_found" }, 404);
      return;
    }
    if (type !== "group_fact" && (groupConfig.memoryDisabledUserIds ?? []).includes(subjectUserId)) {
      this.sendJson(res, { error: "memory_collection_disabled" }, 403);
      return;
    }
    const incoming = Array.isArray(body.decisions) ? body.decisions : [];
    const service = new GroupMemoryDeduplicateService(this.options.groupMemoryStore, this.options.judgeMemorySemanticRelation);
    const semanticTimeoutMs = 10 * 60 * 1000;
    const decisions = incoming.length > 0
      ? incoming.map(normalizeMemoryDedupDecision).filter((item): item is MemoryDedupDecision => Boolean(item))
      : (await service.previewGroup(groupId, {
          subjectUserId,
          ...(type ? { type } : {}),
          semanticMode: "member",
          useSemanticJudge: true,
          semanticTimeoutMs,
          excludedSubjectUserIds: groupConfig.memoryDisabledUserIds,
        })).decisions;
    const wrapped = this.options.adminTaskStore
      ? await this.options.adminTaskStore.run({
          type: "memory-dedup",
          title: `记忆去重 ${subjectUserId}`,
          groupId,
          subjectUserId,
          operatorUserId: session.userId ?? session.username,
          detail: `${decisions.length} decisions`,
        }, () => service.apply(groupId, decisions, {
          excludedSubjectUserIds: groupConfig.memoryDisabledUserIds,
        }))
      : { result: await service.apply(groupId, decisions, {
          excludedSubjectUserIds: groupConfig.memoryDisabledUserIds,
        }), task: undefined };
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

  private async handleGroupMembers(res: ServerResponse, groupId: string, url: URL): Promise<void> {
    // A members GET is intentionally cache-only. In particular, legacy
    // includeNapcat/refresh query parameters must never turn navigation or
    // search into a remote NapCat read or mutate the process cache.
    const profiles = await this.getCachedMemberProfileData(groupId, { cacheOnly: true });
    if (!profiles) {
      const groupConfig = await this.options.groupConfigService.getGroup(groupId);
      if (!groupConfig) {
        this.sendJson(res, { error: "not_found" }, 404);
        return;
      }
      this.sendMemberProfiles(res, [], url, "unloaded");
      return;
    }

    this.sendMemberProfiles(res, profiles.members, url, "cached");
  }

  private async handleGroupMembersRefresh(res: ServerResponse, groupId: string, url: URL): Promise<void> {
    try {
      const profiles = await this.getCachedMemberProfileData(groupId, {
        force: true,
        includeNapcatMembers: true,
      });
      if (!profiles) {
        this.sendJson(res, { error: "not_found" }, 404);
        return;
      }
      this.sendMemberProfiles(res, profiles.members, url, "refreshed");
    } catch (error) {
      if (error instanceof MemberDirectoryUnavailableError) {
        this.sendJson(res, { error: error.message }, 503);
        return;
      }
      throw error;
    }
  }

  private sendMemberProfiles(
    res: ServerResponse,
    members: GroupMemberProfile[],
    url: URL,
    cacheStatus: "cached" | "refreshed" | "unloaded",
  ): void {
    const query = normalizeSearchQuery(url.searchParams.get("q") ?? undefined);
    const returnAll = url.searchParams.get("all") === "1";
    const pagination = paginationParams(url, 24, 100);
    const filteredMembers = members.filter((member) => !query || memberMatchesQuery(member, query));
    if (returnAll) {
      this.sendJson(res, {
        members: filteredMembers,
        cacheStatus,
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
      cacheStatus,
    });
  }

  private async handleMemberIdentity(
    req: IncomingMessage,
    res: ServerResponse,
    route: { groupId: string; userId: string },
    session: AdminSession,
  ): Promise<void> {
    if (!/^\d+$/.test(route.userId)) {
      this.sendJson(res, { error: "invalid_user_id" }, 400);
      return;
    }

    if (req.method === "PUT") {
      const body = await readJsonBody(req);
      const currentProfile = await this.getMemberProfile(route.groupId, route.userId);
      const previousCache = this.memberProfileCache.get(route.groupId);
      const group = await this.options.groupConfigService.updateManualIdentity(route.groupId, route.userId, {
        names: normalizeNames(body.names),
        note: optionalString(body.note),
      });
      this.invalidateMemberProfileCache(route.groupId);
      const member = await this.buildUpdatedMemberProfile(route.groupId, route.userId, group, currentProfile);
      this.replaceMemberProfileCache(route.groupId, group, member, previousCache);
      await this.recordOperation({
        session,
        groupId: route.groupId,
        action: "member_identity_update",
        target: route.userId,
      });
      this.sendJson(res, { group, member });
      return;
    }

    if (req.method === "DELETE") {
      const currentProfile = await this.getMemberProfile(route.groupId, route.userId);
      const previousCache = this.memberProfileCache.get(route.groupId);
      const group = await this.options.groupConfigService.removeManualIdentity(route.groupId, route.userId);
      this.invalidateMemberProfileCache(route.groupId);
      const member = await this.buildUpdatedMemberProfile(route.groupId, route.userId, group, currentProfile);
      this.replaceMemberProfileCache(route.groupId, group, member, previousCache);
      await this.recordOperation({
        session,
        groupId: route.groupId,
        action: "member_identity_remove",
        target: route.userId,
      });
      this.sendJson(res, { group, member });
      return;
    }

    this.sendJson(res, { error: "method_not_allowed" }, 405);
  }

  /**
   * Privacy exits are deliberately separate from ordinary group settings.
   * A group administrator may add an opt-out for an assigned group, but only
   * a super administrator can re-enable collection after that decision.
   */
  private async handleMemberPrivacyOptOut(
    req: IncomingMessage,
    res: ServerResponse,
    route: { groupId: string; userId: string },
    session: AdminSession,
  ): Promise<void> {
    if (!/^\d+$/.test(route.userId)) {
      this.sendJson(res, { error: "invalid_user_id" }, 400);
      return;
    }
    const group = await this.options.groupConfigService.getGroup(route.groupId);
    if (!group) {
      this.sendJson(res, { error: "not_found" }, 404);
      return;
    }
    const current = new Set(group.memoryDisabledUserIds ?? []);

    if (req.method === "POST") {
      current.add(route.userId);
      const updated = await this.options.groupConfigService.updateGroupConfig(route.groupId, {
        memoryDisabledUserIds: [...current],
      });
      this.invalidateMemberProfileCache(route.groupId);
      await this.recordOperation({
        session,
        groupId: route.groupId,
        action: "member_privacy_opt_out",
        target: route.userId,
      });
      this.sendJson(res, { group: updated, optedOut: true });
      return;
    }

    if (req.method === "DELETE") {
      if (!this.requireRecentSuperAdminMfa(session, res)) return;
      current.delete(route.userId);
      const updated = await this.options.groupConfigService.updateGroupConfig(route.groupId, {
        memoryDisabledUserIds: [...current],
      });
      this.invalidateMemberProfileCache(route.groupId);
      await this.recordOperation({
        session,
        groupId: route.groupId,
        action: "member_privacy_opt_out_revoked",
        target: route.userId,
      });
      this.sendJson(res, { group: updated, optedOut: false });
      return;
    }

    this.sendJson(res, { error: "method_not_allowed" }, 405);
  }

  private async handleGroupConfig(
    req: IncomingMessage,
    res: ServerResponse,
    params: RouteParams,
    session: AdminSession,
  ): Promise<void> {
    if (req.method === "GET") {
      const group = await this.options.groupConfigService.getGroup(params.id);
      this.sendJson(res, group ?? { error: "not_found" }, group ? 200 : 404);
      return;
    }

    if (req.method === "PUT") {
      const body = await readJsonBody(req);
      if (hasRetiredSharedAdminSecretField(body)) {
        this.sendJson(res, { error: "shared_admin_secret_retired" }, 410);
        return;
      }
      // Privacy opt-outs are a sensitive collection decision. Keep the
      // generic configuration endpoint from bypassing the dedicated route's
      // recent-MFA requirement for a super administrator.
      if (session.role === "super_admin" && "memoryDisabledUserIds" in body &&
        !this.requireRecentSuperAdminMfa(session, res)) {
        return;
      }
      if (session.role === "super_admin" && this.options.groupConfigService.isV3Runtime() && "switcherUserIds" in body) {
        this.sendJson(res, { error: "legacy_qq_admin_retired" }, 410);
        return;
      }
      try {
        const existing = await this.options.groupConfigService.getGroup(params.id);
        if (!existing) {
          this.sendJson(res, { error: "not_found" }, 404);
          return;
        }
        const update = session.role === "group_admin"
          ? sanitizeGroupAdminConfigPatch(body, existing.memoryDisabledUserIds ?? [])
          : body;
        if (session.role === "group_admin" && Object.keys(update).length === 0 && Object.keys(body).length > 0) {
          this.sendJson(res, { error: "forbidden" }, 403);
          return;
        }
        if (session.role === "group_admin" && "memoryDisabledUserIds" in body && !("memoryDisabledUserIds" in update)) {
          this.sendJson(res, { error: "privacy_opt_out_reenable_requires_super_admin" }, 403);
          return;
        }
        if (session.role === "group_admin" && typeof update.replyModelMode === "string" &&
          !(await this.isApprovedReplyModel(update.replyModelMode))) {
          this.sendJson(res, { error: "reply_model_not_approved" }, 403);
          return;
        }
        const group = await this.options.groupConfigService.updateGroupConfig(params.id, update);
        this.invalidateMemberProfileCache(params.id);
        await this.recordOperation({
          session,
          groupId: params.id,
          action: "group_config_update",
          target: "group_config",
          detail: Object.keys(update).sort().join(",").slice(0, 500),
        });
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
      if (hasRetiredSystemSettingField(body)) {
        this.sendJson(res, { error: "retired_system_setting" }, 410);
        return;
      }
      try {
        this.sendJson(res, await this.options.systemSettingsStore.update(body as Partial<SystemSettings>));
      } catch (error) {
        const errorCode = (error as Error).message;
        if ([
          "invalid_time",
          "invalid_models",
          "invalid_model_config",
          "invalid_model_id",
          "duplicate_model_id",
          "invalid_model_purpose",
          "invalid_memory_confidence_thresholds",
        ].includes(errorCode)) {
          this.sendJson(res, { error: errorCode }, 400);
          return;
        }
        throw error;
      }
      return;
    }
    this.sendJson(res, { error: "method_not_allowed" }, 405);
  }

  private async handleModelConnectionTest(res: ServerResponse, modelId: string, session: AdminSession): Promise<void> {
    if (!this.options.systemSettingsStore) {
      this.sendJson(res, { error: "system_settings_unavailable" }, 503);
      return;
    }
    const settings = await this.options.systemSettingsStore.getInternal();
    const model = runtimeModels(settings).find((item) => item.id === modelId);
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
      const replyModel = { id: "gpt", label: "GPT", purpose: "reply", enabled: true };
      this.sendJson(res, {
        replyModels: session.role === "super_admin"
          ? [{ ...replyModel, hasApiKey: true }]
          : [replyModel],
      });
      return;
    }

    const settings = await this.options.systemSettingsStore.get();
    const models = runtimeModels(settings).map((model) => ({
      id: model.id,
      label: formatModelOptionLabel(model.id, model.model),
      name: model.name,
      shortName: model.shortName,
      purpose: model.purpose,
      enabled: model.enabled,
      hasApiKey: model.hasApiKey,
      baseUrl: model.baseUrl,
      model: model.model,
    }));
    const replyModels = models.filter((model) => (
      model.enabled &&
      model.hasApiKey &&
      model.purpose === "reply"
    ));
    const publicReplyModels = replyModels.map((model) => ({
      id: model.id,
      label: model.label,
      purpose: model.purpose,
      enabled: model.enabled,
    }));
    this.sendJson(res, {
      ...(session.role === "super_admin" ? { models } : {}),
      replyModels: session.role === "super_admin"
        ? replyModels
        : publicReplyModels,
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
    options: { force?: boolean; includeNapcatMembers?: boolean; cacheOnly?: boolean } = {},
  ): Promise<{ groupConfig: GroupBotConfig; members: GroupMemberProfile[] } | undefined> {
    const cached = this.memberProfileCache.get(groupId);
    if (options.cacheOnly === true) {
      // The member page must never present a light identity cache as a full
      // NapCat directory or keep a 30-second snapshot forever.
      if (!cached || !cached.includesNapcatMembers || cached.expiresAt <= Date.now()) {
        if (cached && cached.expiresAt <= Date.now()) {
          this.memberProfileCache.delete(groupId);
        }
        return undefined;
      }
      return { groupConfig: cached.groupConfig, members: cached.members };
    }
    const force = options.force === true;
    const includeNapcatMembers = options.includeNapcatMembers === true;
    if (!force && cached && cached.expiresAt > Date.now() && (!includeNapcatMembers || cached.includesNapcatMembers)) {
      return { groupConfig: cached.groupConfig, members: cached.members };
    }
    const inflightKey = memberProfileInflightKey(groupId, includeNapcatMembers);
    const inflight = this.memberProfileInflight.get(inflightKey);
    if (inflight) {
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

  private async handleHuixianPersona(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.options.characterProfileService) {
      this.sendJson(res, { error: "persona_unavailable" }, 503);
      return;
    }
    if (req.method === "GET") {
      const persona = await this.options.characterProfileService.getHuixianProfile({ refresh: true });
      this.sendJson(res, persona ?? { error: "not_found" }, persona ? 200 : 404);
      return;
    }
    if (req.method === "PUT") {
      try {
        const persona = await this.options.characterProfileService.updateHuixianProfile(await readJsonBody(req) as Partial<CharacterProfile>);
        this.sendJson(res, persona ?? { error: "not_found" }, persona ? 200 : 404);
      } catch (error) {
        this.sendJson(res, { error: error instanceof Error ? error.message : "invalid_persona" }, 400);
      }
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

    const [memoryCounts, napcatMembers] = await Promise.all([
      this.options.groupMemoryStore.countBySubject(groupId),
      includeNapcatMembers ? this.loadNapcatGroupMembers(groupId) : Promise.resolve([]),
    ]);
    const data = {
      groupConfig,
      members: buildGroupMemberProfiles({ groupConfig, napcatMembers, memoryCounts }),
    };
    const existing = this.memberProfileCache.get(groupId);
    // A slow light read cannot overwrite a newer full NapCat snapshot.
    if (includeNapcatMembers || !existing || !existing.includesNapcatMembers || existing.expiresAt <= Date.now()) {
      this.memberProfileCache.set(groupId, {
        ...data,
        includesNapcatMembers: includeNapcatMembers,
        expiresAt: Date.now() + 30_000,
      });
    }
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

  private replaceMemberProfileCache(
    groupId: string,
    groupConfig: GroupBotConfig,
    member: GroupMemberProfile,
    previousCache?: {
      expiresAt: number;
      groupConfig: GroupBotConfig;
      members: GroupMemberProfile[];
      includesNapcatMembers: boolean;
    },
  ): void {
    // This is called only from explicit identity mutations. It keeps a prior
    // NapCat snapshot usable after the write without making a later GET fetch
    // remotely or rebuild cache state on its own.
    const cached = previousCache ?? this.memberProfileCache.get(groupId);
    if (!cached) {
      return;
    }
    const exists = cached.members.some((item) => item.userId === member.userId);
    this.memberProfileCache.set(groupId, {
      groupConfig,
      members: exists
        ? cached.members.map((item) => item.userId === member.userId ? member : item)
        : [...cached.members, member],
      includesNapcatMembers: cached.includesNapcatMembers,
      expiresAt: Date.now() + 30_000,
    });
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
    const [memoryCounts] = await Promise.all([
      this.options.groupMemoryStore.countBySubject(groupId),
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
    }).find((member) => member.userId === userId) ?? {
      userId,
      displayName: userId,
      aliases: [],
      hasManualIdentity: false,
      memoryCount: 0,
    };
  }

  private async loadNapcatGroupMembers(groupId: string): Promise<NapcatGroupMember[]> {
    if (!this.options.listGroupMembers) {
      logWarn("Group member directory is unavailable for admin.", { groupId, error: "listGroupMembers unavailable" });
      throw new MemberDirectoryUnavailableError();
    }
    try {
      return await this.options.listGroupMembers(groupId);
    } catch (error) {
      logWarn("Failed to list group members for admin.", {
        groupId,
        error: (error as Error).message,
      });
      throw new MemberDirectoryUnavailableError();
    }
  }

  private async buildHealthResponse(
    session: AdminSession,
    options: { refresh?: boolean } = {},
  ) {
    const rawTransportHealth = this.options.getTransportHealthStatus
      ? await this.options.getTransportHealthStatus()
      : { ok: true, detail: "未配置传输层自检" };
    const transportHealth = sanitizeHealthStatus(rawTransportHealth);
    const modelStatuses = await this.getModelHealthStatuses(options.refresh ? { refresh: true, source: "manual" } : {});
    const abnormalModelStatuses = modelStatuses.filter(isAbnormalModelStatus);
    const memory = process.memoryUsage();
    const environmentStatus = {
      transportHealth,
      node: {
        ok: true,
        detail: `${process.version} / PID ${process.pid}`,
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
    return {
      transportHealth,
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
      serverStatus: getServerStatusSnapshot(),
      pid: process.pid,
      memory,
    };
  }

  private async getModelHealthStatuses(options: { refresh?: boolean; source?: ModelHealthHistoryEntry["source"] } = {}): Promise<ModelHealthStatus[]> {
    if (!this.options.systemSettingsStore) {
      return [];
    }
    const settings = await this.options.systemSettingsStore.getInternal();
    if (!options.refresh) {
      const historicalStatuses = this.options.modelHealthHistoryStore
        ? new Map((await this.options.modelHealthHistoryStore.list()).map((status) => [status.id, status]))
        : new Map<string, ModelHealthHistoryEntry>();
    return runtimeModels(settings).map((model) => {
        const cached = this.modelHealthCache.get(model.id);
        if (cached && cached.expiresAt > Date.now()) {
          return { ...cached.status, cached: true };
        }
        const historical = historicalStatuses.get(model.id);
        if (historical) {
          return {
            ...historical,
            ...this.buildModelHealthBase(model, settings),
            cached: true,
          };
        }
        return this.buildModelHealthSkippedStatus(model, settings, "尚未手动检测。");
      });
    }

    const source = options.source ?? "manual";
    return await Promise.all(runtimeModels(settings).map(async (model) => {
      const status = await this.buildModelHealthStatus(model, settings);
      this.modelHealthCache.set(model.id, { expiresAt: Date.now() + 60 * 60 * 1000, status });
      await this.recordModelHealth(status, source);
      return status;
    }));
  }

  private async buildModelHealthStatus(model: RuntimeSystemModelConfig, settings: SystemSettings): Promise<ModelHealthStatus> {
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
    model: RuntimeSystemModelConfig,
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
    model: RuntimeSystemModelConfig,
    settings: SystemSettings,
    detail = "模型已停用，已跳过检测。",
  ): ModelHealthStatus {
    return {
      ...this.buildModelHealthBase(model, settings),
      ok: true,
      detail,
      model: model.model,
      baseUrl: model.baseUrl,
      checkedAt: new Date().toISOString(),
      latencyMs: 0,
      cached: false,
      skipped: true,
    };
  }

  private buildModelHealthBase(model: RuntimeSystemModelConfig, settings: SystemSettings): Pick<ModelHealthStatus, "id" | "purpose" | "name" | "shortName" | "selected"> {
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

  private getSession(req: IncomingMessage): AdminAuthSession | undefined {
    return this.auth.getSession(parseCookies(req.headers.cookie ?? "")[ADMIN_SESSION_COOKIE]);
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
    if (requestedGroupId && !groupIds.has(requestedGroupId)) {
      this.sendJson(res, { error: "forbidden" }, 403);
      return;
    }
    const searchGroups = requestedGroupId
      ? groups.filter((group) => group.groupId === requestedGroupId)
      : groups;
    const [memories, knowledge] = await Promise.all([
      this.options.groupMemoryStore.list(),
      this.options.knowledgeBaseStore.list(),
    ]);
    const resultItems: Array<{ type: string; title: string; subtitle: string; path: string; groupId: string }> = [];
    for (const group of groups) {
      if (`${group.groupName || ""} ${group.groupId}`.toLowerCase().includes(query.toLowerCase())) {
        resultItems.push({ type: "group", title: group.groupName || `群 ${group.groupId}`, subtitle: group.groupId, path: "/groups", groupId: group.groupId });
      }
    }
    for (const group of searchGroups) {
      const profiles = await this.getCachedMemberProfileData(group.groupId, { cacheOnly: true });
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
    for (const entry of knowledge.filter((item) => groupIds.has(item.groupId)).slice(0, 500)) {
      if (`${entry.title} ${entry.question} ${entry.answer} ${entry.keywords.join(" ")}`.toLowerCase().includes(query.toLowerCase())) {
        resultItems.push({ type: "knowledge", title: entry.title, subtitle: entry.question, path: `/knowledge?q=${encodeURIComponent(query)}`, groupId: entry.groupId });
      }
    }
    this.sendJson(res, { results: resultItems.slice(0, 30) });
  }

  private async visibleGroups(session: AdminSession, options: { includeDisabled?: boolean } = {}): Promise<GroupBotConfig[]> {
    const groups = await this.options.groupConfigService.getAll();
    if (session.role === "super_admin") {
      return options.includeDisabled ? groups : groups.filter((group) => group.enabled !== false);
    }
    const allowed = new Set(session.allowedGroupIds);
    return groups.filter((group) => (
      group.enabled !== false &&
      allowed.has(group.groupId)
    ));
  }

  private async canAccessGroup(session: AdminSession, groupId: string): Promise<boolean> {
    if (session.role === "super_admin") {
      return true;
    }
    const group = await this.options.groupConfigService.getGroup(groupId);
    return Boolean(
      group &&
      group.enabled !== false &&
      session.userId &&
      this.auth.hasGroupGrant(session.userId, groupId),
    );
  }

  private requireSuperAdmin(session: AdminSession, res: ServerResponse): boolean {
    if (session.role === "super_admin") {
      return true;
    }
    this.sendJson(res, { error: "forbidden" }, 403);
    return false;
  }

  private requireRecentSuperAdminMfa(session: AdminSession, res: ServerResponse): boolean {
    if (session.role !== "super_admin") {
      this.sendJson(res, { error: "forbidden" }, 403);
      return false;
    }
    if (!this.auth.hasRecentMfa(session as AdminAuthSession)) {
      this.sendJson(res, { error: "recent_mfa_required" }, 403);
      return false;
    }
    return true;
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
    return typeof value === "string" && this.auth.validateCsrf(session as AdminAuthSession, value);
  }

  private loginAttemptKey(req: IncomingMessage, username: string): string {
    // Nginx is expected to terminate TLS locally. Do not trust a public
    // X-Forwarded-For header for a security decision in the Node process.
    const ip = (req.socket.remoteAddress || "unknown").trim();
    return `${ip}:${username.trim().toLowerCase() || "unknown"}`;
  }

  private authRequestMeta(req: IncomingMessage): { ip?: string; userAgent?: string } {
    const userAgent = req.headers["user-agent"];
    return {
      ip: (req.socket.remoteAddress || "unknown").trim(),
      ...(typeof userAgent === "string" ? { userAgent } : {}),
    };
  }

  private isTrustedRequestOrigin(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    const expected = this.options.publicBaseUrl.replace(/\/$/, "");
    if (typeof origin === "string" && origin) {
      return safeEqual(origin.replace(/\/$/, ""), expected);
    }
    // Local development and node integration tests lack a browser Origin
    // header. Production URLs never take this compatibility path.
    return /:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/i.test(expected);
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

  private setSessionCookie(res: ServerResponse, value: string, expires: Date): void {
    const secure = this.options.publicBaseUrl.startsWith("https://");
    res.setHeader(
      "Set-Cookie",
      [
        `${ADMIN_SESSION_COOKIE}=${value}`,
        "Path=/",
        "HttpOnly",
        "SameSite=Strict",
        secure ? "Secure" : "",
        `Expires=${expires.toUTCString()}`,
      ].filter(Boolean).join("; "),
    );
  }

  /** Group administrators may select only an enabled, credentialed reply model. */
  private async isApprovedReplyModel(modelId: string): Promise<boolean> {
    if (!this.options.systemSettingsStore) {
      return false;
    }
    const settings = await this.options.systemSettingsStore.get();
    return runtimeModels(settings).some((model) => (
      model.id === modelId &&
      model.purpose === "reply" &&
      model.enabled &&
      model.hasApiKey
    ));
  }

  private clearSessionCookie(res: ServerResponse): void {
    this.setSessionCookie(res, "", new Date(0));
  }

  private sendAuthError(res: ServerResponse, error: unknown): void {
    if (error instanceof AdminAuthError) {
      this.sendJson(res, { error: error.code }, error.statusCode);
      return;
    }
    throw error;
  }

  private sendJson(res: ServerResponse, data: unknown, statusCode = 200): void {
    this.sendText(res, JSON.stringify(data), "application/json; charset=utf-8", { statusCode, cacheControl: ADMIN_API_CACHE_CONTROL });
  }

  private sendHtml(res: ServerResponse, html: string): void {
    this.sendText(res, html, "text/html; charset=utf-8");
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
    if (contentType.includes("text/html")) {
      res.setHeader("Speculation-Rules", `"${ADMIN_SPECULATION_RULES_PATH}"`);
    }
    res.end(content);
  }

  private sendRedirect(res: ServerResponse, location: string): void {
    res.writeHead(302, {
      Location: location,
      "Cache-Control": ADMIN_HTML_CACHE_CONTROL,
      "Speculation-Rules": `"${ADMIN_SPECULATION_RULES_PATH}"`,
    });
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
    if (contentType.includes("text/html")) {
      res.setHeader("Speculation-Rules", `"${ADMIN_SPECULATION_RULES_PATH}"`);
    }
    if (shouldCompress) res.setHeader("Content-Encoding", "gzip");
    res.end(payload);
  }
}

function cacheControlForAdminStatic(contentType: string): string {
  return contentType.includes("text/html") ? ADMIN_HTML_CACHE_CONTROL : "public, max-age=31536000, immutable";
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

function isAdminAssetPath(pathname: string): boolean {
  return pathname === "/assets" || pathname.startsWith("/assets/");
}

function contentTypeFor(filePath: string): string {
  return STATIC_CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
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

function containsSensitiveMemoryCredential(value: string): boolean {
  const text = value.toLowerCase();
  return [
    /-----begin [a-z ]*private key-----/i,
    /\b(?:api[_ -]?key|access[_ -]?token|authorization|bearer|secret|password|passwd)\b/i,
    /(?:密码|口令|令牌|密钥|私钥|访问令牌|授权码)\s*(?:是|为|:|：|=)/u,
    /\bsk-[a-z0-9_-]{12,}\b/i,
    /\bakia[0-9a-z]{16}\b/i,
  ].some((pattern) => pattern.test(text));
}

function normalizeMemoryType(value: unknown): GroupMemoryType {
  return value === "member_profile" ? "member_profile" : "group_fact";
}

function normalizeOptionalMemoryType(value: string | undefined): GroupMemoryType | undefined {
  return value === "member_profile" || value === "group_fact" ? value : undefined;
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
  return value === "memory-dedup" || value === "model-check" || value === "bulk-review"
    ? value
    : undefined;
}

function normalizeTaskStatus(value: string | undefined): AdminTaskStatus | undefined {
  return value === "queued" || value === "running" || value === "succeeded" || value === "failed" || value === "cancelled"
    ? value
    : undefined;
}

type HtmlPreviewStatus = "pending" | "published" | "failed" | "expired" | "deleted";

function normalizeHtmlPreviewStatus(value: string | undefined): HtmlPreviewStatus | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized === "pending" ||
    normalized === "published" ||
    normalized === "failed" ||
    normalized === "expired" ||
    normalized === "deleted"
    ? normalized
    : undefined;
}

function formatHtmlPreviewForAdmin(preview: HtmlPreviewAdminMetadata): {
  id: string;
  groupId: string;
  creatorUserId?: string;
  title: string;
  previewUrl: string;
  status: HtmlPreviewStatus;
  createdAt: string;
  expiresAt: string;
  deletedAt?: string;
  byteSize?: number;
} {
  return {
    id: preview.id,
    groupId: preview.groupId,
    ...(preview.creatorUserId ? { creatorUserId: preview.creatorUserId } : {}),
    title: preview.title.slice(0, 240),
    previewUrl: preview.previewUrl,
    status: normalizeHtmlPreviewStatus(preview.status) ?? "failed",
    createdAt: preview.createdAt,
    expiresAt: preview.expiresAt,
    ...(preview.deletedAt ? { deletedAt: preview.deletedAt } : {}),
    ...(typeof preview.byteSize === "number" && Number.isFinite(preview.byteSize) && preview.byteSize >= 0
      ? { byteSize: Math.floor(preview.byteSize!) }
      : {}),
  };
}

function progressForMemoryDedupEvent(event: MemoryDedupProgressEvent, mode: "fast" | "deep"): number {
  if (event.phase === "loaded") return 18;
  if (event.phase === "local_scanned") return mode === "deep" && event.semanticPairLimit > 0 ? 35 : 80;
  if (event.phase === "semantic_pair") {
    if (event.semanticPairLimit <= 0) return 80;
    return Math.min(90, 35 + Math.floor((event.semanticPairsProcessed / event.semanticPairLimit) * 55));
  }
  return 95;
}

function detailForMemoryDedupEvent(event: MemoryDedupProgressEvent, mode: "fast" | "deep", timeoutMs: number): string {
  return [
    `preview; mode=${mode}`,
    `phase=${event.phase}`,
    `memories=${event.memoryCount}`,
    `semanticCandidates=${event.semanticCandidatePairCount}`,
    `semanticProcessed=${event.semanticPairsProcessed}/${event.semanticPairLimit}`,
    `timeoutMs=${timeoutMs}`,
  ].join("; ");
}

function normalizeModelPurpose(value: string): SystemModelPurpose {
  return value === "reply" ||
    value === "summary" ||
    value === "knowledge" ||
    value === "tts" ||
    value === "custom"
    ? value
    : "custom";
}

function runtimeModels(settings: SystemSettings): RuntimeSystemModelConfig[] {
  return settings.models.filter((model): model is RuntimeSystemModelConfig => isRuntimeModelPurpose(model.purpose));
}

function isRuntimeModelPurpose(value: unknown): value is SystemModelPurpose {
  return value === "reply" || value === "summary" || value === "knowledge" || value === "tts" || value === "custom";
}

function normalizeLogLimit(value: string | undefined): number {
  const parsed = value ? Number(value) : 50;
  return Number.isInteger(parsed) ? Math.max(1, Math.min(200, parsed)) : 50;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)))
    .sort();
}

function normalizeInviteExpiryHours(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : 24;
  if (!Number.isFinite(parsed)) return 24;
  return Math.max(1, Math.min(24 * 30, Math.floor(parsed)));
}

/** Group admins manage their assigned group only, never QQ-level bot admins or global policy. */
function sanitizeGroupAdminConfigPatch(body: Record<string, unknown>, currentPrivacyOptOuts: string[]): Record<string, unknown> {
  const permitted = new Set([
    "replyModelMode",
    "participationMode",
    "liveChatDelaySeconds",
    "dailyReportEnabled",
    "dailyReportTime",
    "dailyReportDateRule",
    "dailyReportWeekdays",
    "dailyReportTopUserCount",
    "holidayCountdownEnabled",
    "holidayCountdownTime",
    "holidayCountdownDateRule",
    "holidayCountdownWeekdays",
    "botMuted",
    "scheduledRemindersEnabled",
    "blacklistedUserIds",
    "opsAlertsEnabled",
    "triggerKeywords",
    "voiceReplyEnabled",
    "defaultVoiceReplyEnabled",
    "onlineLookupEnabled",
    "visionEnabled",
    "htmlPreviewEnabled",
  ]);
  const update = Object.fromEntries(Object.entries(body).filter(([key]) => permitted.has(key)));
  if ("memoryDisabledUserIds" in body) {
    const requested = normalizeStringList(body.memoryDisabledUserIds);
    const current = new Set(currentPrivacyOptOuts);
    // Group administrators may only add privacy exits. Removing even one
    // existing opt-out is reserved for a super administrator and the
    // dedicated audited route.
    if ([...current].every((userId) => requested.includes(userId))) {
      update.memoryDisabledUserIds = requested;
    }
  }
  return update;
}

function isStateChangingMethod(method: string | undefined): boolean {
  const normalized = (method ?? "GET").toUpperCase();
  return normalized !== "GET" && normalized !== "HEAD" && normalized !== "OPTIONS";
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

function hasRetiredSharedAdminSecretField(body: Record<string, unknown>): boolean {
  return [
    "adminSecret",
    "groupAdminSecret",
    "adminSecretHash",
    "groupAdminSecretHash",
    "adminSecretConfigured",
    "groupAdminSecretConfigured",
  ].some((key) => Object.hasOwn(body, key));
}

function hasRetiredSystemSettingField(body: Record<string, unknown>): boolean {
  return hasRetiredSharedAdminSecretField(body) || [
    "profileSummaryMaxChars",
    "profileShortSummaryMaxChars",
    "dailyProfileReviewEnabled",
    "dailyProfileReviewTime",
    "memoryDedupEnabled",
    "memoryDedupTime",
    "memoryDedupSemanticTimeoutMinutes",
    "memoryCandidateConfidenceThreshold",
    "memoryAutoApproveConfidenceThreshold",
    "memoryUnattendedModeEnabled",
  ].some((key) => Object.hasOwn(body, key)) || hasRetiredTokenCostControlField(body.tokenCostControl);
}

function hasRetiredTokenCostControlField(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return [
    "memoryCandidateExtractionEnabled",
    "memoryCandidateNormalizationEnabled",
    "memorySemanticDedupEnabled",
    "dailyProfileReviewAiEnabled",
  ].some((key) => Object.hasOwn(value, key));
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

function safeJsonObject(raw: string): Record<string, boolean> {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"),
    );
  } catch {
    return {};
  }
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function createAdminSessionSecret(): string {
  return randomBytes(32).toString("base64url");
}
