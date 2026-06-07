import { mkdir, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { SkillDefinition } from "../types.js";
import { supportsMimoSinging, isMimoVoiceDesignModel } from "./mimo-tts-config.js";
import { buildMimoTtsInput } from "../utils/tts-text.js";
import { classifyUpstreamFailure, type UpstreamFailureKind } from "../utils/upstream-failure.js";

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

export interface TtsSynthesisOptions {
  mode?: "speech" | "singing";
}

export class TtsServiceError extends Error {
  constructor(
    message: string,
    readonly details: {
      baseUrl: string;
      model: string;
      systemModelId?: string;
      statusCode?: number;
      failureKind?: UpstreamFailureKind;
    },
  ) {
    super(message);
    this.name = "TtsServiceError";
  }
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

  async synthesize(text: string, skill: SkillDefinition, options: TtsSynthesisOptions = {}): Promise<TtsSynthesisResult> {
    if (options.mode === "singing" && !supportsMimoSinging(this.model)) {
      throw new TtsServiceError("Current MiMo TTS model does not support singing mode.", {
        baseUrl: this.baseUrl,
        model: this.model,
        failureKind: "format_error",
      });
    }

    const input = buildMimoTtsInput(skill, text, this.globalStyleHint, options);
    if (!input.assistantText) {
      throw new Error("TTS input text was empty after normalization.");
    }

    const request = buildTtsRequest({
      model: this.model,
      styleInstruction: input.styleInstruction,
      assistantText: input.assistantText,
      audioFormat: this.audioFormat,
      voice: skill.ttsConfig?.voice || this.voice,
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
      throw new TtsServiceError(
        `MiMo TTS request failed with status ${response.status}: ${errorText.slice(0, 200)}`,
        {
          baseUrl: this.baseUrl,
          model: this.model,
          statusCode: response.status,
          failureKind: classifyUpstreamFailure({ statusCode: response.status, message: errorText }),
        },
      );
    }

    const completion = (await response.json()) as TtsCompletionResponse;
    const audioData = completion.choices?.[0]?.message?.audio?.data;
    if (!audioData) {
      throw new TtsServiceError("MiMo TTS response did not contain audio data.", {
        baseUrl: this.baseUrl,
        model: this.model,
        failureKind: classifyUpstreamFailure({ message: "MiMo TTS response did not contain audio data." }),
      });
    }

    const buffer = Buffer.from(audioData, "base64");
    if (buffer.length === 0) {
      throw new TtsServiceError("MiMo TTS returned empty audio data.", {
        baseUrl: this.baseUrl,
        model: this.model,
        failureKind: classifyUpstreamFailure({ message: "MiMo TTS returned empty audio data." }),
      });
    }

    await mkdir(this.cacheDir, { recursive: true });
    const extension = this.audioFormat === "pcm16" ? "pcm" : this.audioFormat;
    const filePath = path.join(this.cacheDir, `${randomUUID()}.${extension}`);
    await writeFile(filePath, buffer);

    return {
      filePath,
      recordFile: `base64://${buffer.toString("base64")}`,
      spokenText: request.assistantText,
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
  styleInstruction?: string;
  assistantText: string;
  audioFormat: "wav" | "mp3" | "pcm" | "pcm16";
  voice: string;
}): {
  model: string;
  messages: TtsMessage[];
  audio: Record<string, string | boolean>;
  assistantText: string;
} {
  const messages: TtsMessage[] = [
    ...(input.styleInstruction ? [{ role: "user" as const, content: input.styleInstruction }] : []),
    { role: "assistant", content: input.assistantText },
  ];
  const audio: Record<string, string | boolean> = { format: input.audioFormat };
  if (isMimoVoiceDesignModel(input.model)) {
    audio.optimize_text_preview = true;
  } else {
    audio.voice = input.voice;
  }
  return {
    model: input.model,
    messages,
    audio,
    assistantText: input.assistantText,
  };
}
