/** Bounded, content-free observations; never pass a draft to the observer. */
export type ReplyArtifactKind = "oops_placeholder" | "text_placeholder" | "state_metadata";
export interface ReplyArtifactOptions {
  userInput?: string;
  allowEnvelope?: boolean;
  history?: boolean;
  report?: boolean;
}
export interface ReplyArtifactResult {
  text: string;
  removed: ReplyArtifactKind[];
  ambiguous: boolean;
}

let observer: ((metric: string) => void) | undefined;
export function observeReplyArtifacts(callback: (metric: string) => void): () => void {
  observer = callback;
  return () => { if (observer === callback) observer = undefined; };
}

export function requestsStructuredReply(input = ""): boolean {
  if (/(?:不要|别|禁止|不许|不需要|无需).{0,10}(?:json|代码|code|结构化)/iu.test(input)) return false;
  return /\b(?:json|javascript|typescript|python|code)\b|代码|正则|(?:解释|讲解|举例|示例|引用|原样|逐字|输出|返回|打印|展示).{0,24}(?:对象|字段|语法|字符串|结构化)|(?:对象|字段|语法|字符串).{0,12}(?:示例|解释|讲解)/iu.test(input);
}

/** Mask presentation examples before checking the private protocol fields. */
export function containsPrivateReplyMetadata(text: string, userInput?: string): boolean {
  if (requestsStructuredReply(userInput)) return false;
  let visible = text.replace(/(`+)[\s\S]*?\1/g, " ")
    .replace(/“[^”]*”|「[^」]*」|『[^』]*』/gu, " ")
    .replace(/(?<![\p{L}\p{N}])'[^'\r\n]*'(?!\s*:)/gu, " ")
    .replace(/^\s*>[^\n]*/gmu, " ");
  if (userInput) for (const range of scanObjects(visible).reverse()) {
    const example = visible.slice(range.start, range.end);
    if (range.complete && userInput.includes(example)) visible = visible.slice(0, range.start) + " ".repeat(example.length) + visible.slice(range.end);
  }
  return /"(?:text|oops|stateUpdate|review|knownFacts|coveredPoints|questions|conclusion|mediaObservations|repeatsAnswered|reasksKnown|unsupportedReversal)"\s*:/u.test(visible);
}

export function hasUnsafeReplyArtifacts(text: string, userInput?: string): boolean {
  const result = cleanReplyArtifacts(text, { userInput, report: false });
  return result.ambiguous || result.removed.length > 0 || containsPrivateReplyMetadata(text, userInput);
}

/** A read projection only: caller-owned and persisted turns remain untouched. */
export function cleanReplyHistory<T extends { role: string; content: string }>(turns: T[]): T[] {
  let userInput: string | undefined;
  return turns.map(turn => {
    if (turn.role === "user") { userInput = turn.content; return turn; }
    if (turn.role !== "assistant") return turn;
    const cleaned = cleanReplyArtifacts(turn.content, { userInput, history: true });
    return cleaned.removed.length && !cleaned.ambiguous ? { ...turn, content: cleaned.text } : turn;
  });
}

const stateFields = new Set(["knownFacts", "coveredPoints", "questions", "conclusion", "mediaObservations"]);
const reviewFields = new Set(["repeatsAnswered", "reasksKnown", "unsupportedReversal"]);
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));

function isStateMetadata(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  if (!keys.length) return false;
  return keys.every(key => {
    const item = value[key];
    if (key === "stateUpdate") return record(item) && Object.keys(item).every(field => stateFields.has(field)) &&
      (!Object.keys(item).length || isStateMetadata(item));
    if (key === "review") return record(item) && Object.keys(item).every(field => reviewFields.has(field) && typeof item[field] === "boolean");
    if (reviewFields.has(key)) return typeof item === "boolean";
    if (!stateFields.has(key)) return false;
    return key === "conclusion" ? record(item) && typeof item.text === "string" &&
      Object.keys(item).every(field => ["text", "evidenceIds", "revisionReason"].includes(field)) : Array.isArray(item);
  });
}

/** Object ranges outside Markdown, quoted examples and JSON string values. */
function scanObjects(text: string): Array<{ start: number; end: number; complete: boolean }> {
  const ranges: Array<{ start: number; end: number; complete: boolean }> = [];
  let start = -1, depth = 0, string = false, escaped = false;
  let ticks = 0, quote = "";
  const closers: Record<string, string> = { '"': '"', "'": "'", "“": "”", "「": "」", "『": "』" };
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (depth) {
      if (string) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') string = false;
      } else if (char === '"') string = true;
      else if (char === "{") depth++;
      else if (char === "}" && --depth === 0) { ranges.push({ start, end: i + 1, complete: true }); start = -1; }
      continue;
    }
    if (char === "`") {
      let length = 1;
      while (text[i + length] === "`") length++;
      if (!ticks) ticks = length;
      else if (ticks === length) ticks = 0;
      i += length - 1;
      continue;
    }
    if (ticks) continue;
    if (quote) { if (char === quote) quote = ""; continue; }
    // Markdown quotations are examples, including a bare object on that line.
    if ((i === 0 || text[i - 1] === "\n") && /^\s*>/.test(text.slice(i))) {
      const end = text.indexOf("\n", i); if (end < 0) break; i = end; continue;
    }
    if (closers[char] && !(char === "'" && /[\p{L}\p{N}]/u.test(text[i - 1] ?? ""))) {
      if (text.indexOf(closers[char]!, i + 1) >= 0) { quote = closers[char]!; continue; }
    }
    if (char === "{") { start = i; depth = 1; }
  }
  if (depth) ranges.push({ start, end: text.length, complete: false });
  return ranges;
}

/** Removes only recognized trailing protocol objects; ambiguous drafts stay blocked. */
export function cleanReplyArtifacts(text: string, options: ReplyArtifactOptions = {}): ReplyArtifactResult {
  const result: ReplyArtifactResult = { text, removed: [], ambiguous: false };
  if (requestsStructuredReply(options.userInput)) return result;
  // Keep meme controls attached until the existing meme parser consumes them.
  const suffix = /(?:\s*\[\[meme:[^\]\r\n]*(?:\]\]|$))+\s*$/iu.exec(text);
  const controls = suffix?.[0] ?? "";
  let body = (suffix ? text.slice(0, suffix.index) : text).trimEnd();
  while (body) {
    const last = scanObjects(body).at(-1);
    if (!last || last.end !== body.length) break;
    const candidate = body.slice(last.start, last.end);
    if (!/^\{\s*["']/u.test(candidate)) break; // Math and ordinary brace notation.
    if (options.userInput?.includes(candidate)) break;
    let kind: ReplyArtifactKind | undefined;
    if (last.complete && /^\{\s*"text"\s*:\s*(?:\.{3}|…+|⋯+)\s*\}$/u.test(candidate)) kind = "text_placeholder";
    else if (last.complete) {
      try {
        const value: unknown = JSON.parse(candidate);
        if (record(value)) {
          if (options.allowEnvelope && last.start === 0 && typeof value.text === "string" && value.text.trim()) break;
          if (Object.keys(value).length === 1 && value.oops === "") kind = "oops_placeholder";
          else if (isStateMetadata(value)) kind = "state_metadata";
        }
      } catch { /* Placeholder or unknown object: never guess its contents. */ }
    }
    if (!kind) { result.ambiguous = true; break; }
    result.removed.push(kind);
    body = body.slice(0, last.start).trimEnd();
  }
  // A protocol-only draft is not a usable answer.
  if (result.removed.length && !body.trim()) result.ambiguous = true;
  result.text = result.removed.length ? body + controls : text;
  if (!options.allowEnvelope && containsPrivateReplyMetadata(result.text, options.userInput)) result.ambiguous = true;
  if (options.report !== false) {
    const prefix = options.history ? "reply_artifact_history" : "reply_artifact";
    for (const kind of result.removed) observer?.(`${prefix}_cleaned_${kind}`);
    if (result.ambiguous) observer?.(`${prefix}_blocked`);
  }
  return result;
}

/** Keeps message boundaries while dropping a trailing object-only bubble. */
export function cleanReplyMessageParts(parts: string[], options: ReplyArtifactOptions = {}): { messages: string[]; ambiguous: boolean } {
  const joined = parts.join("\n");
  const cleaned = cleanReplyArtifacts(joined, options);
  if (!cleaned.removed.length) return { messages: parts, ambiguous: cleaned.ambiguous };
  // All removals are a suffix before optional meme controls, so the surviving
  // prefix can be projected back onto its original message boundaries.
  const controls = /(?:\s*\[\[meme:[^\]\r\n]*(?:\]\]|$))+\s*$/iu.exec(cleaned.text)?.[0] ?? "";
  let remaining = cleaned.text.length - controls.length;
  const messages: string[] = [];
  for (const part of parts) {
    if (remaining <= 0) break;
    const kept = part.slice(0, Math.min(part.length, remaining)).trimEnd();
    if (kept) messages.push(kept);
    remaining -= part.length + 1;
  }
  if (controls && messages.length) messages[messages.length - 1] += controls;
  return { messages, ambiguous: cleaned.ambiguous };
}
