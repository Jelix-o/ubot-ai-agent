import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import type { SkillDefinition } from "../types.js";
import { MIMO_TTS_BASE_URL, MIMO_TTS_MODEL } from "./mimo-tts-config.js";
import { TtsService, TtsServiceError } from "./tts-service.js";

const skill: SkillDefinition = {
  id: "jackma",
  name: "马云",
  systemPrompt: "",
  styleRules: [],
  knowledge: [],
  ttsStyleHint: "热情 讲故事",
  temperature: 0.9,
  maxContextTurns: 12,
};

test("TtsService decodes audio data, writes wav file, and exposes base64 record payload", async () => {
  const originalFetch = globalThis.fetch;
  const cacheDir = path.join(process.cwd(), "data", "test-tts-cache");

  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), `${MIMO_TTS_BASE_URL}/chat/completions`);
    const payload = JSON.parse(String(init?.body));
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("api-key"), "test-key");
    assert.equal(headers.has("authorization"), false);
    assert.equal(payload.model, MIMO_TTS_MODEL);
    assert.equal(payload.audio.voice, "mimo_default");
    assert.equal(payload.audio.format, "wav");
    assert.equal(payload.messages[0].role, "user");
    assert.equal(payload.messages[0].content, "热情 讲故事");
    assert.equal(payload.messages[1].role, "assistant");
    assert.match(payload.messages[1].content, /先说结论/);

    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              audio: {
                data: Buffer.from("tts-audio").toString("base64"),
              },
            },
          },
        ],
      }),
      { status: 200 },
    );
  };

  try {
    const service = new TtsService(
      MIMO_TTS_BASE_URL,
      "test-key",
      MIMO_TTS_MODEL,
      "mimo_default",
      "wav",
      cacheDir,
    );

    const result = await service.synthesize("先说结论，这事能做", skill);
    const buffer = await readFile(result.filePath);

    assert.equal(buffer.toString(), "tts-audio");
    assert.equal(result.recordFile, `base64://${Buffer.from("tts-audio").toString("base64")}`);
    await result.cleanup();
  } finally {
    globalThis.fetch = originalFetch;
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test("TtsService accepts a full MiMo chat completions URL without appending the path twice", async () => {
  const originalFetch = globalThis.fetch;
  const cacheDir = path.join(process.cwd(), "data", "test-tts-full-url-cache");

  globalThis.fetch = async (input: string | URL | Request) => {
    assert.equal(String(input), "https://api.xiaomimimo.com/v1/chat/completions");
    return new Response(
      JSON.stringify({
        choices: [{ message: { audio: { data: Buffer.from("ok").toString("base64") } } }],
      }),
      { status: 200 },
    );
  };

  try {
    const service = new TtsService(
      "https://api.xiaomimimo.com/v1/chat/completions",
      "test-key",
      "mimo-v2.5-tts",
      "mimo_default",
      "wav",
      cacheDir,
    );

    const result = await service.synthesize("测试语音", skill);
    assert.equal((await readFile(result.filePath)).toString(), "ok");
    await result.cleanup();
  } finally {
    globalThis.fetch = originalFetch;
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test("TtsService errors include safe request metadata without api keys", async () => {
  const originalFetch = globalThis.fetch;
  const cacheDir = path.join(process.cwd(), "data", "test-tts-error-cache");

  globalThis.fetch = async () => new Response(
    JSON.stringify({ error: { message: "Invalid API Key", type: "invalid_key" } }),
    { status: 401 },
  );

  try {
    const service = new TtsService(
      MIMO_TTS_BASE_URL,
      "secret-key-must-not-leak",
      MIMO_TTS_MODEL,
      "mimo_default",
      "wav",
      cacheDir,
    );

    await assert.rejects(
      service.synthesize("测试语音", skill),
      (error) => {
        assert.ok(error instanceof TtsServiceError);
        assert.equal(error.details.baseUrl, MIMO_TTS_BASE_URL);
        assert.equal(error.details.model, MIMO_TTS_MODEL);
        assert.equal(error.details.statusCode, 401);
        assert.equal(error.details.failureKind, "auth");
        assert.equal(error.message.includes("secret-key-must-not-leak"), false);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(cacheDir, { recursive: true, force: true });
  }
});
