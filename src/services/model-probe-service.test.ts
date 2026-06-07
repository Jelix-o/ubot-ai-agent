import assert from "node:assert/strict";
import test from "node:test";

import { MIMO_TTS_BASE_URL } from "./mimo-tts-config.js";
import { probeSystemModel } from "./model-probe-service.js";

test("probeSystemModel uses MiMo api-key header for TTS probes", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), `${MIMO_TTS_BASE_URL}/chat/completions`);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("api-key"), "tts-key");
    assert.equal(headers.has("authorization"), false);
    const payload = JSON.parse(String(init?.body));
    assert.equal(payload.model, "mimo-v2.5-tts");
    assert.equal(payload.messages[0].role, "assistant");
    return new Response(JSON.stringify({
      choices: [{ message: { audio: { data: Buffer.from("ok").toString("base64") } } }],
    }), { status: 200 });
  };

  try {
    const status = await probeSystemModel({
      purpose: "tts",
      baseUrl: MIMO_TTS_BASE_URL,
      apiKey: "tts-key",
      model: "mimo-v2.5-tts",
    });
    assert.equal(status.ok, true);
    assert.equal(status.probeType, "tts");
    assert.equal(status.upstreamStatusCode, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("probeSystemModel keeps upstream TTS status code in failures", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("bad gateway", { status: 502 });

  try {
    const status = await probeSystemModel({
      purpose: "tts",
      baseUrl: MIMO_TTS_BASE_URL,
      apiKey: "tts-key",
      model: "mimo-v2.5-tts",
    });
    assert.equal(status.ok, false);
    assert.equal(status.probeType, "tts");
    assert.equal(status.upstreamStatusCode, 502);
    assert.equal(status.failureKind, "unavailable");
    assert.match(status.detail, /HTTP 502/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("probeSystemModel classifies TTS format failures", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: {} }] }), { status: 200 });

  try {
    const status = await probeSystemModel({
      purpose: "tts",
      baseUrl: MIMO_TTS_BASE_URL,
      apiKey: "tts-key",
      model: "mimo-v2.5-tts",
    });
    assert.equal(status.ok, false);
    assert.equal(status.failureKind, "format_error");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("probeSystemModel accepts a full MiMo chat completions URL", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    assert.equal(String(input), "https://api.xiaomimimo.com/v1/chat/completions");
    return new Response(JSON.stringify({
      choices: [{ message: { audio: { data: Buffer.from("ok").toString("base64") } } }],
    }), { status: 200 });
  };

  try {
    const status = await probeSystemModel({
      purpose: "tts",
      baseUrl: "https://api.xiaomimimo.com/v1/chat/completions",
      apiKey: "tts-key",
      model: "mimo-v2.5-tts",
    });
    assert.equal(status.ok, true);
    assert.equal(status.probeType, "tts");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
