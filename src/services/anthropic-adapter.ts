import type OpenAI from "openai";

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ChatCompletion = OpenAI.Chat.Completions.ChatCompletion;
type ChatCompletionCreateParams = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | Array<{ type: string; [key: string]: unknown }>;
}

interface AnthropicRequest {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: string;
  temperature?: number;
}

interface AnthropicResponse {
  id: string;
  type: string;
  role: string;
  content: Array<{ type: string; text?: string }>;
  model: string;
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
}

export class AnthropicChatCompletions {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  async create(params: ChatCompletionCreateParams): Promise<ChatCompletion> {
    const { messages, model, temperature, max_tokens } = params;

    let systemPrompt = "";
    const anthropicMessages: AnthropicMessage[] = [];

    for (const msg of messages) {
      if (msg.role === "system") {
        systemPrompt += (systemPrompt ? "\n" : "") + (typeof msg.content === "string" ? msg.content : "");
      } else {
        let content: string;
        if (typeof msg.content === "string") {
          content = msg.content;
        } else if (Array.isArray(msg.content)) {
          content = msg.content
            .filter((part): part is OpenAI.Chat.Completions.ChatCompletionContentPartText => part.type === "text")
            .map((part) => part.text)
            .join("\n");
        } else {
          content = String(msg.content ?? "");
        }
        anthropicMessages.push({ role: msg.role as "user" | "assistant", content });
      }
    }

    const body: AnthropicRequest = {
      model,
      max_tokens: max_tokens ?? 1024,
      messages: anthropicMessages,
      ...(systemPrompt ? { system: systemPrompt } : {}),
      ...(temperature != null ? { temperature } : {}),
    };

    const url = `${this.baseUrl.replace(/\/$/, "")}/v1/messages`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown error");
      throw new Error(`Anthropic API error ${response.status}: ${errorText}`);
    }

    const result = (await response.json()) as AnthropicResponse;

    const textContent = result.content
      .filter((block) => block.type === "text" && block.text)
      .map((block) => block.text!)
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
