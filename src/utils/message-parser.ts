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
    return normalizeText(stripCqNonTextSegments(message));
  }

  const parts: string[] = [];
  for (const segment of message) {
    if (typeof segment === "string") {
      parts.push(stripCqNonTextSegments(segment));
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
    return extractCqImages(message);
  }

  const images: MessageImageInput[] = [];
  for (const segment of message) {
    if (typeof segment === "string") {
      images.push(...extractCqImages(segment));
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

  const url = readSegmentData(segment, "url");
  if (url) {
    return url;
  }

  const file = readSegmentData(segment, "file");
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
  const file = readSegmentData(segment, "file");
  const summary = readSegmentData(segment, "summary");

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
    return parseCqStringMessage(message, botQq);
  }

  let hasAtBot = false;
  const parts: string[] = [];
  const plainTextParts: string[] = [];
  const images: MessageImageInput[] = [];
  const verifiedMentionUserIds: string[] = [];
  let replyMessageId: string | undefined;

  for (const segment of message) {
    if (typeof segment === "string") {
      const parsed = parseCqStringMessage(segment, botQq);
      hasAtBot ||= parsed.hasAtBot;
      parts.push(parsed.text);
      plainTextParts.push(stripAllCqSegments(segment));
      images.push(...parsed.images);
      verifiedMentionUserIds.push(...parsed.verifiedMentionUserIds);
      replyMessageId ??= parsed.replyMessageId;
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
const CQ_SEGMENT_PATTERN = /\[CQ:([a-z_]+)((?:,[^\]]*)?)\]/gi;

interface CqSegment {
  type: string;
  data: Record<string, string>;
}

function parseCqStringMessage(message: string, botQq: string): ParsedGroupMessage {
  const textWithoutNonText = stripCqNonTextSegments(message);
  const escapedQq = escapeRegex(botQq);
  const cqAtTargets = extractCqAtTargets(textWithoutNonText);
  const plainBotAtPattern = new RegExp(`(^|\\s)@${escapedQq}\\b`);
  const botAtReplacementPattern = new RegExp(`(^|\\s)@${escapedQq}\\b`, "g");
  const replyMessageId = extractCqSegments(message)
    .find((segment) => segment.type === "reply")?.data.id?.trim();

  return {
    hasAtBot: cqAtTargets.includes(botQq) || plainBotAtPattern.test(textWithoutNonText),
    text: normalizeText(
      textWithoutNonText
        .replace(CQ_AT_PATTERN, (_match, rawTarget: string) => formatCqAtText(rawTarget, botQq))
        .replace(botAtReplacementPattern, " "),
    ),
    images: extractCqImages(message),
    verifiedMentionUserIds: normalizeMentionUserIds(cqAtTargets.filter((target) => target !== botQq)),
    plainTextMentionCandidates: extractPlainTextMentionCandidates(
      textWithoutNonText.replace(CQ_AT_PATTERN, " "),
      botQq,
    ),
    replyMessageId,
  };
}

function extractCqImages(text: string): MessageImageInput[] {
  const images: MessageImageInput[] = [];
  for (const segment of extractCqSegments(text)) {
    if (segment.type !== "image") {
      continue;
    }
    const image = extractImageInput({ type: "image", data: segment.data });
    if (image) {
      images.push(image);
    }
  }
  return images;
}

function extractCqSegments(text: string): CqSegment[] {
  const segments: CqSegment[] = [];
  for (const match of text.matchAll(CQ_SEGMENT_PATTERN)) {
    const rawType = match[1]?.trim().toLowerCase();
    if (!rawType) {
      continue;
    }
    const data: Record<string, string> = {};
    const rawParameters = match[2]?.slice(1) ?? "";
    for (const parameter of rawParameters.split(",")) {
      const separator = parameter.indexOf("=");
      if (separator <= 0) {
        continue;
      }
      const key = parameter.slice(0, separator).trim().toLowerCase();
      if (!key) {
        continue;
      }
      data[key] = decodeCqValue(parameter.slice(separator + 1));
    }
    segments.push({ type: rawType, data });
  }
  return segments;
}

function stripCqNonTextSegments(text: string): string {
  return text.replace(CQ_SEGMENT_PATTERN, (match, rawType: string) => {
    const type = rawType.trim().toLowerCase();
    return type === "image" || type === "reply" ? " " : match;
  });
}

function stripAllCqSegments(text: string): string {
  return text.replace(CQ_SEGMENT_PATTERN, " ");
}

function decodeCqValue(value: string): string {
  return value
    .replace(/&#91;/g, "[")
    .replace(/&#93;/g, "]")
    .replace(/&#44;/g, ",")
    .replace(/&amp;/g, "&")
    .trim();
}

function readSegmentData(segment: Exclude<MessageSegment, string>, key: string): string | undefined {
  const value = segment.data?.[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized || undefined;
}

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
