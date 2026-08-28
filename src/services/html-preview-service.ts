import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readdir, rename, rm, statfs, writeFile } from "node:fs/promises";
import path from "node:path";

import type { SharedDb } from "../shared/sqlite.js";
import {
  HTML_PREVIEW_RETENTION_MS,
  HtmlPreviewRepository,
  isHtmlPreviewToken,
  type HtmlPreviewClaim,
  type HtmlPreviewListArgs,
  type HtmlPreviewRecord,
  type HtmlPreviewVisibleStatus,
} from "./html-preview-repository.js";

export const MAX_HTML_PREVIEW_REQUEST_CHARS = 4_000;
export const MAX_HTML_PREVIEW_BYTES = 512 * 1024;
export const DEFAULT_HTML_PREVIEW_MIN_FREE_BYTES = 32 * 1024 * 1024;
const HTML_PREVIEW_TEMP_RETENTION_MS = 15 * 60 * 1_000;
export const HTML_PREVIEW_FAILURE_MESSAGE = "网页生成失败了，这次没能发布预览链接。请换个说法后再试一次。";
export const HTML_PREVIEW_PROVIDER_UNAVAILABLE_MESSAGE = "网页生成服务暂时繁忙，请稍后再试。";

export interface ParsedHtmlPreviewRequest {
  request: string;
  source: "command" | "natural";
}

export interface HtmlPreviewMetadata {
  id: string;
  groupId: string;
  creatorUserId: string;
  sourceMessageId: string;
  title: string;
  previewUrl: string;
  status: HtmlPreviewVisibleStatus;
  createdAt: string;
  expiresAt: string;
  deletedAt?: string;
  byteSize?: number;
}

export interface HtmlPreviewGenerationResult {
  text: string;
  model?: string;
}

export interface HtmlPreviewGeneratorContext {
  repair: boolean;
  /** Kept bounded and transient. Never put it into a repository record. */
  previousOutput?: string;
}

export interface HtmlPreviewProcessResult {
  status: "idle" | "published" | "failed" | "unavailable" | "not_found";
  page?: HtmlPreviewMetadata;
  previewUrl?: string;
  announcementOutboxId?: number;
  errorCode?: string;
}

export interface HtmlPreviewServiceOptions {
  sharedDb: SharedDb;
  rootDir: string;
  publicBaseUrl: string;
  minFreeBytes?: number;
}

export interface HtmlPreviewProcessOptions {
  /** Target source record. If earlier same-group work exists it is drained first. */
  id?: string;
  /** The just-parsed current request. It is never stored in html_previews. */
  request?: string;
  /** Optional external resolver; DB message ledger remains the default recovery source. */
  requestFor?: (page: HtmlPreviewRecord) => string | undefined | Promise<string | undefined>;
  generate: (
    request: string,
    signal?: AbortSignal,
    context?: HtmlPreviewGeneratorContext,
  ) => HtmlPreviewGenerationResult | string | Promise<HtmlPreviewGenerationResult | string>;
  /**
   * Optional legacy/custom announcement path. Prefer omitting this: the
   * service creates and links the durable Outbox row atomically itself.
   */
  announce?: (page: HtmlPreviewMetadata, message: string) => number | { outboxId?: number; deliveryId?: string } | void | Promise<number | { outboxId?: number; deliveryId?: string } | void>;
  signal?: AbortSignal;
  now?: number;
}

interface ParsedModelPage {
  title: string;
  html: string;
}

/** Error codes are deliberately concise because they can become audit metadata. */
export class HtmlPreviewError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "HtmlPreviewError";
  }
}

/**
 * Static page generation is intentionally isolated from bot prompts and
 * conversations. It owns only metadata, output validation and file delivery;
 * BotApplication supplies the selected reply-model generator through
 * `processNext`.
 */
export class HtmlPreviewService {
  readonly repository: HtmlPreviewRepository;
  private readonly sharedDb: SharedDb;
  private readonly rootDir: string;
  private readonly pagesDir: string;
  private readonly tempDir: string;
  private readonly publicBaseUrl: string;
  private readonly minFreeBytes: number;

  constructor(options: HtmlPreviewServiceOptions) {
    this.sharedDb = options.sharedDb;
    this.repository = new HtmlPreviewRepository(options.sharedDb);
    this.rootDir = path.resolve(options.rootDir);
    this.pagesDir = path.join(this.rootDir, "pages");
    this.tempDir = path.join(this.rootDir, "tmp");
    this.publicBaseUrl = normalizePublicBaseUrl(options.publicBaseUrl);
    this.minFreeBytes = normalizeMinimumFreeBytes(options.minFreeBytes);
  }

  async enqueue(input: {
    groupId: string;
    creatorUserId: string;
    sourceMessageId: string;
    /** Accepted for ergonomic Bot callers, but deliberately not persisted. */
    request?: string;
    now?: number;
    expiresAt?: number;
  }): Promise<{ page: HtmlPreviewMetadata; created: boolean }> {
    if (input.request !== undefined) validatePreviewRequest(input.request);
    await this.ensureStorageReady();
    await this.assertDiskSpace();
    const result = this.repository.enqueue(input);
    return { page: this.toMetadata(result.page), created: result.created };
  }

  get(id: string): Promise<HtmlPreviewMetadata | undefined> {
    const page = this.repository.get(id);
    return Promise.resolve(page ? this.toMetadata(page) : undefined);
  }

  listPage(args: HtmlPreviewListArgs = {}): Promise<{
    items: HtmlPreviewMetadata[];
    pagination: { page: number; pageSize: number; total: number; totalPages: number };
  }> {
    const page = this.repository.listPage(args);
    return Promise.resolve({ ...page, items: page.items.map((item) => this.toMetadata(item)) });
  }

  /**
   * Claims and completes the oldest same-group page before the requested one.
   * This matters when a worker died after accepting A and the next event is B:
   * B's worker can recover A from the retained message ledger, then generate B
   * in FIFO order without persisting either raw request in this repository.
   */
  async processNext(options: HtmlPreviewProcessOptions): Promise<HtmlPreviewProcessResult> {
    const targetId = options.id?.trim();
    if (targetId && !isHtmlPreviewToken(targetId)) {
      return { status: "not_found" };
    }
    if (options.request !== undefined) validatePreviewRequest(options.request);
    const now = options.now ?? Date.now();
    const target = targetId ? this.repository.get(targetId) : undefined;
    if (targetId && !target) {
      return { status: "not_found" };
    }
    let attempts = 0;
    const maxAttempts = targetId ? 64 : 1;

    while (attempts < maxAttempts) {
      if (options.signal?.aborted) {
        return { status: "unavailable", errorCode: "html_preview_aborted" };
      }
      const claimed = this.repository.claimNext({
        ...(target ? { groupId: target.groupId } : {}),
        now: attempts === 0 ? now : Date.now(),
      });
      if (!claimed) {
        if (targetId) {
          const target = this.repository.get(targetId);
          if (!target) return { status: "not_found" };
          if (target.status === "published") {
            const announced = await this.ensureAnnouncement(target, options, now);
            return {
              status: "published",
              page: this.toMetadata(this.repository.get(target.id) ?? target),
              previewUrl: this.previewUrl(target.id),
              ...(announced === undefined ? {} : { announcementOutboxId: announced }),
            };
          }
          if (target.status === "failed") {
            const announcementOutboxId = this.repository.enqueueFailureNotice(target.id, failureMessageFor(target.errorCode), now);
            return {
              status: "failed",
              page: this.toMetadata(this.repository.get(target.id) ?? target),
              ...(announcementOutboxId === undefined ? {} : { announcementOutboxId }),
              errorCode: target.errorCode,
            };
          }
          if (target.status === "expired" || target.status === "deleted") {
            return { status: "not_found", page: this.toMetadata(target) };
          }
        }
        return { status: "idle" };
      }

      attempts += 1;
      const result = await this.processClaim(claimed, options, targetId, now);
      if (claimed.page.id === targetId || !targetId) return result;
    }

    return { status: "unavailable", errorCode: "html_preview_queue_depth_exceeded" };
  }

  /** Deletes the static directory before exposing the terminal state to admin. */
  async remove(id: string, now = Date.now()): Promise<boolean> {
    const page = this.repository.get(id);
    if (!page || page.status === "deleted") return false;
    await this.removePageDirectory(page.id);
    return this.repository.markDeleted(page.id, now);
  }

  /**
   * Removes expired pages and non-authoritative temp/orphan directories.
   * Generated HTML is never read or returned through this service/API.
   */
  async cleanup(now = Date.now()): Promise<{
    expired: number;
    temp: number;
    orphans: number;
  }> {
    await this.ensureStorageReady();
    let expired = 0;
    for (const page of this.repository.listExpired(now)) {
      try {
        await this.removePageDirectory(page.id);
        if (this.repository.markExpired(page.id, now)) expired += 1;
      } catch {
        // Keep the DB non-terminal when filesystem removal failed so the next
        // maintenance pass can retry instead of falsely promising a 404.
      }
    }

    const knownIds = new Set(this.repository.listIds());
    // A publisher writes into tmp before its atomic rename. Leave recent
    // directories alone so hourly maintenance cannot race a live request.
    const temp = await this.removeDirectories(
      this.tempDir,
      () => true,
      HTML_PREVIEW_TEMP_RETENTION_MS,
      now,
    );
    const orphans = await this.removeDirectories(this.pagesDir, (name) => !knownIds.has(name));
    return { expired, temp, orphans };
  }

  private async processClaim(
    claim: HtmlPreviewClaim,
    options: HtmlPreviewProcessOptions,
    targetId: string | undefined,
    now: number,
  ): Promise<HtmlPreviewProcessResult> {
    const page = claim.page;
    try {
      const request = await this.resolveRequest(page, options, targetId);
      if (!request) throw new HtmlPreviewError("html_preview_request_unavailable");
      await this.assertDiskSpace();
      const generated = await this.generateValidatedPage(request, options.generate, options.signal);
      const published = await this.publishFiles(page.id, generated.title, generated.html);
      const stored = this.repository.publish({
        id: page.id,
        leaseToken: claim.leaseToken,
        title: generated.title,
        contentSha256: published.contentSha256,
        byteSize: published.byteSize,
        now,
      });
      if (!stored) {
        throw new HtmlPreviewError("html_preview_publish_lease_lost");
      }
      const announcementOutboxId = await this.ensureAnnouncement(stored, options, now, claim.leaseToken);
      const latest = this.repository.get(stored.id) ?? stored;
      return {
        status: "published",
        page: this.toMetadata(latest),
        previewUrl: this.previewUrl(stored.id),
        ...(announcementOutboxId === undefined ? {} : { announcementOutboxId }),
      };
    } catch (error) {
      const errorCode = errorCodeOf(error);
      const failed = this.repository.fail(page.id, claim.leaseToken, errorCode, now);
      if (!failed) {
        // A lease loss can happen only if an operator removed/expired the page;
        // do not overwrite its terminal metadata or emit a duplicate failure.
        return { status: "unavailable", errorCode };
      }
      const announcementOutboxId = this.repository.enqueueFailureNotice(failed.id, failureMessageFor(errorCode), now);
      return {
        status: "failed",
        page: this.toMetadata(this.repository.get(failed.id) ?? failed),
        ...(announcementOutboxId === undefined ? {} : { announcementOutboxId }),
        errorCode,
      };
    }
  }

  private async resolveRequest(
    page: HtmlPreviewRecord,
    options: HtmlPreviewProcessOptions,
    targetId: string | undefined,
  ): Promise<string | undefined> {
    if (targetId === page.id && options.request?.trim()) return options.request.trim();
    const resolved = await options.requestFor?.(page);
    if (resolved?.trim()) return resolved.trim();
    return this.loadRequestFromMessageLedger(page);
  }

  private async generateValidatedPage(
    request: string,
    generate: HtmlPreviewProcessOptions["generate"],
    signal?: AbortSignal,
  ): Promise<ParsedModelPage> {
    let previousOutput: string | undefined;
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await generate(
        attempt === 0 ? request : buildRepairRequest(request, errorCodeOf(lastError)),
        signal,
        { repair: attempt === 1, ...(previousOutput ? { previousOutput } : {}) },
      );
      const text = typeof result === "string" ? result : result.text;
      previousOutput = text.slice(0, 1_600);
      try {
        const parsed = parseStaticHtmlGeneration(text);
        return { title: parsed.title, html: sanitizeStaticHtml(parsed.html) };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new HtmlPreviewError("html_preview_model_output_invalid");
  }

  private async ensureAnnouncement(
    page: HtmlPreviewRecord,
    options: HtmlPreviewProcessOptions,
    now: number,
    existingLeaseToken?: string,
  ): Promise<number | undefined> {
    if (page.announcementOutboxId !== undefined) return page.announcementOutboxId;
    const claim = existingLeaseToken && page.leaseToken === existingLeaseToken
      ? { page, leaseToken: existingLeaseToken }
      : this.repository.claimAnnouncement(page.id, { now });
    if (!claim) return this.repository.get(page.id)?.announcementOutboxId;
    const message = formatPreviewAnnouncement(claim.page.title, this.previewUrl(claim.page.id));
    if (!options.announce) {
      return this.repository.enqueueAnnouncement(claim.page.id, claim.leaseToken, message, now);
    }
    const received = await options.announce(this.toMetadata(claim.page), message);
    const outboxId = extractOutboxId(received);
    if (!outboxId) {
      // A custom sender that cannot expose a durable Outbox id cannot provide
      // retry-safe announcements. Release the lease and use the built-in
      // Outbox on the next recovery pass rather than claiming success.
      this.repository.release(claim.page.id, claim.leaseToken, now);
      throw new HtmlPreviewError("html_preview_announcement_not_durable");
    }
    this.repository.recordAnnouncement(claim.page.id, claim.leaseToken, outboxId, now);
    return outboxId;
  }

  private loadRequestFromMessageLedger(page: HtmlPreviewRecord): string | undefined {
    const db = this.sharedDb.db;
    const row = db.prepare(
      `SELECT text, has_at_bot
         FROM messages
        WHERE group_id = ? AND msg_id = ?
        ORDER BY id DESC
        LIMIT 1`,
    ).get(page.groupId, page.sourceMessageId) as { text: string; has_at_bot: number } | undefined;
    if (!row) return undefined;
    return parseHtmlPreviewRequest(row.text, Boolean(row.has_at_bot))?.request;
  }

  private async ensureStorageReady(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true, mode: 0o755 });
    await mkdir(this.pagesDir, { recursive: true, mode: 0o755 });
    await mkdir(this.tempDir, { recursive: true, mode: 0o755 });
    await Promise.all([chmod(this.rootDir, 0o755), chmod(this.pagesDir, 0o755), chmod(this.tempDir, 0o755)]);
  }

  private async assertDiskSpace(): Promise<void> {
    const filesystem = await statfs(this.rootDir);
    const free = Number(filesystem.bavail) * Number(filesystem.bsize);
    if (!Number.isFinite(free) || free < this.minFreeBytes) {
      throw new HtmlPreviewError("html_preview_disk_space_low");
    }
  }

  private async publishFiles(id: string, title: string, html: string): Promise<{ contentSha256: string; byteSize: number }> {
    await this.ensureStorageReady();
    const finalDir = this.pageDirectory(id);
    const tempName = `${id}.${randomBytes(8).toString("hex")}.tmp`;
    const temporaryDir = path.join(this.tempDir, tempName);
    const content = Buffer.from(html, "utf8");
    if (content.byteLength > MAX_HTML_PREVIEW_BYTES) {
      throw new HtmlPreviewError("html_preview_too_large");
    }
    const contentSha256 = createHash("sha256").update(content).digest("hex");
    const index = Buffer.from(buildTrustedIndex(title), "utf8");
    try {
      await this.removePageDirectory(id);
      await mkdir(temporaryDir, { recursive: false, mode: 0o755 });
      await chmod(temporaryDir, 0o755);
      await Promise.all([
        writePublicFile(path.join(temporaryDir, "index.html"), index),
        writePublicFile(path.join(temporaryDir, "content.html"), content),
      ]);
      await rename(temporaryDir, finalDir);
      await chmod(finalDir, 0o755);
      return { contentSha256, byteSize: content.byteLength };
    } catch (error) {
      await rm(temporaryDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async removePageDirectory(id: string): Promise<void> {
    const directory = this.pageDirectory(id);
    try {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new HtmlPreviewError("html_preview_path_unsafe");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    await rm(directory, { recursive: true, force: true });
  }

  private async removeDirectories(
    directory: string,
    shouldRemove: (name: string) => boolean,
    minAgeMs = 0,
    now = Date.now(),
  ): Promise<number> {
    let entries: string[];
    try {
      entries = await readdir(directory, { encoding: "utf8", withFileTypes: false });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
    let removed = 0;
    for (const name of entries) {
      if (!shouldRemove(name)) continue;
      const resolved = path.resolve(directory, name);
      if (path.dirname(resolved) !== directory) continue;
      try {
        const info = await lstat(resolved);
        if (!info.isDirectory() || info.isSymbolicLink()) continue;
        if (minAgeMs > 0 && now - info.mtimeMs < minAgeMs) continue;
        await rm(resolved, { recursive: true, force: true });
        removed += 1;
      } catch {
        // Maintenance is best-effort; a concurrent publisher may own this dir.
      }
    }
    return removed;
  }

  private pageDirectory(id: string): string {
    if (!isHtmlPreviewToken(id)) throw new HtmlPreviewError("html_preview_token_invalid");
    const target = path.resolve(this.pagesDir, id);
    if (path.dirname(target) !== this.pagesDir) throw new HtmlPreviewError("html_preview_path_unsafe");
    return target;
  }

  private previewUrl(id: string): string {
    return `${this.publicBaseUrl}/p/${id}/`;
  }

  private toMetadata(page: HtmlPreviewRecord): HtmlPreviewMetadata {
    return {
      id: page.id,
      groupId: page.groupId,
      creatorUserId: page.creatorUserId,
      sourceMessageId: page.sourceMessageId,
      title: page.title,
      previewUrl: this.previewUrl(page.id),
      status: page.status === "processing" ? "pending" : page.status,
      createdAt: new Date(page.createdAt).toISOString(),
      expiresAt: new Date(page.expiresAt).toISOString(),
      ...(page.deletedAt === undefined ? {} : { deletedAt: new Date(page.deletedAt).toISOString() }),
      ...(page.byteSize === undefined ? {} : { byteSize: page.byteSize }),
    };
  }
}

/**
 * Detects only intentional page-generation requests. Casual mentions of a
 * web page remain normal conversation so the bot never publishes by surprise.
 */
export function parseHtmlPreviewRequest(text: string, hasAtBot: boolean): ParsedHtmlPreviewRequest | undefined {
  const normalized = text.trim();
  const command = normalized.match(/^#(?:网页|html)\s+([\s\S]+)$/i);
  if (command) {
    const request = command[1]!.trim();
    return request ? { request, source: "command" } : undefined;
  }
  if (!hasAtBot) return undefined;
  const withoutMention = normalized
    .replace(/^\s*@[^\s]+\s*/u, "")
    .replace(/^\s*会仙[，,:：\s]*/u, "")
    .trim();
  const asksToCreate = /(生成|制作|创建|做(?:个|一[个份])?|写(?:个|一[个份])?|设计|帮(?:我|忙)?(?:做|写|生成|制作))/u.test(withoutMention);
  const asksForPage = /(网页|网站|html|静态页面|静态网页|web页面)/iu.test(withoutMention);
  if (!asksToCreate || !asksForPage || withoutMention.length < 4) return undefined;
  return { request: withoutMention, source: "natural" };
}

export function parseStaticHtmlGeneration(text: string): ParsedModelPage {
  const raw = text.trim();
  if (!raw || raw.length > MAX_HTML_PREVIEW_BYTES * 3) {
    throw new HtmlPreviewError("html_preview_model_output_invalid");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new HtmlPreviewError("html_preview_model_output_not_json");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HtmlPreviewError("html_preview_model_output_schema_invalid");
  }
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => key !== "title" && key !== "html") || typeof object.title !== "string" || typeof object.html !== "string") {
    throw new HtmlPreviewError("html_preview_model_output_schema_invalid");
  }
  const title = normalizeTitle(object.title);
  if (!title || !object.html.trim()) throw new HtmlPreviewError("html_preview_model_output_schema_invalid");
  return { title, html: object.html };
}

/**
 * A conservative single-document sanitizer. The preview is sandboxed again by
 * trusted `index.html` and static-host CSP, but validation fails closed before
 * a model-authored file reaches the public directory.
 */
export function sanitizeStaticHtml(input: string): string {
  const html = normalizeBenignSvgNamespace(input.replace(/^\uFEFF/, "").trim());
  if (!html || Buffer.byteLength(html, "utf8") > MAX_HTML_PREVIEW_BYTES) {
    throw new HtmlPreviewError("html_preview_too_large");
  }
  if (!/^<!doctype\s+html\s*>/i.test(html) || !/<html(?:\s|>)/i.test(html) || !/<body(?:\s|>)/i.test(html)) {
    throw new HtmlPreviewError("html_preview_document_invalid");
  }
  rejectUnsafeDocumentTokens(html);
  const sanitized = html.replace(/<\/?([A-Za-z][A-Za-z0-9:-]*)([^>]*)>/g, (whole, rawName: string, rawAttributes: string) => {
    const name = rawName.toLowerCase();
    const closing = /^<\//.test(whole);
    if (!ALLOWED_HTML_TAGS.has(name)) {
      throw new HtmlPreviewError("html_preview_tag_disallowed");
    }
    if (closing) return `</${name}>`;
    const selfClosing = /\/\s*>$/.test(whole) || VOID_HTML_TAGS.has(name);
    const attributes = sanitizeTagAttributes(name, rawAttributes.replace(/\/\s*$/, ""));
    return `<${name}${attributes}${selfClosing ? "" : ""}>`;
  });
  if (/<(?:script|style)\b[^>]*>[^]*<\/(?:script|style)>/i.test(sanitized) === false && /<(?:script|style)\b/i.test(html)) {
    throw new HtmlPreviewError("html_preview_document_invalid");
  }
  return sanitized;
}

function normalizeBenignSvgNamespace(html: string): string {
  // The default SVG namespace is inert in inline HTML and commonly emitted by
  // generators. Remove that exact declaration so published content still has
  // no namespace attributes; every other xmlns/xlink form remains fail-closed.
  return html.replace(
    /(<svg\b[^>]*?)\s+xmlns\s*=\s*(["'])http:\/\/www\.w3\.org\/2000\/svg\2(?=[\s>])/gi,
    "$1",
  );
}

function rejectUnsafeDocumentTokens(html: string): void {
  const forbiddenTag = /<\/?\s*(?:iframe|frame|frameset|embed|object|applet|form|base|link|meta|portal|template|math|audio|video|source|track|picture|canvas|image|use|foreignobject|animate|animatemotion|animatetransform|set)\b/i;
  const forbiddenAttribute = /\s(?:on[a-z0-9:_-]+|src|srcdoc|action|formaction|poster|background|cite|ping|xlink:href|xmlns)\s*=/i;
  const forbiddenNetwork = /(?:https?:|\/\/|\b(?:fetch|xmlhttprequest|websocket|eventsource|sendbeacon)\b|\bimportscripts\b|\bimport\s*\(|@import\b|\burl\s*\()/i;
  const forbiddenScript = /\b(?:window\.open|location(?:\.|\s*=)|document\.(?:cookie|write|open)|(?:inner|outer)html|insertadjacenthtml|createelement|appendchild|setattribute|eval\s*\(|new\s+function)\b/i;
  const unsafeProtocol = /(?:javascript|vbscript|data|file|blob)\s*:/i;
  if (forbiddenTag.test(html)) throw new HtmlPreviewError("html_preview_tag_disallowed");
  if (forbiddenAttribute.test(html)) throw new HtmlPreviewError("html_preview_attribute_disallowed");
  if (forbiddenNetwork.test(html)) throw new HtmlPreviewError("html_preview_network_disallowed");
  if (forbiddenScript.test(html)) throw new HtmlPreviewError("html_preview_script_disallowed");
  if (unsafeProtocol.test(html)) throw new HtmlPreviewError("html_preview_url_disallowed");
}

const ALLOWED_HTML_TAGS = new Set([
  "html", "head", "body", "title", "style", "script",
  "main", "header", "footer", "section", "article", "aside", "nav", "div", "span",
  "h1", "h2", "h3", "h4", "h5", "h6", "p", "pre", "code", "blockquote", "hr", "br",
  "ul", "ol", "li", "dl", "dt", "dd", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption",
  "button", "input", "label", "select", "option", "textarea", "details", "summary", "dialog",
  "strong", "b", "em", "i", "small", "mark", "time", "a",
  "svg", "g", "path", "circle", "ellipse", "rect", "line", "polyline", "polygon", "text", "tspan", "desc",
]);
const VOID_HTML_TAGS = new Set(["br", "hr", "input"]);
const GLOBAL_ATTRIBUTES = new Set([
  "id", "class", "title", "role", "style", "tabindex", "hidden", "dir", "lang",
  "aria-label", "aria-labelledby", "aria-describedby", "aria-expanded", "aria-controls", "aria-live",
]);
const SVG_PRESENTATION_ATTRIBUTES = new Set([
  "fill", "fill-opacity", "fill-rule", "clip-rule", "stroke", "stroke-width", "stroke-opacity",
  "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "stroke-dasharray", "stroke-dashoffset",
  "opacity", "color", "vector-effect", "paint-order", "shape-rendering", "text-rendering",
  "font-family", "font-size", "font-style", "font-weight", "letter-spacing", "word-spacing",
  "text-anchor", "dominant-baseline", "visibility", "display",
]);
const TAG_ATTRIBUTES: Record<string, ReadonlySet<string>> = {
  a: new Set(["href", "target"]),
  button: new Set(["type", "disabled", "value"]),
  input: new Set(["type", "value", "placeholder", "checked", "disabled", "min", "max", "step", "name"]),
  label: new Set(["for"]),
  option: new Set(["value", "selected", "disabled"]),
  select: new Set(["disabled", "name"]),
  textarea: new Set(["placeholder", "disabled", "name", "rows", "cols"]),
  td: new Set(["colspan", "rowspan", "headers"]),
  th: new Set(["colspan", "rowspan", "scope", "headers"]),
  time: new Set(["datetime"]),
  svg: new Set(["viewbox", "width", "height", "preserveaspectratio", "fill", "stroke", "stroke-width"]),
  g: new Set(["transform", "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "opacity"]),
  path: new Set(["d", "pathlength", "transform", "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-dasharray", "stroke-dashoffset", "opacity"]),
  circle: new Set(["cx", "cy", "r", "transform", "fill", "stroke", "stroke-width", "opacity"]),
  ellipse: new Set(["cx", "cy", "rx", "ry", "transform", "fill", "stroke", "stroke-width", "opacity"]),
  rect: new Set(["x", "y", "width", "height", "rx", "ry", "transform", "fill", "stroke", "stroke-width", "opacity"]),
  line: new Set(["x1", "y1", "x2", "y2", "transform", "stroke", "stroke-width", "stroke-linecap", "opacity"]),
  polyline: new Set(["points", "transform", "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "opacity"]),
  polygon: new Set(["points", "transform", "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "opacity"]),
  text: new Set(["x", "y", "dx", "dy", "transform", "fill", "stroke", "stroke-width", "opacity", "text-anchor", "dominant-baseline"]),
  tspan: new Set(["x", "y", "dx", "dy", "fill", "stroke", "opacity", "text-anchor"]),
};

function sanitizeTagAttributes(tag: string, raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  const matched: string[] = [];
  const matcher = /([A-Za-z][A-Za-z0-9:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let cursor = 0;
  for (let match = matcher.exec(value); match; match = matcher.exec(value)) {
    if (value.slice(cursor, match.index).trim()) throw new HtmlPreviewError("html_preview_attribute_invalid");
    cursor = matcher.lastIndex;
    const name = match[1]!.toLowerCase();
    const attributeValue = match[2] ?? match[3] ?? match[4] ?? "";
    const allowed = GLOBAL_ATTRIBUTES.has(name) ||
      name.startsWith("data-") ||
      TAG_ATTRIBUTES[tag]?.has(name) === true ||
      (SVG_TAGS.has(tag) && SVG_PRESENTATION_ATTRIBUTES.has(name)) ||
      isPassiveAttributeName(name);
    if (!allowed || name.startsWith("on")) throw new HtmlPreviewError("html_preview_attribute_disallowed");
    if (name === "href" && !/^#[A-Za-z][A-Za-z0-9_-]*$/.test(attributeValue)) {
      throw new HtmlPreviewError("html_preview_url_disallowed");
    }
    if (name === "target" && attributeValue !== "_self") throw new HtmlPreviewError("html_preview_attribute_disallowed");
    if (name === "style") rejectUnsafeCss(attributeValue);
    if (name === "id" && !/^[A-Za-z][A-Za-z0-9_-]*$/.test(attributeValue)) throw new HtmlPreviewError("html_preview_attribute_invalid");
    if (name === "tabindex" && !/^-?\d{1,3}$/.test(attributeValue)) throw new HtmlPreviewError("html_preview_attribute_invalid");
    if (SVG_TAGS.has(tag)) validateSvgAttribute(name, attributeValue);
    const outputName = tag === "svg" && name === "viewbox"
      ? "viewBox"
      : tag === "svg" && name === "preserveaspectratio"
        ? "preserveAspectRatio"
        : name;
    matched.push(attributeValue ? ` ${outputName}="${escapeAttribute(attributeValue)}"` : ` ${outputName}`);
  }
  if (value.slice(cursor).trim()) throw new HtmlPreviewError("html_preview_attribute_invalid");
  return matched.join("");
}

const SVG_TAGS = new Set(["svg", "g", "path", "circle", "ellipse", "rect", "line", "polyline", "polygon", "text", "tspan", "desc"]);
const SVG_NUMBER_ATTRIBUTES = new Set([
  "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "dx", "dy",
  "width", "height", "stroke-width", "stroke-dashoffset", "stroke-miterlimit", "pathlength", "font-size",
]);
const SVG_PAINT_ATTRIBUTES = new Set(["fill", "stroke"]);

function validateSvgAttribute(name: string, value: string): void {
  if (!value) throw new HtmlPreviewError("html_preview_attribute_invalid");
  if (value.length > 4_096 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value)) {
    throw new HtmlPreviewError("html_preview_attribute_invalid");
  }
  if (SVG_NUMBER_ATTRIBUTES.has(name) && !/^-?(?:\d+(?:\.\d+)?|\.\d+)(?:%|px)?$/.test(value)) {
    throw new HtmlPreviewError("html_preview_attribute_invalid");
  }
  if (name === "viewbox" && !/^\s*-?(?:\d+(?:\.\d+)?|\.\d+)(?:[ ,]+-?(?:\d+(?:\.\d+)?|\.\d+)){3}\s*$/.test(value)) {
    throw new HtmlPreviewError("html_preview_attribute_invalid");
  }
  if (name === "preserveaspectratio" && !/^(?:none|x(?:Min|Mid|Max)Y(?:Min|Mid|Max)(?:\s+(?:meet|slice))?)$/.test(value)) {
    throw new HtmlPreviewError("html_preview_attribute_invalid");
  }
  if (name === "d" && !/^[MmZzLlHhVvCcSsQqTtAa0-9eE+.,\s-]+$/.test(value)) {
    throw new HtmlPreviewError("html_preview_attribute_invalid");
  }
  if (name === "points" && !/^[0-9eE+.,\s-]+$/.test(value)) {
    throw new HtmlPreviewError("html_preview_attribute_invalid");
  }
  if (name === "transform" && !/^(?:(?:matrix|translate|scale|rotate|skewX|skewY)\(\s*[-+0-9eE.,\s]+\)\s*)+$/.test(value)) {
    throw new HtmlPreviewError("html_preview_attribute_invalid");
  }
  if (SVG_PAINT_ATTRIBUTES.has(name) && !/^(?:none|currentColor|transparent|#[0-9A-Fa-f]{3,8}|[A-Za-z]+|rgba?\([0-9.% ,]+\)|hsla?\([0-9.% ,]+\))$/.test(value)) {
    throw new HtmlPreviewError("html_preview_attribute_invalid");
  }
  if (["opacity", "fill-opacity", "stroke-opacity"].includes(name) && (!/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(value) || Number(value) < 0 || Number(value) > 1)) {
    throw new HtmlPreviewError("html_preview_attribute_invalid");
  }
  if (name === "stroke-dasharray" && !/^(?:none|[-+0-9eE.,\s]+)$/.test(value)) {
    throw new HtmlPreviewError("html_preview_attribute_invalid");
  }
  if (name === "stroke-linecap" && !/^(?:butt|round|square)$/.test(value)) throw new HtmlPreviewError("html_preview_attribute_invalid");
  if (name === "stroke-linejoin" && !/^(?:arcs|bevel|miter|miter-clip|round)$/.test(value)) throw new HtmlPreviewError("html_preview_attribute_invalid");
  if (["fill-rule", "clip-rule"].includes(name) && !/^(?:nonzero|evenodd)$/.test(value)) throw new HtmlPreviewError("html_preview_attribute_invalid");
  if (name === "vector-effect" && value !== "non-scaling-stroke") throw new HtmlPreviewError("html_preview_attribute_invalid");
  if (name === "paint-order" && !/^(?:normal|(?:fill|stroke|markers)(?:\s+(?:fill|stroke|markers)){0,2})$/.test(value)) throw new HtmlPreviewError("html_preview_attribute_invalid");
  if (name === "shape-rendering" && !/^(?:auto|optimizeSpeed|crispEdges|geometricPrecision)$/.test(value)) throw new HtmlPreviewError("html_preview_attribute_invalid");
  if (name === "text-rendering" && !/^(?:auto|optimizeSpeed|optimizeLegibility|geometricPrecision)$/.test(value)) throw new HtmlPreviewError("html_preview_attribute_invalid");
  if (name === "font-weight" && !/^(?:normal|bold|bolder|lighter|[1-9]00)$/.test(value)) throw new HtmlPreviewError("html_preview_attribute_invalid");
  if (name === "font-style" && !/^(?:normal|italic|oblique)$/.test(value)) throw new HtmlPreviewError("html_preview_attribute_invalid");
  if (name === "font-family" && !/^[A-Za-z0-9\u4E00-\u9FFF ,_'"-]{1,120}$/.test(value)) throw new HtmlPreviewError("html_preview_attribute_invalid");
  if (["letter-spacing", "word-spacing"].includes(name) && !/^(?:normal|-?(?:\d+(?:\.\d+)?|\.\d+)(?:px|em|rem|%)?)$/.test(value)) throw new HtmlPreviewError("html_preview_attribute_invalid");
  if (name === "visibility" && !/^(?:visible|hidden|collapse)$/.test(value)) throw new HtmlPreviewError("html_preview_attribute_invalid");
  if (name === "display" && !/^(?:none|inline|block)$/.test(value)) throw new HtmlPreviewError("html_preview_attribute_invalid");
  if (name === "text-anchor" && !/^(?:start|middle|end)$/.test(value)) throw new HtmlPreviewError("html_preview_attribute_invalid");
  if (name === "dominant-baseline" && !/^(?:auto|middle|central|hanging|text-after-edge|text-before-edge)$/.test(value)) {
    throw new HtmlPreviewError("html_preview_attribute_invalid");
  }
}

function isPassiveAttributeName(name: string): boolean {
  return /^[a-z][a-z0-9-]*$/.test(name) &&
    !name.startsWith("on") &&
    ![
      "href", "src", "srcdoc", "action", "formaction", "poster", "background",
      "cite", "ping", "xmlns", "http-equiv",
    ].includes(name);
}

function rejectUnsafeCss(value: string): void {
  if (/(?:@import|\burl\s*\(|expression\s*\(|-moz-binding|behavior\s*:|javascript\s*:|https?:|\/\/)/i.test(value)) {
    throw new HtmlPreviewError("html_preview_css_disallowed");
  }
}

function buildTrustedIndex(title: string): string {
  const safeTitle = escapeHtmlText(title);
  return [
    "<!doctype html>",
    '<html lang="zh-CN">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${safeTitle}</title>`,
    "<style>html,body,iframe{width:100%;height:100%;margin:0;border:0;display:block}body{overflow:hidden}</style>",
    "</head>",
    "<body>",
    `<iframe title="${escapeAttribute(title)}" src="content.html" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

function formatPreviewAnnouncement(title: string, previewUrl: string): string {
  return `网页已生成：${title}\n在线预览：${previewUrl}\n30 天后自动删除。`;
}

async function writePublicFile(file: string, content: Uint8Array): Promise<void> {
  await writeFile(file, content, { mode: 0o644 });
  await chmod(file, 0o644);
}

function normalizePublicBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new HtmlPreviewError("html_preview_public_base_url_invalid");
  }
  if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new HtmlPreviewError("html_preview_public_base_url_invalid");
  }
  return parsed.href.replace(/\/$/, "");
}

function normalizeMinimumFreeBytes(value: number | undefined): number {
  const normalized = Math.floor(value ?? DEFAULT_HTML_PREVIEW_MIN_FREE_BYTES);
  if (!Number.isFinite(normalized) || normalized < 0) throw new HtmlPreviewError("html_preview_min_free_bytes_invalid");
  return normalized;
}

function validatePreviewRequest(value: string): void {
  const request = value.trim();
  if (!request) throw new HtmlPreviewError("html_preview_request_empty");
  if (request.length > MAX_HTML_PREVIEW_REQUEST_CHARS) throw new HtmlPreviewError("html_preview_request_too_long");
}

function normalizeTitle(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 160);
}

function buildRepairRequest(request: string, errorCode?: string): string {
  const suffix = [
    "\n\n请重新生成。上一版未通过严格 JSON 或静态安全校验。",
    errorCode ? `校验结果：${errorCode}。` : "",
    '只输出 {\\"title\\":\\"...\\",\\"html\\":\\"完整 HTML 文档\\"}，不要解释、Markdown、外链或联网代码。',
    "不要输出 meta 或 xmlns 属性。SVG 只可使用 svg、g、path、circle、ellipse、rect、line、polyline、polygon、text、tspan、desc；动画只用 CSS @keyframes、transform、opacity。",
  ].join("");
  return `${request.slice(0, Math.max(1, MAX_HTML_PREVIEW_REQUEST_CHARS - suffix.length))}${suffix}`;
}

function errorCodeOf(error: unknown): string {
  if (error instanceof HtmlPreviewError) return error.code;
  if (error instanceof Error && error.name === "AbortError") return "html_preview_aborted";
  return "html_preview_generation_failed";
}

function failureMessageFor(errorCode: string | undefined): string {
  return errorCode === "html_preview_provider_unavailable"
    ? HTML_PREVIEW_PROVIDER_UNAVAILABLE_MESSAGE
    : HTML_PREVIEW_FAILURE_MESSAGE;
}

function extractOutboxId(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (value && typeof value === "object" && "outboxId" in value) {
    const id = (value as { outboxId?: unknown }).outboxId;
    return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : undefined;
  }
  return undefined;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeHtmlText(value: string): string {
  return escapeAttribute(value).replace(/'/g, "&#39;");
}
