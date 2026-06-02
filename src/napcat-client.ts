import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket, { type RawData } from "ws";

import { logError, logInfo, logWarn } from "./logger.js";
import type { TransportHealthStatus } from "./bot.js";
import type {
  MessageImageInput,
  MessageSegment,
  NapcatGroupMember,
  NapcatGroupMessageEvent,
  GroupMemberIdentity,
  ReferencedMessage,
} from "./types.js";
import { resolveMentionTargetsFromMembers } from "./utils/mention-resolver.js";
import { extractImagesFromMessage, extractTextFromMessage } from "./utils/message-parser.js";

interface NapCatClientOptions {
  wsUrl: string;
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

export class NapCatClient extends EventEmitter<{ groupMessage: [NapcatGroupMessageEvent] }> {
  private socket?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private readonly httpBaseUrl: string;
  private readonly aiCharacterCache = new Map<string, string>();
  private readonly groupMemberCache = new Map<
    string,
    { expiresAt: number; members: NapcatGroupMember[] }
  >();
  private manuallyClosed = false;

  constructor(private readonly options: NapCatClientOptions) {
    super();
    this.httpBaseUrl = deriveHttpBaseUrl(options.wsUrl);
  }

  connect(): void {
    this.manuallyClosed = false;
    const headers: Record<string, string> = {};

    if (this.options.accessToken) {
      headers.Authorization = `Bearer ${this.options.accessToken}`;
    }

    this.socket = new WebSocket(this.options.wsUrl, { headers });

    this.socket.on("open", () => {
      logInfo("Connected to NapCat WebSocket.");
    });

    this.socket.on("message", (data: RawData) => {
      this.handleMessage(data.toString());
    });

    this.socket.on("close", () => {
      logWarn("NapCat WebSocket closed. Scheduling reconnect.");
      if (!this.manuallyClosed) {
        this.scheduleReconnect();
      }
    });

    this.socket.on("error", (error: Error) => {
      logError("NapCat WebSocket error.", {
        error: error.message,
      });
    });
  }

  start(): void {
    this.connect();
  }

  close(): void {
    this.manuallyClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    this.socket?.close();
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
    const data = await this.callHttpAction<NapCatGetMessageResponse>("get_msg", {
      message_id: Number(messageId),
    });
    return toReferencedMessage(messageId, data);
  }

  async resolveImageInputs(images: MessageImageInput[]): Promise<MessageImageInput[]> {
    const resolved = await Promise.all(images.map((image) => this.resolveImageInput(image)));
    return resolved.filter((image): image is MessageImageInput => Boolean(image?.url));
  }

  async getHealthStatus(): Promise<TransportHealthStatus> {
    return {
      ok: this.isSocketOpen(),
      detail: this.isSocketOpen() ? "WebSocket 已连接" : "WebSocket 未连接",
    };
  }

  private handleMessage(raw: string): void {
    try {
      const parsed = JSON.parse(raw) as Partial<NapcatGroupMessageEvent>;
      if (parsed.post_type !== "message" || parsed.message_type !== "group") {
        return;
      }

      this.emit("groupMessage", parsed as NapcatGroupMessageEvent);
    } catch (error) {
      logWarn("Failed to parse NapCat event.", {
        raw,
        error: (error as Error).message,
      });
    }
  }

  private isSocketOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  private async resolveImageInput(image: MessageImageInput): Promise<MessageImageInput | undefined> {
    if (image.url && isUsableImageUrl(image.url)) {
      return image;
    }

    if (image.file && isUsableImageUrl(image.file)) {
      return { ...image, url: image.file };
    }

    if (!image.file) {
      return undefined;
    }

    try {
      const payload = await this.callHttpAction<{ file?: string; path?: string; url?: string }>(
        "get_image",
        {
          file: image.file,
        },
      );

      if (payload.url && isUsableImageUrl(payload.url)) {
        return { ...image, url: payload.url };
      }

      const localPath = payload.path ?? payload.file;
      if (localPath) {
        const dataUrl = await toDataUrl(localPath);
        return { ...image, url: dataUrl };
      }
    } catch (error) {
      logWarn("Failed to resolve image through NapCat get_image.", {
        file: image.file,
        error: (error as Error).message,
      });
    }

    return undefined;
  }

  private async getAiCharacter(groupId: string): Promise<string> {
    const cached = this.aiCharacterCache.get(groupId);
    if (cached) {
      return cached;
    }

    const data = await this.callHttpAction<unknown>("get_ai_characters", {
      group_id: Number(groupId),
    });
    const character = pickFirstAiCharacter(data);
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

    const members = await this.callHttpAction<NapcatGroupMember[]>("get_group_member_list", {
      group_id: Number(groupId),
      no_cache: false,
    });

    this.groupMemberCache.set(groupId, {
      members,
      expiresAt: Date.now() + 30_000,
    });
    return members;
  }

  private async dispatchAction(action: string, payload: Record<string, unknown>): Promise<void> {
    if (this.isSocketOpen()) {
      this.socket?.send(
        JSON.stringify({
          action,
          params: payload,
        } satisfies OutgoingAction<typeof payload>),
      );
      return;
    }

    await this.callHttpAction(action, payload);
  }

  private async callHttpAction<TData>(action: string, payload: Record<string, unknown>): Promise<TData> {
    const response = await fetch(`${this.httpBaseUrl}/${action}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.options.accessToken
          ? { Authorization: `Bearer ${this.options.accessToken}` }
          : {}),
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`NapCat HTTP ${action} failed with status ${response.status}`);
    }

    const json = (await response.json()) as NapCatActionResponse<TData> | TData;

    if ("retcode" in (json as Record<string, unknown>) && (json as { retcode?: number }).retcode) {
      throw new Error(
        `NapCat action ${action} returned retcode ${(json as { retcode?: number }).retcode}`,
      );
    }

    if ("data" in (json as Record<string, unknown>) && (json as { data?: TData }).data) {
      return (json as { data: TData }).data;
    }

    return json as TData;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      logInfo("Reconnecting to NapCat WebSocket.");
      this.connect();
    }, 5000);
  }
}

function deriveHttpBaseUrl(wsUrl: string): string {
  const url = new URL(wsUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function isUsableImageUrl(value: string): boolean {
  return /^(https?:\/\/|data:image\/)/i.test(value);
}

async function toDataUrl(filePath: string): Promise<string> {
  const normalizedPath = filePath.startsWith("file:///")
    ? fileURLToPath(filePath)
    : filePath.replace(/^file:\/\//i, "");
  const buffer = await readFile(normalizedPath);
  const mimeType = inferMimeType(normalizedPath);
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

function inferMimeType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();

  switch (extension) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".bmp":
      return "image/bmp";
    default:
      return "application/octet-stream";
  }
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
