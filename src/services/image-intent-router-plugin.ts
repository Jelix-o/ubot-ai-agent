/**
 * The image-intent model receives this deliberately small, identity-free
 * contract. Callers must replace real member mentions with opaque markers
 * before assigning `sanitizedText`; this module never accepts QQ ids, image
 * URLs, archive ids, or target identities.
 */
export interface ImageIntentRouterInput {
  /** Sanitized message content, with real member mentions represented opaquely. */
  sanitizedText: string;
  facts: {
    hasTrustedBotMention: boolean;
    hasTrustedReply: boolean;
    replyIsGeneratedImage: boolean;
    attachmentCount: number;
  };
}

export const IMAGE_INTENT_ACTIONS = [
  "chat",
  "generate",
  "edit",
  "avatar_edit",
  "clarification",
] as const;

export type ImageIntentAction = typeof IMAGE_INTENT_ACTIONS[number];

/**
 * Metadata identifies the configured router model for the durable route
 * ledger. The upstream tool itself is restricted to the `action` property.
 */
export interface ImageIntentRoute {
  action: ImageIntentAction;
  modelId: string;
  model: string;
}

export interface ImageIntentRouter {
  isConfigured(): Promise<boolean>;
  classify(input: ImageIntentRouterInput): Promise<ImageIntentRoute>;
}

/** The lower-level AI service contract, intentionally separate from chat tools. */
export interface ImageIntentClassifier {
  isImageIntentConfigured(): Promise<boolean>;
  classifyImageIntent(input: ImageIntentRouterInput): Promise<ImageIntentRoute>;
}

export type ImageIntentRouterErrorCode = "unavailable" | "invalid_response";

/**
 * Safe, machine-readable failure for callers that need to persist an
 * unavailable routing result. It deliberately does not include upstream text
 * or user input in its message.
 */
export class ImageIntentRouterError extends Error {
  public readonly modelId?: string;
  public readonly model?: string;

  constructor(
    public readonly code: ImageIntentRouterErrorCode,
    options?: { cause?: unknown; modelId?: string; model?: string },
  ) {
    super(`image_intent_router_${code}`, options);
    this.name = "ImageIntentRouterError";
    const modelId = options?.modelId?.trim();
    const model = options?.model?.trim();
    if (modelId && model) {
      this.modelId = modelId;
      this.model = model;
    }
  }
}

/**
 * A narrow plugin boundary for natural-language image routing. It does not
 * execute an image request, download a reference, or resolve an avatar.
 */
export class ImageIntentRouterPlugin implements ImageIntentRouter {
  constructor(private readonly classifier: ImageIntentClassifier) {}

  async isConfigured(): Promise<boolean> {
    try {
      return await this.classifier.isImageIntentConfigured();
    } catch {
      return false;
    }
  }

  async classify(input: ImageIntentRouterInput): Promise<ImageIntentRoute> {
    const normalized = normalizeImageIntentRouterInput(input);
    try {
      const result = await this.classifier.classifyImageIntent(normalized);
      if (!isImageIntentAction(result?.action)) {
        throw new ImageIntentRouterError("invalid_response");
      }
      const modelId = typeof result?.modelId === "string" ? result.modelId.trim() : "";
      const model = typeof result?.model === "string" ? result.model.trim() : "";
      if (!modelId || !model) {
        throw new ImageIntentRouterError("invalid_response");
      }
      return { action: result.action, modelId, model };
    } catch (error) {
      if (error instanceof ImageIntentRouterError) {
        throw error;
      }
      throw new ImageIntentRouterError("unavailable", { cause: error });
    }
  }
}

export function isImageIntentAction(value: unknown): value is ImageIntentAction {
  return typeof value === "string" && (IMAGE_INTENT_ACTIONS as readonly string[]).includes(value);
}

/**
 * Bounds model input without adding request-specific interpretation. The
 * caller is responsible for converting platform mention segments to opaque
 * tokens before this boundary.
 */
export function normalizeImageIntentRouterInput(input: ImageIntentRouterInput): ImageIntentRouterInput {
  const text = typeof input?.sanitizedText === "string"
    ? input.sanitizedText.replace(/\u0000/g, "").trim().slice(0, 4_000)
    : "";
  const facts = input?.facts;
  return {
    sanitizedText: text,
    facts: {
      hasTrustedBotMention: facts?.hasTrustedBotMention === true,
      hasTrustedReply: facts?.hasTrustedReply === true,
      replyIsGeneratedImage: facts?.replyIsGeneratedImage === true,
      attachmentCount: normalizeAttachmentCount(facts?.attachmentCount),
    },
  };
}

function normalizeAttachmentCount(value: unknown): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(4, Math.floor(value as number)));
}
