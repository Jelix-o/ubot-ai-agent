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
 *   1. Internal HTTP proxy fetching the QQ image host (soft 4s / hard 6s)
 *   2. NapCat get_image/data-URL bridge (hard 6s)
 *   3. NapCat local cache via `localize` callback (soft 800ms / hard 1.5s)
 *   4. Failure → tier "image_unavailable" (L1)
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
   * It follows a reachable HTTP image URL and precedes local file-cache reads.
   */
  localizeDataUrl?: (image: MessageImageInput) => Promise<string | undefined>;
  /** Local OCR/caption for pure-text models; returns the [图片内容: ...] text. */
  ocr?: (image: MessageImageInput) => Promise<string | undefined>;
  metrics?: Metrics;
  /** Soft/hard timeouts in ms. */
  localSoftTimeoutMs?: number;
  localHardTimeoutMs?: number;
  /** Worker-to-ingress get_image/data-URL bridge timeout in ms. */
  localizeDataUrlTimeoutMs?: number;
  proxySoftTimeoutMs?: number;
  proxyHardTimeoutMs?: number;
}

const DEFAULT_OPTIONS = {
  localSoftTimeoutMs: 800,
  localHardTimeoutMs: 1_500,
  localizeDataUrlTimeoutMs: 6_000,
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
    return this.resolveImages(images, async (image) => ({
      input: image,
      dataUrl: await this.stage1(image),
    }));
  }

  /** Resolves images through Stage 1 + OCR caption for text-only models. */
  async resolveForText(images: MessageImageInput[]): Promise<ResolvedImage[]> {
    return this.resolveImages(images, async (image) => {
      const dataUrl = await this.stage1(image);
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
      return { input: image, dataUrl, caption };
    });
  }

  /**
   * Keep usable images when a message contains a mix of reachable and stale
   * NapCat image references. A fixed failure is surfaced only when no image
   * could be materialized, so one broken attachment never discards the rest.
   */
  private async resolveImages(
    images: MessageImageInput[],
    resolve: (image: MessageImageInput) => Promise<ResolvedImage>,
  ): Promise<ResolvedImage[]> {
    const resolved: ResolvedImage[] = [];
    const failureTiers = new Set<ImageTier>();

    for (const image of images) {
      try {
        resolved.push(await resolve(image));
      } catch (error) {
        failureTiers.add(error instanceof ImagePipelineError ? error.tier : "image_unavailable");
      }
    }

    if (resolved.length > 0) {
      if (failureTiers.size > 0) {
        logWarn("Image materialization kept usable attachments after partial failures.", {
          event: "image_materialization_partial_success",
          imageCount: images.length,
          resolvedImageCount: resolved.length,
          failedImageCount: images.length - resolved.length,
          failureTiers: [...failureTiers],
        });
      }
      return resolved;
    }

    if (images.length > 0) {
      const tier = failureTiers.has("image_unavailable")
        ? "image_unavailable"
        : [...failureTiers][0] ?? "image_unavailable";
      logWarn("Image materialization produced no usable content.", {
        event: "image_materialization_no_content",
        imageCount: images.length,
        resolvedImageCount: 0,
        failureTiers: [...failureTiers],
      });
      throw new ImagePipelineError(tier, "no image inputs could be materialized");
    }

    return resolved;
  }

  private async stage1(image: MessageImageInput): Promise<string> {
    const metrics = this.options.metrics;
    // 0. Already a data URL — nothing to fetch.
    if (isImageDataUrl(image.url)) {
      return image.url;
    }

    // 1. Prefer the public QQ image URL when available. This avoids an
    // unnecessary get_image round trip and works when ingress has no shared
    // filesystem with NapCat.
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
            logWarn("Stage1 proxy retry failed; falling back to NapCat image resolution.", {
              error: retryError instanceof Error ? retryError.message : String(retryError),
            });
          }
        }
      }
    }

    // 2. Worker -> ingress -> NapCat get_image bridge. This is a separate
    // cross-process operation, not a local-cache read, so it receives its own
    // 6s timeout instead of the cache's 800ms fast-fail budget.
    if (this.options.localizeDataUrl) {
      try {
        const dataUrl = await withTimeout(
          this.options.localizeDataUrl(stripHttpImageSources(image)),
          this.options.localizeDataUrlTimeoutMs ?? DEFAULT_OPTIONS.localizeDataUrlTimeoutMs,
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
    }

    // 3. In-process local cache retains its existing fast soft/hard limits.
    if (this.options.localize && image.file && !isHttpUrl(image.file)) {
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

    // 4. Unavailable.
    metrics?.inc("image_stage1_failure");
    logWarn("Image stage1 failed; entering failure tier.", { tier: "image_unavailable" });
    throw new ImagePipelineError("image_unavailable", "image could not be materialized");
  }
}

function stripHttpImageSources(image: MessageImageInput): MessageImageInput {
  if (!isHttpUrl(image.url) && !isHttpUrl(image.file)) {
    return image;
  }
  return {
    ...image,
    ...(isHttpUrl(image.url) ? { url: undefined } : {}),
    ...(isHttpUrl(image.file) ? { file: undefined } : {}),
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timeout after ${timeoutMs}ms`));
    }, timeoutMs);
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
