/**
 * The image-intent model receives this deliberately small, identity-free
 * contract. Callers must replace real member mentions with opaque markers
 * before assigning `sanitizedText`; this module never accepts QQ ids, image
 * URLs, archive ids, or target identities.
 */
export interface ImageIntentRouterInput {
  /** Sanitized message content, with real member mentions represented opaquely. */
  sanitizedText: string;
  pending?: { action: ImageIntentAction; missingFields: ImageIntentMissingField[]; messages: string[] };
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
 * ledger. The upstream tool may also extract bounded source-backed request details.
 */
export type ImageIntentMissingField = "target" | "instruction" | "reference";
export interface ImageIntentDetails {
  /** Exact excerpt of the sanitized current or pending user message. */
  avatarTarget?: string;
  missingFields?: ImageIntentMissingField[];
  continuesPending?: boolean;
}

export interface ImageIntentRoute extends ImageIntentDetails {
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
      return { action: result.action, ...validateImageIntentDetails(result), modelId, model };
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
  const pending = normalizePendingImageIntent(input?.pending);
  return {
    sanitizedText: text,
    ...(pending ? { pending } : {}),
    facts: {
      hasTrustedBotMention: facts?.hasTrustedBotMention === true,
      hasTrustedReply: facts?.hasTrustedReply === true,
      replyIsGeneratedImage: facts?.replyIsGeneratedImage === true,
      attachmentCount: normalizeAttachmentCount(facts?.attachmentCount),
    },
  };
}

function normalizePendingImageIntent(value: unknown): ImageIntentRouterInput["pending"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const pending = value as { action?: unknown; missingFields?: unknown; messages?: unknown };
  const action = pending.action;
  const missingFields = pending.missingFields;
  const messages = pending.messages;
  if (!isImageIntentAction(action) || !Array.isArray(missingFields) || missingFields.length > 3 ||
    !missingFields.every(isImageIntentMissingField) || !Array.isArray(messages) ||
    !messages.every((message): message is string => typeof message === "string")) {
    return undefined;
  }
  return {
    action,
    missingFields: [...new Set(missingFields)],
    messages: messages.slice(-8).map(message => message.replace(/\u0000/g, "").slice(0, 4_000)),
  };
}

function isImageIntentMissingField(value: unknown): value is ImageIntentMissingField {
  return value === "target" || value === "instruction" || value === "reference";
}

function normalizeAttachmentCount(value: unknown): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(4, Math.floor(value as number)));
}

export function validateImageIntentDetails(value: ImageIntentDetails): ImageIntentDetails {
  if (value.avatarTarget !== undefined && (typeof value.avatarTarget !== "string" ||
      !value.avatarTarget.trim() || value.avatarTarget.length > 200)) throw new ImageIntentRouterError("invalid_response");
  if (value.missingFields !== undefined && (!Array.isArray(value.missingFields) ||
      value.missingFields.length > 3 || value.missingFields.some(field => field !== "target" && field !== "instruction" && field !== "reference"))) {
    throw new ImageIntentRouterError("invalid_response");
  }
  if (value.continuesPending !== undefined && typeof value.continuesPending !== "boolean") throw new ImageIntentRouterError("invalid_response");
  return {
    ...(value.avatarTarget === undefined ? {} : { avatarTarget: value.avatarTarget.trim() }),
    ...(value.missingFields === undefined ? {} : { missingFields: [...new Set(value.missingFields)] }),
    ...(value.continuesPending === undefined ? {} : { continuesPending: value.continuesPending }),
  };
}
