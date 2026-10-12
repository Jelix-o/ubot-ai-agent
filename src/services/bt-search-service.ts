import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";

export const BT_TYPES = ["anime", "movie", "adult"] as const;
export const BT_SOURCES = ["mikan", "nyaa", "btbtla", "onelou", "kpkuang", "sukebei"] as const;
export type BtSearchType = typeof BT_TYPES[number];
export interface BtSearchRequest {
  query: string;
  type?: BtSearchType;
  fast: boolean;
  full: boolean;
  json: boolean;
  debug: boolean;
  noCache: boolean;
  noDeep: boolean;
  sources: string[];
  timeoutMs: number;
  limit: number;
}
export interface BtSearchItem {
  title: string;
  page: string;
  torrent: string;
  magnet: string;
  size: string;
  resolution: string;
  subtitle: string;
  sources: string[];
  episodeStart: number;
  episodeEnd: number;
  isBatch: boolean;
}
export interface BtSearchSite {
  siteId: string;
  siteName: string;
  via: string;
  durationMs: number;
  resultCount: number;
  warnings: string[];
  items?: BtSearchItem[];
}
export interface BtSearchResult {
  query: string;
  requestedType: BtSearchType;
  resolvedType: BtSearchType;
  totalResults: number;
  rawResultCount: number;
  uniqueResultCount: number;
  durationMs: number;
  fromCache: boolean;
  cacheAgeMs: number;
  budgetExceeded: boolean;
  warnings: string[];
  sites: BtSearchSite[];
  items: BtSearchItem[];
}
export type BtSearchErrorCode = "invalid_arguments" | "busy" | "cancelled" | "timeout" | "engine_failed" | "invalid_output";
export class BtSearchError extends Error {
  constructor(public readonly code: BtSearchErrorCode, message: string = code) { super(message); }
}
export interface BtSearchRuntime {
  search(request: BtSearchRequest, options?: { signal?: AbortSignal; onStarted?: () => Promise<void> }): Promise<BtSearchResult>;
  stop?(): Promise<void>;
}

/** Quotes group words; shell metacharacters remain ordinary query characters. */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quote) {
      if (char === quote) quote = "";
      else if (char === "\\" && text[i + 1] === quote) token += text[++i];
      else token += char;
    } else if (char === '"' || char === "'") quote = char;
    else if (/\s/u.test(char)) { if (token) tokens.push(token); token = ""; }
    else token += char;
  }
  if (quote) throw new BtSearchError("invalid_arguments", "关键词的引号未闭合");
  if (token) tokens.push(token);
  return tokens;
}

export function parseBtSearchRequest(text: string): BtSearchRequest | undefined {
  const tokens = tokenize(text);
  if (!tokens.length || tokens.includes("--help") || tokens.includes("-h")) return undefined;
  const request: BtSearchRequest = {
    query: "", fast: false, full: false, json: false, debug: false,
    noCache: false, noDeep: false, sources: [], timeoutMs: 30_000, limit: 5,
  };
  const positional: string[] = [];
  let explicitLimit = false;
  let explicitTimeout = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (!token.startsWith("--")) { positional.push(token); continue; }
    const equals = token.indexOf("=");
    const flag = equals < 0 ? token : token.slice(0, equals);
    if (["--source", "--timeout", "--limit"].includes(flag)) {
      const value = equals < 0 ? tokens[++i] : token.slice(equals + 1);
      if (!value || value.startsWith("--")) throw new BtSearchError("invalid_arguments", `${flag} 缺少参数`);
      if (flag === "--source") {
        request.sources = [...new Set(value.toLowerCase().split(",").map((item) => item.trim()).filter(Boolean))];
        if (!request.sources.length || request.sources.some((item) => !(BT_SOURCES as readonly string[]).includes(item))) {
          throw new BtSearchError("invalid_arguments", `来源可选：${BT_SOURCES.join(",")}`);
        }
      } else if (flag === "--limit") {
        if (!/^\d+$/u.test(value) || Number(value) < 1 || Number(value) > 20) throw new BtSearchError("invalid_arguments", "--limit 必须为 1～20");
        request.limit = Number(value);
        explicitLimit = true;
      } else {
        const match = /^(\d+(?:\.\d+)?)(ms|s|m)?$/iu.exec(value);
        const milliseconds = match ? Number(match[1]) * ({ ms: 1, s: 1000, m: 60_000 }[match[2]?.toLowerCase() ?? "ms"] ?? 1) : 0;
        if (!Number.isFinite(milliseconds) || milliseconds < 1000 || milliseconds > 60_000) throw new BtSearchError("invalid_arguments", "--timeout 必须为 1～60 秒，例如 8s");
        request.timeoutMs = Math.round(milliseconds);
        explicitTimeout = true;
      }
      continue;
    }
    if (equals >= 0) throw new BtSearchError("invalid_arguments", `不支持的参数：${token}`);
    switch (flag) {
      case "--fast": request.fast = true; break;
      case "--full": case "--detail": case "--all": request.full = true; break;
      case "--json": request.json = true; break;
      case "--debug": request.debug = true; break;
      case "--no-cache": request.noCache = true; break;
      case "--no-deep": request.noDeep = true; break;
      default: throw new BtSearchError("invalid_arguments", `不支持的参数：${flag}`);
    }
  }
  const last = positional.at(-1);
  if ((BT_TYPES as readonly string[]).includes(last ?? "")) request.type = positional.pop() as BtSearchType;
  request.query = positional.join(" ").trim();
  if (!request.query || request.query.length > 300) throw new BtSearchError("invalid_arguments", "请提供 1～300 字的搜索关键词");
  if (request.full && !explicitLimit) request.limit = 20;
  if (request.fast && !explicitTimeout) request.timeoutMs = 8000;
  return request;
}

export function btEngineArguments(request: BtSearchRequest): string[] {
  const args = [request.query, ...(request.type ? [request.type] : []), "--json", "--timeout", String(request.timeoutMs), "--limit", String(request.limit)];
  for (const [enabled, flag] of [[request.fast, "--fast"], [request.full, "--full"], [request.debug, "--debug"], [request.noCache, "--no-cache"], [request.noDeep, "--no-deep"]] as const) {
    if (enabled) args.push(flag);
  }
  if (request.sources.length) args.push("--source", request.sources.join(","));
  return args;
}

function nonnegative(value: unknown): number { return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0; }
function text(value: unknown, max = 400): string { return typeof value === "string" ? value.replace(/[\r\n\u0000]/gu, " ").trim().slice(0, max) : ""; }
function link(value: unknown, magnet = false): string {
  if (typeof value !== "string" || value.length > 16_000 || /[\r\n\u0000]/u.test(value)) return "";
  try { const url = new URL(value); return (magnet ? url.protocol === "magnet:" && Boolean(url.searchParams.get("xt")?.startsWith("urn:btih:")) : ["http:", "https:"].includes(url.protocol)) ? value : ""; } catch { return ""; }
}
function item(value: unknown): BtSearchItem {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    title: text(raw.title), page: link(raw.page), torrent: link(raw.torrent), magnet: link(raw.magnet, true),
    size: text(raw.size), resolution: text(raw.resolution), subtitle: text(raw.subtitle),
    sources: (Array.isArray(raw.sources) ? raw.sources : [raw.siteName ?? raw.source]).map((source) => text(source, 80)).filter(Boolean).slice(0, 6),
    episodeStart: nonnegative(raw.episodeStart), episodeEnd: nonnegative(raw.episodeEnd), isBatch: raw.isBatch === true,
  };
}
export function normalizeBtSearchResult(value: unknown, request: BtSearchRequest): BtSearchResult {
  if (!value || typeof value !== "object") throw new BtSearchError("invalid_output");
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.items) || !Array.isArray(raw.sites) || !(BT_TYPES as readonly unknown[]).includes(raw.resolvedType)) throw new BtSearchError("invalid_output");
  return {
    query: text(raw.query, 300) || request.query,
    requestedType: (BT_TYPES as readonly unknown[]).includes(raw.requestedType) ? raw.requestedType as BtSearchType : raw.resolvedType as BtSearchType,
    resolvedType: raw.resolvedType as BtSearchType,
    totalResults: nonnegative(raw.totalResults), rawResultCount: nonnegative(raw.rawResultCount), uniqueResultCount: nonnegative(raw.uniqueResultCount),
    durationMs: nonnegative(raw.durationMs), fromCache: raw.fromCache === true, cacheAgeMs: nonnegative(raw.cacheAgeMs), budgetExceeded: raw.budgetExceeded === true,
    warnings: (Array.isArray(raw.warnings) ? raw.warnings : []).map((warning) => text(warning)).slice(0, 8),
    items: raw.items.slice(0, request.limit).map(item).filter((result) => Boolean(result.title && (result.page || result.torrent || result.magnet))),
    sites: raw.sites.slice(0, 18).map((value) => {
      const site = value as Record<string, unknown>;
      return { siteId: text(site.siteId, 40), siteName: text(site.siteName, 80), via: text(site.via, 80), durationMs: nonnegative(site.durationMs), resultCount: nonnegative(site.resultCount),
        warnings: (Array.isArray(site.warnings) ? site.warnings : []).map((warning) => text(warning)).slice(0, 5),
        ...(request.full && Array.isArray(site.items) ? { items: site.items.slice(0, 5).map(item) } : {}),
      };
    }),
  };
}

interface Waiter { resolve: () => void; reject: (error: Error) => void; signal?: AbortSignal; abort: () => void; }
export class BtSearchService implements BtSearchRuntime {
  private active = false;
  private closed = false;
  private waiters: Waiter[] = [];
  private controllers = new Set<AbortController>();
  private running = new Set<Promise<BtSearchResult>>();
  constructor(private readonly options: { dataDir: string; enginePath?: string; python?: string; proxy?: string; budgetMs?: number; graceMs?: number }) {}

  async search(request: BtSearchRequest, options: { signal?: AbortSignal; onStarted?: () => Promise<void> } = {}): Promise<BtSearchResult> {
    await this.acquire(options.signal);
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) controller.abort();
    this.controllers.add(controller);
    try {
      if (controller.signal.aborted || this.closed) throw new BtSearchError("cancelled");
      await options.onStarted?.();
      const task = this.execute(request, controller.signal);
      this.running.add(task);
      try { return await task; } finally { this.running.delete(task); }
    } finally {
      options.signal?.removeEventListener("abort", abort);
      this.controllers.delete(controller);
      this.release();
    }
  }

  async stop(): Promise<void> {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) { waiter.signal?.removeEventListener("abort", waiter.abort); waiter.reject(new BtSearchError("cancelled")); }
    for (const controller of this.controllers) controller.abort();
    await Promise.allSettled([...this.running]);
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    if (this.closed || signal?.aborted) return Promise.reject(new BtSearchError("cancelled"));
    if (!this.active) { this.active = true; return Promise.resolve(); }
    if (this.waiters.length >= 4) return Promise.reject(new BtSearchError("busy"));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal, abort: () => {
        this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
        signal?.removeEventListener("abort", waiter.abort);
        reject(new BtSearchError("cancelled"));
      } };
      this.waiters.push(waiter);
      signal?.addEventListener("abort", waiter.abort, { once: true });
    });
  }
  private release(): void {
    const next = this.waiters.shift();
    if (next) { next.signal?.removeEventListener("abort", next.abort); next.resolve(); }
    else this.active = false;
  }

  private async execute(request: BtSearchRequest, signal: AbortSignal): Promise<BtSearchResult> {
    await mkdir(this.options.dataDir, { recursive: true, mode: 0o700 });
    if (signal.aborted) throw new BtSearchError("cancelled");
    const enginePath = this.options.enginePath ?? fileURLToPath(new URL("../../assets/bt/scripts/bt.js", import.meta.url));
    const appData = realpathSync(path.dirname(this.options.dataDir));
    const runtimeRoot = path.join(path.dirname(appData), "bt-runtime");
    const venvPython = path.join(runtimeRoot, "venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
    const budgetMs = this.options.budgetMs ?? (request.fast ? 15_000 : 180_000);
    const browserState = path.join(this.options.dataDir, "browser-state");
    await Promise.all(["config", "cache", "share"].map(name => mkdir(path.join(browserState, name), { recursive: true, mode: 0o700 })));
    if (signal.aborted) throw new BtSearchError("cancelled");
    const env = {
      ...process.env,
      OPENCLAW_BT_STATE_FILE: path.join(this.options.dataDir, "state.json"),
      OPENCLAW_BT_CACHE_DIR: path.join(this.options.dataDir, "cache"),
      OPENCLAW_BT_COOKIE_JAR: path.join(this.options.dataDir, "cookies.json"),
      OPENCLAW_BT_KPKUANG_COOKIE_JAR: path.join(this.options.dataDir, "kpkuang-cookies.json"),
      OPENCLAW_BT_PYTHON: this.options.python?.trim() || process.env.UBOT_BT_PYTHON?.trim() || (existsSync(venvPython) ? venvPython : process.platform === "win32" ? "python" : "python3"),
      UBOT_BT_TOTAL_BUDGET_MS: String(budgetMs),
      PLAYWRIGHT_BROWSERS_PATH: process.env.UBOT_BT_BROWSER_PATH?.trim() || path.join(runtimeRoot, "browsers"),
      XDG_CONFIG_HOME: path.join(browserState, "config"),
      XDG_CACHE_HOME: path.join(browserState, "cache"),
      XDG_DATA_HOME: path.join(browserState, "share"),
      WARP_PROXY: this.options.proxy ?? (process.env.UBOT_BT_PROXY?.trim() || process.env.WARP_PROXY?.trim() || ""),
      PYTHONUNBUFFERED: "1",
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8",
      OPENCLAW_BT_INCLUDE_RAW: "0",
    };
    const child = spawn(process.execPath, [enginePath, ...btEngineArguments(request)], {
      env, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    return new Promise((resolve, reject) => {
      let output = "";
      const decoder = new StringDecoder("utf8");
      let bytes = 0;
      let partial: BtSearchResult | undefined;
      let completed: BtSearchResult | undefined;
      let stopping = false;
      let terminalError: BtSearchError | undefined;
      const startedAt = Date.now();
      const terminate = (error: BtSearchError) => {
        if (stopping) return;
        stopping = true;
        terminalError = error;
        void killProcessTree(child).catch(() => child.kill("SIGKILL"));
      };
      const abort = () => terminate(new BtSearchError("cancelled"));
      const timer = setTimeout(() => terminate(new BtSearchError("timeout")), budgetMs + (this.options.graceMs ?? 0));
      timer.unref();
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      child.stdout?.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) { terminate(new BtSearchError("invalid_output")); return; }
        output += decoder.write(chunk);
      });
      // Always drain stderr, but diagnostics never become a group message.
      child.stderr?.on("data", () => {});
      child.on("message", (message: unknown) => {
        try {
          const progress = message as { kind?: string; result?: unknown };
          if (progress.kind === "bt-progress") partial = normalizeBtSearchResult(progress.result, request);
          if (progress.kind === "bt-complete" && !stopping) {
            completed = normalizeBtSearchResult(progress.result, request);
            stopping = true;
            // Keep the engine PID alive until we kill its descendants, including
            // browser helpers, on Windows as well as POSIX.
            void killProcessTree(child).catch(() => child.kill("SIGKILL"));
          }
        } catch { /* A malformed progress update cannot replace a valid result. */ }
      });
      child.once("error", () => { terminalError = new BtSearchError("engine_failed"); });
      child.once("close", async (code) => {
        output += decoder.end();
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        await killProcessTree(child).catch(() => {});
        if (signal.aborted || terminalError?.code === "cancelled") { reject(new BtSearchError("cancelled")); return; }
        if (terminalError?.code === "timeout" && partial) {
          resolve({ ...partial, durationMs: Date.now() - startedAt, budgetExceeded: true }); return;
        }
        if (terminalError) { reject(terminalError); return; }
        if (completed) { resolve(completed); return; }
        if (code !== 0) { reject(new BtSearchError("engine_failed")); return; }
        try { resolve(normalizeBtSearchResult(JSON.parse(output), request)); }
        catch { reject(new BtSearchError("invalid_output")); }
      });
    });
  }
}

async function killProcessTree(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  if (process.platform !== "win32") {
    try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    return;
  }
  await new Promise<void>((resolve) => {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, shell: false, stdio: "ignore" });
    killer.once("error", () => { child.kill("SIGKILL"); resolve(); });
    killer.once("close", () => resolve());
  });
}
