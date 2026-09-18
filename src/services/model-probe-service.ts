import os from "node:os";

import { AiService } from "./ai-service.js";
import { AnthropicChatCompletions } from "./anthropic-adapter.js";
import type { AiHealthStatus, SystemModelConfig } from "../types.js";
import { classifyUpstreamFailure } from "../utils/upstream-failure.js";
import { requestGeneratedImage } from "./image-generation-service.js";

export interface ModelProbeStatus extends AiHealthStatus {
  probeType: "chat" | "image";
  upstreamStatusCode?: number;
}

export async function probeSystemModel(model: Pick<SystemModelConfig, "baseUrl" | "model" | "purpose" | "apiKey" | "apiProtocol" | "requestTimeoutMs">): Promise<ModelProbeStatus> {
  if (model.purpose === "image") return probeImageModel(model);
  return probeChatModel(model);
}

export function getServerStatusSnapshot(): Record<string, unknown> {
  const memory = process.memoryUsage();
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  return {
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()} ${os.arch()}`,
    uptimeSeconds: Math.floor(os.uptime()),
    loadAverage: os.loadavg(),
    cpuCount: os.cpus().length,
    totalMemory,
    freeMemory,
    usedMemory: Math.max(0, totalMemory - freeMemory),
    process: {
      pid: process.pid,
      uptimeSeconds: Math.floor(process.uptime()),
      nodeVersion: process.version,
      rss: memory.rss,
      heapUsed: memory.heapUsed,
      heapTotal: memory.heapTotal,
    },
    checkedAt: new Date().toISOString(),
  };
}

async function probeChatModel(model: Pick<SystemModelConfig, "baseUrl" | "model" | "apiKey" | "apiProtocol">): Promise<ModelProbeStatus> {
  const startedAt = Date.now();
  let service: AiService;
  if (model.apiProtocol === "anthropic") {
    const client = new AnthropicChatCompletions(model.baseUrl, model.apiKey ?? "");
    service = new AiService(model.baseUrl, model.apiKey ?? "", model.model, client as any);
  } else {
    service = new AiService(model.baseUrl, model.apiKey ?? "", model.model);
  }
  const health = await service.checkHealth({ refresh: true, cacheTtlMs: 0 });
  return {
    ...health,
    detail: health.ok ? `文本模型连接正常：${health.detail}` : normalizeProbeDetail(health.detail),
    latencyMs: health.latencyMs || Date.now() - startedAt,
    probeType: "chat",
  };
}

async function probeImageModel(
  model: Pick<SystemModelConfig, "baseUrl" | "model" | "apiKey" | "requestTimeoutMs">,
): Promise<ModelProbeStatus> {
  const startedAt = Date.now();
  try {
    const image = await requestGeneratedImage(model, "A simple solid blue circle on a white background", { quality: "low" });
    return {
      ok: image.data.byteLength > 0,
      detail: "图片模型连接正常，已完成一次低质量测试生成。",
      model: model.model,
      baseUrl: model.baseUrl,
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
      cached: false,
      probeType: "image",
    };
  } catch (error) {
    return {
      ok: false,
      detail: `图片模型请求失败：${error instanceof Error ? error.message : String(error)}`,
      model: model.model,
      baseUrl: model.baseUrl,
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
      cached: false,
      probeType: "image",
      failureKind: classifyUpstreamFailure({ error }),
    };
  }
}
function normalizeProbeDetail(detail: string): string {
  return detail.replace(/^画像\/记忆模型不可用：?/, "模型检测不通过：");
}
