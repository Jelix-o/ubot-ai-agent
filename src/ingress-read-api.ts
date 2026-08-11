import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { logWarn } from "./logger.js";
import type { MessageTransport } from "./bot.js";
import type { MessageImageInput, ReferencedMessage } from "./types.js";

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
  private readonly server = createServer((req, res) => {
    void this.handle(req, res);
  });

  constructor(
    private readonly transport: MessageTransport,
    private readonly port: number,
    private readonly host = "127.0.0.1",
  ) {}

  start(): void {
    this.server.listen(this.port, this.host);
  }

  close(): void {
    this.server.close();
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
        const members = await this.transport.listGroupMembers(groupId);
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
      logWarn("Ingress read API request failed.", {
        path: url.pathname,
        error: error instanceof Error ? error.message : String(error),
      });
      return this.json(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private json(res: ServerResponse, status: number, data: unknown): void {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(data));
  }
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

/** Typed client for the worker side. */
export class IngressReadApiClient {
  constructor(private readonly baseUrl: string) {}

  async getHealth(): Promise<{ ok: boolean; detail: string }> {
    try {
      const response = await fetch(`${this.baseUrl}/read/health`);
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

  async listGroupMembers(groupId: string): Promise<Array<{ user_id: number; nickname?: string; card?: string; role?: string }>> {
    const response = await this.safeFetch(`${this.baseUrl}/read/group_members?group_id=${encodeURIComponent(groupId)}`);
    if (!response) {
      return [];
    }
    const body = (await response.json()) as { members?: Array<{ user_id: number; nickname?: string; card?: string; role?: string }> };
    return body.members ?? [];
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
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(5_000) });
      return response.ok ? response : undefined;
    } catch {
      return undefined;
    }
  }
}
