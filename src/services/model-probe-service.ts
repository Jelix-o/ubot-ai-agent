import { withModelOperation } from "./model-telemetry.js";
import os from "node:os";

import {
  AiService,
  ImageIntentClassificationError,
  getAiProviderFailureDetails,
} from "./ai-service.js";
import { AnthropicChatCompletions } from "./anthropic-adapter.js";
import type { AiHealthStatus, SystemModelConfig } from "../types.js";
import { classifyUpstreamFailure } from "../utils/upstream-failure.js";
import { requestGeneratedImage } from "./image-generation-service.js";

export interface ModelProbeStatus extends AiHealthStatus {
  probeType: "chat" | "image" | "image_intent";
  upstreamStatusCode?: number;
}

export async function probeSystemModel(model: Pick<SystemModelConfig, "baseUrl" | "model" | "purpose" | "apiKey" | "apiProtocol" | "requestTimeoutMs"> & { id?: string }): Promise<ModelProbeStatus> { return withModelOperation("probe", undefined, async () => {
  if (model.purpose === "image") return probeImageModel(model);
  if (model.purpose === "image_intent") return probeImageIntentModel(model);
  return probeChatModel(model);
}, model.id); }

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

/**
 * A normal chat check cannot establish that an OpenAI-compatible gateway
 * honors forced function calls. Exercise the exact bounded tool-call boundary
 * used by the natural image router without sending user content.
 */
async function probeImageIntentModel(
  model: Pick<SystemModelConfig, "baseUrl" | "model" | "apiKey" | "apiProtocol">,
): Promise<ModelProbeStatus> {
  const startedAt = Date.now();
  try {
    if (model.apiProtocol === "anthropic") {
      throw new ImageIntentClassificationError("unavailable");
    }
    const service = new AiService(model.baseUrl, model.apiKey ?? "", model.model, undefined, {
      providerCapabilities: { toolCalling: true },
    });
    const result = await service.classifyImageIntent({
      sanitizedText: "生成一张蓝色圆形图标",
      facts: {
        hasTrustedBotMention: true,
        hasTrustedReply: false,
        replyIsGeneratedImage: false,
        attachmentCount: 0,
      },
    });
    return {
      ok: true,
      detail: "图片意图判断模型连接正常，已完成一次原生工具调用检测。",
      model: result.model || model.model,
      baseUrl: model.baseUrl,
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
      cached: false,
      probeType: "image_intent",
    };
  } catch (error) {
    const details = getAiProviderFailureDetails(error);
    const invalidToolResult = error instanceof ImageIntentClassificationError && error.code === "invalid_response";
    return {
      ok: false,
      detail: invalidToolResult
        ? "图片意图判断模型未返回有效的原生工具调用结果。"
        : `图片意图工具调用失败：${imageIntentProbeErrorMessage(error)}`,
      model: model.model,
      baseUrl: model.baseUrl,
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
      cached: false,
      probeType: "image_intent",
      failureKind: invalidToolResult ? "format_error" : details.kind,
      ...(details.statusCode === undefined ? {} : { upstreamStatusCode: details.statusCode }),
    };
  }
}

function imageIntentProbeErrorMessage(error: unknown): string {
  if (error instanceof ImageIntentClassificationError && error.cause instanceof Error) {
    return error.cause.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function normalizeProbeDetail(detail: string): string {
  return detail.replace(/^画像\/记忆模型不可用：?/, "模型检测不通过：");
}
