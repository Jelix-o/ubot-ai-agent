import type { SkillDefinition, SkillTtsConfig } from "../types.js";
import { formatReplyMessages } from "./reply-format.js";

export interface MimoTtsInput {
  styleInstruction?: string;
  assistantText: string;
}

export interface MimoTtsBuildOptions {
  mode?: "speech" | "singing";
}

export function buildTtsInputText(
  skill: SkillDefinition,
  replyText: string,
  globalStyleHint?: string,
): string {
  return buildMimoTtsInput(skill, replyText, globalStyleHint).assistantText;
}

export function buildMimoTtsInput(
  skill: SkillDefinition,
  replyText: string,
  globalStyleHint?: string,
  options: MimoTtsBuildOptions = {},
): MimoTtsInput {
  const formattedMessages = formatReplyMessages(skill, replyText);
  const combined = formattedMessages.length > 0 ? formattedMessages.join("，") : replyText;
  const normalized = combined
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s{0,3}(?:[-*•]+|\d+\.)\s+/g, "")
        .replace(/\*\*(.*?)\*\*/g, "$1")
        .replace(/__(.*?)__/g, "$1")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/[*_~]/g, "")
        .trim(),
    )
    .filter(Boolean)
    .join("，")
    .replace(/\s+/g, " ")
    .replace(/[，。！？；：,.!?;:]{2,}/g, (match) => match[0] ?? "")
    .trim();

  if (!normalized) {
    return { assistantText: "" };
  }

  const styleInstruction = buildStyleInstruction(skill, globalStyleHint);
  const assistantText = addSentenceStyleTags(normalized, skill.ttsConfig, options.mode === "singing");
  return {
    ...(styleInstruction ? { styleInstruction } : {}),
    assistantText,
  };
}

function buildStyleInstruction(skill: SkillDefinition, globalStyleHint?: string): string {
  const config = skill.ttsConfig;
  return uniqueInstructionParts([
    globalStyleHint,
    config?.stylePrompt,
    skill.ttsStyleHint,
    config?.voice ? `音色使用 ${config.voice}` : undefined,
    config?.dialect ? `带一点${config.dialect}口音，但不要影响可懂度` : undefined,
    config?.personaTone ? `人设腔调偏${config.personaTone}` : undefined,
    config?.overallTone ? `整体语调${config.overallTone}` : undefined,
    config?.voiceTexture ? `音色定位${config.voiceTexture}` : undefined,
    config?.paceRhythm ? `语速与节奏体现${config.paceRhythm}` : undefined,
    config?.emotionState ? `情绪状态包含${config.emotionState}` : undefined,
    "根据每句话的语义自动匹配基础情绪、复合情绪、整体语调、音色定位、语速节奏、语音特征和哭笑表达，语气自然，不要把指令内容读出来。",
  ]).join("，").trim();
}

function uniqueInstructionParts(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const value of values) {
    const text = value?.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    parts.push(text);
  }
  return parts;
}

function addSentenceStyleTags(text: string, config: SkillTtsConfig | undefined, singing: boolean): string {
  const sentences = splitSentences(text);
  if (sentences.length === 0) {
    return singing ? `(唱歌)${text}` : text;
  }

  return sentences.map((sentence, index) => {
    const tags = [
      ...(singing && index === 0 ? ["唱歌"] : []),
      ...configuredTags(config),
      ...inferSentenceTags(sentence),
    ];
    const uniqueTags = Array.from(new Set(tags.map((tag) => tag.trim()).filter(Boolean))).slice(0, 8);
    return uniqueTags.length ? `(${uniqueTags.join(" ")})${sentence}` : sentence;
  }).join("");
}

function configuredTags(config: SkillTtsConfig | undefined): string[] {
  if (!config) return [];
  return [
    config.baseEmotion,
    config.compoundEmotion,
    config.overallTone,
    config.voiceTexture,
    config.paceRhythm,
    config.emotionState,
    config.voiceFeature,
    config.laughCry,
    config.dialect,
    config.personaTone,
  ].filter((value): value is string => Boolean(value?.trim()));
}

function inferSentenceTags(sentence: string): string[] {
  const tags: string[] = [];
  if (/[!！]{1,}|哈哈|牛|太好了|开心|高兴|赢|成功|冲/.test(sentence)) {
    tags.push("开心", "兴奋", "活泼", "语速加快");
  }
  if (/伤心|难过|遗憾|可惜|唉|哭|心酸|失落/.test(sentence)) {
    tags.push("悲伤", "怅然", "低声");
  }
  if (/生气|离谱|过分|别闹|滚|烦|不耐烦/.test(sentence)) {
    tags.push("愤怒", "不耐烦", "凌厉");
  }
  if (/害怕|紧张|完了|糟糕|危险|慌/.test(sentence)) {
    tags.push("紧张", "恐惧", "屏息");
  }
  if (/[?？]$|为什么|怎么会|真的假的|不会吧/.test(sentence)) {
    tags.push("惊讶", "疑惑", "语尾上扬");
  }
  if (/谢谢|辛苦|没事|放心|晚安|温柔|陪你/.test(sentence)) {
    tags.push("温柔", "平静", "轻声");
  }
  if (/哈哈|笑死|乐|绷不住/.test(sentence)) {
    tags.push("轻笑");
  }
  if (/呜|哭|哽咽|破防/.test(sentence)) {
    tags.push("哽咽");
  }
  if (tags.length === 0) {
    tags.push("平静", "自然");
  }
  return tags;
}

function splitSentences(text: string): string[] {
  return text
    .match(/[^。！？!?；;]+[。！？!?；;]?/g)
    ?.map((item) => item.trim())
    .filter(Boolean) ?? [];
}
