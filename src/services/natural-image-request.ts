import type { ParsedGroupMessage } from "../utils/message-parser.js";
import {
  parseAvatarEditRequest,
  type AvatarEditRequest,
} from "./avatar-edit-request.js";
import { parseImagePrompt } from "./image-generation-service.js";

export type NaturalImageReferenceSource = "attachment" | "reply";

/**
 * The only action surface exposed by the image-intent routing plugin. It
 * deliberately carries no prompt, identity, image URL, or execution option;
 * those values are recovered and validated locally from trusted segments.
 */
export type NaturalImageIntentAction =
  | "chat"
  | "generate"
  | "edit"
  | "avatar_edit"
  | "clarification";

export type NaturalImageClarificationReason =
  | "avatar_syntax"
  | "missing_avatar_target"
  | "missing_edit_instruction"
  | "request_cancelled"
  | "invalid_ratio"
  | "missing_prompt"
  | "missing_reference"
  | "reference_requires_edit_instruction"
  | "unrecognized_intent";

export type NaturalImageRequest =
  | {
      kind: "generate";
      prompt: string;
      size?: string;
    }
  | {
      kind: "edit";
      prompt: string;
      size?: string;
      referenceSource: NaturalImageReferenceSource;
    }
  | {
      kind: "avatar_edit";
      request: AvatarEditRequest;
      prompt: string;
      size?: string;
    }
  | {
      kind: "clarification";
      reason: NaturalImageClarificationReason;
    };

/**
 * Facts that must be established before natural-language image parsing. The
 * parser deliberately does not turn a textual @, a reply id, or an arbitrary
 * image into an authorization signal on its own.
 */
export interface NaturalImageIntentDetails {
  avatarTargetText?: string;
  /** Safe local rendering of the target in promptText, never model output. */
  avatarTargetPromptText?: string;
  missingFields?: ("target" | "instruction" | "reference")[];
}

export interface NaturalImageRequestInput {
  message: Pick<ParsedGroupMessage, "text" | "images" | "replyMessageId">;
  /**
   * Optional display-safe prompt text reconstructed from trusted message
   * segments. It must not contain identifiers from structured @ segments.
   * Local avatar-target parsing continues to use `message.text`.
   */
  promptText?: string;
  /** True only when the original platform event contained a real @bot segment. */
  hasTrustedBotMention: boolean;
  /** True only when the original platform event contained the matching reply segment. */
  hasTrustedReply: boolean;
  /** True only when replyMessageId belongs to a live generated-image receipt in this group. */
  replyIsGeneratedImage: boolean;
  /** Prevent a configured explicit command from being reinterpreted as natural text. */
  isExplicitCommand?: boolean;
}

/**
 * Converts an already-authorized, model-selected image action into the same
 * bounded request used by explicit commands. The router never supplies a
 * prompt or an identity; it can only choose this action enum.
 */
export function parseNaturalImageRequestForIntent(
  input: NaturalImageRequestInput,
  action: NaturalImageIntentAction,
  details?: NaturalImageIntentDetails,
): NaturalImageRequest | undefined {
  const text = input.message.text.trim();
  if (input.isExplicitCommand || text.startsWith("#")) return undefined;
  const promptText = (input.promptText ?? text).trim();

  const hasAttachment = input.message.images.length > 0;
  const hasTrustedReply = Boolean(input.message.replyMessageId && input.hasTrustedReply);
  const hasGeneratedReply = hasTrustedReply && input.replyIsGeneratedImage;
  const hasReference = hasAttachment || hasTrustedReply;
  const isAuthorized = input.hasTrustedBotMention || hasGeneratedReply;

  if (action === "chat" || action === "clarification") return undefined;

  if (action === "avatar_edit") {
    // A reply to a generated image can authorize its own edit, but cannot
    // authorize selecting somebody's avatar or creating a new image.
    if (!input.hasTrustedBotMention) return undefined;
    if (details) {
      if (!details.avatarTargetText || details.missingFields?.includes("target")) return { kind: "clarification", reason: "missing_avatar_target" };
      if (details.missingFields?.includes("instruction")) return { kind: "clarification", reason: "missing_edit_instruction" };
      const avatarPrompt = stripAvatarTarget(
        promptText,
        details.avatarTargetText,
        details.avatarTargetPromptText,
      );
      const parsed = parsePrompt(avatarPrompt);
      if (!parsed) return { kind: "clarification", reason: "invalid_ratio" };
      if (!parsed.prompt) return { kind: "clarification", reason: "missing_edit_instruction" };
      return { kind: "avatar_edit", request: { targetText: details.avatarTargetText, action: parsed.prompt,
        hasExplicitAvatarWord: /头像/u.test(text) }, prompt: parsed.prompt, ...(parsed.size ? { size: parsed.size } : {}) };
    }
    const avatar = parseAvatarEditRequest(text);
    if (avatar.kind === "invalid_avatar_edit") {
      return { kind: "clarification", reason: "avatar_syntax" };
    }
    if (avatar.kind !== "avatar_edit") {
      return { kind: "clarification", reason: "avatar_syntax" };
    }
    const promptAvatar = parseAvatarEditRequest(promptText);
    const promptAction = promptAvatar.kind === "avatar_edit"
      ? promptAvatar.request.action
      : avatar.request.action;
    const parsed = parsePrompt(promptAction);
    if (!parsed) return { kind: "clarification", reason: "invalid_ratio" };
    if (!parsed.prompt) return { kind: "clarification", reason: "missing_prompt" };
    return {
      kind: "avatar_edit",
      request: { ...avatar.request, action: parsed.prompt },
      prompt: parsed.prompt,
      ...(parsed.size ? { size: parsed.size } : {}),
    };
  }

  if (action === "generate") {
    if (!input.hasTrustedBotMention) return undefined;
    if (details?.missingFields?.includes("instruction")) return { kind: "clarification", reason: "missing_prompt" };
    // Preserve the raw user wording for arbitrary requests, while removing
    // only a deterministic generation lead when it is present. The routing
    // model never creates or rewrites the prompt. A router-selected generation
    // deliberately ignores attached or quoted media instead of turning into an
    // edit merely because media is present on the message.
    const parsed = parsePrompt(findGenerationRequest(promptText)?.[1] ?? promptText);
    if (!parsed) return { kind: "clarification", reason: "invalid_ratio" };
    if (!parsed.prompt) return { kind: "clarification", reason: "missing_prompt" };
    return {
      kind: "generate",
      prompt: parsed.prompt,
      ...(parsed.size ? { size: parsed.size } : {}),
    };
  }

  if (!isAuthorized) return undefined;
  if (!hasReference) return { kind: "clarification", reason: "missing_reference" };
  if (details?.missingFields?.includes("instruction")) return { kind: "clarification", reason: "missing_edit_instruction" };
  const parsed = parsePrompt(promptText);
  if (!parsed) return { kind: "clarification", reason: "invalid_ratio" };
  if (!parsed.prompt) return { kind: "clarification", reason: "missing_prompt" };
  return {
    kind: "edit",
    prompt: parsed.prompt,
    ...(parsed.size ? { size: parsed.size } : {}),
    referenceSource: hasTrustedReply ? "reply" : "attachment",
  };
}

function stripAvatarTarget(prompt: string, target: string, safeTarget: string | undefined): string {
  const phrase = target === "我"
    ? "(?:我本人|我自己|我的|我|本人|自己)"
    : escapeRegex(safeTarget?.trim() || target.trim());
  if (!phrase) return prompt;
  return prompt
    .replace(new RegExp(`(?:用|给|把|让|以|拿)?\\s*${phrase}\\s*(?:的\\s*)?头像`, "gu"), " ")
    // Target-only supplements are kept for local identity verification but
    // must not expose that identity in the image model's prompt.
    .replace(new RegExp(`(?:^|\\s)(?:用|给|把|让|以|拿)?\\s*${phrase}\\s*(?:的)?[。！!]?\\s*$`, "u"), " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const DRAW_GENERATION_REQUEST = /^(?:请\s*)?(?:(?:帮我|给我|麻烦(?:你)?|帮忙)\s*)?(?:画|绘制)\s*(?:一(?:张|幅|副))?\s*(?:图片|图|图像|照片|插画|海报|壁纸)?(?:[：:,，]\s*|\s+)?([\s\S]*)$/u;
// Generic verbs such as "做" and "创建" are common in ordinary requests
// (for example, "做一个表格"). Keep them behind an explicit image noun so a
// real @ mention still cannot accidentally consume an image request.
const EXPLICIT_IMAGE_GENERATION_REQUEST = /^(?:请\s*)?(?:(?:帮我|给我|麻烦(?:你)?|帮忙)\s*)?(?:生成|制作|创建|做|来)\s*(?:(?:一(?:张|幅|副))\s*(?:图片|图|图像|照片|插画|海报|壁纸)?|(?:图片|图|图像|照片|插画|海报|壁纸))(?:[：:,，]\s*|\s+)?([\s\S]*)$/u;
const EDIT_WORDING = /(?:改成|改图|修改|变成|换成|替换|编辑|修图|加上|添加|去掉|删除|移除|抹掉|加(?:一|个|些|点))/u;
const PAGE_WORDING = /(?:网页|网站|html|静态页面|静态网页|web页面)/iu;
const IMAGE_ACTION_WORDING = /(?:生成|画|绘制|制作|创建|做|生图|改图|改成|修改|变成|换成|替换|编辑|修图|加上|添加|去掉|删除|移除|抹掉)/u;

/**
 * Detects only deliberate, bounded natural-language image requests. It is a
 * pure parser: caller-provided trust facts establish mention/reply authority,
 * while reference downloads, member lookup, permissions, and model calls stay
 * outside this module.
 */
export function parseNaturalImageRequest(
  input: NaturalImageRequestInput,
): NaturalImageRequest | undefined {
  const text = input.message.text.trim();
  if (!text) return undefined;
  if (input.isExplicitCommand || text.startsWith("#")) return undefined;
  if (isQuestionOrNegative(text) || PAGE_WORDING.test(text)) return undefined;

  const hasAttachment = input.message.images.length > 0;
  const hasTrustedReply = Boolean(input.message.replyMessageId && input.hasTrustedReply);
  const hasGeneratedReply = hasTrustedReply && input.replyIsGeneratedImage;
  const hasReference = hasAttachment || hasTrustedReply;
  const isAuthorized = input.hasTrustedBotMention || hasGeneratedReply;

  if (input.hasTrustedBotMention && /^(?:(?:让|将|把)\s*|我\s*(?:的\s*)?头像)/u.test(text)) {
    const avatar = parseAvatarEditRequest(text);
    if (avatar.kind === "avatar_edit") {
      const parsed = parsePrompt(avatar.request.action);
      if (!parsed) return { kind: "clarification", reason: "invalid_ratio" };
      if (!parsed.prompt) return { kind: "clarification", reason: "missing_prompt" };
      return {
        kind: "avatar_edit",
        request: { ...avatar.request, action: parsed.prompt },
        prompt: parsed.prompt,
        ...(parsed.size ? { size: parsed.size } : {}),
      };
    }
    if (avatar.kind === "invalid_avatar_edit") {
      return { kind: "clarification", reason: "avatar_syntax" };
    }
  }

  const generation = findGenerationRequest(text);
  if (generation) {
    if (!input.hasTrustedBotMention) return undefined;
    if (hasReference) return { kind: "clarification", reason: "reference_requires_edit_instruction" };
    const parsed = parsePrompt(generation[1] ?? "");
    if (!parsed) return { kind: "clarification", reason: "invalid_ratio" };
    if (!parsed.prompt) return { kind: "clarification", reason: "missing_prompt" };
    return {
      kind: "generate",
      prompt: parsed.prompt,
      ...(parsed.size ? { size: parsed.size } : {}),
    };
  }

  if (EDIT_WORDING.test(text)) {
    if (!isAuthorized) return undefined;
    if (!hasReference) return { kind: "clarification", reason: "missing_reference" };
    const parsed = parsePrompt(text);
    if (!parsed) return { kind: "clarification", reason: "invalid_ratio" };
    if (!parsed.prompt) return { kind: "clarification", reason: "missing_prompt" };
    return {
      kind: "edit",
      prompt: parsed.prompt,
      ...(parsed.size ? { size: parsed.size } : {}),
        referenceSource: hasTrustedReply ? "reply" : "attachment",
    };
  }

  return undefined;
}

function findGenerationRequest(text: string): RegExpExecArray | undefined {
  return DRAW_GENERATION_REQUEST.exec(text) ?? EXPLICIT_IMAGE_GENERATION_REQUEST.exec(text) ?? undefined;
}

export function isPoliteGenerationQuestion(text: string): boolean {
  return /[?？]\s*$/u.test(text) || /(?:吗|么|好不好|行不行|可不可以|可以不可以|能不能|会不会|是否)\s*[。！!]?$/u.test(text) ||
    /(?:能不能|可不可以|能否|是否可以|你能|可以帮|能帮)/u.test(text);
}

function parsePrompt(raw: string): { prompt: string; size?: string } | undefined {
  try {
    return parseImagePrompt(raw);
  } catch {
    return undefined;
  }
}

function isQuestionOrNegative(text: string): boolean {
  if (/[?？]\s*$/u.test(text)) return true;
  // Chinese questions often omit the final question mark. Treat the common
  // interrogative endings as questions before matching an otherwise valid
  // drawing imperative (for example, "帮我画一张风景可以吗").
  if (/(?:吗|么|好不好|行不行|可不可以|可以不可以|能不能|会不会|是否)\s*$/u.test(text)) return true;
  if (/^(?:能(?:不能)?|可以|会不会|是否|怎么|如何|为什么|能否|请问|想问)/u.test(text)) return true;
  if (new RegExp(`(?:能(?:不能)?|可以|会不会|是否|怎么|如何|为什么|能否).{0,24}${IMAGE_ACTION_WORDING.source}`, "u").test(text)) return true;
  // These are requests to explain or evaluate an image, not requests to
  // generate one. Keep the patterns narrow so phrases such as "教程海报"
  // can still be valid visual descriptions.
  if (/(?:画一张图|画图|生成(?:一张)?图(?:片)?|改图|修图).{0,16}(?:的)?(?:教程|教学|步骤|方法)(?:[。！!?？]|$)/u.test(text)) return true;
  if (/(?:画|绘制|生成|制作|改图|修图)(?:得|的).{0,16}(?:好看|漂亮|好美|不错|很好|厉害|真棒|好棒)(?:[。！!?？]|$)/u.test(text)) return true;
  return /^(?:请\s*)?(?:不要|别|无需|不用|不必|不需要|不想|停止|取消|先别)\s*(?:(?:帮我|给我)\s*)?(?:生成|画|绘制|做|制作|创建|改图|编辑|修图|图片|图)/u.test(text);
}
