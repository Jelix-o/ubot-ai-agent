import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { AiService, type AiToolRuntime } from "./ai-service.js";
import { AnthropicChatCompletions } from "./anthropic-adapter.js";

test("AnthropicChatCompletions preserves text and image URL content blocks", async (t) => {
  let received: Record<string, unknown> | undefined;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    received = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      id: "msg_test",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "图片已读取" }],
      model: "claude-test",
      stop_reason: "end_turn",
      usage: { input_tokens: 12, output_tokens: 4 },
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address() as AddressInfo;
  const adapter = new AnthropicChatCompletions(`http://127.0.0.1:${address.port}`, "test-key");

  const response = await adapter.create({
    model: "claude-test",
    max_tokens: 64,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "帮我看图" },
        { type: "image_url", image_url: { url: "https://example.com/image.png" } },
      ],
    }],
  } as never);

  assert.equal(response.choices[0]?.message.content, "图片已读取");
  assert.deepEqual(received, {
    model: "claude-test",
    max_tokens: 64,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "帮我看图" },
        { type: "image", source: { type: "url", url: "https://example.com/image.png" } },
      ],
    }],
  });
});

test("AnthropicChatCompletions explicitly declines OpenAI-style streaming", async () => {
  const adapter = new AnthropicChatCompletions("https://example.invalid", "test-key");
  await assert.rejects(
    adapter.create({ model: "claude-test", max_tokens: 64, stream: true, messages: [] } as never),
    /anthropic_stream_unsupported/,
  );
});

test("AnthropicChatCompletions sends cancellation and data URLs through the Messages SDK boundary", async () => {
  let received: Record<string, unknown> | undefined;
  let receivedSignal: AbortSignal | undefined;
  const controller = new AbortController();
  const adapter = new AnthropicChatCompletions("https://example.invalid/v1", "test-key", {
    client: {
      messages: {
        async create(request: unknown, options?: { signal?: AbortSignal }) {
          received = request as Record<string, unknown>;
          receivedSignal = options?.signal;
          return {
            id: "msg_sdk",
            model: "claude-test",
            stop_reason: "end_turn",
            content: [{ type: "text", text: "已完成" }],
            usage: { input_tokens: 3, output_tokens: 2 },
          } as never;
        },
      } as never,
    },
  });

  const response = await adapter.create({
    model: "claude-test",
    max_tokens: 32,
    temperature: 0.2,
    signal: controller.signal,
    messages: [
      { role: "system", content: "system instruction" },
      {
        role: "user",
        content: [
          { type: "text", text: "看一下" },
          { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
        ],
      },
    ],
  } as never);

  assert.equal(response.choices[0]?.message.content, "已完成");
  assert.equal(receivedSignal, controller.signal);
  assert.deepEqual(received, {
    model: "claude-test",
    max_tokens: 32,
    temperature: 0.2,
    system: "system instruction",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "看一下" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
      ],
    }],
  });
});

test("AnthropicChatCompletions translates client tools, tool results, and tool-use replies", async () => {
  let received: Record<string, unknown> | undefined;
  const adapter = new AnthropicChatCompletions("https://example.invalid", "test-key", {
    client: {
      messages: {
        async create(request: unknown) {
          received = request as Record<string, unknown>;
          return {
            id: "msg_tool",
            model: "claude-test",
            stop_reason: "tool_use",
            content: [{
              type: "tool_use",
              id: "toolu_1",
              name: "search_group_faq",
              input: { query: "请假流程" },
            }],
            usage: { input_tokens: 8, output_tokens: 3 },
          } as never;
        },
      } as never,
    },
  });

  const response = await adapter.create({
    model: "claude-test",
    max_tokens: 64,
    messages: [
      { role: "system", content: "Use supplied tools." },
      { role: "user", content: "查一下群里的请假流程" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: { name: "search_group_faq", arguments: '{"query":"请假流程"}' },
        }],
      },
      { role: "tool", tool_call_id: "call_1", content: '{"status":"ok"}' },
    ],
    tools: [{
      type: "function",
      function: {
        name: "search_group_faq",
        description: "Search only the current group's enabled FAQ entries.",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
          additionalProperties: false,
        },
      },
    }],
    tool_choice: { type: "function", function: { name: "search_group_faq" } },
  } as never);

  assert.deepEqual(received, {
    model: "claude-test",
    max_tokens: 64,
    system: "Use supplied tools.",
    messages: [
      { role: "user", content: "查一下群里的请假流程" },
      {
        role: "assistant",
        content: [{
          type: "tool_use",
          id: "call_1",
          name: "search_group_faq",
          input: { query: "请假流程" },
        }],
      },
      {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "call_1",
          content: '{"status":"ok"}',
        }],
      },
    ],
    tools: [{
      name: "search_group_faq",
      description: "Search only the current group's enabled FAQ entries.",
      input_schema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
    }],
    tool_choice: {
      type: "tool",
      name: "search_group_faq",
      disable_parallel_tool_use: true,
    },
  });
  assert.equal(response.choices[0]?.message.content, null);
  assert.equal(response.choices[0]?.finish_reason, "tool_calls");
  assert.deepEqual(response.choices[0]?.message.tool_calls, [{
    id: "toolu_1",
    type: "function",
    function: { name: "search_group_faq", arguments: '{"query":"请假流程"}' },
  }]);
});

test("AnthropicChatCompletions completes a native knowledge tool round through AiService", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const adapter = new AnthropicChatCompletions("https://example.invalid", "test-key", {
    client: {
      messages: {
        async create(request: unknown) {
          requests.push(request as Record<string, unknown>);
          if (requests.length === 1) {
            return {
              id: "msg_round_1",
              model: "claude-test",
              stop_reason: "tool_use",
              content: [{
                type: "tool_use",
                id: "toolu_round_1",
                name: "search_group_faq",
                input: { query: "请假" },
              }],
              usage: { input_tokens: 8, output_tokens: 3 },
            } as never;
          }
          return {
            id: "msg_round_2",
            model: "claude-test",
            stop_reason: "end_turn",
            content: [{ type: "text", text: "请按已核验的群规执行。" }],
            usage: { input_tokens: 16, output_tokens: 8 },
          } as never;
        },
      } as never,
    },
  });
  const runtime: AiToolRuntime = {
    tools: [{
      name: "search_group_faq",
      description: "Search only the current group's enabled FAQ entries.",
      parameters: {
        type: "object",
        required: ["query"],
        properties: { query: { type: "string" } },
        additionalProperties: false,
      },
    }],
    forceToolName: "search_group_faq",
    async execute(call) {
      assert.equal(call.name, "search_group_faq");
      assert.equal(call.arguments, '{"query":"请假"}');
      return { content: '{"status":"found","entries":[{"answer":"已核验群规"}]}' };
    },
  };
  const service = new AiService("https://example.invalid", "test-key", "claude-test", adapter as never);

  const reply = await service.generateReply({
    skill: {
      id: "huixian",
      name: "会仙",
      systemPrompt: "回答当前问题。",
      styleRules: [],
      knowledge: [],
      temperature: 0,
      maxContextTurns: 4,
    },
    history: [],
    userInput: "请查群规的请假流程",
    toolRuntime: runtime,
  });

  assert.equal(reply.text, "请按已核验的群规执行。");
  assert.deepEqual(reply.knowledgeToolCalls, ["search_group_faq"]);
  assert.equal(requests.length, 2);
  const first = requests[0] ?? {};
  assert.deepEqual(first.tool_choice, { type: "tool", name: "search_group_faq", disable_parallel_tool_use: true });
  const secondMessages = requests[1]?.messages as Array<{ role?: string; content?: unknown }>;
  assert.deepEqual(secondMessages.at(-1), {
    role: "user",
    content: [{
      type: "tool_result",
      tool_use_id: "toolu_round_1",
      content: '{"status":"found","entries":[{"answer":"已核验群规"}]}',
    }],
  });
});
