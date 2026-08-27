import Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";

import {
  ANTHROPIC_PROVIDER_CAPABILITIES,
  type ProviderCapabilitiesCarrier,
} from "./ai-provider.js";

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ChatCompletion = OpenAI.Chat.Completions.ChatCompletion;
type ChatCompletionCreateParams = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;

type AnthropicMessagesClient = Pick<Anthropic["messages"], "create">;

export interface AnthropicChatCompletionsOptions {
  timeoutMs?: number;
  /** Injection point for deterministic tests; production constructs the official SDK. */
  client?: { messages: AnthropicMessagesClient };
}

/**
 * A narrow compatibility adapter for the existing OpenAI-shaped AiService.
 * Network requests are issued only by Anthropic's official SDK; this class
 * merely translates request and response payloads at the provider boundary.
 */
export class AnthropicChatCompletions implements ProviderCapabilitiesCarrier {
  readonly providerCapabilities = ANTHROPIC_PROVIDER_CAPABILITIES;
  private readonly client: { messages: AnthropicMessagesClient };

  constructor(
    baseUrl: string,
    apiKey: string,
    options: AnthropicChatCompletionsOptions = {},
  ) {
    this.client = options.client ?? new Anthropic({
      baseURL: normalizeAnthropicBaseUrl(baseUrl),
      apiKey,
      timeout: options.timeoutMs,
      maxRetries: 0,
    });
  }

  async create(params: ChatCompletionCreateParams): Promise<ChatCompletion> {
    if ((params as { stream?: boolean }).stream === true) {
      throw new Error("anthropic_stream_unsupported");
    }
    const request = toAnthropicRequest(params);
    const signal = (params as { signal?: AbortSignal }).signal;
    const result = await this.client.messages.create(request as never, signal ? { signal } : undefined) as Anthropic.Message;

    const textContent = result.content
      .flatMap((block) => block.type === "text" ? [block.text] : [])
      .join("");

    return {
      id: result.id,
      object: "chat_completion",
      created: Math.floor(Date.now() / 1000),
      model: result.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: textContent },
          finish_reason: result.stop_reason === "end_turn" ? "stop" : result.stop_reason,
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: result.usage.input_tokens,
        completion_tokens: result.usage.output_tokens,
        total_tokens: result.usage.input_tokens + result.usage.output_tokens,
      },
    } as unknown as ChatCompletion;
  }
}

function toAnthropicRequest(params: ChatCompletionCreateParams): Record<string, unknown> {
  const systemParts: string[] = [];
  const messages: Array<{ role: "user" | "assistant"; content: string | Array<Record<string, unknown>> }> = [];

  for (const message of params.messages) {
    if (message.role === "system") {
      const content = extractText(message.content);
      if (content) systemParts.push(content);
      continue;
    }
    messages.push({
      role: message.role === "assistant" ? "assistant" : "user",
      content: toAnthropicContent(message.content),
    });
  }

  return {
    model: params.model,
    max_tokens: params.max_tokens ?? 1024,
    messages,
    ...(systemParts.length > 0 ? { system: systemParts.join("\n") } : {}),
    ...(params.temperature != null ? { temperature: params.temperature } : {}),
  };
}

function toAnthropicContent(content: unknown): string | Array<Record<string, unknown>> {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");

  const blocks = content.flatMap((part): Array<Record<string, unknown>> => {
    if (!part || typeof part !== "object") return [];
    const value = part as { type?: unknown; text?: unknown; image_url?: { url?: unknown } };
    if (value.type === "text" && typeof value.text === "string") {
      return [{ type: "text", text: value.text }];
    }
    if (value.type === "image_url" && typeof value.image_url?.url === "string") {
      return [{ type: "image", source: toAnthropicImageSource(value.image_url.url) }];
    }
    return [];
  });

  return blocks.length > 0 ? blocks : "";
}

function toAnthropicImageSource(url: string): Record<string, string> {
  const matched = /^data:(image\/(?:jpeg|png|gif|webp));base64,([a-z0-9+/=\s]+)$/i.exec(url);
  if (matched) {
    return {
      type: "base64",
      media_type: matched[1].toLowerCase(),
      data: matched[2].replace(/\s/g, ""),
    };
  }
  return { type: "url", url };
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => part && typeof part === "object" && (part as { type?: unknown }).type === "text"
      ? [typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""]
      : [])
    .filter(Boolean)
    .join("\n");
}

function normalizeAnthropicBaseUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, "");
  if (!normalized) {
    throw new Error("invalid_anthropic_base_url");
  }
  return normalized.replace(/\/v1(?:\/messages)?$/i, "") || normalized;
}
