import { currentModelOperation, recordModelRequest, withModelOperation } from "./model-telemetry.js";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { logWarn } from "../logger.js";
import { imageDimensions } from "../utils/image-dimensions.js";
import type { SystemModelConfig } from "../types.js";
import { classifyUpstreamFailure, type UpstreamFailureKind } from "../utils/upstream-failure.js";
import type { RuntimeCapabilityPolicy } from "./capability-policy-service.js";
import type { SystemSettingsStore } from "./system-settings-store.js";
import type { V3StateRepository } from "./v3-state-repository.js";

export const IMAGE_GENERATION_MAX_PROMPT_CHARS = 5_000;
export const IMAGE_GENERATION_MAX_BYTES = 20 * 1024 * 1024;
export const IMAGE_GENERATION_COOLDOWN_SECONDS = 60;
export const IMAGE_EDIT_COOLDOWN_SECONDS = 15;
export const IMAGE_GENERATION_DEFAULT_TIMEOUT_MS = 180_000;
export const IMAGE_GENERATION_ORPHAN_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const COOLDOWN_DOCUMENT_TYPE = "image-generation-cooldown";

interface CooldownDocument {
  lastSuccessAt: number;
}

export interface GeneratedImageResult {
  filePath: string;
  modelId: string;
  model: string;
  fallbackUsed: boolean;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  byteLength: number;
  outputSize?: string;
}

export interface ImageReference {
  data: Buffer;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  previewId?: string;
}

export interface ImageGenerationRuntime {
  generate(input: {
    groupId: string;
    userId: string;
    prompt: string;
    referenceImages?: ImageReference[];
    size?: string;
    signal?: AbortSignal;
    onStarted?: () => void | Promise<void>;
  }): Promise<GeneratedImageResult>;
  discard(filePath: string): Promise<void>;
  cleanup(now?: number): Promise<number>;
}

/** Safe diagnostic fields only; never retain upstream messages or request bodies. */
export interface ImageGenerationDiagnostics {
  modelId?: string;
  model?: string;
  statusCode?: number;
  upstreamCode?: string;
  upstreamType?: string;
  moderationStage?: "input" | "output" | "unknown";
  moderationCategories?: string[];
  requestId?: string;
  upstreamRequestId?: string;
  failureKind?: UpstreamFailureKind | "content_blocked";
}

export class ImageGenerationError extends Error {
  constructor(
    public readonly code:
      | "prompt_empty"
      | "prompt_too_long"
      | "not_configured"
      | "provider_disabled"
      | "cooldown"
      | "busy"
      | "editing_not_configured"
      | "invalid_reference"
      | "invalid_size"
      | "content_blocked"
      | "upstream_rejected"
      | "upstream_unavailable"
      | "invalid_image_response",
    message: string = code,
    public readonly retryAfterSeconds?: number,
    public readonly diagnostics?: ImageGenerationDiagnostics,
  ) {
    super(message);
    this.name = "ImageGenerationError";
  }
}

class ImageUpstreamError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly statusCode?: number,
    readonly diagnostics?: ImageGenerationDiagnostics,
  ) {
    super(message);
    this.name = "ImageUpstreamError";
  }
}

export class ConfiguredImageGenerationService implements ImageGenerationRuntime {
  private readonly activeRequests = new Set<string>();
  private readonly legacyCooldowns = new Map<string, number>();

  constructor(
    private readonly settingsStore: SystemSettingsStore,
    private readonly rootDir: string,
    private readonly v3State?: V3StateRepository,
    private readonly capabilityPolicy?: RuntimeCapabilityPolicy,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly listRetainedPaths: () => Iterable<string> = () => [],
  ) {}

  async generate(input: {
    groupId: string;
    userId: string;
    prompt: string;
    referenceImages?: ImageReference[];
    size?: string;
    signal?: AbortSignal;
    onStarted?: () => void | Promise<void>;
  }): Promise<GeneratedImageResult> {
    const requestKey = cooldownKey(input.groupId, input.userId);
    if (this.activeRequests.has(requestKey)) throw new ImageGenerationError("busy");
    this.activeRequests.add(requestKey);
    try {
      return await withModelOperation("image", input.groupId, async () => {
        const references = input.referenceImages ?? [];
        validateImageReferences(references);
        validateImageSize(input.size);
        const editing = references.length > 0;
        const prompt = input.prompt.trim();
        if (!prompt) throw new ImageGenerationError("prompt_empty");
        if (countImagePromptCharacters(prompt) > IMAGE_GENERATION_MAX_PROMPT_CHARS) {
          throw new ImageGenerationError("prompt_too_long");
        }

        const retryAfterSeconds = this.getRetryAfterSeconds(input.groupId, input.userId, editing ? IMAGE_EDIT_COOLDOWN_SECONDS : IMAGE_GENERATION_COOLDOWN_SECONDS);
        if (retryAfterSeconds > 0) {
          throw new ImageGenerationError("cooldown", "cooldown", retryAfterSeconds);
        }
        if (this.capabilityPolicy && !this.capabilityPolicy.isEnabled("image_generation")) {
          throw new ImageGenerationError("provider_disabled");
        }
        if (!this.providerSupportsImageGeneration()) {
          throw new ImageGenerationError("provider_disabled");
        }

        const settings = await this.settingsStore.getInternal();
        const enabled = settings.models.filter((model) =>
          model.purpose === "image" &&
          model.enabled &&
          model.hasApiKey &&
          Boolean(model.apiKey?.trim()) &&
          model.apiProtocol !== "anthropic" &&
          (!editing || model.capabilities?.imageEditing === true),
        );
        const selectedId = settings.selectedModelIds.image;
        if (selectedId === "") throw new ImageGenerationError("not_configured");
        const candidates = selectedId
          ? [
              ...enabled.filter((model) => model.id === selectedId),
              ...enabled.filter((model) => model.id !== selectedId),
            ]
          : enabled;
        if (candidates.length === 0) {
          throw new ImageGenerationError(editing ? "editing_not_configured" : "not_configured");
        }
        if (input.signal?.aborted) {
          throw input.signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
        }

        await input.onStarted?.();

        let lastRetryableError: unknown;
        let lastDiagnostics: ImageGenerationDiagnostics | undefined;
        for (let index = 0; index < candidates.length; index += 1) {
          const candidate = candidates[index]!;
          try {
            const generated = await withModelOperation("image", input.groupId, () => requestGeneratedImage(candidate, prompt, {
              signal: input.signal,
              fetchImpl: this.fetchImpl,
              referenceImages: references,
              size: input.size ?? (editing ? "auto" : "1024x1024"),
            }), candidate.id);
            const filePath = await this.stage(generated.data, generated.extension);
            this.recordSuccess(input.groupId, input.userId);
            return {
              filePath,
              modelId: candidate.id,
              model: candidate.model,
              fallbackUsed: index > 0,
              mimeType: generated.mimeType,
              byteLength: generated.data.byteLength,
              outputSize: imageDimensions(generated.data),
            };
          } catch (error) {
            if (input.signal?.aborted) throw error;
            const diagnostics = {
              ...(error instanceof ImageUpstreamError || error instanceof ImageGenerationError ? error.diagnostics : {}),
              modelId: candidate.id,
              model: candidate.model,
            };
            if (!(error instanceof ImageUpstreamError) || !error.retryable) {
              if (error instanceof ImageGenerationError) {
                throw new ImageGenerationError(error.code, error.message, error.retryAfterSeconds, diagnostics);
              }
              throw new ImageGenerationError("upstream_rejected", error instanceof Error ? error.message : "upstream_rejected", undefined, diagnostics);
            }
            lastRetryableError = error;
            lastDiagnostics = diagnostics;
            logWarn("Image generation upstream failed; trying the next configured image model.", {
              ...diagnostics,
              fallbackAvailable: index + 1 < candidates.length,
            });
          }
        }
        throw new ImageGenerationError(
          "upstream_unavailable",
          lastRetryableError instanceof Error ? lastRetryableError.message : "upstream_unavailable",
          undefined,
          lastDiagnostics,
        );
      });
    } finally {
      this.activeRequests.delete(requestKey);
    }
  }

  async discard(filePath: string): Promise<void> {
    if (!isPathInside(this.rootDir, filePath)) return;
    await rm(filePath, { force: true });
  }

  async cleanup(now = this.now()): Promise<number> {
    await mkdir(this.rootDir, { recursive: true });
    const retained = new Set([...this.listRetainedPaths()].map((filePath) => path.resolve(filePath)));
    let removed = 0;
    for (const entry of await readdir(this.rootDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const filePath = path.join(this.rootDir, entry.name);
      if (retained.has(path.resolve(filePath))) continue;
      const file = await stat(filePath);
      if (now - file.mtimeMs < IMAGE_GENERATION_ORPHAN_MAX_AGE_MS) continue;
      await rm(filePath, { force: true });
      removed += 1;
    }
    return removed;
  }

  private providerSupportsImageGeneration(): boolean {
    return this.capabilityPolicy?.isProviderFeatureEnabled("openai", "imageGeneration") ?? true;
  }

  private async stage(data: Buffer, extension: "png" | "jpg" | "webp"): Promise<string> {
    await mkdir(this.rootDir, { recursive: true });
    const filePath = path.join(this.rootDir, `${randomUUID()}.${extension}`);
    await writeFile(filePath, data, { flag: "wx", mode: 0o600 });
    await chmod(filePath, 0o600).catch(() => undefined);
    return filePath;
  }

  private getRetryAfterSeconds(groupId: string, userId: string, cooldownSeconds: number): number {
    const key = cooldownKey(groupId, userId);
    const lastSuccessAt = this.v3State
      ? this.v3State.getDocument<CooldownDocument>(COOLDOWN_DOCUMENT_TYPE, key, { lastSuccessAt: 0 }).lastSuccessAt
      : this.legacyCooldowns.get(key) ?? 0;
    if (!Number.isFinite(lastSuccessAt) || lastSuccessAt <= 0) return 0;
    const remainingMs = cooldownSeconds * 1_000 - (this.now() - lastSuccessAt);
    return remainingMs > 0 ? Math.ceil(remainingMs / 1_000) : 0;
  }

  private recordSuccess(groupId: string, userId: string): void {
    const key = cooldownKey(groupId, userId);
    const lastSuccessAt = this.now();
    if (this.v3State) {
      this.v3State.saveDocument(COOLDOWN_DOCUMENT_TYPE, key, { lastSuccessAt }, lastSuccessAt);
    } else {
      this.legacyCooldowns.set(key, lastSuccessAt);
    }
  }
}

/** Counts user-visible Unicode code points instead of UTF-16 code units. */
export function countImagePromptCharacters(prompt: string): number {
  return Array.from(prompt).length;
}

export async function requestGeneratedImage(
  model: Pick<SystemModelConfig, "baseUrl" | "model" | "apiKey" | "requestTimeoutMs">,
  prompt: string,
  options: {
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
    quality?: "low" | "auto";
    referenceImages?: ImageReference[];
    size?: string;
  } = {},
): Promise<{
  data: Buffer;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  extension: "png" | "jpg" | "webp";
}> {
  const references = options.referenceImages ?? [];
  validateImageReferences(references);
  validateImageSize(options.size);
  const editing = references.length > 0;
  const telemetryStartedAt = Date.now();
  let telemetryResponse: unknown;
  let telemetryStatus: "succeeded" | "failed" | "cancelled" = "failed";
  const telemetryOperation = currentModelOperation();
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, model.requestTimeoutMs ?? IMAGE_GENERATION_DEFAULT_TIMEOUT_MS);
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  try {
    const size = options.size ?? (editing ? "auto" : "1024x1024");
    const parameters = { model: model.model, prompt: imagePromptWithSize(prompt, size), n: 1,
      size,
      quality: options.quality ?? "auto", output_format: "png" };
    let body: string | FormData = JSON.stringify(parameters);
    if (editing) {
      const form = new FormData();
      for (const [key, value] of Object.entries(parameters)) form.set(key, String(value));
      references.forEach((image, index) => form.append(references.length === 1 ? "image" : "image[]",
        new Blob([new Uint8Array(image.data)], { type: image.mimeType }),
        `image${index + 1}.${image.mimeType === "image/jpeg" ? "jpg" : image.mimeType.split("/")[1]}`));
      body = form;
    }
    const response = await fetchImpl(imageGenerationEndpoint(model.baseUrl, editing), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${model.apiKey ?? ""}`,
        ...(editing ? {} : { "Content-Type": "application/json" }),
      },
      body,
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 16_384);
      const { diagnostics, message } = readUpstreamDiagnostics(response, detail);
      // A gateway may include words like "upstream" or "unavailable" in a
      // policy error. Stable provider codes must win over generic text matching.
      if (diagnostics.upstreamCode === "moderation_blocked" || diagnostics.upstreamCode === "content_policy_violation") {
        throw new ImageGenerationError("content_blocked", "content_blocked", undefined, {
          ...diagnostics, moderationStage: diagnostics.moderationStage ?? "unknown", failureKind: "content_blocked",
        });
      }
      const kind = classifyUpstreamFailure({ statusCode: response.status, message });
      const retryable = diagnostics.upstreamType !== "image_generation_user_error" &&
        (kind === "rate_limit" || kind === "unavailable" || kind === "timeout" || kind === "network");
      throw new ImageUpstreamError(`image_upstream_http_${response.status}`, retryable, response.status, { ...diagnostics, failureKind: kind });
    }
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > Math.ceil(IMAGE_GENERATION_MAX_BYTES * 4 / 3) + 1_000_000) {
      throw new ImageGenerationError("invalid_image_response", "image_response_too_large");
    }
    let payload: unknown;
    try {
      const responseText = await response.text();
      const maxResponseChars = Math.ceil(IMAGE_GENERATION_MAX_BYTES / 3) * 4 + 1_000_000;
      if (responseText.length > maxResponseChars) {
        throw new ImageGenerationError("invalid_image_response", "image_response_too_large");
      }
      payload = JSON.parse(responseText);
      telemetryResponse = payload;
    } catch (error) {
      if (error instanceof ImageGenerationError) throw error;
      throw new ImageGenerationError("invalid_image_response", "image_response_invalid_json");
    }
    const encoded = readBase64Image(payload);
    const data = decodeBase64Image(encoded);
    const type = detectImageType(data);
    if (!type) throw new ImageGenerationError("invalid_image_response", "image_response_type_invalid");
    telemetryStatus = "succeeded";
    return { data, ...type };
  } catch (error) {
    if (error instanceof ImageGenerationError || error instanceof ImageUpstreamError) throw error;
    if (options.signal?.aborted) throw error;
    if (timedOut) throw new ImageUpstreamError("image_upstream_timeout", true, undefined, { failureKind: "timeout" });
    const kind = classifyUpstreamFailure({ error });
    throw new ImageUpstreamError(
      "image_upstream_network_error",
      kind === "network" || kind === "timeout" || kind === "unavailable" || kind === "rate_limit",
      undefined,
      { failureKind: kind },
    );
  } finally {
    if (options.signal?.aborted) telemetryStatus = "cancelled";
    recordModelRequest({ startedAt: telemetryStartedAt, model: model.model, status: telemetryStatus, response: telemetryResponse, images: telemetryStatus === "succeeded" ? 1 : 0, operation: telemetryOperation });
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}

export function isGeneratedImagePath(rootDir: string, filePath: string): boolean {
  return isPathInside(rootDir, filePath) && /\.(?:png|jpe?g|webp)$/i.test(filePath);
}

export function isSupportedGeneratedImage(data: Buffer): boolean {
  return detectImageType(data) !== undefined;
}

function imageGenerationEndpoint(baseUrl: string, editing = false): string {
  return `${baseUrl.replace(/\/+$/, "")}/images/${editing ? "edits" : "generations"}`;
}

function readUpstreamDiagnostics(response: Response, detail: string): {
  diagnostics: ImageGenerationDiagnostics;
  message: string;
} {
  let payload: Record<string, unknown> = {};
  try { payload = JSON.parse(detail); } catch { /* Non-JSON proxy errors still use HTTP/text classification. */ }
  const error = asRecord(asRecord(payload).error);
  const moderation = asRecord(error.moderation_details);
  const stage = moderation.moderation_stage;
  const message = typeof error.message === "string" ? error.message : detail;
  const upstreamRequestId = diagnosticToken(error.request_id) ?? diagnosticToken(asRecord(payload).request_id) ??
    diagnosticToken(message.match(/\brequest\s+id\s*[:=]?\s*([a-z0-9_-]{1,160})/i)?.[1]);
  return {
    message,
    diagnostics: {
      statusCode: response.status,
      upstreamCode: diagnosticToken(error.code),
      upstreamType: diagnosticToken(error.type),
      requestId: diagnosticToken(response.headers.get("x-request-id") ?? response.headers.get("request-id")),
      upstreamRequestId,
      ...(stage === "input" || stage === "output" || stage === "unknown" ? { moderationStage: stage } : {}),
      ...(Array.isArray(moderation.categories) ? {
        moderationCategories: moderation.categories.slice(0, 8).map(diagnosticToken).filter((value): value is string => Boolean(value)),
      } : {}),
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function diagnosticToken(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-z0-9_:-][a-z0-9_.:-]{0,159}$/i.test(value) ? value : undefined;
}

function readBase64Image(payload: unknown): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ImageGenerationError("invalid_image_response", "image_response_missing_data");
  }
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data) || !data[0] || typeof data[0] !== "object") {
    throw new ImageGenerationError("invalid_image_response", "image_response_missing_data");
  }
  const encoded = (data[0] as { b64_json?: unknown }).b64_json;
  if (typeof encoded !== "string" || !encoded.trim()) {
    throw new ImageGenerationError("invalid_image_response", "image_response_missing_base64");
  }
  return encoded.trim();
}

function decodeBase64Image(encoded: string): Buffer {
  const maxEncodedChars = Math.ceil(IMAGE_GENERATION_MAX_BYTES / 3) * 4 + 4;
  if (encoded.length > maxEncodedChars || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    throw new ImageGenerationError("invalid_image_response", "image_response_base64_invalid");
  }
  const data = Buffer.from(encoded, "base64");
  if (data.byteLength === 0 || data.byteLength > IMAGE_GENERATION_MAX_BYTES) {
    throw new ImageGenerationError("invalid_image_response", "image_response_size_invalid");
  }
  return data;
}

function detectImageType(data: Buffer): {
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  extension: "png" | "jpg" | "webp";
} | undefined {
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mimeType: "image/png", extension: "png" };
  }
  if (data[0] === 0xff && data[1] === 0xd8 && data[data.length - 2] === 0xff && data[data.length - 1] === 0xd9) {
    return { mimeType: "image/jpeg", extension: "jpg" };
  }
  if (data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") {
    return { mimeType: "image/webp", extension: "webp" };
  }
  return undefined;
}

function cooldownKey(groupId: string, userId: string): string {
  return `${groupId.trim()}:${userId.trim()}`;
}

function isPathInside(rootDir: string, filePath: string): boolean {
  const root = path.resolve(rootDir);
  const candidate = path.resolve(filePath);
  const relative = path.relative(root, candidate);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function validateImageReferences(images: ImageReference[]): void {
  if (images.length > 4) throw new ImageGenerationError("invalid_reference");
  for (const image of images) {
    const detected = detectImageType(image.data);
    if (!detected || detected.mimeType !== image.mimeType || image.data.length > IMAGE_GENERATION_MAX_BYTES) {
      throw new ImageGenerationError("invalid_reference");
    }
  }
}
export const IMAGE_ASPECT_SIZES: Record<string, string> = {
  "1:1": "1024x1024", "2:3": "1024x1536", "3:2": "1536x1024",
  "9:16": "864x1536", "16:9": "1536x864",
};
function validateImageSize(size?: string): void {
  if (size !== undefined && size !== "auto" && !Object.values(IMAGE_ASPECT_SIZES).includes(size)) {
    throw new ImageGenerationError("invalid_size");
  }
}
export function parseImagePrompt(raw: string): { prompt: string; size?: string } {
  const parameter = raw.match(/(?:^|\s)--比例\s+(\S+)/u);
  if (/(?:^|\s)--比例(?:\s|$)/u.test(raw) && !parameter) throw new ImageGenerationError("invalid_size");
  const leading = raw.trim().match(/^(\d+[:：]\d+)(?=\s|の|$)/u);
  const ratio = (parameter?.[1] ?? leading?.[1])?.replace("：", ":");
  if (ratio && !IMAGE_ASPECT_SIZES[ratio]) throw new ImageGenerationError("invalid_size");
  return { prompt: (parameter ? raw.replace(parameter[0], " ") : raw).trim(),
    ...(ratio ? { size: IMAGE_ASPECT_SIZES[ratio] } : {}) };
}
export function imageReferenceFromDataUrl(value: string): ImageReference {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/i.exec(value);
  if (!match) throw new ImageGenerationError("invalid_reference");
  const image: ImageReference = { data: decodeBase64Image(match[2]!), mimeType: match[1]!.toLowerCase() as ImageReference["mimeType"] };
  validateImageReferences([image]);
  return image;
}


function imagePromptWithSize(prompt: string, size: string): string {
  if (size === "auto") return prompt;
  const [width, height] = size.split("x").map(Number) as [number, number];
  const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
  const divisor = gcd(width, height);
  // OAuth image gateways can normalize the tool's size to auto. Repeat the
  // user's format in the prompt so framing follows it on those gateways too.
  return `${prompt}\n\nOutput canvas: aspect ratio ${width / divisor}:${height / divisor} (${size} pixels). Adjust the framing to fill this canvas. This output format takes precedence over other aspect ratios in the description.`;
}
