import type { MessageImageInput, MessageSegment } from "../types.js";

export interface ParsedGroupMessage {
  hasAtBot: boolean;
  text: string;
  images: MessageImageInput[];
  /**
   * Targets carried by a platform message segment, rather than inferred from
   * free-form text. These are the only mention targets that may authorize
   * person-specific prompt context or an outbound @.
   */
  verifiedMentionUserIds: string[];
  /**
   * QQ numbers and @-style strings typed into message text. Keep them separate
   * for non-authorizing text handling; they do not establish an identity link.
   */
  plainTextMentionCandidates: string[];
  replyMessageId?: string;
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function extractTextFromMessage(message: MessageSegment[] | string): string {
  if (typeof message === "string") {
    return normalizeText(message);
  }

  const parts: string[] = [];
  for (const segment of message) {
    if (typeof segment === "string") {
      parts.push(segment);
      continue;
    }

    if (segment.type === "text") {
      parts.push(segment.data?.text ?? "");
    }
  }

  return normalizeText(parts.join(" "));
}

export function extractImagesFromMessage(message: MessageSegment[] | string): MessageImageInput[] {
  if (typeof message === "string") {
    return [];
  }

  const images: MessageImageInput[] = [];
  for (const segment of message) {
    if (typeof segment === "string") {
      continue;
    }

    const imageInput = extractImageInput(segment);
    if (imageInput) {
      images.push(imageInput);
    }
  }

  return images;
}

function extractImageUrl(segment: Exclude<MessageSegment, string>): string | undefined {
  if (segment.type !== "image") {
    return undefined;
  }

  const url = segment.data?.url?.trim();
  if (url) {
    return url;
  }

  const file = segment.data?.file?.trim();
  if (file && /^https?:\/\//i.test(file)) {
    return file;
  }

  return undefined;
}

function extractImageInput(segment: Exclude<MessageSegment, string>): MessageImageInput | undefined {
  if (segment.type !== "image") {
    return undefined;
  }

  const url = extractImageUrl(segment);
  const file = segment.data?.file?.trim();
  const summary = segment.data?.summary?.trim();

  if (!url && !file) {
    return undefined;
  }

  return {
    url,
    file,
    summary,
  };
}

export function parseGroupMessage(
  message: MessageSegment[] | string,
  botQq: string,
): ParsedGroupMessage {
  if (typeof message === "string") {
    const text = normalizeText(message);
    const escapedQq = escapeRegex(botQq);
    const cqReplyPattern = /\[CQ:reply,id=([^\],]+)(?:,[^\]]*)?\]/i;
    const replyMessageId = text.match(cqReplyPattern)?.[1]?.trim();
    const textWithoutReply = text.replace(cqReplyPattern, " ");
    const cqAtTargets = extractCqAtTargets(textWithoutReply);
    const plainBotAtPattern = new RegExp(`(^|\\s)@${escapedQq}\\b`);
    const botAtReplacementPattern = new RegExp(`(^|\\s)@${escapedQq}\\b`, "g");
    const hasAtBot = cqAtTargets.includes(botQq) || plainBotAtPattern.test(text);

    return {
      hasAtBot,
      text: normalizeText(
        textWithoutReply
          .replace(CQ_AT_PATTERN, (_match, rawTarget: string) => formatCqAtText(rawTarget, botQq))
          .replace(botAtReplacementPattern, " "),
      ),
      images: [],
      verifiedMentionUserIds: normalizeMentionUserIds(cqAtTargets.filter((target) => target !== botQq)),
      plainTextMentionCandidates: extractPlainTextMentionCandidates(
        textWithoutReply.replace(CQ_AT_PATTERN, " "),
        botQq,
      ),
      replyMessageId,
    };
  }

  let hasAtBot = false;
  const parts: string[] = [];
  const plainTextParts: string[] = [];
  const images: MessageImageInput[] = [];
  const verifiedMentionUserIds: string[] = [];
  let replyMessageId: string | undefined;

  for (const segment of message) {
    if (typeof segment === "string") {
      parts.push(segment);
      plainTextParts.push(segment);
      continue;
    }

    if (segment.type === "at") {
      const targetQq = String(segment.data?.qq ?? "").trim();
      if (targetQq === botQq) {
        hasAtBot = true;
      } else if (targetQq) {
        verifiedMentionUserIds.push(targetQq);
        parts.push(`@${targetQq}`);
      }
      continue;
    }

    if (segment.type === "reply") {
      const id = String(segment.data?.id ?? "").trim();
      if (id) {
        replyMessageId = id;
      }
      continue;
    }

    if (segment.type === "text") {
      parts.push(segment.data?.text ?? "");
      plainTextParts.push(segment.data?.text ?? "");
      continue;
    }

    const imageInput = extractImageInput(segment);
    if (imageInput) {
      images.push(imageInput);
    }
  }

  return {
    hasAtBot,
    text: normalizeText(parts.join(" ")),
    images,
    verifiedMentionUserIds: normalizeMentionUserIds(verifiedMentionUserIds),
    plainTextMentionCandidates: extractPlainTextMentionCandidates(plainTextParts.join(" "), botQq),
    replyMessageId,
  };
}

const CQ_AT_PATTERN = /\[CQ:at,qq=([^,\]]+)(?:,[^\]]*)?\]/gi;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractCqAtTargets(text: string): string[] {
  const targets: string[] = [];
  for (const match of text.matchAll(CQ_AT_PATTERN)) {
    const target = match[1]?.trim();
    if (target) {
      targets.push(target);
    }
  }
  return targets;
}

function formatCqAtText(rawTarget: string, botQq: string): string {
  const target = rawTarget.trim();
  return target && target !== botQq ? `@${target}` : " ";
}

function extractPlainTextMentionCandidates(text: string, botQq: string): string[] {
  const candidates = new Set<string>();
  const qqNumberPattern = /(?<!\d)(\d{5,12})(?!\d)/g;
  const plainAtPattern = /(^|[\s，,。！？!；;、])@([^\s@，,。！？!；;、()[\]{}<>《》"'`]+)/g;

  for (const match of text.matchAll(qqNumberPattern)) {
    const qq = match[1]?.trim();
    if (qq && qq !== botQq) {
      candidates.add(qq);
    }
  }

  for (const match of text.matchAll(plainAtPattern)) {
    const candidate = match[2]?.trim();
    if (!candidate || candidate === botQq) {
      continue;
    }

    candidates.add(candidate);
  }

  return [...candidates];
}

function normalizeMentionUserIds(userIds: string[]): string[] {
  return [...new Set(userIds.map((userId) => userId.trim()).filter(Boolean))];
}
