export interface WebQueryPlan {
  lookupQuery?: string;
  lookupSubject?: string;
  lookupFallbackQueries?: string[];
  lookupAliases?: string[];
  lookupFreshness?: "current" | "recent" | "all_time";
  lookupTopic?: "general" | "news";
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
  const aliases = (semantic.lookupAliases ?? []).filter((s): s is string => typeof s === "string" && s.trim().length >= 2).slice(0, 3).map(s => s.trim().slice(0, 100));
  const alternatives = [...(Array.isArray(semantic.lookupFallbackQueries) ? semantic.lookupFallbackQueries : []),
    ...(subject ? [topic ? `${subject} ${topic}` : subject, subject] : [compactSearchQuery(text)])];
  const seen = new Set([normalizeSearchText(query)]);
  const fallback: string[] = [];
  for (const value of alternatives) {
    if (typeof value !== "string") continue;
    const candidate = value.trim().slice(0, 240);
    const key = normalizeSearchText(candidate);
    if (!key || seen.has(key) || (!matches(candidate) && !aliases.some(alias => key.includes(normalizeSearchText(alias))))) continue;
    seen.add(key);
    fallback.push(candidate);
    if (fallback.length === 2) break;
  }
  const freshness = /(?:所有|历届|全部).{0,30}冠军|冠军.{0,30}(?:所有|历届|全部)/u.test(text) ? "all_time"
    : /最新|最近|进展|新闻|资讯/u.test(text) ? "recent"
    : /当前|现在|目前|后续|赛程/u.test(text) ? "current"
    : semantic.lookupFreshness ?? (/所有|历届|全部|冠军/u.test(text) ? "all_time" : undefined);
  const lookupTopic = /赛程|历届|冠军/u.test(text) && !/新闻|报道/u.test(text) ? "general"
    : semantic.lookupTopic ?? (/新闻|资讯|官司|诉讼|调研|进展/u.test(text) ? "news" : "general");
  const englishAlias = aliases.filter(alias => /[A-Za-z]{3}/u.test(alias)).sort((a, b) => b.length - a.length)[0];
  const englishTopic = /赛程/u.test(text) ? "schedule" : /冠军/u.test(text) ? "champions winners" : /行业新闻|机构调研|研报/u.test(text) ? "industry news analyst research" : /官司|诉讼|裁定/u.test(text) ? "court lawsuit ruling" : undefined;
  if (englishAlias && englishTopic && !fallback.some(query => /[A-Za-z]{3}/u.test(query))) {
    fallback.unshift(`${englishAlias} ${englishTopic}`.slice(0, 240));
    fallback.splice(2);
  }
  return { lookupQuery: query, ...(subject ? { lookupSubject: subject } : {}), ...(aliases.length ? { lookupAliases: aliases } : {}),
    ...(freshness ? { lookupFreshness: freshness } : {}), lookupTopic, ...(fallback.length ? { lookupFallbackQueries: fallback } : {}) };
}

export function compactSearchQuery(text: string): string {
  return text.replace(/(?:只要|仅要).*/u, "").replace(/当前时间|查得到吗|查一下|帮我|请问|关于|拉出来|总结一下|按[，,].*|[，,？?。！!]/gu, " ").replace(/的(?=最新|后续|所有)/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 240);
}

export interface WebSearchCandidate { title: string; url: string; content: string; publishedAt?: string; backend?: string }

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
  const official = /(?:^|\.)(?:playstation\.com|callofduty\.com|activision\.com|xbox\.com|microsoft\.com|apple\.com|sony\.com|lolesports\.com|leagueoflegends\.com|riotgames\.com|nexperia\.com|rechtspraak\.nl|gov\.cn|edu\.cn)$/iu.test(host);
  const terms = query.split(/[\s《》：:,，]+/u).map(normalizeSearchText).filter(t => t.length >= 2);
  const title = normalizeSearchText(item.title);
  const content = normalizeSearchText(item.content);
  return (official ? 20 : 0) + terms.reduce((sum, term) => sum + (title.includes(term) ? 3 : content.includes(term) ? 1 : 0), 0);
}

/** Missing dates are unknown, not fresh; dynamic official pages still remain usable. */
export function isStaleResult(item: WebSearchCandidate, freshness: WebQueryPlan["lookupFreshness"], now: Date): boolean {
  if (!freshness || freshness === "all_time") return false;
  const date = item.publishedAt ? Date.parse(item.publishedAt) : NaN;
  if (Number.isFinite(date)) return now.getTime() - date > (freshness === "recent" ? 120 : 370) * 86_400_000;
  const years = item.title.match(/\b20\d{2}\b/gu)?.map(Number) ?? [];
  return years.length > 0 && Math.max(...years) < now.getFullYear() - (freshness === "recent" ? 0 : 1);
}

export function coversSearchQuestion(item: WebSearchCandidate, question: string): boolean {
  const text = item.title + " " + item.content;
  if (/行业新闻|机构调研|研报/u.test(question)) return /行业|产业|供应链|产能|经营|调研|研报|research|industry|supply|production/iu.test(text);
  if (/官司|诉讼|裁定|法院/u.test(question)) return /诉讼|官司|法院|裁定|起诉|court|lawsuit|ruling|litigation/iu.test(text);
  if (/赛程|后续.*比赛/u.test(question)) return /赛程|对阵|开赛|schedule|fixture|match|final/iu.test(text);
  if (/冠军/u.test(question)) return /冠军|夺冠|champion|winner/iu.test(text);
  return true;
}
