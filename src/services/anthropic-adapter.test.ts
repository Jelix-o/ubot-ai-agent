import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

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
