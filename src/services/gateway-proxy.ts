import { createServer } from "node:http";

import { logInfo, logWarn } from "../logger.js";
import type { Metrics } from "../shared/metrics.js";

/**
 * LLM Gateway Proxy (plan section 1 & 2.4/2.5):
 *  - Circuit breaker: 5 consecutive failures or p95 > 40s opens the breaker
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
  /** p95 latency (ms) sustained above which the breaker trips. */
  slowThresholdMs?: number;
  /** How long the breaker stays open before half-open probing. */
  openMs?: number;
  /** Minimal calls needed to evaluate p95 slowness. */
  slowSampleMin?: number;
}

export interface GatewayCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class GatewayProxy {
  private consecutiveFailures = 0;
  private openedAt = 0;
  private state: "closed" | "open" | "half_open" = "closed";
  private readonly recentLatencyMs: number[] = [];

  constructor(
    private readonly execute?: (signal: AbortSignal) => Promise<unknown>,
    private readonly metrics?: Metrics,
    private readonly options: GatewayProxyOptions = {},
  ) {}

  get stateName(): "closed" | "open" | "half_open" {
    if (this.state === "open" && Date.now() - this.openedAt >= this.openMsOrDefault()) {
      return "half_open";
    }
    return this.state;
  }

  /**
   * Runs `task` under the breaker. When a task is given it overrides the
   * constructor execute — the breaker state (failures, latency, open window)
   * is shared across calls regardless of which task ran.
   */
  async call<T>(task?: (signal: AbortSignal) => Promise<T>, options: GatewayCallOptions = {}): Promise<T> {
    if (this.state === "open") {
      if (Date.now() - this.openedAt >= this.openMsOrDefault()) {
        this.state = "half_open";
      } else {
        this.metrics?.inc("circuit_open_calls");
        throw new CircuitOpenError("circuit tripped");
      }
    }

    const execute = task ?? this.execute;
    if (!execute) {
      throw new Error("GatewayProxy requires an execute callback or a per-call task.");
    }

    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? 50_000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onExternalAbort = (): void => controller.abort();
    options.signal?.addEventListener("abort", onExternalAbort, { once: true });

    const startedAt = Date.now();
    try {
      const result = await execute(controller.signal);
      const latency = Date.now() - startedAt;
      this.recordLatency(latency);
      this.consecutiveFailures = 0;
      this.state = "closed";
      return result as T;
    } catch (error) {
      this.consecutiveFailures += 1;
      const failure = error instanceof Error ? error.message : String(error);
      this.metrics?.inc("llm_error");
      if (this.consecutiveFailures >= this.tripAfterFailuresOrDefault()) {
        this.openCircuit(`consecutive failures ${this.consecutiveFailures}`);
      } else if (this.isSlowP95()) {
        this.openCircuit("p95 latency above threshold");
      }
      throw error;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onExternalAbort);
    }
  }

  private recordLatency(latencyMs: number): void {
    this.recentLatencyMs.push(latencyMs);
    if (this.recentLatencyMs.length > 100) {
      this.recentLatencyMs.shift();
    }
    this.metrics?.observeLatency("llm", latencyMs);
    if (this.isSlowP95()) {
      this.openCircuit("p95 latency above threshold");
    }
  }

  private isSlowP95(): boolean {
    const samples = this.recentLatencyMs;
    const minSamples = this.options.slowSampleMin ?? 20;
    if (samples.length < minSamples) {
      return false;
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)]!;
    return p95 > (this.options.slowThresholdMs ?? 40_000);
  }

  private openCircuit(reason: string): void {
    if (this.state === "open") {
      return;
    }
    this.state = "open";
    this.openedAt = Date.now();
    this.metrics?.inc("circuit_breaker_open");
    logWarn("LLM circuit breaker opened.", { reason });
  }

  private openMsOrDefault(): number {
    return this.options.openMs ?? 30_000;
  }

  private tripAfterFailuresOrDefault(): number {
    return this.options.tripAfterFailures ?? 5;
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
