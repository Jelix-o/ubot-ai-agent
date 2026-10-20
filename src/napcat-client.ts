import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import WebSocket, { type RawData } from "ws";

import { logError, logInfo, logWarn } from "./logger.js";
import { withReplyReference } from "./utils/reply-reference.js";
import { toNapCatForwardNodes, type ForwardMessageNode } from "./forward-message.js";
import { NapCatActionNotSentError, NapCatActionRejectedError, NapCatActionOutcomeUnknownError, napCatActionFailure } from "./napcat-action-errors.js";
import type { ForwardAutoRecallOptions, TransportHealthStatus } from "./bot.js";
import type {
  MessageImageInput,
  MessageSegment,
  NapcatGroupInfo,
  NapcatGroupMember,
  NapcatGroupMessageEvent,
  GroupMemberIdentity,
  ReferencedMessage,
} from "./types.js";
import { resolveMentionTargetsFromMembers } from "./utils/mention-resolver.js";
import { extractImagesFromMessage, extractTextFromMessage } from "./utils/message-parser.js";
import {
  downloadImageAsDataUrl,
  isHttpUrl,
  isImageDataUrl,
  readImageFileAsDataUrl,
} from "./utils/image-data-url.js";

interface NapCatClientOptions {
  wsUrl: string;
  accessToken?: string;
  actionTimeoutMs?: number;
}

interface OutgoingAction<TParams> {
  action: string;
  params: TParams;
  echo?: string;
}

interface NapCatActionResponse<TData = unknown> {
  status?: string;
  retcode?: number;
  message?: string;
  wording?: string;
  data?: TData;
  echo?: string;
}

interface NapCatGetMessageResponse {
  message_id?: number | string;
  group_id?: number | string;
  sender?: {
    user_id?: number | string;
    nickname?: string;
    card?: string;
  };
  message?: MessageSegment[] | string;
  raw_message?: string;
}

interface NapCatSendMessageResponse {
  message_id?: number | string;
}

const GROUP_MEMBER_CACHE_TTL_MS = 10 * 60 * 1000;

export class NapCatClient extends EventEmitter<{
  groupMessage: [NapcatGroupMessageEvent];
  groupRecall: [unknown];
}> {
  private socket?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private readonly httpBaseUrl: string;
  private readonly groupMemberCache = new Map<
    string,
    { expiresAt: number; members: NapcatGroupMember[] }
  >();
  private readonly groupMemberRequests = new Map<string, Promise<NapcatGroupMember[]>>();
  private readonly pendingActions = new Map<
    string,
    {
      resolve: (data: unknown) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
      action: string;
    }
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
      this.rejectPendingActions(new NapCatActionOutcomeUnknownError("NapCat WebSocket closed."));
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
    this.rejectPendingActions(new NapCatActionOutcomeUnknownError("NapCat client stopped."));
    this.socket?.close();
  }

  async sendGroupMessage(groupId: string, text: string, options?: { replyToMessageId?: string }): Promise<{ messageId?: string } | undefined> {
    const data = await this.callAction<NapCatSendMessageResponse>("send_group_msg", {
      group_id: Number(groupId),
      message: withReplyReference(text, options?.replyToMessageId),
    });
    return toMessageReceipt(data);
  }

  async sendGroupForwardMessage(groupId: string, nodes: ForwardMessageNode[], _options?: ForwardAutoRecallOptions) {
    const data = await this.callAction<NapCatSendMessageResponse>("send_group_forward_msg", {
      group_id: Number(groupId), messages: toNapCatForwardNodes(nodes),
    });
    const receipt = toMessageReceipt(data);
    if (!receipt?.platformMessageId?.trim()) throw new NapCatActionOutcomeUnknownError("Forward send succeeded without a message id");
    return receipt;
  }

  async deleteMessage(messageId: string): Promise<void> {
    await this.callAction("delete_msg", { message_id: messageId });
  }

  async sendGroupImage(groupId: string, imageFile: string): Promise<{ messageId?: string } | undefined> {
    const data = await this.callAction<NapCatSendMessageResponse>("send_group_msg", {
      group_id: Number(groupId),
      message: [
        {
          type: "image",
          data: {
            file: imageFile,
          },
        },
      ],
    });
    return toMessageReceipt(data);
  }

  async resolveMentionTargets(groupId: string, candidates: string[]): Promise<string[]> {
    const members = await this.getGroupMembers(groupId);
    return resolveMentionTargetsFromMembers(members, candidates);
  }

  async listGroupMembers(groupId: string, options?: { refresh?: boolean }): Promise<NapcatGroupMember[]> {
    return this.getGroupMembers(groupId, options?.refresh === true);
  }

  async listGroups(): Promise<NapcatGroupInfo[]> {
    const groups = await this.callHttpAction<NapcatGroupInfo[]>("get_group_list", {});
    return Array.isArray(groups) ? groups : [];
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
      const parsed = JSON.parse(raw) as Record<string, unknown> & NapCatActionResponse<unknown>;
      if (parsed.echo && this.pendingActions.has(parsed.echo)) {
        const pending = this.pendingActions.get(parsed.echo);
        if (!pending) {
          return;
        }
        clearTimeout(pending.timer);
        this.pendingActions.delete(parsed.echo);
        if (parsed.retcode || parsed.status === "failed") {
          pending.reject(napCatActionFailure(pending.action, parsed));
        } else {
          pending.resolve(parsed.data);
        }
        return;
      }
      if (parsed.post_type === "notice" && parsed.notice_type === "group_recall") {
        this.emit("groupRecall", parsed);
        return;
      }
      if (parsed.post_type !== "message" || parsed.message_type !== "group") {
        return;
      }

      this.emit("groupMessage", parsed as unknown as NapcatGroupMessageEvent);
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
    if (isImageDataUrl(image.url)) {
      return image;
    }

    const sourceUrl = isHttpUrl(image.url) ? image.url : isHttpUrl(image.file) ? image.file : undefined;
    if (sourceUrl) {
      try {
        return { ...image, url: await downloadImageAsDataUrl(sourceUrl) };
      } catch (error) {
        logWarn("Failed to materialize image URL through the proxy; falling back to NapCat get_image.", {
          error: (error as Error).message,
        });
      }
    }

    if (image.file && !isHttpUrl(image.file)) {
      try {
        const payload = await this.callHttpAction<{ file?: string; path?: string; url?: string }>(
          "get_image",
          {
            file: image.file,
          },
        );
        const localPath = payload.path ?? payload.file;
        if (localPath) {
          try {
            return { ...image, url: await readImageFileAsDataUrl(localPath) };
          } catch {
            // The path can belong to a remote NapCat host. Fall through to its URL.
          }
        }
        if (isHttpUrl(payload.url)) {
          return { ...image, url: await downloadImageAsDataUrl(payload.url) };
        }
      } catch (error) {
        logWarn("Failed to resolve image through NapCat get_image.", {
          error: (error as Error).message,
        });
      }
    }

    if (image.file) {
      logWarn("Failed to resolve image through NapCat get_image.", {
        error: "No usable local image data or URL was returned.",
      });
    }

    return undefined;
  }

  private async getGroupMembers(groupId: string, refresh = false): Promise<NapcatGroupMember[]> {
    if (refresh) {
      const members = await this.callHttpAction<NapcatGroupMember[]>("get_group_member_list", {
        group_id: Number(groupId),
        no_cache: true,
      });
      return Array.isArray(members) ? members : [];
    }
    const cached = this.groupMemberCache.get(groupId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.members;
    }

    const pending = this.groupMemberRequests.get(groupId);
    if (pending) {
      return pending;
    }

    const request = this.callHttpAction<NapcatGroupMember[]>("get_group_member_list", {
      group_id: Number(groupId),
      no_cache: false,
    }).then((members) => {
      this.groupMemberCache.set(groupId, {
        members,
        expiresAt: Date.now() + GROUP_MEMBER_CACHE_TTL_MS,
      });
      return members;
    });
    this.groupMemberRequests.set(groupId, request);
    try {
      return await request;
    } finally {
      if (this.groupMemberRequests.get(groupId) === request) {
        this.groupMemberRequests.delete(groupId);
      }
    }
  }

  private async callAction<TData>(action: string, payload: Record<string, unknown>): Promise<TData> {
    if (this.isSocketOpen()) {
      return this.callWebSocketAction<TData>(action, payload);
    }

    return this.callHttpAction<TData>(action, payload);
  }

  private async callWebSocketAction<TData>(action: string, payload: Record<string, unknown>): Promise<TData> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new NapCatActionNotSentError("NapCat WebSocket is not connected.");
    }
    const echo = randomUUID();
    return new Promise<TData>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingActions.delete(echo);
        reject(new NapCatActionOutcomeUnknownError(`NapCat action ${action} timed out.`));
      }, this.options.actionTimeoutMs ?? 10_000);
      this.pendingActions.set(echo, {
        action,
        resolve: (data) => resolve(data as TData),
        reject,
        timer,
      });
      try {
        socket.send(JSON.stringify({ action, params: payload, echo } satisfies OutgoingAction<typeof payload>), error => {
          if (!error) return;
          const pending = this.pendingActions.get(echo);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.pendingActions.delete(echo);
          pending.reject(new NapCatActionOutcomeUnknownError(`NapCat action ${action} could not be confirmed`));
        });
      } catch {
        clearTimeout(timer);
        this.pendingActions.delete(echo);
        reject(new NapCatActionOutcomeUnknownError(`NapCat action ${action} dispatch outcome is unknown`));
      }
    });
  }

  private async callHttpAction<TData>(action: string, payload: Record<string, unknown>): Promise<TData> {
    const deliveryAction = action === "send_group_forward_msg" || action === "delete_msg";
    let response: Response;
    try { response = await fetch(`${this.httpBaseUrl}/${action}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.options.accessToken
          ? { Authorization: `Bearer ${this.options.accessToken}` }
          : {}),
      },
      body: JSON.stringify(payload),
      ...(deliveryAction ? { signal: AbortSignal.timeout(this.options.actionTimeoutMs ?? 10_000) } : {}),
    }); } catch (error) {
      if (deliveryAction) throw new NapCatActionOutcomeUnknownError(`NapCat ${action} HTTP dispatch outcome is unknown`);
      throw error;
    }

    if (!response.ok) {
      if (deliveryAction) {
        if ([400, 401, 403, 404, 405, 422].includes(response.status)) throw new NapCatActionRejectedError(`NapCat ${action} HTTP rejected with status ${response.status}`);
        throw new NapCatActionOutcomeUnknownError(`NapCat ${action} HTTP returned status ${response.status}`);
      }
      throw new Error(`NapCat HTTP ${action} failed with status ${response.status}`);
    }

    let json: NapCatActionResponse<TData> | TData;
    try { json = await response.json(); } catch (error) {
      if (deliveryAction) throw new NapCatActionOutcomeUnknownError(`NapCat ${action} HTTP response could not be decoded`);
      throw error;
    }
    if (deliveryAction && (!json || typeof json !== "object")) throw new NapCatActionOutcomeUnknownError(`NapCat ${action} HTTP response is invalid`);

    if ((json as NapCatActionResponse).retcode || (json as NapCatActionResponse).status === "failed") {
      throw napCatActionFailure(action, json as NapCatActionResponse);
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

  private rejectPendingActions(error: Error): void {
    for (const [echo, pending] of this.pendingActions.entries()) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pendingActions.delete(echo);
    }
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
    ...(data.group_id !== undefined ? { groupId: String(data.group_id) } : {}),
    userId,
    userName: card || nickname || userId,
    text: extractTextFromMessage(message),
    images: extractImagesFromMessage(message),
  };
}

function toMessageReceipt(data: NapCatSendMessageResponse | undefined): { messageId?: string; platformMessageId?: string } | undefined {
  if (data?.message_id === undefined || data.message_id === null) {
    return undefined;
  }
  const platformMessageId = String(data.message_id);
  return { messageId: platformMessageId, platformMessageId };
}
