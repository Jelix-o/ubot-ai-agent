import type { WebSearchCandidate } from "./web-search-policy.js";

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
export interface SearchBatch {
  results: WebSearchCandidate[];
  backend: string;
  engineErrors: number;
  fallbackReason?: string;
}

/** A keyless installation uses the same Google index through local SearXNG. */
export class WebSearchBackend {
  private blockedUntil = 0;
  private blockedReason?: string;
  private recoveryProbeInFlight = false;
  constructor(private readonly options: { searchUrl: URL; fetch: FetchLike; apiKey?: string; now: () => Date }) {}

  async search(query: string, topic: "general" | "news", recent: boolean, alternate: boolean, signal: AbortSignal): Promise<SearchBatch> {
    let fallbackReason = this.options.apiKey ? this.blockedReason : "api_not_configured";
    if (this.options.apiKey && this.options.now().getTime() >= this.blockedUntil && !this.recoveryProbeInFlight) {
      const probing = this.blockedUntil > 0;
      if (probing) this.recoveryProbeInFlight = true;
      try {
        const response = await this.options.fetch(`https://google.serper.dev/${topic === "news" ? "news" : "search"}`, {
          method: "POST", redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(3500)]),
          headers: { "X-API-KEY": this.options.apiKey, "Content-Type": "application/json" },
          body: JSON.stringify({ q: query, num: 10, gl: "us", hl: "zh-cn", ...(recent ? { tbs: "qdr:m" } : {}) }),
        });
        const payload = await boundedJson(response);
        if (!response.ok || payload.message || payload.error) {
          // Never log upstream response bodies: they may echo credentials.
          const quota = /credit|quota|balance|exhaust|payment/iu.test(String(payload.message ?? payload.error ?? ""));
          fallbackReason = quota || response.status === 402 ? "api_quota_exhausted" : `api_http_${response.status}`;
          this.blockedUntil = this.options.now().getTime() + (quota || [401, 402, 403].includes(response.status) ? 6 * 60 * 60_000 : 60_000);
          this.blockedReason = fallbackReason;
        } else {
          this.blockedReason = undefined;
          this.blockedUntil = 0;
          const results = normalizeResults(topic === "news" ? payload.news : payload.organic);
          if (results.length) return { results, backend: "serper_google", engineErrors: 0 };
          fallbackReason = "api_empty_results";
        }
      } catch {
        signal.throwIfAborted();
        fallbackReason = "api_request_failed";
        this.blockedUntil = this.options.now().getTime() + 60_000;
        this.blockedReason = fallbackReason;
      } finally { if (probing) this.recoveryProbeInFlight = false; }
    }
    const engine = (topic === "news") !== alternate ? "bing news" : "google cse";
    const url = new URL("search", this.options.searchUrl.href.replace(/\/?$/u, "/"));
    // categories adds the entire category to engines, re-enabling challenged engines.
    for (const [key, value] of Object.entries({ q: query, format: "json", engines: engine, language: "all", safesearch: "1" })) url.searchParams.set(key, value);
    if (recent) url.searchParams.set("time_range", "month");
    const response = await this.options.fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(3500)]), redirect: "error" });
    if (!response.ok) throw new Error(`free_search_http_${response.status}`);
    const payload = await boundedJson(response);
    return { results: normalizeResults(payload.results), backend: engine === "google cse" ? "free_google" : "free_bing_news",
      engineErrors: Array.isArray(payload.unresponsive_engines) ? payload.unresponsive_engines.length : 0, fallbackReason };
  }
}

function normalizeResults(raw: unknown): WebSearchCandidate[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 30).flatMap(item => {
    if (!item || typeof item !== "object") return [];
    const title = typeof item.title === "string" ? item.title : "";
    const url = item.url ?? item.link;
    if (!title || typeof url !== "string") return [];
    const published = item.publishedDate ?? item.published_date ?? item.date;
    return [{ title: title.slice(0, 160), url, content: String(item.content ?? item.snippet ?? "").slice(0, 1500),
      ...(typeof published === "string" ? { publishedAt: published.slice(0, 100) } : {}) }];
  });
}

async function boundedJson(response: Response): Promise<Record<string, any>> {
  if (!response.body) throw new Error("empty_search_response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 512 * 1024) throw new Error("search_response_too_large");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
