import type { ParsedGroupMessage } from "../utils/message-parser.js";
import {
  parseAvatarEditRequest,
  type AvatarEditRequest,
} from "./avatar-edit-request.js";
import { parseImagePrompt } from "./image-generation-service.js";

export type NaturalImageReferenceSource = "attachment" | "reply";

export type NaturalImageClarificationReason =
  | "avatar_syntax"
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
export interface NaturalImageRequestInput {
  message: Pick<ParsedGroupMessage, "text" | "images" | "replyMessageId">;
  /** True only when the original platform event contained a real @bot segment. */
  hasTrustedBotMention: boolean;
  /** True only when the original platform event contained the matching reply segment. */
  hasTrustedReply: boolean;
  /** True only when replyMessageId belongs to a live generated-image receipt in this group. */
  replyIsGeneratedImage: boolean;
  /** Prevent a configured explicit command from being reinterpreted as natural text. */
  isExplicitCommand?: boolean;
}

const DRAW_GENERATION_REQUEST = /^(?:请\s*)?(?:(?:帮我|给我|麻烦(?:你)?|帮忙)\s*)?(?:画|绘制)\s*(?:一(?:张|幅|副))?\s*(?:图片|图|图像|照片|插画|海报|壁纸)?(?:[：:,，]\s*|\s+)?([\s\S]*)$/u;
// Generic verbs such as "做" and "创建" are common in ordinary requests
// (for example, "做一个表格"). Keep them behind an explicit image noun so a
// real @ mention still cannot accidentally consume an image request.
const EXPLICIT_IMAGE_GENERATION_REQUEST = /^(?:请\s*)?(?:(?:帮我|给我|麻烦(?:你)?|帮忙)\s*)?(?:生成|制作|创建|做|来)\s*(?:(?:一(?:张|幅|副))\s*(?:图片|图|图像|照片|插画|海报|壁纸)?|(?:图片|图|图像|照片|插画|海报|壁纸))(?:[：:,，]\s*|\s+)?([\s\S]*)$/u;
const EDIT_WORDING = /(?:改成|改图|修改|变成|换成|替换|编辑|修图|加上|添加|去掉|删除|移除|抹掉|加(?:一|个|些|点))/u;
const IMAGE_INTENT_WORDING = /(?:生成|画|绘制|生图|改图|编辑|修图|头像|图片|图像|插画|海报|壁纸)/u;
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
  if (!text) {
    // A real direct mention with no meaningful text is intentionally a
    // clarification, not a model request. This gives the caller a compact
    // usage hint without treating a typed @ or a reply alone as authority.
    return input.hasTrustedBotMention && !input.isExplicitCommand
      ? { kind: "clarification", reason: "unrecognized_intent" }
      : undefined;
  }
  if (input.isExplicitCommand || text.startsWith("#")) return undefined;
  if (isQuestionOrNegative(text) || PAGE_WORDING.test(text)) return undefined;

  const hasAttachment = input.message.images.length > 0;
  const hasTrustedReply = Boolean(input.message.replyMessageId && input.hasTrustedReply);
  const hasGeneratedReply = hasTrustedReply && input.replyIsGeneratedImage;
  const hasReference = hasAttachment || hasTrustedReply;
  const isAuthorized = input.hasTrustedBotMention || hasGeneratedReply;

  if (input.hasTrustedBotMention) {
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

  if (input.hasTrustedBotMention && IMAGE_INTENT_WORDING.test(text)) {
    return { kind: "clarification", reason: "unrecognized_intent" };
  }
  return undefined;
}

function findGenerationRequest(text: string): RegExpExecArray | undefined {
  return DRAW_GENERATION_REQUEST.exec(text) ?? EXPLICIT_IMAGE_GENERATION_REQUEST.exec(text) ?? undefined;
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
