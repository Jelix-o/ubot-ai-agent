import type { SkillDefinition, SkillTtsConfig } from "../types.js";

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
  const normalized = normalizeTtsText(replyText);

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

function normalizeTtsText(text: string): string {
  return text
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
}

function buildStyleInstruction(skill: SkillDefinition, globalStyleHint?: string): string {
  const config = skill.ttsConfig;
  return uniqueInstructionParts([
    globalStyleHint,
    config?.stylePrompt,
    config?.voice ? `音色使用 ${config.voice}` : undefined,
    config?.dialect ? `带一点${config.dialect}口音，但不要影响可懂度` : undefined,
    config?.personaTone ? `人设腔调偏${config.personaTone}` : undefined,
    "目标文本中的每句话已按 MiMo 标签自动标注基础情绪、复合情绪、整体语调、音色定位、语速节奏、情绪状态、语音特征和哭笑表达；按标签自然演绎，不要把指令内容读出来。",
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

  const taggedText = sentences.map((sentence) => {
    const inferredTags = inferSentenceTags(sentence);
    const styleTags = [
      ...configuredTags(config),
      ...inferredTags.styleTags,
    ];
    const stylePrefix = formatTagBlock(styleTags);
    const audioPrefix = formatTagBlock(inferredTags.audioTags, "square");
    return `${stylePrefix}${audioPrefix}${sentence}`;
  }).join("");
  return singing ? `(唱歌)${taggedText}` : taggedText;
}

function formatTagBlock(tags: string[], mode: "paren" | "square" = "paren"): string {
  const uniqueTags = Array.from(new Set(tags.map((tag) => tag.trim()).filter(Boolean))).slice(0, 8);
  if (uniqueTags.length === 0) return "";
  return mode === "square" ? `[${uniqueTags.join(" ")}]` : `(${uniqueTags.join(" ")})`;
}

function configuredTags(config: SkillTtsConfig | undefined): string[] {
  if (!config) return [];
  return [
    config.dialect,
    config.personaTone,
  ].filter((value): value is string => Boolean(value?.trim()));
}

interface SentenceTtsTags {
  styleTags: string[];
  audioTags: string[];
}

function inferSentenceTags(sentence: string): SentenceTtsTags {
  let baseEmotion = "平静";
  let compoundEmotion = "";
  let overallTone = "干练";
  let voiceTexture = "清亮";
  const audioTags: string[] = [];

  if (/[!！]{1,}|哈哈|牛|太好了|开心|高兴|赢|成功|冲/.test(sentence)) {
    baseEmotion = "开心";
    compoundEmotion = "欣慰";
    overallTone = "活泼";
    voiceTexture = "清亮";
    audioTags.push("激动");
  }
  if (/伤心|难过|遗憾|可惜|唉|哭|心酸|失落/.test(sentence)) {
    baseEmotion = "悲伤";
    compoundEmotion = "怅然";
    overallTone = "深沉";
    voiceTexture = "沙哑";
    audioTags.push("叹气", "气声");
  }
  if (/生气|离谱|过分|别闹|滚|烦|不耐烦/.test(sentence)) {
    baseEmotion = "愤怒";
    compoundEmotion = "无奈";
    overallTone = "凌厉";
    voiceTexture = "沙哑";
    audioTags.push("不耐烦");
  }
  if (/害怕|紧张|完了|糟糕|危险|慌/.test(sentence)) {
    baseEmotion = "恐惧";
    compoundEmotion = "忐忑";
    overallTone = "严肃";
    voiceTexture = "清亮";
    audioTags.push("屏息", "紧张", "声音颤抖");
  }
  if (/[?？]$|为什么|怎么会|真的假的|不会吧/.test(sentence)) {
    baseEmotion = "惊讶";
    compoundEmotion = compoundEmotion || "忐忑";
    overallTone = overallTone === "干练" ? "俏皮" : overallTone;
    audioTags.push("震惊");
  }
  if (/谢谢|辛苦|没事|放心|晚安|温柔|陪你/.test(sentence)) {
    baseEmotion = "平静";
    compoundEmotion = "欣慰";
    overallTone = "温柔";
    voiceTexture = "醇雅";
  }
  if (/累|困|疲惫|没力气|撑不住/.test(sentence)) {
    baseEmotion = baseEmotion === "平静" ? "悲伤" : baseEmotion;
    compoundEmotion = "无奈";
    overallTone = "慵懒";
    voiceTexture = "沙哑";
    audioTags.push("长叹一口气", "疲惫", "气声");
  }
  if (/委屈|冤枉|心虚|对不起|抱歉/.test(sentence)) {
    baseEmotion = "委屈";
    compoundEmotion = /对不起|抱歉|心虚/.test(sentence) ? "愧疚" : "无奈";
    overallTone = "温柔";
    voiceTexture = "沙哑";
    audioTags.push(/心虚/.test(sentence) ? "心虚" : "委屈");
  }
  if (/冷笑/.test(sentence)) {
    audioTags.push("冷笑");
  } else if (/哈哈哈|大笑|笑死/.test(sentence)) {
    audioTags.push("大笑");
  } else if (/哈哈|轻笑|乐|绷不住/.test(sentence)) {
    audioTags.push("轻笑");
  }
  if (/嚎啕大哭/.test(sentence)) {
    audioTags.push("嚎啕大哭");
  } else if (/呜咽/.test(sentence)) {
    audioTags.push("呜咽");
  } else if (/呜|哭|哽咽|破防/.test(sentence)) {
    audioTags.push("哽咽");
  }

  return {
    styleTags: [baseEmotion, compoundEmotion, overallTone, voiceTexture],
    audioTags,
  };
}

function splitSentences(text: string): string[] {
  return text
    .match(/[^。！？!?；;，,]+[。！？!?；;，,]?/g)
    ?.map((item) => item.trim())
    .filter(Boolean) ?? [];
}
