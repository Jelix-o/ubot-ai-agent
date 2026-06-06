import { mkdir, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { SkillDefinition } from "../types.js";
import { buildTtsInputText } from "../utils/tts-text.js";

interface TtsCompletionResponse {
  choices?: Array<{
    message?: {
      audio?: {
        data?: string;
      };
    };
  }>;
}

type TtsMessage = {
  role: "user" | "assistant";
  content: string;
};

export interface TtsSynthesisResult {
  filePath: string;
  recordFile: string;
  spokenText: string;
  cleanup(): Promise<void>;
}

export class TtsService {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
    private readonly voice: string,
    private readonly audioFormat: "wav" | "mp3" | "pcm" | "pcm16",
    private readonly cacheDir: string,
    private readonly globalStyleHint?: string,
  ) {}

  async synthesize(text: string, skill: SkillDefinition): Promise<TtsSynthesisResult> {
    const spokenText = buildTtsInputText(skill, text, this.globalStyleHint);
    if (!spokenText) {
      throw new Error("TTS input text was empty after normalization.");
    }

    const request = buildTtsRequest({
      model: this.model,
      spokenText,
      audioFormat: this.audioFormat,
      voice: this.voice,
    });
    const response = await fetch(buildTtsUrl(this.baseUrl), {
      method: "POST",
      headers: {
        "api-key": this.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `MiMo TTS request failed with status ${response.status}: ${errorText.slice(0, 200)}`,
      );
    }

    const completion = (await response.json()) as TtsCompletionResponse;
    const audioData = completion.choices?.[0]?.message?.audio?.data;
    if (!audioData) {
      throw new Error("MiMo TTS response did not contain audio data.");
    }

    const buffer = Buffer.from(audioData, "base64");
    if (buffer.length === 0) {
      throw new Error("MiMo TTS returned empty audio data.");
    }

    await mkdir(this.cacheDir, { recursive: true });
    const extension = this.audioFormat === "pcm16" ? "pcm" : this.audioFormat;
    const filePath = path.join(this.cacheDir, `${randomUUID()}.${extension}`);
    await writeFile(filePath, buffer);

    return {
      filePath,
      recordFile: `base64://${buffer.toString("base64")}`,
      spokenText: request.spokenText,
      async cleanup(): Promise<void> {
        await unlink(filePath);
      },
    };
  }
}

function buildTtsUrl(baseUrl: string): string {
  const normalized = baseUrl.trim();
  if (/\/chat\/completions\/?$/i.test(normalized)) {
    return normalized.replace(/\/+$/, "");
  }
  return new URL("chat/completions", `${normalized.replace(/\/+$/, "")}/`).toString();
}

function buildTtsRequest(input: {
  model: string;
  spokenText: string;
  audioFormat: "wav" | "mp3" | "pcm" | "pcm16";
  voice: string;
}): {
  model: string;
  messages: TtsMessage[];
  audio: Record<string, string | boolean>;
  spokenText: string;
} {
  const { styleInstruction, text } = extractStyleInstruction(input.spokenText);
  const messages: TtsMessage[] = [
    ...(styleInstruction ? [{ role: "user" as const, content: styleInstruction }] : []),
    { role: "assistant", content: text },
  ];
  const audio: Record<string, string | boolean> = { format: input.audioFormat };
  if (input.model.includes("voicedesign")) {
    audio.optimize_text_preview = true;
  } else {
    audio.voice = input.voice;
  }
  return {
    model: input.model,
    messages,
    audio,
    spokenText: text,
  };
}

function extractStyleInstruction(value: string): { styleInstruction?: string; text: string } {
  const match = value.match(/^<style>(.*?)<\/style>(.*)$/su);
  if (!match) {
    return { text: value };
  }
  const styleInstruction = match[1]?.trim();
  const text = match[2]?.trim() || value;
  return {
    ...(styleInstruction ? { styleInstruction } : {}),
    text,
  };
}
