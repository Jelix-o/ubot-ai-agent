import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { logWarn } from "./logger.js";
import type { MessageTransport } from "./bot.js";
import type { MessageImageInput, ReferencedMessage } from "./types.js";

const MAX_READ_API_BODY_BYTES = 1024 * 1024;
const READ_API_HEADERS_TIMEOUT_MS = 10_000;
const READ_API_REQUEST_TIMEOUT_MS = 15_000;

export class IngressReadApiUnavailableError extends Error {
  constructor() {
    super("ingress_read_api_unavailable");
  }
}

class IngressReadApiRequestError extends Error {
  constructor(
    readonly code: "invalid_json" | "invalid_json_body" | "request_body_too_large",
    readonly statusCode: 400 | 413,
  ) {
    super(code);
  }
}

/**
 * Localhost read API exposed by the ingress process so the worker can use
 * NapCat read actions (get_msg, member list, image resolution) without owning
 * the reverse WebSocket. Worker → HTTP → ingress → NapCat action channel.
 *
 * Endpoints:
 *   GET  /read/health
 *   GET  /read/get_msg?message_id=X
 *   GET  /read/group_members?group_id=X
 *   GET  /read/groups
 *   POST /read/mentions      { groupId, candidates }
 *   POST /read/identities    { groupId, candidates }
 *   POST /read/images        { images: MessageImageInput[] } → data URLs
 */
export class IngressReadApi {
  private startPromise?: Promise<void>;
  private readonly server = createServer((req, res) => {
    void this.handle(req, res);
  });

  constructor(
    private readonly transport: MessageTransport,
    private readonly port: number,
    private readonly token: string,
    private readonly host = "127.0.0.1",
  ) {
    if (!token.trim()) {
      throw new Error("Ingress read API requires a non-empty bearer token.");
    }
    this.server.headersTimeout = READ_API_HEADERS_TIMEOUT_MS;
    this.server.requestTimeout = READ_API_REQUEST_TIMEOUT_MS;
  }

  async start(): Promise<void> {
    if (this.server.listening) return;
    if (this.startPromise) return this.startPromise;

    const pending = new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        this.server.off("listening", onListening);
        this.server.off("error", onError);
      };
      const onListening = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      this.server.once("listening", onListening);
      this.server.once("error", onError);
      try {
        this.server.listen(this.port, this.host);
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
    this.startPromise = pending;
    try {
      await pending;
    } finally {
      if (this.startPromise === pending) this.startPromise = undefined;
    }
  }

  async close(): Promise<void> {
    if (!this.server.listening) return;
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => error ? reject(error) : resolve());
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    try {
      if (req.method === "GET" && url.pathname === "/read/health") {
        const health = this.transport.getHealthStatus
          ? await this.transport.getHealthStatus()
          : { ok: true, detail: "no health check" };
        return this.json(res, 200, { ok: health.ok, detail: health.detail });
      }
      if (!this.isAuthorized(req)) {
        return this.json(res, 401, { error: "unauthorized" });
      }
      if (req.method === "GET" && url.pathname === "/read/get_msg") {
        const messageId = url.searchParams.get("message_id") ?? "";
        if (!this.transport.getMessage) {
          return this.json(res, 501, { error: "getMessage unavailable" });
        }
        const message = await this.transport.getMessage(messageId);
        return this.json(res, 200, { message: message ?? null });
      }

      if (req.method === "GET" && url.pathname === "/read/group_members") {
        const groupId = url.searchParams.get("group_id") ?? "";
        if (!this.transport.listGroupMembers) {
          return this.json(res, 501, { error: "listGroupMembers unavailable" });
        }
        const members = await this.transport.listGroupMembers(groupId, {
          refresh: url.searchParams.get("refresh") === "1",
        });
        return this.json(res, 200, { members });
      }

      if (req.method === "GET" && url.pathname === "/read/groups") {
        if (!this.transport.listGroups) {
          return this.json(res, 501, { error: "listGroups unavailable" });
        }
        const groups = await this.transport.listGroups();
        return this.json(res, 200, { groups });
      }

      if (req.method === "POST" && url.pathname === "/read/mentions") {
        const body = (await readJsonBody(req)) as { groupId?: string; candidates?: string[] };
        if (!this.transport.resolveMentionTargets) {
          return this.json(res, 501, { error: "resolveMentionTargets unavailable" });
        }
        const resolved = await this.transport.resolveMentionTargets(body.groupId ?? "", body.candidates ?? []);
        return this.json(res, 200, { resolved });
      }

      if (req.method === "POST" && url.pathname === "/read/identities") {
        const body = (await readJsonBody(req)) as { groupId?: string; candidates?: string[] };
        if (!this.transport.resolveMemberIdentities) {
          return this.json(res, 501, { error: "resolveMemberIdentities unavailable" });
        }
        const identities = await this.transport.resolveMemberIdentities(body.groupId ?? "", body.candidates ?? []);
        return this.json(res, 200, { identities });
      }

      if (req.method === "POST" && url.pathname === "/read/images") {
        const body = (await readJsonBody(req)) as { images?: MessageImageInput[] };
        if (!this.transport.resolveImageInputs) {
          return this.json(res, 501, { error: "resolveImageInputs unavailable" });
        }
        const resolved = await this.transport.resolveImageInputs(body.images ?? []);
        return this.json(res, 200, { images: resolved });
      }

      return this.json(res, 404, { error: "not found" });
    } catch (error) {
      if (error instanceof IngressReadApiRequestError) {
        return this.json(res, error.statusCode, { error: error.code });
      }
      logWarn("Ingress read API request failed.", {
        path: url.pathname,
        error: error instanceof Error ? error.message : String(error),
      });
      return this.json(res, 500, { error: "read_api_failed" });
    }
  }

  private isAuthorized(req: IncomingMessage): boolean {
    const authorization = req.headers.authorization;
    if (typeof authorization !== "string") return false;
    const expected = Buffer.from(`Bearer ${this.token}`, "utf8");
    const actual = Buffer.from(authorization, "utf8");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  private json(res: ServerResponse, status: number, data: unknown): void {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(data));
  }
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const contentLength = req.headers["content-length"];
  if (typeof contentLength === "string" && contentLength.trim()) {
    const declaredLength = Number(contentLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) {
      throw new IngressReadApiRequestError("invalid_json_body", 400);
    }
    if (declaredLength > MAX_READ_API_BODY_BYTES) {
      req.resume();
      throw new IngressReadApiRequestError("request_body_too_large", 413);
    }
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_READ_API_BODY_BYTES) {
      req.resume();
      throw new IngressReadApiRequestError("request_body_too_large", 413);
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new IngressReadApiRequestError("invalid_json_body", 400);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof IngressReadApiRequestError) throw error;
    throw new IngressReadApiRequestError("invalid_json", 400);
  }
}

/** Typed client for the worker side. */
export class IngressReadApiClient {
  private readonly authorizationHeader: string;

  constructor(
    private readonly baseUrl: string,
    token: string,
  ) {
    if (!token.trim()) {
      throw new Error("Ingress read API client requires a non-empty bearer token.");
    }
    this.authorizationHeader = `Bearer ${token}`;
  }

  async getHealth(): Promise<{ ok: boolean; detail: string }> {
    try {
      const response = await fetch(`${this.baseUrl}/read/health`, this.withAuthorization({ signal: AbortSignal.timeout(5_000) }));
      if (!response.ok) {
        return { ok: false, detail: `health endpoint ${response.status}` };
      }
      const body = (await response.json()) as { ok?: boolean; detail?: string };
      return { ok: body.ok !== false, detail: body.detail ?? "" };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  async getMessage(messageId: string): Promise<ReferencedMessage | undefined> {
    const response = await this.safeFetch(`${this.baseUrl}/read/get_msg?message_id=${encodeURIComponent(messageId)}`);
    if (!response) {
      return undefined;
    }
    const body = (await response.json()) as { message?: ReferencedMessage | null };
    return body.message ?? undefined;
  }

  async listGroupMembers(groupId: string, options?: { refresh?: boolean }): Promise<Array<{ user_id: number; nickname?: string; card?: string; role?: string }>> {
    const query = new URLSearchParams({ group_id: groupId });
    if (options?.refresh) query.set("refresh", "1");
    const response = await this.safeFetch(`${this.baseUrl}/read/group_members?${query.toString()}`);
    if (!response) {
      return [];
    }
    const body = (await response.json()) as { members?: Array<{ user_id: number; nickname?: string; card?: string; role?: string }> };
    return body.members ?? [];
  }

  /**
   * Admin member management must distinguish a genuinely empty group from an
   * unavailable ingress or NapCat directory. Worker reads keep the forgiving
   * method above so transient ingress restarts do not interrupt conversation.
   */
  async listGroupMembersStrict(groupId: string): Promise<Array<{ user_id: number; nickname?: string; card?: string; role?: string }>> {
    try {
      const response = await this.fetchRequired(`${this.baseUrl}/read/group_members?group_id=${encodeURIComponent(groupId)}`);
      const body = (await response.json()) as { members?: unknown };
      if (!Array.isArray(body.members)) {
        throw new IngressReadApiUnavailableError();
      }
      return body.members as Array<{ user_id: number; nickname?: string; card?: string; role?: string }>;
    } catch (error) {
      if (error instanceof IngressReadApiUnavailableError) {
        throw error;
      }
      throw new IngressReadApiUnavailableError();
    }
  }

  async listGroups(): Promise<Array<{ group_id: number; group_name?: string }>> {
    const response = await this.safeFetch(`${this.baseUrl}/read/groups`);
    if (!response) {
      return [];
    }
    const body = (await response.json()) as { groups?: Array<{ group_id: number; group_name?: string }> };
    return body.groups ?? [];
  }

  async resolveImages(images: MessageImageInput[]): Promise<MessageImageInput[]> {
    const response = await this.safeFetch(`${this.baseUrl}/read/images`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ images }),
    });
    if (!response) {
      return [];
    }
    const body = (await response.json()) as { images?: MessageImageInput[] };
    return body.images ?? [];
  }

  async resolveMentionTargets(groupId: string, candidates: string[]): Promise<string[]> {
    const response = await this.safeFetch(`${this.baseUrl}/read/mentions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ groupId, candidates }),
    });
    if (!response) {
      return candidates.filter((candidate) => /^\d+$/.test(candidate));
    }
    const body = (await response.json()) as { resolved?: string[] };
    return body.resolved ?? [];
  }

  async resolveMemberIdentities(groupId: string, candidates: string[]): Promise<Array<{ userId: string; names: string[] }>> {
    const response = await this.safeFetch(`${this.baseUrl}/read/identities`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ groupId, candidates }),
    });
    if (!response) {
      return [];
    }
    const body = (await response.json()) as { identities?: Array<{ userId: string; names: string[] }> };
    return body.identities ?? [];
  }

  /** Wraps fetch so a down ingress (e.g. during rolling restart) degrades instead of throwing. */
  private async safeFetch(
    url: string,
    init?: RequestInit,
  ): Promise<Response | undefined> {
    try {
      const response = await fetch(url, this.withAuthorization({ ...init, signal: AbortSignal.timeout(5_000) }));
      return response.ok ? response : undefined;
    } catch {
      return undefined;
    }
  }

  private async fetchRequired(url: string, init?: RequestInit): Promise<Response> {
    try {
      const response = await fetch(url, this.withAuthorization({ ...init, signal: AbortSignal.timeout(5_000) }));
      if (!response.ok) {
        throw new IngressReadApiUnavailableError();
      }
      return response;
    } catch (error) {
      if (error instanceof IngressReadApiUnavailableError) {
        throw error;
      }
      throw new IngressReadApiUnavailableError();
    }
  }

  private withAuthorization(init: RequestInit = {}): RequestInit {
    const headers = new Headers(init.headers);
    headers.set("authorization", this.authorizationHeader);
    return { ...init, headers };
  }
}
