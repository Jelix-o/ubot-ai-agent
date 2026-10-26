import type { MessageImageInput, MessageSegment } from "../types.js";

const MAX_SEGMENTS = 64;
const MAX_TEXT_CHARS = 20_000;
const MAX_FIELD_CHARS = 4_096;

type CanonicalSegment =
  | { type: "text"; text: string }
  | { type: "at"; qq: string }
  | { type: "reply"; id: string }
  | { type: "image"; url?: string; file?: string; summary?: string };

/**
 * Persists only the message segment types that the worker can safely replay.
 * In particular, an `at` entry exists only when the platform supplied an
 * actual segment, so callers can distinguish it from text that merely looks
 * like an @ mention.
 */
export function serializeCanonicalMessageSegments(message: MessageSegment[] | string): string | undefined {
  const canonical: CanonicalSegment[] = [];
  const appendText = (text: string): boolean => appendCanonicalText(canonical, text);

  if (typeof message === "string") {
    // A raw CQ string has no platform provenance. A user can type the same
    // bytes as a CQ marker, so retain it as text rather than turning it into
    // an authoritative mention, reply, or image segment.
    if (!appendText(message)) return undefined;
    return JSON.stringify(canonical);
  }

  for (const segment of message) {
    if (typeof segment === "string") {
      // OneBot's messagePostFormat array may contain text string entries.
      // Like a top-level raw message, those entries are not structured
      // platform segments and must never establish identity or reply trust.
      if (!appendText(segment)) return undefined;
      continue;
    }
    if (segment.type === "text") {
      const text = boundedText(segment.data?.text, MAX_TEXT_CHARS);
      if (text !== undefined && !appendText(text)) return undefined;
      continue;
    }
    if (segment.type === "at") {
      const qq = boundedString(segment.data?.qq, 64);
      if (qq !== undefined && !appendCanonicalSegment(canonical, { type: "at", qq })) return undefined;
      continue;
    }
    if (segment.type === "reply") {
      const id = boundedString(segment.data?.id, 160);
      if (id !== undefined && !appendCanonicalSegment(canonical, { type: "reply", id })) return undefined;
      continue;
    }
    if (segment.type === "image") {
      const url = boundedString(segment.data?.url, MAX_FIELD_CHARS);
      const file = boundedString(segment.data?.file, MAX_FIELD_CHARS);
      const summary = boundedString(segment.data?.summary, MAX_FIELD_CHARS);
      if (url || file) {
        const image: CanonicalSegment = {
          type: "image",
          ...(url ? { url } : {}),
          ...(file ? { file } : {}),
          ...(summary ? { summary } : {}),
        };
        if (!appendCanonicalSegment(canonical, image)) return undefined;
      }
    }
  }
  return JSON.stringify(canonical);
}

function appendCanonicalText(canonical: CanonicalSegment[], text: string): boolean {
  if (!text) return true;
  if (text.length > MAX_TEXT_CHARS) return false;
  const previous = canonical.at(-1);
  if (previous?.type === "text" && previous.text.length + text.length <= MAX_TEXT_CHARS) {
    previous.text += text;
    return true;
  }
  return appendCanonicalSegment(canonical, { type: "text", text });
}

function appendCanonicalSegment(canonical: CanonicalSegment[], segment: CanonicalSegment): boolean {
  if (canonical.length >= MAX_SEGMENTS) return false;
  canonical.push(segment);
  return true;
}

/** Returns validated worker-replayable segments, never raw persisted payloads. */
export function restoreCanonicalMessageSegments(value: string | null | undefined): MessageSegment[] | undefined {
  if (!value) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_SEGMENTS) return undefined;
  const restored: MessageSegment[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
    const record = item as Record<string, unknown>;
    const type = record.type;
    if (type === "text") {
      const text = boundedText(record.text, MAX_TEXT_CHARS);
      if (text === undefined) return undefined;
      restored.push({ type: "text", data: { text } });
      continue;
    }
    if (type === "at") {
      const qq = boundedString(record.qq, 64);
      if (qq === undefined) return undefined;
      restored.push({ type: "at", data: { qq } });
      continue;
    }
    if (type === "reply") {
      const id = boundedString(record.id, 160);
      if (id === undefined) return undefined;
      restored.push({ type: "reply", data: { id } });
      continue;
    }
    if (type === "image") {
      const url = boundedString(record.url, MAX_FIELD_CHARS);
      const file = boundedString(record.file, MAX_FIELD_CHARS);
      const summary = boundedString(record.summary, MAX_FIELD_CHARS);
      if (!url && !file) return undefined;
      restored.push({ type: "image", data: { ...(url ? { url } : {}), ...(file ? { file } : {}), ...(summary ? { summary } : {}) } });
      continue;
    }
    return undefined;
  }
  return restored;
}

export function hasCanonicalBotMention(value: string | null | undefined, botQq: string): boolean {
  const segments = restoreCanonicalMessageSegments(value);
  return Boolean(segments?.some((segment) =>
    typeof segment !== "string" && segment.type === "at" && String(segment.data?.qq ?? "").trim() === botQq,
  ));
}

/**
 * Compatibility replay for pre-canonical rows. Only an already-recorded
 * verified `@QQ` placeholder in the persisted text becomes an `at` segment.
 * There is no recoverable provenance for a legacy reply id or a standalone
 * mention id, so neither may authorize image references or avatar targets.
 */
export function rebuildLegacyGroupMessageSegments(input: {
  text: string;
  images: readonly MessageImageInput[];
  replyTo?: string | null;
  hasAtBot?: boolean;
  botQq: string;
  verifiedMentionUserIds: readonly string[];
}): MessageSegment[] {
  const segments: MessageSegment[] = [];
  // Legacy rows cannot recover the bot mention position. This preserves
  // existing command/chat compatibility; natural-image routing separately
  // requires a canonical trusted marker.
  if (input.hasAtBot) segments.push({ type: "at", data: { qq: input.botQq } });

  const verified = new Set(
    input.verifiedMentionUserIds.map((value) => value.trim()).filter((value) => /^\d{5,12}$/u.test(value)),
  );
  const text = input.text ?? "";
  let cursor = 0;
  const token = /(^|\s)@(\d{5,12})(?=\s|$)/gu;
  for (const match of text.matchAll(token)) {
    const prefix = match[1] ?? "";
    const userId = match[2] ?? "";
    if (!verified.has(userId)) continue;
    const start = match.index ?? 0;
    const before = text.slice(cursor, start) + prefix;
    if (before) segments.push({ type: "text", data: { text: before } });
    segments.push({ type: "at", data: { qq: userId } });
    cursor = start + match[0].length;
  }
  const tail = text.slice(cursor);
  if (tail) segments.push({ type: "text", data: { text: tail } });
  for (const image of input.images) {
    const url = boundedString(image.url, MAX_FIELD_CHARS);
    const file = boundedString(image.file, MAX_FIELD_CHARS);
    const summary = boundedString(image.summary, MAX_FIELD_CHARS);
    if (url || file) segments.push({ type: "image", data: { ...(url ? { url } : {}), ...(file ? { file } : {}), ...(summary ? { summary } : {}) } });
  }
  return segments;
}

function boundedString(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= limit ? normalized : undefined;
}

/**
 * Text whitespace can be meaningful at a segment boundary. Keep it exactly
 * as ingress supplied it while still rejecting blank or oversized payloads.
 */
function boundedText(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string" || value.length > limit) return undefined;
  return value;
}
