import {
  imageReferenceFromDataUrl,
  type ImageReference,
} from "./image-generation-service.js";

export const QQ_AVATAR_REFERENCE_ENDPOINT = "https://q1.qlogo.cn/g";
export const QQ_AVATAR_REFERENCE_TIMEOUT_MS = 15_000;
export const QQ_AVATAR_REFERENCE_MAX_BYTES = 5 * 1024 * 1024;

export type QqAvatarReferenceErrorCode =
  | "invalid_user_id"
  | "download_timeout"
  | "download_failed"
  | "redirect_rejected"
  | "download_http_error"
  | "invalid_content_type"
  | "image_too_large"
  | "invalid_image";

/**
 * Stable failures for the command layer to turn into a short, user-facing
 * avatar-reference error without retaining or exposing upstream response data.
 */
export class QqAvatarReferenceError extends Error {
  constructor(
    public readonly code: QqAvatarReferenceErrorCode,
    message: string = code,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "QqAvatarReferenceError";
  }
}

/** Resolves an avatar only after the caller has verified group membership. */
export interface QqAvatarReferenceResolver {
  resolve(verifiedUserId: string): Promise<ImageReference>;
}

export interface QqAvatarReferenceServiceOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
}

/**
 * Downloads QQ avatars through one fixed, HTTPS-only endpoint. It deliberately
 * accepts an ID rather than a URL so command input cannot influence the host,
 * path, redirect target, or local filesystem.
 */
export class QqAvatarReferenceService implements QqAvatarReferenceResolver {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;

  constructor(options: QqAvatarReferenceServiceOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? QQ_AVATAR_REFERENCE_TIMEOUT_MS;
    this.maxBytes = options.maxBytes ?? QQ_AVATAR_REFERENCE_MAX_BYTES;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new TypeError("qq_avatar_reference_timeout_invalid");
    }
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes <= 0) {
      throw new TypeError("qq_avatar_reference_max_bytes_invalid");
    }
  }

  async resolve(verifiedUserId: string): Promise<ImageReference> {
    const url = qqAvatarReferenceUrl(verifiedUserId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers: { Accept: "image/png,image/jpeg,image/webp;q=0.9" },
        redirect: "error",
        signal: controller.signal,
      });
      if (response.redirected || isRedirect(response.status)) {
        throw new QqAvatarReferenceError("redirect_rejected");
      }
      if (!response.ok) {
        throw new QqAvatarReferenceError("download_http_error", "download_http_error", response.status);
      }

      const mimeType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (!isSupportedImageMimeType(mimeType)) {
        throw new QqAvatarReferenceError("invalid_content_type");
      }
      const contentLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > this.maxBytes) {
        throw new QqAvatarReferenceError("image_too_large");
      }

      const data = await this.readBody(response);
      try {
        return imageReferenceFromDataUrl(`data:${mimeType};base64,${data.toString("base64")}`);
      } catch {
        throw new QqAvatarReferenceError("invalid_image");
      }
    } catch (error) {
      if (error instanceof QqAvatarReferenceError) throw error;
      if (controller.signal.aborted) throw new QqAvatarReferenceError("download_timeout");
      throw new QqAvatarReferenceError("download_failed");
    } finally {
      clearTimeout(timer);
    }
  }

  private async readBody(response: Response): Promise<Buffer> {
    if (!response.body) throw new QqAvatarReferenceError("invalid_image");
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        length += value.byteLength;
        if (length > this.maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new QqAvatarReferenceError("image_too_large");
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
    if (length === 0) throw new QqAvatarReferenceError("invalid_image");
    return Buffer.concat(chunks, length);
  }
}

export function qqAvatarReferenceUrl(verifiedUserId: string): URL {
  if (!isVerifiedNumericQqUserId(verifiedUserId)) {
    throw new QqAvatarReferenceError("invalid_user_id");
  }
  const url = new URL(QQ_AVATAR_REFERENCE_ENDPOINT);
  url.searchParams.set("b", "qq");
  url.searchParams.set("nk", verifiedUserId);
  url.searchParams.set("s", "640");
  return url;
}

export function isVerifiedNumericQqUserId(value: string): boolean {
  return /^[1-9]\d{0,19}$/u.test(value);
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

function isSupportedImageMimeType(value: string | undefined): value is ImageReference["mimeType"] {
  return value === "image/png" || value === "image/jpeg" || value === "image/webp";
}
