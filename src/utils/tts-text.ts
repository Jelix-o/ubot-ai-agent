import type { SkillDefinition } from "../types.js";

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
  const normalized = cleanTtsTargetText(replyText);

  if (!normalized) {
    return { assistantText: "" };
  }

  const singing = options.mode === "singing";
  const styleInstruction = buildStyleInstruction(skill, normalized, globalStyleHint, singing);
  const assistantText = singing ? `(唱歌)${normalized}` : normalized;
  return {
    ...(styleInstruction ? { styleInstruction } : {}),
    assistantText,
  };
}

function cleanTtsTargetText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/```[a-zA-Z0-9_-]*\n?/g, "")
    .replace(/```/g, "")
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s{0,3}(?:[-*•]+|\d+\.)\s+/g, "")
        .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .replace(/\*\*(.*?)\*\*/g, "$1")
        .replace(/__(.*?)__/g, "$1")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/<[^>]+>/g, "")
        .replace(/[（(【\[]([^）)\]】]{1,30})[）)】\]]/g, (match, content: string) =>
          isStageDirection(content) ? "" : match,
        )
        .replace(/[*_~]/g, "")
        .trim(),
    )
    .filter(Boolean)
    .join("，")
    .replace(/\s+/g, " ")
    .replace(/[，。！？；：,.!?;:]{2,}/g, (match) => match[0] ?? "")
    .trim();
}

function isStageDirection(content: string): boolean {
  const normalized = content.trim();
  if (!normalized) return false;
  if (/^\d+$/.test(normalized)) return false;
  return /(?:语气|语调|口吻|腔调|声线|音色|音量|语速|节奏|停顿|情绪|表情|旁白|独白|内心|唱腔|念白|轻声|低声|小声|大声|压低|提高|温柔|坚定|激动|开心|难过|伤心|紧张|害怕|生气|撒娇|俏皮|严肃|冷静|深情|哽咽|哭|笑|轻笑|大笑|冷笑|叹气|喘息|地$)/u.test(normalized);
}

function buildStyleInstruction(
  skill: SkillDefinition,
  cleanText: string,
  globalStyleHint?: string,
  singing = false,
): string {
  const config = skill.ttsConfig;
  const inferredInstruction = buildInferredStyleInstruction(cleanText);
  return uniqueInstructionParts([
    globalStyleHint,
    config?.stylePrompt,
    config?.voice ? `音色使用 ${config.voice}` : undefined,
    config?.dialect ? `带一点${config.dialect}口音，但不要影响可懂度` : undefined,
    config?.personaTone ? `人设腔调偏${config.personaTone}` : undefined,
    singing ? "使用唱歌模式自然演绎正文，保持旋律感，不要把括号标签、舞台提示或控制说明唱出来。" : undefined,
    inferredInstruction,
    "assistant 消息只包含需要合成的干净正文；本消息中的风格、语气、情绪、音色、语速和舞台控制说明只用于演绎，不要朗读。",
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

function buildInferredStyleInstruction(text: string): string | undefined {
  const sentences = splitSentences(text);
  if (sentences.length === 0) return undefined;

  const inferred = sentences.map(inferSentenceTags);
  const styleTags = uniqueTags(inferred.flatMap((item) => item.styleTags));
  const audioTags = uniqueTags(inferred.flatMap((item) => item.audioTags));
  if (styleTags.length === 0 && audioTags.length === 0) return undefined;
  return `根据正文语义自然演绎，参考风格：${styleTags.join("、")}；参考语音表现：${audioTags.join("、")}`;
}

function uniqueTags(tags: string[]): string[] {
  return Array.from(new Set(tags.map((tag) => tag.trim()).filter(Boolean))).slice(0, 12);
}

interface SentenceTtsTags {
  styleTags: string[];
  audioTags: string[];
}

function inferSentenceTags(sentence: string): SentenceTtsTags {
  let baseEmotion = "平静";
  let compoundEmotion = "释然";
  let overallTone = "干练";
  let voiceTexture = "清亮";
  let speedRhythm = "自然停顿";
  let emotionalState = "平稳";
  let voiceFeature = "清晰";
  let cryLaughExpression = "无哭笑";

  if (/[!！]{1,}|哈哈|牛|太好了|开心|高兴|赢|成功|冲/.test(sentence)) {
    baseEmotion = "开心";
    compoundEmotion = "欣慰";
    overallTone = "活泼";
    voiceTexture = "清亮";
    speedRhythm = "语速稍快";
    emotionalState = "激动";
    voiceFeature = "明亮";
  }
  if (/伤心|难过|遗憾|可惜|唉|哭|心酸|失落/.test(sentence)) {
    baseEmotion = "悲伤";
    compoundEmotion = "怅然";
    overallTone = "深沉";
    voiceTexture = "沙哑";
    speedRhythm = "叹气";
    emotionalState = "低落";
    voiceFeature = "气声";
  }
  if (/生气|离谱|过分|别闹|滚|烦|不耐烦/.test(sentence)) {
    baseEmotion = "愤怒";
    compoundEmotion = "无奈";
    overallTone = "凌厉";
    voiceTexture = "沙哑";
    speedRhythm = "短促";
    emotionalState = "不耐烦";
    voiceFeature = "沙哑";
  }
  if (/害怕|紧张|完了|糟糕|危险|慌/.test(sentence)) {
    baseEmotion = "恐惧";
    compoundEmotion = "忐忑";
    overallTone = "严肃";
    voiceTexture = "清亮";
    speedRhythm = "屏息";
    emotionalState = "紧张";
    voiceFeature = "声音颤抖";
  }
  if (/[?？]$|为什么|怎么会|真的假的|不会吧/.test(sentence)) {
    baseEmotion = "惊讶";
    compoundEmotion = compoundEmotion === "释然" ? "忐忑" : compoundEmotion;
    overallTone = overallTone === "干练" ? "俏皮" : overallTone;
    speedRhythm = speedRhythm === "自然停顿" ? "语尾上扬" : speedRhythm;
    emotionalState = emotionalState === "平稳" ? "震惊" : emotionalState;
  }
  if (/谢谢|辛苦|没事|放心|晚安|温柔|陪你/.test(sentence)) {
    baseEmotion = "平静";
    compoundEmotion = "欣慰";
    overallTone = "温柔";
    voiceTexture = "醇雅";
    speedRhythm = "轻缓";
    emotionalState = "温柔";
    voiceFeature = "柔和";
  }
  if (/累|困|疲惫|没力气|撑不住/.test(sentence)) {
    baseEmotion = baseEmotion === "平静" ? "悲伤" : baseEmotion;
    compoundEmotion = "无奈";
    overallTone = "慵懒";
    voiceTexture = "沙哑";
    speedRhythm = "长叹一口气";
    emotionalState = "疲惫";
    voiceFeature = "气声";
  }
  if (/委屈|冤枉|心虚|对不起|抱歉/.test(sentence)) {
    baseEmotion = "委屈";
    compoundEmotion = /对不起|抱歉|心虚/.test(sentence) ? "愧疚" : "无奈";
    overallTone = "温柔";
    voiceTexture = "沙哑";
    speedRhythm = "轻缓";
    emotionalState = /心虚/.test(sentence) ? "心虚" : "委屈";
    voiceFeature = "气声";
  }
  if (/冷笑/.test(sentence)) {
    cryLaughExpression = "冷笑";
  } else if (/哈哈哈|大笑|笑死/.test(sentence)) {
    cryLaughExpression = "大笑";
  } else if (/哈哈|轻笑|乐|绷不住/.test(sentence)) {
    cryLaughExpression = "轻笑";
  }
  if (/嚎啕大哭/.test(sentence)) {
    cryLaughExpression = "嚎啕大哭";
  } else if (/呜咽/.test(sentence)) {
    cryLaughExpression = "呜咽";
  } else if (/呜|哭|哽咽|破防/.test(sentence)) {
    cryLaughExpression = "哽咽";
  }

  return {
    styleTags: [baseEmotion, compoundEmotion, overallTone, voiceTexture],
    audioTags: [speedRhythm, emotionalState, voiceFeature, cryLaughExpression],
  };
}

function splitSentences(text: string): string[] {
  return text
    .match(/[^。！？!?；;，,]+[。！？!?；;，,]?/g)
    ?.map((item) => item.trim())
    .filter(Boolean) ?? [];
}
