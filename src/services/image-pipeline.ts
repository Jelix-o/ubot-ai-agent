import { logWarn } from "../logger.js";
import type { MessageImageInput } from "../types.js";
import type { Metrics } from "../shared/metrics.js";
import {
  downloadImageAsDataUrl,
  isHttpUrl,
  isImageDataUrl,
  readImageFileAsDataUrl,
} from "../utils/image-data-url.js";

/**
 * Two-stage image pipeline (plan section 4):
 *
 * Stage 1 Localization — only obtain local bytes:
 *   1. NapCat local cache via `localize` callback (soft 800ms / hard 1.5s)
 *   2. Internal HTTP proxy fetching the QQ image host (soft 4s / hard 6s)
 *   3. Failure → tier "image_unavailable" (L1)
 *
 * Stage 2 Recognition — only after local bytes exist:
 *   - Vision-capable model path is handled by the caller (data URL in prompt).
 *   - Pure-text model path runs a local caption/OCR model configured via
 *     `ocr` callback; its structured text is injected as [图片内容: ...].
 *
 * Failure tiers (fixed wording, never model-generated):
 *   L1 image_unavailable  "那张图我这边没打开…"
 *   L2 image_format       "这张图我识别不了"
 *   L3 image_safety       "这张图我不太方便评论"
 *   L4 image_vision_timeout "我看了一下这张图，暂时想不出具体见解"
 * Red line: L1/L2/L3 must NEVER be phrased as "思考超时" in logs — the tier
 * name is logged separately so "couldn't fetch" and "couldn't reason" are
 * distinguishable.
 */

export type ImageTier =
  | "image_unavailable"
  | "image_format"
  | "image_safety"
  | "image_vision_timeout";

export class ImagePipelineError extends Error {
  constructor(
    readonly tier: ImageTier,
    message: string,
  ) {
    super(message);
    this.name = "ImagePipelineError";
  }
}

export interface ImagePipelineOptions {
  /** NapCat local cache read; must resolve to a local file path or reject. */
  localize?: (image: MessageImageInput) => Promise<string | undefined>;
  /**
   * Alternative localization that resolves directly to a data URL (e.g. a
   * transport that already materializes via get_image + data URL conversion).
   * When present it takes precedence over `localize` + file read.
   */
  localizeDataUrl?: (image: MessageImageInput) => Promise<string | undefined>;
  /** Local OCR/caption for pure-text models; returns the [图片内容: ...] text. */
  ocr?: (image: MessageImageInput) => Promise<string | undefined>;
  metrics?: Metrics;
  /** Soft/hard timeouts in ms. */
  localSoftTimeoutMs?: number;
  localHardTimeoutMs?: number;
  proxySoftTimeoutMs?: number;
  proxyHardTimeoutMs?: number;
}

const DEFAULT_OPTIONS = {
  localSoftTimeoutMs: 800,
  localHardTimeoutMs: 1_500,
  proxySoftTimeoutMs: 4_000,
  proxyHardTimeoutMs: 6_000,
};

export interface ResolvedImage {
  input: MessageImageInput;
  /** data URL usable in a vision prompt. */
  dataUrl: string;
  /** OCR/caption text when the reply model is text-only. */
  caption?: string;
}

export class ImagePipeline {
  constructor(private readonly options: ImagePipelineOptions = {}) {}

  /** Resolves images through Stage 1; returns data URLs for the vision path. */
  async resolveForVision(images: MessageImageInput[]): Promise<ResolvedImage[]> {
    const resolved: ResolvedImage[] = [];
    for (const image of images) {
      const dataUrl = await this.stage1(image);
      if (dataUrl) {
        resolved.push({ input: image, dataUrl });
      }
    }
    return resolved;
  }

  /** Resolves images through Stage 1 + OCR caption for text-only models. */
  async resolveForText(images: MessageImageInput[]): Promise<ResolvedImage[]> {
    const resolved: ResolvedImage[] = [];
    for (const image of images) {
      const dataUrl = await this.stage1(image);
      if (!dataUrl) {
        continue;
      }
      let caption: string | undefined;
      if (this.options.ocr) {
        try {
          caption = await this.options.ocr(image);
        } catch (error) {
          logWarn("OCR failed for image; continuing without caption.", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      resolved.push({ input: image, dataUrl, caption });
    }
    return resolved;
  }

  private async stage1(image: MessageImageInput): Promise<string | undefined> {
    const metrics = this.options.metrics;
    // 0. Already a data URL — nothing to fetch.
    if (isImageDataUrl(image.url)) {
      return image.url;
    }

    // 1. NapCat local cache (soft/hard timeouts).
    if (this.options.localizeDataUrl) {
      try {
        const dataUrl = await withTimeout(
          this.options.localizeDataUrl(image),
          this.options.localSoftTimeoutMs ?? DEFAULT_OPTIONS.localSoftTimeoutMs,
        );
        if (dataUrl && isImageDataUrl(dataUrl)) {
          metrics?.inc("image_stage1_local_hit");
          return dataUrl;
        }
      } catch (error) {
        logWarn("Stage1 localizeDataUrl failed; falling back to proxy fetch.", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } else if (this.options.localize && image.file && !isHttpUrl(image.file)) {
      try {
        const startedAt = Date.now();
        const localPath = await withTimeout(
          this.options.localize(image),
          this.options.localSoftTimeoutMs ?? DEFAULT_OPTIONS.localSoftTimeoutMs,
        );
        if (localPath) {
          try {
            const dataUrl = await withTimeout(
              readImageFileAsDataUrl(localPath),
              (this.options.localHardTimeoutMs ?? DEFAULT_OPTIONS.localHardTimeoutMs) - (Date.now() - startedAt),
            );
            metrics?.inc("image_stage1_local_hit");
            return dataUrl;
          } catch (error) {
            logWarn("Stage1 local cache read failed.", {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      } catch (error) {
        logWarn("Stage1 localize failed; falling back to proxy fetch.", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // 2. Internal HTTP proxy fetch of the QQ image host.
    const sourceUrl = isHttpUrl(image.url) ? image.url : isHttpUrl(image.file) ? image.file : undefined;
    if (sourceUrl) {
      const proxyStartedAt = Date.now();
      try {
        const dataUrl = await withTimeout(
          downloadImageAsDataUrl(sourceUrl),
          this.options.proxySoftTimeoutMs ?? DEFAULT_OPTIONS.proxySoftTimeoutMs,
        );
        metrics?.inc("image_stage1_proxy_hit");
        return dataUrl;
      } catch (error) {
        const remaining = (this.options.proxyHardTimeoutMs ?? DEFAULT_OPTIONS.proxyHardTimeoutMs) - (Date.now() - proxyStartedAt);
        if (remaining > 0) {
          try {
            const dataUrl = await withTimeout(downloadImageAsDataUrl(sourceUrl), remaining);
            metrics?.inc("image_stage1_proxy_retry_hit");
            return dataUrl;
          } catch (retryError) {
            logWarn("Stage1 proxy retry failed.", {
              error: retryError instanceof Error ? retryError.message : String(retryError),
            });
          }
        }
      }
    }

    // 3. Unavailable.
    metrics?.inc("image_stage1_failure");
    logWarn("Image stage1 failed; entering failure tier.", { tier: "image_unavailable" });
    throw new ImagePipelineError("image_unavailable", "image could not be materialized");
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
