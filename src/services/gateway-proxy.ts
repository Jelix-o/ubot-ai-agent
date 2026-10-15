import { createServer } from "node:http";

import { logInfo, logWarn } from "../logger.js";
import type { Metrics } from "../shared/metrics.js";

/**
 * LLM Gateway Proxy (plan section 1 & 2.4/2.5):
 *  - Circuit breaker: 5 consecutive transient failures open the breaker
 *    for `openMs`; while open, calls are rejected with CircuitOpenError and NO
 *    LLM quota is consumed (plan section 2.5).
 *  - Tiered timeouts: the caller supplies an overall budget; this proxy adds
 *    the breaker semantics on top of the underlying cancellable call.
 *  - Fixed degradation wording per tier — never generated on the spot.
 *  - Exposes a standard OpenAI-compatible HTTP endpoint on 127.0.0.1:18080/v1
 *    so a future standalone gateway process can reuse the same class.
 */

export class CircuitOpenError extends Error {
  constructor(detail: string) {
    super(`LLM circuit breaker is open: ${detail}`);
    this.name = "CircuitOpenError";
  }
}

export interface GatewayProxyOptions {
  /** Consecutive failures that trip the breaker. */
  tripAfterFailures?: number;
  /** Legacy compatibility option. Latency no longer trips the breaker. */
  slowThresholdMs?: number;
  /** How long the breaker stays open before half-open probing. */
  openMs?: number;
  /** Legacy compatibility option. Latency is monitoring data only. */
  slowSampleMin?: number;
}

export interface GatewayCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  countFailure?: (error: unknown) => boolean;
}

export class GatewayProxy {
  private consecutiveFailures = 0;
  private openedAt = 0;
  private state: "closed" | "open" | "half_open" = "closed";
  private probeInFlight = false;
  private generation = 0;

  constructor(
    private readonly execute?: (signal: AbortSignal) => Promise<unknown>,
    private readonly metrics?: Metrics,
    private readonly options: GatewayProxyOptions = {},
  ) {}

  get stateName(): "closed" | "open" | "half_open" {
    return this.state === "open" && Date.now() - this.openedAt >= (this.options.openMs ?? 30_000) ? "half_open" : this.state;
  }

  async call<T>(task?: (signal: AbortSignal) => Promise<T>, options: GatewayCallOptions = {}): Promise<T> {
    options.signal?.throwIfAborted();
    if (this.state === "open") {
      if (this.stateName !== "half_open") throw new CircuitOpenError("circuit tripped");
      this.state = "half_open";
    }
    if (this.state === "half_open" && this.probeInFlight) throw new CircuitOpenError("probe in flight");
    const probe = this.state === "half_open";
    if (probe) this.probeInFlight = true;
    const generation = this.generation;
    const execute = task ?? this.execute;
    if (!execute) { this.probeInFlight = false; throw new Error("GatewayProxy requires an execute callback or a per-call task."); }
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", onExternalAbort, { once: true });
    const timer = setTimeout(() => controller.abort(Object.assign(new Error("model attempt timed out"), { status: 408 })), options.timeoutMs ?? 50_000);
    const startedAt = Date.now();
    let onAbort: (() => void) | undefined;
    try {
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener("abort", onAbort, { once: true });
        if (controller.signal.aborted) onAbort();
      });
      const result = await Promise.race([Promise.resolve().then(() => { controller.signal.throwIfAborted(); return execute(controller.signal); }), aborted]);
      this.metrics?.observeLatency("llm", Date.now() - startedAt);
      if (generation === this.generation) { this.consecutiveFailures = 0; this.state = "closed"; }
      return result as T;
    } catch (error) {
      if (!options.signal?.aborted && (options.countFailure?.(error) ?? true) && generation === this.generation) {
        this.consecutiveFailures += 1;
        this.metrics?.inc("llm_error");
        if (probe || this.consecutiveFailures >= (this.options.tripAfterFailures ?? 5)) {
          this.state = "open"; this.openedAt = Date.now(); this.generation += 1;
          this.metrics?.inc("circuit_breaker_open");
          logWarn("LLM model circuit breaker opened.", { reason: "consecutive upstream failures" });
        }
      } else if (probe && generation === this.generation) {
        this.state = "open"; this.openedAt = Date.now();
      }
      throw error;
    } finally {
      clearTimeout(timer);
      if (onAbort) controller.signal.removeEventListener("abort", onAbort);
      options.signal?.removeEventListener("abort", onExternalAbort);
      if (probe) this.probeInFlight = false;
    }
  }

}

/**
 * Fixed degradation wording per failure tier (plan section 2.5) — the caller
 * maps a failure to a tier, never asks the model to phrase it.
 */
export const DEGRADED_MESSAGES: Record<string, string> = {
  circuit_open: "我这会儿有点忙，稍后回你哈",
  timeout: "这次回复超过等待时间了，请稍后再试一次",
  rate_limit: "回复服务现在有点忙，请稍后再试一次",
  auth: "回复服务的上游配置异常，管理员需要检查模型连接",
  unavailable: "回复服务暂时不可用，请稍后再试一次",
  network: "回复服务暂时不可用，请稍后再试一次",
  image_unavailable: "那张图我这边没打开，方便重发或者简单说下内容吗？",
  image_format: "这张图我识别不了",
  image_safety: "这张图我不太方便评论",
  image_vision_timeout: "我看了一下这张图，暂时想不出具体见解",
  realtime_lookup_failed: "我没查到实时数据，稍后你可以再问一次",
  llm_semaphore_timeout: "我这会儿有点忙，稍后回你哈",
};

export function degradedMessage(tier: string): string {
  return DEGRADED_MESSAGES[tier] ?? DEGRADED_MESSAGES.unavailable!;
}

// ---- HTTP endpoint (127.0.0.1:18080/v1) ----

export interface GatewayHttpOptions {
  host?: string;
  port?: number;
}

/**
 * Minimal OpenAI-compatible proxy endpoint. Requests are forwarded to the
 * `execute` callback with an abort signal so the caller's cancellation
 * semantics apply. Used by a standalone gateway process when the worker count
 * grows; in the current single-worker deployment the worker uses GatewayProxy
 * directly and this server is optional.
 */
export function startGatewayHttpServer(
  execute: (signal: AbortSignal) => Promise<unknown>,
  options: GatewayHttpOptions = {},
): { close: () => void; port: number } {
  const port = options.port ?? 18_080;
  const host = options.host ?? "127.0.0.1";
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || !req.url?.startsWith("/v1/chat/completions")) {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }
    try {
      const result = await execute(new AbortController().signal);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(result));
    } catch (error) {
      res.statusCode = 502;
      res.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }));
    }
  });
  server.listen(port, host);
  logInfo("Gateway HTTP proxy listening.", { host, port });
  return {
    close: () => server.close(),
    port,
  };
}
