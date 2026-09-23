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

const MAX_TOOL_ARGUMENTS_LENGTH = 8_000;

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

  async create(
    params: ChatCompletionCreateParams,
    options?: { signal?: AbortSignal; timeout?: number },
  ): Promise<ChatCompletion> {
    if ((params as { stream?: boolean }).stream === true) {
      throw new Error("anthropic_stream_unsupported");
    }
    const request = toAnthropicRequest(params);
    const signal = options?.signal ?? (params as { signal?: AbortSignal }).signal;
    const requestOptions = signal || options?.timeout
      ? { ...(signal ? { signal } : {}), ...(options?.timeout ? { timeout: options.timeout } : {}) }
      : undefined;
    const result = await this.client.messages.create(request as never, requestOptions) as Anthropic.Message;

    const textContent = result.content
      .flatMap((block) => block.type === "text" ? [block.text] : [])
      .join("");
    const toolCalls = result.content
      .flatMap((block, index) => block.type === "tool_use"
        ? [{
            id: block.id || `tool-${index + 1}`,
            type: "function" as const,
            function: { name: block.name, arguments: serializeToolArguments(block.input) },
          }]
        : []);

    return {
      id: result.id,
      object: "chat_completion",
      created: Math.floor(Date.now() / 1000),
      model: result.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: textContent || null,
            ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: toolCalls.length > 0 || result.stop_reason === "tool_use"
            ? "tool_calls"
            : result.stop_reason === "end_turn" ? "stop" : result.stop_reason,
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

  for (let index = 0; index < params.messages.length; index += 1) {
    const message = params.messages[index]! as unknown as Record<string, unknown>;
    if (message.role === "system") {
      const content = extractText(message.content);
      if (content) systemParts.push(content);
      continue;
    }
    if (message.role === "assistant") {
      messages.push({ role: "assistant", content: toAnthropicAssistantContent(message) });
      continue;
    }
    if (message.role === "tool") {
      const blocks: Array<Record<string, unknown>> = [];
      while (index < params.messages.length && (params.messages[index] as { role?: unknown })?.role === "tool") {
        const toolMessage = params.messages[index] as unknown as Record<string, unknown>;
        const id = typeof toolMessage.tool_call_id === "string" ? toolMessage.tool_call_id : "";
        if (id) {
          blocks.push({ type: "tool_result", tool_use_id: id, content: extractText(toolMessage.content) });
        }
        index += 1;
      }
      index -= 1;
      if (blocks.length > 0) messages.push({ role: "user", content: blocks });
      continue;
    }
    messages.push({ role: "user", content: toAnthropicContent(message.content) });
  }

  const tools = toAnthropicTools(params);
  // Anthropic rejects a tool choice when there are no usable tool definitions.
  const toolChoice = tools ? toAnthropicToolChoice(params) : undefined;

  return {
    model: params.model,
    max_tokens: params.max_tokens ?? 1024,
    messages,
    ...(systemParts.length > 0 ? { system: systemParts.join("\n") } : {}),
    ...(params.temperature != null ? { temperature: params.temperature } : {}),
    ...(tools ? { tools } : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
  };
}

function toAnthropicAssistantContent(message: Record<string, unknown>): string | Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  const text = extractText(message.content);
  if (text) blocks.push({ type: "text", text });
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const [index, raw] of calls.entries()) {
    if (!raw || typeof raw !== "object") continue;
    const call = raw as { id?: unknown; type?: unknown; function?: { name?: unknown; arguments?: unknown } };
    if (call.type !== "function" || typeof call.function?.name !== "string" || !call.function.name.trim()) continue;
    blocks.push({
      type: "tool_use",
      id: typeof call.id === "string" && call.id.trim() ? call.id : `tool-${index + 1}`,
      name: call.function.name,
      input: parseToolArguments(call.function.arguments),
    });
  }
  return blocks.length > 0 ? blocks : "";
}

function toAnthropicTools(params: ChatCompletionCreateParams): Array<Record<string, unknown>> | undefined {
  const rawTools = (params as unknown as { tools?: unknown }).tools;
  if (!Array.isArray(rawTools) || rawTools.length === 0) return undefined;
  const tools = rawTools.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const tool = raw as { type?: unknown; function?: { name?: unknown; description?: unknown; parameters?: unknown } };
    if (tool.type !== "function" || typeof tool.function?.name !== "string" || !tool.function.name.trim()) return [];
    const schema = tool.function.parameters && typeof tool.function.parameters === "object" && !Array.isArray(tool.function.parameters)
      ? tool.function.parameters
      : { type: "object", properties: {} };
    return [{
      name: tool.function.name,
      ...(typeof tool.function.description === "string" && tool.function.description.trim() ? { description: tool.function.description } : {}),
      input_schema: schema,
    }];
  });
  return tools.length > 0 ? tools : undefined;
}

function toAnthropicToolChoice(params: ChatCompletionCreateParams): Record<string, unknown> | undefined {
  const choice = (params as unknown as { tool_choice?: unknown }).tool_choice;
  if (choice === "auto") return { type: "auto", disable_parallel_tool_use: true };
  if (choice === "required") return { type: "any", disable_parallel_tool_use: true };
  if (choice === "none") return { type: "none" };
  if (choice && typeof choice === "object") {
    const name = (choice as { type?: unknown; function?: { name?: unknown } }).function?.name;
    if (typeof name === "string" && name.trim()) return { type: "tool", name, disable_parallel_tool_use: true };
  }
  return undefined;
}

function parseToolArguments(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || value.length > MAX_TOOL_ARGUMENTS_LENGTH) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function serializeToolArguments(value: unknown): string {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  try {
    const serialized = JSON.stringify(input);
    return serialized.length <= MAX_TOOL_ARGUMENTS_LENGTH ? serialized : "{}";
  } catch {
    return "{}";
  }
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
