import { createServer, type IncomingMessage } from "node:http";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import WebSocket, { RawData, WebSocketServer } from "ws";

import { logInfo, logWarn } from "./logger.js";
import type { TransportHealthStatus } from "./bot.js";
import type {
  GroupMemberIdentity,
  MessageSegment,
  NapcatGroupInfo,
  NapcatGroupMember,
  NapcatGroupMessageEvent,
  ReferencedMessage,
} from "./types.js";
import { resolveMentionTargetsFromMembers } from "./utils/mention-resolver.js";
import { extractImagesFromMessage, extractTextFromMessage } from "./utils/message-parser.js";

interface NapCatReverseServerOptions {
  host: string;
  port: number;
  path: string;
  accessToken?: string;
}

interface OutgoingAction<TParams> {
  action: string;
  params: TParams;
  echo?: string;
}

interface NapCatActionResponse<TData = unknown> {
  status?: string;
  retcode?: number;
  data?: TData;
  echo?: string;
}

interface NapCatGetMessageResponse {
  message_id?: number | string;
  sender?: {
    user_id?: number | string;
    nickname?: string;
    card?: string;
  };
  message?: MessageSegment[] | string;
  raw_message?: string;
}

export class NapCatReverseServer extends EventEmitter<{ groupMessage: [NapcatGroupMessageEvent] }> {
  private readonly httpServer = createServer((_req, res) => {
    res.statusCode = 200;
    res.end("NapCat reverse ws server is running.");
  });

  private readonly wsServer = new WebSocketServer({ noServer: true });
  private activeSocket?: WebSocket;
  private readonly pendingActions = new Map<
    string,
    {
      resolve: (response: NapCatActionResponse<unknown>) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private readonly aiCharacterCache = new Map<string, string>();
  private readonly groupMemberCache = new Map<
    string,
    { expiresAt: number; members: NapcatGroupMember[] }
  >();

  constructor(private readonly options: NapCatReverseServerOptions) {
    super();
  }

  start(): void {
    this.httpServer.on("upgrade", (req, socket, head) => {
      const pathname = extractPathname(req);
      if (pathname !== this.options.path) {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
      }

      if (!this.isAuthorized(req)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      this.wsServer.handleUpgrade(req, socket, head, (ws) => {
        this.wsServer.emit("connection", ws, req);
      });
    });

    this.wsServer.on("connection", (ws) => {
      this.activeSocket = ws;
      logInfo("NapCat reverse WebSocket connected.");

      ws.on("message", (data: RawData) => this.handleIncomingMessage(data.toString()));
      ws.on("close", () => {
        if (this.activeSocket === ws) {
          this.activeSocket = undefined;
        }
        this.rejectPendingActions(new Error("NapCat reverse WebSocket closed."));
        logWarn("NapCat reverse WebSocket closed.");
      });
    });

    this.httpServer.listen(this.options.port, this.options.host, () => {
      logInfo("NapCat reverse WebSocket server listening.", {
        host: this.options.host,
        port: this.options.port,
        path: this.options.path,
      });
    });
  }

  close(): void {
    this.rejectPendingActions(new Error("NapCat reverse WebSocket server stopped."));
    this.activeSocket?.close();
    this.wsServer.close();
    this.httpServer.close();
  }

  async sendGroupMessage(groupId: string, text: string): Promise<void> {
    await this.dispatchAction("send_group_msg", {
      group_id: Number(groupId),
      message: text,
    });
  }

  async sendGroupRecord(groupId: string, recordFile: string): Promise<void> {
    await this.dispatchAction("send_group_msg", {
      group_id: Number(groupId),
      message: [
        {
          type: "record",
          data: {
            file: normalizeNapCatRecordFile(recordFile),
          },
        },
      ],
    });
  }

  async sendGroupAiRecord(groupId: string, text: string): Promise<void> {
    const character = await this.getAiCharacter(groupId);
    await this.dispatchAction("send_group_ai_record", {
      group_id: Number(groupId),
      character,
      text,
    });
  }

  async resolveMentionTargets(groupId: string, candidates: string[]): Promise<string[]> {
    const members = await this.getGroupMembers(groupId);
    return resolveMentionTargetsFromMembers(members, candidates);
  }

  async listGroupMembers(groupId: string): Promise<NapcatGroupMember[]> {
    return this.getGroupMembers(groupId);
  }

  async listGroups(): Promise<NapcatGroupInfo[]> {
    const response = await this.callAction<NapcatGroupInfo[]>("get_group_list", {});
    return Array.isArray(response.data) ? response.data : [];
  }

  async resolveMemberIdentities(
    groupId: string,
    candidates: string[],
  ): Promise<GroupMemberIdentity[]> {
    const members = await this.getGroupMembers(groupId);
    const userIds = new Set(resolveMentionTargetsFromMembers(members, candidates));
    return members
      .filter((member) => userIds.has(String(member.user_id)))
      .map((member) => ({
        userId: String(member.user_id),
        names: [member.card?.trim(), member.nickname?.trim(), String(member.user_id)].filter(
          (name): name is string => Boolean(name),
        ),
      }));
  }

  async getMessage(messageId: string): Promise<ReferencedMessage | undefined> {
    const response = await this.callAction<NapCatGetMessageResponse>("get_msg", {
      message_id: Number(messageId),
    });
    return toReferencedMessage(messageId, response.data);
  }

  async getHealthStatus(): Promise<TransportHealthStatus> {
    const connected = this.activeSocket?.readyState === WebSocket.OPEN;
    return {
      ok: connected,
      detail: connected
        ? `反向 WebSocket 已连接，监听 ${this.options.host}:${this.options.port}${this.options.path}`
        : `反向 WebSocket 未连接，监听 ${this.options.host}:${this.options.port}${this.options.path}`,
    };
  }

  private handleIncomingMessage(raw: string): void {
    try {
      const parsed = JSON.parse(raw) as Partial<NapcatGroupMessageEvent> & NapCatActionResponse<unknown>;
      if (parsed.echo && this.pendingActions.has(parsed.echo)) {
        const pending = this.pendingActions.get(parsed.echo);
        if (!pending) {
          return;
        }

        clearTimeout(pending.timer);
        this.pendingActions.delete(parsed.echo);
        if (parsed.retcode) {
          pending.reject(
            new Error(`NapCat action failed with retcode ${parsed.retcode} (${parsed.status ?? "unknown"})`),
          );
        } else {
          pending.resolve(parsed);
        }
        return;
      }

      if (parsed.post_type !== "message" || parsed.message_type !== "group") {
        return;
      }

      this.emit("groupMessage", parsed as NapcatGroupMessageEvent);
    } catch {
      logWarn("Failed to parse reverse WebSocket event.");
    }
  }

  private isAuthorized(req: IncomingMessage): boolean {
    const expected = this.options.accessToken?.trim();
    if (!expected) {
      return true;
    }

    const authHeader = req.headers.authorization;
    if (authHeader) {
      const normalized = authHeader.replace(/^Bearer\s+/i, "").trim();
      if (normalized === expected) {
        return true;
      }
    }

    return false;
  }

  private async getAiCharacter(groupId: string): Promise<string> {
    const cached = this.aiCharacterCache.get(groupId);
    if (cached) {
      return cached;
    }

    const response = await this.callAction<unknown>("get_ai_characters", {
      group_id: Number(groupId),
    });
    const character = pickFirstAiCharacter(response.data);
    if (!character) {
      throw new Error("NapCat get_ai_characters did not return any available character.");
    }

    this.aiCharacterCache.set(groupId, character);
    return character;
  }

  private async getGroupMembers(groupId: string): Promise<NapcatGroupMember[]> {
    const cached = this.groupMemberCache.get(groupId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.members;
    }

    const response = await this.callAction<NapcatGroupMember[]>("get_group_member_list", {
      group_id: Number(groupId),
      no_cache: false,
    });
    const members = Array.isArray(response.data) ? response.data : [];

    this.groupMemberCache.set(groupId, {
      members,
      expiresAt: Date.now() + 30_000,
    });
    return members;
  }

  private async dispatchAction(action: string, payload: Record<string, unknown>): Promise<void> {
    const socket = this.ensureSocketOpen();
    socket.send(
      JSON.stringify({
        action,
        params: payload,
      } satisfies OutgoingAction<typeof payload>),
    );
  }

  private async callAction<TData>(
    action: string,
    payload: Record<string, unknown>,
  ): Promise<NapCatActionResponse<TData>> {
    const socket = this.ensureSocketOpen();
    const echo = randomUUID();

    return new Promise<NapCatActionResponse<TData>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingActions.delete(echo);
        reject(new Error(`NapCat action ${action} timed out.`));
      }, 10000);

      this.pendingActions.set(echo, {
        resolve: (response) => resolve(response as NapCatActionResponse<TData>),
        reject,
        timer,
      });

      socket.send(
        JSON.stringify({
          action,
          params: payload,
          echo,
        } satisfies OutgoingAction<typeof payload>),
      );
    });
  }

  private ensureSocketOpen(): WebSocket {
    if (!this.activeSocket || this.activeSocket.readyState !== WebSocket.OPEN) {
      throw new Error("NapCat reverse WebSocket is not connected.");
    }

    return this.activeSocket;
  }

  private rejectPendingActions(error: Error): void {
    for (const [echo, pending] of this.pendingActions.entries()) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pendingActions.delete(echo);
    }
  }
}

function extractPathname(req: IncomingMessage): string {
  const reqUrl = req.url ?? "/";
  return new URL(reqUrl, "http://localhost").pathname;
}

function pickFirstAiCharacter(data: unknown): string | undefined {
  if (!Array.isArray(data)) {
    return undefined;
  }

  for (const item of data) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const characters = (item as { characters?: unknown }).characters;
    if (!Array.isArray(characters)) {
      continue;
    }

    for (const character of characters) {
      if (!character || typeof character !== "object") {
        continue;
      }

      const characterId = (character as { character_id?: unknown }).character_id;
      if (typeof characterId === "string" && characterId) {
        return characterId;
      }
    }
  }

  return undefined;
}

function normalizeNapCatRecordFile(recordFile: string): string {
  if (/^(base64:\/\/|https?:\/\/|file:\/\/)/i.test(recordFile)) {
    return recordFile;
  }

  return recordFile.replace(/\\/g, "/");
}

function toReferencedMessage(
  fallbackMessageId: string,
  data: NapCatGetMessageResponse | undefined,
): ReferencedMessage | undefined {
  if (!data) {
    return undefined;
  }

  const message = data.message ?? data.raw_message ?? "";
  const userId = data.sender?.user_id === undefined ? undefined : String(data.sender.user_id);
  const card = data.sender?.card?.trim();
  const nickname = data.sender?.nickname?.trim();

  return {
    messageId: String(data.message_id ?? fallbackMessageId),
    userId,
    userName: card || nickname || userId,
    text: extractTextFromMessage(message),
    images: extractImagesFromMessage(message),
  };
}
