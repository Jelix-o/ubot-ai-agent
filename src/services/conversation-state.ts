import type { AmbientGroupContextMessage } from "../types.js";

export type ConversationIntent = "chat" | "opinion" | "explain" | "confirm" | "challenge" | "image" | "lookup" | "task";

export type ReplyDetailLevel = "direct" | "brief_explanation" | "detailed";

export type ContextAnchorKind = "explicit_reply" | "recent_cluster" | "explicit_follow_up" | "none";

/**
 * The evidence source that chose this turn's topic. It is carried from
 * resolution into the reply plan so routing and prompt context cannot quietly
 * disagree about what the user is responding to.
 */
export interface ContextAnchor {
  kind: ContextAnchorKind;
  messageIds: string[];
  topicCandidateId?: string;
}

export interface ContextResolution {
  intent: ConversationIntent;
  relation: "new" | "follow_up" | "supplement";
  resolvedInput: string;
  topicCandidateId?: string;
  selectedMessageIds: string[];
  mediaSourceMessageIds: string[];
  needsMoreContext: boolean;
  clarification?: string;
  source: "rules" | "model";
  expandedContext?: boolean;
  anchor?: ContextAnchor;
}

export interface ConversationFact {
  userId: string;
  text: string;
  sourceMessageIds: string[];
}

export interface ConversationQuestion {
  key: string;
  userId: string;
  text: string;
  status: "open" | "answered" | "skipped";
}

export interface ConversationUpdate {
  knownFacts: ConversationFact[];
  coveredPoints: string[];
  questions: ConversationQuestion[];
  conclusion?: { text: string; evidenceIds: string[]; revisionReason?: string };
  mediaObservations: Array<{ sourceMessageId: string; text: string }>;
}

export interface ConversationState extends ConversationUpdate {
  revision: number;
  asOfTurnId: number;
  pendingMedia: Array<{ sourceMessageId: string; status: "queued" | "processing" | "awaiting_delivery" | "failed" }>;
}

export interface ReplyPlan {
  action: "reply" | "clarify" | "tool";
  intent: ConversationIntent;
  explanation: "on_request" | "requested";
  detailLevel: ReplyDetailLevel;
  resolvedInput: string;
  selectedMessageIds: string[];
  clarification?: string;
  sourceMessageId?: string;
  mediaSourceMessageIds?: string[];
  recipientUserId?: string;
  newContent: string;
  alreadyCovered: string[];
  answeredQuestionKeys: string[];
  toolNeeds: Array<"lookup" | "image" | "task">;
  anchor?: ContextAnchor;
}

export interface ConversationReplyCheck {
  repeatsAnswered: boolean;
  reasksKnown: boolean;
  unsupportedReversal: boolean;
}

/**
 * A reply-plan response included its private envelope but was not a complete,
 * parseable envelope. Callers must never deliver the raw draft because it can
 * expose state metadata to the group.
 */
export class ConversationReplyEnvelopeError extends Error {
  constructor() {
    super("conversation reply invalid JSON envelope");
    this.name = "ConversationReplyEnvelopeError";
  }
}

// These fields are private conversation-state protocol, never user-visible
// reply text. Keep the detection shared with the final outbox guard so a
// provider adapter cannot leak a partial envelope through a different path.
const CONVERSATION_REPLY_ENVELOPE_MARKER = /"(?:stateUpdate|review|knownFacts|coveredPoints|questions|conclusion|mediaObservations|repeatsAnswered|reasksKnown|unsupportedReversal)"\s*:/u;

export function hasConversationReplyEnvelopeMarker(text: string): boolean {
  return CONVERSATION_REPLY_ENVELOPE_MARKER.test(text);
}

export interface ConversationTopicCandidate {
  id: string;
  topicId: string;
  ownerUserId: string;
  title: string;
  lastUserInput: string;
  lastReply: string;
  updatedAt: number;
  pendingTask?: boolean;
}

export function emptyConversationState(): ConversationState {
  return { revision: 0, asOfTurnId: 0, knownFacts: [], coveredPoints: [], questions: [], mediaObservations: [], pendingMedia: [] };
}

const boundedText = (value: unknown, max = 400): string => typeof value === "string" ? value.trim().slice(0, max) : "";
const strings = (value: unknown, limit = 12): string[] => Array.isArray(value)
  ? [...new Set(value.map(item => boundedText(item)).filter(Boolean))].slice(0, limit) : [];

/** Only an actual user message can substantiate a remembered user condition. */
export function sanitizeConversationUpdate(value: unknown, sources: Map<string, string>): ConversationUpdate {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const knownFacts: ConversationFact[] = [];
  for (const item of Array.isArray(raw.knownFacts) ? raw.knownFacts.slice(0, 20) : []) {
    if (!item || typeof item !== "object") continue;
    const userId = boundedText(item.userId, 40);
    const sourceMessageIds = strings(item.sourceMessageIds).filter(id => sources.get(id) === userId);
    const text = boundedText(item.text);
    if (userId && text && sourceMessageIds.length) knownFacts.push({ userId, text, sourceMessageIds });
  }
  const questions: ConversationQuestion[] = [];
  for (const item of Array.isArray(raw.questions) ? raw.questions.slice(0, 12) : []) {
    if (!item || typeof item !== "object") continue;
    const key = boundedText(item.key, 80), text = boundedText(item.text), userId = boundedText(item.userId, 40);
    if (key && text && userId && [...sources.values()].includes(userId)) {
      questions.push({ key, text, userId, status: ["answered", "skipped"].includes(item.status) ? item.status : "open" });
    }
  }
  const conclusion = raw.conclusion && typeof raw.conclusion === "object" ? raw.conclusion as Record<string, unknown> : undefined;
  const conclusionText = boundedText(conclusion?.text, 800);
  const mediaObservations = (Array.isArray(raw.mediaObservations) ? raw.mediaObservations : []).flatMap(item => {
    if (!item || typeof item !== "object") return [];
    const sourceMessageId = boundedText(item.sourceMessageId, 80), text = boundedText(item.text, 800);
    return sources.has(sourceMessageId) && text ? [{ sourceMessageId, text }] : [];
  }).slice(0, 6);
  return {
    knownFacts, questions, coveredPoints: strings(raw.coveredPoints, 16), mediaObservations,
    ...(conclusionText ? { conclusion: {
      text: conclusionText,
      evidenceIds: strings(conclusion?.evidenceIds).filter(id => sources.has(id)),
      ...(boundedText(conclusion?.revisionReason) ? { revisionReason: boundedText(conclusion?.revisionReason) } : {}),
    } } : {}),
  };
}

export function mergeConversationState(state: ConversationState, update: ConversationUpdate, turnId: number): ConversationState {
  const facts = new Map(state.knownFacts.map(fact => [`${fact.userId}:${fact.text}`, fact]));
  for (const fact of update.knownFacts) facts.set(`${fact.userId}:${fact.text}`, fact);
  const questions = new Map(state.questions.map(question => [`${question.userId}:${question.key}`, question]));
  for (const question of update.questions) questions.set(`${question.userId}:${question.key}`, question);
  const media = new Map(state.mediaObservations.map(item => [item.sourceMessageId, item]));
  for (const item of update.mediaObservations) media.set(item.sourceMessageId, item);
  return {
    ...state, revision: state.revision + 1, asOfTurnId: turnId,
    knownFacts: [...facts.values()].slice(-32),
    coveredPoints: [...new Set([...state.coveredPoints, ...update.coveredPoints])].slice(-32),
    questions: [...questions.values()].slice(-16),
    mediaObservations: [...media.values()].slice(-6),
    ...(update.conclusion ? { conclusion: update.conclusion } : {}),
  };
}

/** Restrict a selected transcript to a bounded evidence budget, preserving order. */
export function selectConversationEvidence(messages: AmbientGroupContextMessage[], ids: string[], maxChars = 8_000): AmbientGroupContextMessage[] {
  const wanted = new Set(ids);
  const selected = ids.length ? messages.filter(message => message.messageId && wanted.has(message.messageId)) : messages;
  let used = 0;
  return [...selected].reverse().flatMap(message => {
    const text = message.text.slice(0, 500);
    if (used + text.length > maxChars) return [];
    used += text.length;
    return [{ ...message, text }];
  }).reverse().slice(-60);
}

export function parseConversationReply(text: string): {
  text: string; update?: unknown; check?: ConversationReplyCheck;
} {
  const json = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let raw: any;
  try { raw = JSON.parse(json); }
  catch {
    // A common model failure starts with a normal-looking answer and then
    // appends private envelope fields. It is still a malformed private
    // envelope, not safe natural text.
    if (
      /^\{\s*"text"\s*:/u.test(json) ||
      hasConversationReplyEnvelopeMarker(json)
    ) {
      throw new ConversationReplyEnvelopeError();
    }
    return { text };
  }
  if (!raw || typeof raw.text !== "string" || !raw.text.trim()) {
    if (raw && typeof raw === "object" && ("text" in raw || hasConversationReplyEnvelopeMarker(json))) {
      throw new ConversationReplyEnvelopeError();
    }
    return { text };
  }
  const review = raw.review;
  return {
    text: raw.text.trim(), update: raw.stateUpdate,
    ...(review && typeof review === "object" ? { check: {
      repeatsAnswered: review.repeatsAnswered === true,
      reasksKnown: review.reasksKnown === true,
      unsupportedReversal: review.unsupportedReversal === true,
    } } : {}),
  };
}

