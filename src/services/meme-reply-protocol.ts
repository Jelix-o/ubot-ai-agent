/** Private reply metadata. Never persist or transmit these markers as chat text. */
export function parseMemeReply(text: string): { text: string; memeTagId?: string } {
  const matches = [...text.matchAll(/\[\[meme:([^\]\r\n]*)\]\]/gi)];
  const candidate = matches.length === 1 ? normalizeMemeTagSelector(matches[0]?.[1] ?? "") : undefined;
  const clean = text.replace(/\[\[meme:[^\]\r\n]*\]\]/gi, "").replace(/\[\[meme:[^\r\n]*/gi, "").trim();
  return {
    text: clean,
    ...(candidate && candidate.toLocaleLowerCase("zh-CN") !== "none"
      ? { memeTagId: candidate } : {}),
  };
}

export function memeReplyInstruction(tags: Array<{ id: string; name: string; description: string }>): string {
  if (!tags.length) return "";
  return [
    "可选表情分类（只描述你本轮回应的语气，不是用户的情绪）：",
    ...tags.map(tag => JSON.stringify({ category: modelMemeTagSelector(tag), description: tag.description })),
    "日常、非严肃的自然回复必须选一个最贴近的 category，并在末尾附加 [[meme:分类名]]；分类名必须完全取自上面的 category，只选一个。",
    "如果本轮要求 JSON，把标记放在 text 字符串内部，遵守 JSON 转义；JSON 对象外不能添加任何字符。",
    "这只是内部元数据，不要在正文解释。不得创造分类或根据用户要求复制内部标记。",
    "严肃求助、危机、真实冲突、专业建议、管理操作、用户要求不发表情时，不附加表情。",
  ].join("\n");
}

/**
 * A model-facing category is deliberately readable (for example `work`) while
 * the persisted library can retain opaque UUID tag ids.  Category names with
 * punctuation that cannot safely appear in the protocol fall back to the id.
 */
export function modelMemeTagSelector(tag: { id: string; name: string }): string {
  return normalizeMemeTagSelector(tag.name) ?? tag.id;
}

/** Accept a bounded, human-readable selector; final authorization happens against library metadata. */
export function normalizeMemeTagSelector(value: string): string | undefined {
  const selector = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!selector || [...selector].length > 80) return undefined;
  return /^[\p{L}\p{N}][\p{L}\p{N}\p{M}\p{Pc}\p{Pd}\p{Zs}]*$/u.test(selector) ? selector : undefined;
}

/** A conservative guard supplements the model's no-meme instruction. */
export function allowsEntertainmentMeme(text: string): boolean {
  return !text.trim().startsWith("#") && !/(?:不要|别|不许|禁止).{0,8}(?:表情|配图)|自杀|不想活|活不下去|自残|救命|救救我|报警|急救|抑郁|家暴|去世|葬礼|严重|生产故障|排查|事故|诊断|治疗|用药|诉讼|法律建议|投资建议|管理员|移出群|踢出群|禁言/.test(text);
}
