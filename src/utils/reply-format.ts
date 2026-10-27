import { getReplyBehaviorOptions } from "../persona/common-chat-behavior.js";
import type { SkillDefinition } from "../types.js";

type SentenceUnit = {
  text: string;
  hardBreakAfter: boolean;
};

export interface ReplyFormatBudget {
  maxChars: number;
  maxTotalChars: number;
  maxMessages: number;
  preferredMaxMessages: number;
}

export function formatReplyMessages(
  skill: SkillDefinition,
  replyText: string,
  budget?: ReplyFormatBudget,
): string[] {
  const behavior = applyReplyFormatBudget(getReplyBehaviorOptions(skill), budget);
  const sanitized = sanitizeReply(
    replyText,
    behavior.stripAsterisks,
    behavior.respectLineBreaks,
  );
  if (!sanitized) {
    return [];
  }

  const maxChars = behavior.maxChars;
  const maxMessages = shouldAllowBurstMessages(sanitized, behavior)
    ? behavior.maxMessages
    : behavior.preferredMaxMessages;
  const stripTerminalPunctuation = behavior.stripTerminalPunctuation;

  // Detailed answers often contain many paragraphs or code lines. Pack those
  // lines into the existing long-answer budget instead of spending one bubble
  // per line and silently dropping the rest of an otherwise in-budget answer.
  if (budget && budget.maxTotalChars >= 1_200) {
    return fitMessagesWithinBudget(
      packDetailedReply(sanitized, behavior.maxChars, behavior.maxMessages),
      behavior.maxTotalChars, behavior.maxChars, stripTerminalPunctuation,
    );
  }

  const rawMessages = behavior.singleSentencePerMessage
    ? formatSingleSentenceMessages(
        sanitized,
        maxChars,
        maxMessages,
        stripTerminalPunctuation,
        behavior.respectLineBreaks,
      )
    : groupSentencesIntoMessages(
        sanitized,
        maxChars,
        maxMessages,
        stripTerminalPunctuation,
        behavior.respectLineBreaks,
      );

  return fitMessagesWithinBudget(
    rawMessages,
    behavior.maxTotalChars,
    maxChars,
    stripTerminalPunctuation,
  );
}

function packDetailedReply(text: string, maxChars: number, maxMessages: number): string[] {
  const messages: string[] = [];
  let rest = text.trim();
  while (rest && messages.length < maxMessages) {
    if (rest.length <= maxChars) { messages.push(rest); break; }
    const slice = rest.slice(0, maxChars);
    const preferred = findSplitIndex(slice);
    const required = rest.length - (maxMessages - messages.length - 1) * maxChars;
    const splitAt = preferred >= required ? preferred : maxChars;
    messages.push(rest.slice(0, splitAt).trim());
    rest = rest.slice(splitAt).trim();
  }
  return messages;
}

function applyReplyFormatBudget(
  behavior: ReturnType<typeof getReplyBehaviorOptions>,
  budget: ReplyFormatBudget | undefined,
): ReturnType<typeof getReplyBehaviorOptions> {
  if (!budget) {
    return behavior;
  }
  const maxMessages = Math.max(1, Math.min(20, Math.floor(budget.maxMessages)));
  return {
    ...behavior,
    maxChars: Math.max(20, Math.min(4_000, Math.floor(budget.maxChars))),
    maxTotalChars: Math.max(20, Math.min(8_000, Math.floor(budget.maxTotalChars))),
    maxMessages,
    preferredMaxMessages: Math.max(1, Math.min(maxMessages, Math.floor(budget.preferredMaxMessages))),
  };
}

function formatSingleSentenceMessages(
  text: string,
  maxChars: number,
  maxMessages: number,
  stripTerminalPunctuation: boolean,
  respectLineBreaks: boolean,
): string[] {
  const messages = splitIntoSentenceUnits(text, respectLineBreaks)
    .map((unit) => unit.text)
    .flatMap((sentence) => chunkLongSentence(sentence, maxChars))
    .map((message) => finalizeMessage(message, stripTerminalPunctuation))
    .filter(Boolean)
    .slice(0, maxMessages);

  return messages.length > 0
    ? messages
    : chunkLongSentence(text, maxChars)
        .map((message) => finalizeMessage(message, stripTerminalPunctuation))
        .filter(Boolean)
        .slice(0, maxMessages);
}

function sanitizeReply(
  text: string,
  stripAsterisks: boolean,
  respectLineBreaks: boolean,
): string {
  let normalized = text.replace(/\r\n/g, "\n");
  if (stripAsterisks) {
    normalized = normalized.replace(/[*＊]/g, "");
  }

  const lineJoiner = respectLineBreaks ? "\n" : " ";

  return normalized
    .split("\n")
    .map((line) => line.replace(/^\s*[-—]+\s*/g, "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(lineJoiner)
    .replace(/[ \t]+([，。！？；,.!?;:])/g, "$1")
    .trim();
}

function splitIntoSentenceUnits(text: string, respectLineBreaks: boolean): SentenceUnit[] {
  const lines = (respectLineBreaks ? text.replace(/\n+/g, "\n").split("\n") : [text])
    .map((line) => line.trim())
    .filter(Boolean);

  const units: SentenceUnit[] = [];
  for (const line of lines) {
    const parts = line
      .replace(/([。！？!?])/g, "$1\n")
      .replace(/([；;])/g, "$1\n")
      .split("\n")
      .map((part) => part.trim())
      .filter(Boolean);

    parts.forEach((part, index) => {
      units.push({
        text: part,
        hardBreakAfter: index === parts.length - 1,
      });
    });
  }

  return units;
}

function groupSentencesIntoMessages(
  text: string,
  maxChars: number,
  maxMessages: number,
  stripTerminalPunctuation: boolean,
  respectLineBreaks: boolean,
): string[] {
  const sentenceUnits = splitIntoSentenceUnits(text, respectLineBreaks);
  if (sentenceUnits.length === 0) {
    return chunkLongSentence(text, maxChars)
      .map((message) => finalizeMessage(message, stripTerminalPunctuation))
      .filter(Boolean)
      .slice(0, maxMessages);
  }

  const messages: string[] = [];
  let current = "";

  for (const sentenceUnit of sentenceUnits) {
    const cleanSentence = finalizeMessage(sentenceUnit.text.trim(), stripTerminalPunctuation);
    if (!cleanSentence) {
      continue;
    }

    if (cleanSentence.length > maxChars) {
      if (current) {
        messages.push(finalizeMessage(current, stripTerminalPunctuation));
        current = "";
      }

      for (const chunk of chunkLongSentence(cleanSentence, maxChars)) {
        if (messages.length >= maxMessages) {
          break;
        }
        messages.push(finalizeMessage(chunk, stripTerminalPunctuation));
      }
      continue;
    }

    if (!current) {
      current = cleanSentence;
      if (sentenceUnit.hardBreakAfter) {
        messages.push(finalizeMessage(current, stripTerminalPunctuation));
        current = "";
      }
      continue;
    }

    const candidate = `${current} ${cleanSentence}`.trim();
    if (candidate.length <= maxChars) {
      current = candidate;
      if (sentenceUnit.hardBreakAfter) {
        messages.push(finalizeMessage(current, stripTerminalPunctuation));
        current = "";
      }
      continue;
    }

    messages.push(finalizeMessage(current, stripTerminalPunctuation));
    current = cleanSentence;
    if (sentenceUnit.hardBreakAfter) {
      messages.push(finalizeMessage(current, stripTerminalPunctuation));
      current = "";
    }

    if (messages.length >= maxMessages) {
      break;
    }
  }

  if (current && messages.length < maxMessages) {
    messages.push(finalizeMessage(current, stripTerminalPunctuation));
  }

  return messages.filter(Boolean).slice(0, maxMessages);
}

function fitMessagesWithinBudget(
  messages: string[],
  maxTotalChars: number,
  maxChars: number,
  stripTerminalPunctuation: boolean,
): string[] {
  if (messages.length === 0) {
    return [];
  }

  const fitted: string[] = [];
  let usedChars = 0;

  for (const message of messages) {
    const cleanMessage = finalizeMessage(message, stripTerminalPunctuation);
    if (!cleanMessage) {
      continue;
    }

    const candidateCost = cleanMessage.length;
    if (usedChars + candidateCost <= maxTotalChars) {
      fitted.push(cleanMessage);
      usedChars += candidateCost;
      continue;
    }

    const remaining = maxTotalChars - usedChars;
    if (remaining <= 0) {
      break;
    }

    const shortened = shortenToCompleteThought(cleanMessage, remaining, maxChars, stripTerminalPunctuation);
    if (shortened) {
      fitted.push(shortened);
    }
    break;
  }

  return fitted;
}

function shortenToCompleteThought(
  text: string,
  limit: number,
  maxChars: number,
  stripTerminalPunctuation: boolean,
): string {
  if (limit <= 0) {
    return "";
  }

  const finalized = finalizeMessage(text, stripTerminalPunctuation);
  if (finalized.length <= limit) {
    return finalized;
  }

  const sliceLimit = Math.min(limit, maxChars);
  const candidates = chunkLongSentence(finalized, sliceLimit)
    .map((chunk) => finalizeMessage(chunk, stripTerminalPunctuation))
    .filter(Boolean);

  return candidates[0] ?? "";
}

function chunkLongSentence(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) {
    return [text];
  }

  const chunks: string[] = [];
  let rest = text.trim();

  while (rest.length > maxChars) {
    const slice = rest.slice(0, maxChars);
    const splitIndex = findSplitIndex(slice);
    chunks.push(rest.slice(0, splitIndex).trim());
    rest = rest.slice(splitIndex).trim();
  }

  if (rest) {
    chunks.push(rest);
  }

  return chunks.filter(Boolean);
}

function findSplitIndex(slice: string): number {
  const punctuation = ["，", "。", "！", "？", "；", ",", ".", "!", "?", ";", " "];
  let best = -1;

  for (const char of punctuation) {
    const index = slice.lastIndexOf(char);
    if (index > best) {
      best = index;
    }
  }

  return best >= Math.floor(slice.length / 2) ? best + 1 : slice.length;
}

function finalizeMessage(text: string, stripTerminalPunctuation: boolean): string {
  const normalized = text.trim();
  if (!normalized) {
    return "";
  }

  if (!stripTerminalPunctuation) {
    return normalized;
  }

  return normalized.replace(/[。?!？！；;，,]+$/g, "").trim();
}

function shouldAllowBurstMessages(
  text: string,
  behavior: ReturnType<typeof getReplyBehaviorOptions>,
): boolean {
  if (!behavior.allowBurstOnHighEmotion) {
    return false;
  }

  if (/[!！？]{2,}/.test(text)) {
    return true;
  }

  if (/(哈哈哈|蚌埠|妈的|几把|煞笔|傻逼|废物|狗叫|气死|难受|破防|真烦|真恶心)/i.test(text)) {
    return true;
  }

  return behavior.highEmotionKeywords.some((keyword) => keyword && text.includes(keyword));
}
