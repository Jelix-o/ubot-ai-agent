export interface WebQueryPlan {
  lookupQuery?: string;
  lookupSubject?: string;
  lookupFallbackQueries?: string[];
}

export const normalizeSearchText = (text: string): string => text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

export function inferLookupSubject(text: string): string | undefined {
  return (text.match(/《([^》\n]{2,100})》/u)?.[1] ??
    text.match(/^\s*(.{2,100}?)(?:中|里)(?=\s|的)/u)?.[1])?.trim();
}

/** Build bounded, increasingly broad queries without substituting a work/version. */
export function planWebQueries(text: string, semantic: WebQueryPlan = {}): WebQueryPlan {
  const inferred = inferLookupSubject(text);
  const proposed = typeof semantic.lookupSubject === "string" ? semantic.lookupSubject.trim().slice(0, 100) : undefined;
  const subject = inferred || (proposed && normalizeSearchText(proposed).length >= 2 &&
    normalizeSearchText(text + " " + (semantic.lookupQuery ?? "")).includes(normalizeSearchText(proposed)) ? proposed : undefined);
  const matches = (query: string) => !subject || normalizeSearchText(query).includes(normalizeSearchText(subject));
  const primary = semantic.lookupQuery?.trim().slice(0, 240);
  const query = primary && matches(primary) ? primary : text.trim().slice(0, 240);
  const topic = /剧情|结局|主线|战役/u.test(text) ? "剧情" : /版本|更新/u.test(text) ? "版本" : /参数|性能|支持/u.test(text) ? "规格" : /发售|发布|上市/u.test(text) ? "发布" : "";
  const alternatives = [...(Array.isArray(semantic.lookupFallbackQueries) ? semantic.lookupFallbackQueries : []),
    ...(subject ? [topic ? `${subject} ${topic}` : subject, subject] : [])];
  const seen = new Set([normalizeSearchText(query)]);
  const fallback: string[] = [];
  for (const value of alternatives) {
    if (typeof value !== "string") continue;
    const candidate = value.trim().slice(0, 240);
    const key = normalizeSearchText(candidate);
    if (!key || seen.has(key) || !matches(candidate)) continue;
    seen.add(key);
    fallback.push(candidate);
    if (fallback.length === 2) break;
  }
  return { lookupQuery: query, ...(subject ? { lookupSubject: subject } : {}), ...(fallback.length ? { lookupFallbackQueries: fallback } : {}) };
}

export interface WebSearchCandidate { title: string; url: string; content: string }

export function matchesLookupSubject(item: WebSearchCandidate, subject?: string): boolean {
  if (!subject) return true;
  const normalized = normalizeSearchText(subject);
  const version = normalized.match(/^(.*\D)(\d+)$/u);
  const title = normalizeSearchText(item.title);
  if (version) {
    const at = title.indexOf(version[1]!);
    const titleVersion = at < 0 ? undefined : title.slice(at + version[1]!.length).match(/^\d+/u)?.[0];
    if (titleVersion && titleVersion !== version[2]) return false;
  }
  return normalizeSearchText(item.title + " " + item.content).includes(normalized);
}

export function rankWebResult(item: WebSearchCandidate, query: string): number {
  const host = new URL(item.url).hostname;
  const official = /(?:^|\.)(?:playstation\.com|callofduty\.com|activision\.com|xbox\.com|microsoft\.com|apple\.com|sony\.com|gov\.cn|edu\.cn)$/iu.test(host);
  const terms = query.split(/[\s《》：:,，]+/u).map(normalizeSearchText).filter(t => t.length >= 2);
  const title = normalizeSearchText(item.title);
  const content = normalizeSearchText(item.content);
  return (official ? 20 : 0) + terms.reduce((sum, term) => sum + (title.includes(term) ? 3 : content.includes(term) ? 1 : 0), 0);
}
