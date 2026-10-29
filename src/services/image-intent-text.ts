import type { NapcatGroupMessageEvent } from "../types.js";

/** Stable display text plus local provenance; identifiers never go to the router. */
export function imageIntentText(
  segments: NapcatGroupMessageEvent["message"] | undefined,
  botQq: string,
  sourceRowId?: number,
) {
  let mentionIndex = 0;
  let numberIndex = 0;
  const targets = new Map<string, string>();
  // Source-scoped markers cannot bind a different member in a later turn.
  // This scope is only a local message association, never a member identity.
  const scope = sourceRowId === undefined ? "" : `S${sourceRowId}_`;
  const fragment = (value: string) => value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    // A Chinese sentence often continues immediately after a URL with a
    // full-width delimiter. Keep that following request text available to the
    // router instead of consuming it as part of the opaque URL token.
    .replace(/(?:https?:\/\/|www\.)[^\s\u3000\uff0c\u3002\uff01\uff1f\uff1b\uff1a\u3001\u3010\u3011]+/giu, "[URL]")
    .replace(/(?<!\d)\d{5,12}(?!\d)/gu, value => {
      const token = `[NUMBER_${scope}${++numberIndex}]`;
      targets.set(token, value);
      return token;
    });
  const parts: string[] = [];
  for (const segment of Array.isArray(segments) ? segments : []) {
    if (typeof segment === "string") parts.push(fragment(segment));
    else if (segment.type === "text") parts.push(fragment(String(segment.data?.text ?? "")));
    else if (segment.type === "at") {
      const qq = String(segment.data?.qq ?? "").trim();
      if (qq === botQq) parts.push("[BOT_MENTION]");
      else {
        const token = `[MEMBER_MENTION_${scope}${++mentionIndex}]`;
        targets.set(token, `@${qq}`);
        parts.push(token);
      }
    }
  }
  return { text: parts.join("").replace(/\s+/gu, " ").trim().slice(0, 4_000), targets };
}

export function restoreImageIntentTarget(excerpt: string, targets: Map<string, string>): string | undefined {
  if (/^(?:我|我的|我自己|我本人|本人|自己)(?:的)?$/u.test(excerpt)) return "我";
  const mapped = targets.get(excerpt);
  if (mapped) return mapped;
  // A typed @ must stay unverified, even when its numeric part is opaque.
  if (excerpt.startsWith("@") && targets.has(excerpt.slice(1))) return `@${targets.get(excerpt.slice(1))}`;
  if (/[\[\]]/u.test(excerpt)) return undefined;
  return excerpt;
}
