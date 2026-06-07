import os from "node:os";

import { AiService } from "./ai-service.js";
import type { AiHealthStatus, SystemModelConfig } from "../types.js";
import { classifyUpstreamFailure } from "../utils/upstream-failure.js";

export interface ModelProbeStatus extends AiHealthStatus {
  probeType: "chat" | "tts";
  upstreamStatusCode?: number;
}

interface TtsProbeResponse {
  choices?: Array<{
    message?: {
      audio?: {
        data?: string;
      };
    };
  }>;
}

export async function probeSystemModel(model: Pick<SystemModelConfig, "baseUrl" | "model" | "purpose" | "apiKey">): Promise<ModelProbeStatus> {
  return model.purpose === "tts" ? probeTtsModel(model) : probeChatModel(model);
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

async function probeChatModel(model: Pick<SystemModelConfig, "baseUrl" | "model" | "apiKey">): Promise<ModelProbeStatus> {
  const startedAt = Date.now();
  const health = await new AiService(model.baseUrl, model.apiKey ?? "", model.model).checkHealth({ refresh: true, cacheTtlMs: 0 });
  return {
    ...health,
    detail: health.ok ? `文本模型连接正常：${health.detail}` : normalizeProbeDetail(health.detail),
    latencyMs: health.latencyMs || Date.now() - startedAt,
    probeType: "chat",
  };
}

async function probeTtsModel(model: Pick<SystemModelConfig, "baseUrl" | "model" | "apiKey">): Promise<ModelProbeStatus> {
  const startedAt = Date.now();
  const endpoint = buildChatCompletionsUrl(model.baseUrl);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "api-key": model.apiKey ?? "",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: model.model,
        messages: [{ role: "assistant", content: "系统状态检测" }],
        audio: buildTtsProbeAudio(model.model),
      }),
    });
    const latencyMs = Date.now() - startedAt;
    const text = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        detail: `TTS 上游返回 HTTP ${response.status}：${text.slice(0, 220)}`,
        model: model.model,
        baseUrl: model.baseUrl,
        checkedAt: new Date().toISOString(),
        latencyMs,
        cached: false,
        probeType: "tts",
        upstreamStatusCode: response.status,
        failureKind: classifyUpstreamFailure({ statusCode: response.status, message: text }),
      };
    }
    const json = JSON.parse(text) as TtsProbeResponse;
    const audioData = json.choices?.[0]?.message?.audio?.data;
    return {
      ok: Boolean(audioData),
      detail: audioData ? "TTS 模型连接正常，已返回音频数据。" : "TTS 模型接口可用，但未返回音频数据。",
      model: model.model,
      baseUrl: model.baseUrl,
      checkedAt: new Date().toISOString(),
      latencyMs,
      cached: false,
      probeType: "tts",
      upstreamStatusCode: response.status,
      ...(audioData ? {} : { failureKind: classifyUpstreamFailure({ message: "TTS response did not contain audio data" }) }),
    };
  } catch (error) {
    return {
      ok: false,
      detail: `TTS 请求失败：${error instanceof Error ? error.message : String(error)}`,
      model: model.model,
      baseUrl: model.baseUrl,
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
      cached: false,
      probeType: "tts",
      failureKind: classifyUpstreamFailure({ error }),
    };
  }
}

function buildChatCompletionsUrl(baseUrl: string): string {
  const normalized = baseUrl.trim();
  if (/\/chat\/completions\/?$/i.test(normalized)) {
    return normalized.replace(/\/+$/, "");
  }
  return new URL("chat/completions", `${normalized.replace(/\/+$/, "")}/`).toString();
}

function buildTtsProbeAudio(model: string): Record<string, string | boolean> {
  if (model.includes("voicedesign")) {
    return {
      format: "wav",
      optimize_text_preview: true,
    };
  }
  return {
    voice: "mimo_default",
    format: "wav",
  };
}

function normalizeProbeDetail(detail: string): string {
  return detail.replace(/^画像\/记忆模型不可用：?/, "模型检测不通过：");
}
