import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import type { SkillDefinition } from "../types.js";
import { TtsService } from "./tts-service.js";

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

  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body));
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("api-key"), "test-key");
    assert.equal(headers.has("authorization"), false);
    assert.equal(payload.model, "mimo-v2-tts");
    assert.equal(payload.audio.voice, "mimo_default");
    assert.match(payload.messages[0].content, /<style>热情 讲故事<\/style>/);

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
      "https://api.xiaomimimo.com/v1",
      "test-key",
      "mimo-v2-tts",
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
