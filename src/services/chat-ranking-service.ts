import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { MessageTransport } from "../bot.js";
import { logWarn } from "../logger.js";
import type { OutboxRow } from "../shared/sqlite.js";
import type { GroupBotConfig, NapcatGroupMember } from "../types.js";
import { beijingDateKey } from "../utils/beijing-calendar.js";
import { normalizeCommandPermission, permissionAtLeast } from "./command-permissions.js";
import { V3CapabilityPolicyService } from "./capability-policy-service.js";
import type { DailyReportStore } from "./daily-report-store.js";
import { renderChatRanking } from "./chat-ranking-renderer.js";
import { buildChatRankingSnapshot, chatRankingText, type ChatRankingSnapshot } from "./chat-ranking-statistics.js";
import { QqAdminAuthorizationService } from "./qq-admin-authorization-service.js";
import type { V3StateRepository } from "./v3-state-repository.js";

export const CHAT_RANKING_DOCUMENT = "chat-ranking";
export const CHAT_RANKING_TTL_MS = 10 * 60_000;
const RETENTION_MS = 24 * 60 * 60_000;
const MAX_BYTES = 10 * 1024 * 1024;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
interface RankingDocument {
  id: string;
  groupId: string;
  userId: string;
  sourceMessageId: string;
  createdAt: number;
  snapshot: ChatRankingSnapshot;
  renderFailed?: boolean;
  textOutboxId?: number;
  imageOutboxId?: number;
}
export interface ChatRankingInput {
  group: GroupBotConfig;
  userId: string;
  sourceMessageId: string;
  members?: readonly NapcatGroupMember[];
  now?: Date;
}

export class ChatRankingService {
  constructor(
    private readonly store: Pick<DailyReportStore, "getSummaryMessages">,
    private readonly root: string,
    private readonly repo?: V3StateRepository,
    private readonly renderer: (snapshot: ChatRankingSnapshot) => Promise<Buffer> = renderChatRanking,
  ) {}

  isRolloutEnabled(groupId: string): boolean {
    const rollout = this.repo?.getDocument<{ allowedGroupIds: string[] } | null>("chat-ranking-rollout", "default", null);
    return !rollout || Array.isArray(rollout.allowedGroupIds) && rollout.allowedGroupIds.includes(groupId);
  }

  private allowed(doc: Pick<RankingDocument, "groupId" | "userId" | "sourceMessageId">): boolean {
    if (!this.repo) return true;
    const group = this.repo.getGroup(doc.groupId);
    if (!group || group.enabled === false || group.blacklistedUserIds?.includes(doc.userId) || !this.isRolloutEnabled(doc.groupId) ||
        !new V3CapabilityPolicyService(this.repo).isEnabled("daily_reports")) return false;
    const source = this.repo.sharedDb.db.prepare("SELECT sender_role FROM messages WHERE group_id=? AND user_id=? AND msg_id=? AND is_bot_msg=0")
      .get(doc.groupId, doc.userId, doc.sourceMessageId) as { sender_role: string | null } | undefined;
    if (!source || this.repo.sharedDb.isRetracted(doc.groupId, doc.sourceMessageId)) return false;
    const command = this.repo.getSystemSettings()?.commands?.find(c => c.id === "chat_ranking");
    if (command?.enabled === false) return false;
    const principal = new QqAdminAuthorizationService(this.repo.sharedDb).resolve(doc.userId, doc.groupId);
    const role = principal?.role === "super_admin" ? "super_admin" : principal || source.sender_role === "owner" || source.sender_role === "admin" ? "group_admin" : "member";
    return permissionAtLeast(role, normalizeCommandPermission("chat_ranking", command?.permission));
  }

  async send(input: ChatRankingInput, transport: MessageTransport): Promise<void> {
    const now = input.now ?? new Date();
    const id = createHash("sha256").update(JSON.stringify([input.group.groupId, input.sourceMessageId])).digest("hex");
    let doc = this.repo?.getDocument<RankingDocument | null>(CHAT_RANKING_DOCUMENT, id, null);
    if (doc?.textOutboxId) return;
    if (!doc) {
      const messages = await this.store.getSummaryMessages(input.group.groupId, beijingDateKey(now), input.sourceMessageId);
      const initial: RankingDocument = { id, groupId: input.group.groupId, userId: input.userId, sourceMessageId: input.sourceMessageId,
        createdAt: now.getTime(), snapshot: buildChatRankingSnapshot({ group: input.group, messages, userId: input.userId, members: input.members, now }) };
      if (!this.allowed(initial)) return;
      doc = this.repo ? this.repo.updateDocument<RankingDocument | null>(CHAT_RANKING_DOCUMENT, id, null, current => current ?? initial, now.getTime()) : initial;
    }
    if (!doc || doc.userId !== input.userId || doc.textOutboxId || Date.now() - doc.createdAt > CHAT_RANKING_TTL_MS) return;
    const imagePath = path.join(this.root, `${id}.png`);
    const temporary = `${imagePath}.tmp-${randomUUID()}`;
    let renderFailed = false;
    try {
      const bytes = await this.renderer(doc.snapshot);
      if (bytes.length > MAX_BYTES || !bytes.subarray(0, 8).equals(PNG)) throw new Error("chat_ranking_invalid_png");
      await mkdir(this.root, { recursive: true });
      await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
      await rename(temporary, imagePath);
    } catch {
      renderFailed = true;
      logWarn("Chat ranking image render failed; preserving text result.");
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
    if (!this.allowed(doc) || Date.now() - doc.createdAt > CHAT_RANKING_TTL_MS) return;
    if (!this.repo) {
      await transport.sendGroupMessage(doc.groupId, chatRankingText(doc.snapshot) + (renderFailed ? "\n图片暂时生成失败，已先发文字榜单。" : ""));
      if (!renderFailed) await transport.sendGroupImage(doc.groupId, `base64://${(await readFile(imagePath)).toString("base64")}`);
      return;
    }
    const repo = this.repo;
    repo.runAtomically(() => {
      const current = repo.getDocument<RankingDocument | null>(CHAT_RANKING_DOCUMENT, id, null);
      if (!current || current.textOutboxId || !this.allowed(current)) return;
      const timing = { batchId: `chat-ranking:${id}`, delayBeforeMs: 0 };
      const textOutboxId = repo.sharedDb.enqueueOutbox(doc!.groupId, null, id, "chat_ranking_text", undefined, undefined, undefined, undefined, timing);
      const imageOutboxId = renderFailed ? undefined : repo.sharedDb.enqueueOutbox(doc!.groupId, null, id, "chat_ranking_image", undefined, undefined, undefined, undefined, timing);
      repo.saveDocument(CHAT_RANKING_DOCUMENT, id, { ...current, renderFailed, textOutboxId, imageOutboxId });
    });
  }

  validate(row: Pick<OutboxRow, "id" | "text" | "group_id" | "kind">, now = Date.now()): RankingDocument {
    if (!/^[a-f0-9]{64}$/u.test(row.text) || !this.repo) throw new Error("chat_ranking_unavailable");
    const doc = this.repo.getDocument<RankingDocument | null>(CHAT_RANKING_DOCUMENT, row.text, null);
    if (!doc || doc.id !== row.text || doc.groupId !== row.group_id || !this.allowed(doc) ||
        (row.kind === "chat_ranking_text" ? doc.textOutboxId : row.kind === "chat_ranking_image" ? doc.imageOutboxId : undefined) !== row.id) throw new Error("chat_ranking_unavailable");
    if (!Number.isFinite(doc.createdAt) || now < doc.createdAt || now - doc.createdAt > CHAT_RANKING_TTL_MS) throw new Error("chat_ranking_expired");
    if (row.kind === "chat_ranking_image") {
      const text = this.repo.sharedDb.db.prepare("SELECT status,platform_message_id FROM outbox WHERE id=? AND group_id=?").get(doc.textOutboxId!, doc.groupId) as { status: string; platform_message_id: string | null } | undefined;
      if (text?.status !== "sent" || !text.platform_message_id) throw new Error("chat_ranking_text_unconfirmed");
    }
    return doc;
  }

  textFor(row: Pick<OutboxRow, "id" | "text" | "group_id" | "kind">, now = Date.now()): string {
    const doc = this.validate(row, now);
    return chatRankingText(doc.snapshot) + (doc.renderFailed ? "\n图片暂时生成失败，已先发文字榜单。" : "");
  }

  async imageFor(row: Pick<OutboxRow, "id" | "text" | "group_id" | "kind">, now = Date.now()): Promise<Buffer> {
    const doc = this.validate(row, now);
    const root = await realpath(this.root), file = path.join(root, `${doc.id}.png`);
    const metadata = await lstat(file);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_BYTES || metadata.size < 8) throw new Error("chat_ranking_image_unavailable");
    const bytes = await readFile(file);
    if (bytes.length > MAX_BYTES || !bytes.subarray(0, 8).equals(PNG)) throw new Error("chat_ranking_image_unavailable");
    this.validate(row, Date.now());
    return bytes;
  }

  async cleanup(now = Date.now()): Promise<void> {
    const protectedIds = new Set<string>();
    for (const doc of this.repo?.listDocuments<RankingDocument>(CHAT_RANKING_DOCUMENT) ?? []) {
      if (now - doc.value.createdAt <= RETENTION_MS) { protectedIds.add(doc.key); continue; }
      const db = this.repo!.sharedDb.db;
      db.prepare("UPDATE outbox SET status='cancelled',retry_after=NULL,updated_at=? WHERE text=? AND kind IN ('chat_ranking_text','chat_ranking_image') AND status IN ('pending','preparing','failed')").run(now, doc.key);
      if (db.prepare("SELECT 1 FROM outbox WHERE text=? AND kind IN ('chat_ranking_text','chat_ranking_image') AND status='sending'").get(doc.key)) protectedIds.add(doc.key);
      else this.repo!.deleteDocument(CHAT_RANKING_DOCUMENT, doc.key);
    }
    for (const file of await readdir(this.root).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; })) {
      const match = /^([a-f0-9]{64})\.png(?:\.tmp-[a-f0-9-]+)?$/u.exec(file);
      if (!match || protectedIds.has(match[1]!)) continue;
      const filePath = path.join(this.root, file), metadata = await lstat(filePath);
      if (metadata.isFile() && !metadata.isSymbolicLink() && now - metadata.mtimeMs > RETENTION_MS) await rm(filePath);
    }
  }
}
