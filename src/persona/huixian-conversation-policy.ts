import { createHash } from "node:crypto";

import type { SkillDefinition } from "../types.js";

const LEGACY_HUIXIAN_CONVERSATION_REVISION = "conversation-delta-2026-10-20";
export const PREVIOUS_HUIXIAN_CONVERSATION_REVISION = "conversation-policy-2026-10-20-r2";
export const PREVIOUS_HUIXIAN_CONVERSATION_REVISIONS = [
  LEGACY_HUIXIAN_CONVERSATION_REVISION,
  PREVIOUS_HUIXIAN_CONVERSATION_REVISION,
] as const;
export const HUIXIAN_CONVERSATION_REVISION = "conversation-policy-2026-10-20-r3";
export const HUIXIAN_CONVERSATION_MARKER = "【会仙对话策略：2026-10-20-r3】";
const LEGACY_MARKER = "【会仙对话策略：2026-10-20】";
const PREVIOUS_MARKER = "【会仙对话策略：2026-10-20-r2】";
const PREVIOUS_HEADER = "以下为当前对话风格，覆盖前文对篇幅、铺垫、主动解释和习惯性追问的旧偏好；准确性、尊重和必要风险提醒继续有效。";
const POLICY_HEADER = "当前对话风格由下方受管理的 styleRules 统一定义；本轮明确要求优先于默认篇幅偏好，准确性与必要风险提醒继续有效。";
export const HUIXIAN_CONVERSATION_RULES = [
  "直白、俏皮、敢吐槽，像熟悉的群友接话，不端着，不写客服式分析报告。",
  "默认先直接回答、给判断或接梗；只有用户追问为什么、要求展开，或明确任务确有需要时才解释。",
  "按本轮新增信息决定篇幅，不设目标字数，不为完整感添加原因、建议、总结或风险清单。",
  "已经提供的条件不重复询问，已经解释的内容不换措辞重播；用户重问时简短确认，再回应剩余疑惑。",
  "不强行以反问结尾；只有缺少会改变答案的关键条件时才问一个具体问题。",
  "可以接住吹牛和起哄，但不把群友态度当作事实证据，不因最后一个人换了说法就改判断；新证据到来时直接修正。",
  "不主动引入无关的疾病或负面假设；必要且直接相关的风险提醒保留，条件未变不反复追加。",
  "按本轮材料接话，不把旧示例、旧段子或别的话题套进当前问题。",
];

const RELEASE_MANAGED_EXAMPLE_FINGERPRINTS = new Set([
  "b84802bdd332e3628d21e06444e149e861da0349d34e19bc96eea5c85ae4f18f",
  "b11ded16ad1b3e5de4932e5c01779fea2ea0174c4b7424856cf39dd895f84630",
  "d587e60d7a35524fd0f1d240af796ae6c9e6742b88963ab02a1ea7c66fab0476",
  "a54aa72a2097e446f2ee1297d542b3f9bdb934bc1ae900c809fbac4a9d17e330",
]);

/** Remove only known managed lines, keeping edits or additions around them. */
export function stripManagedConversationSections(prompt: string): string {
  const base = prompt.replace("会接梗、吐槽、表达偏好、安慰人、认真分析，也会把实际问题讲清楚并给出能马上用的建议。", "会接梗、吐槽、表达偏好、安慰人，也能认真处理实际问题。");
  if (![LEGACY_MARKER, PREVIOUS_MARKER, HUIXIAN_CONVERSATION_MARKER].some(marker => base.includes(marker))) return base;
  const managed = new Set([LEGACY_MARKER, PREVIOUS_MARKER, HUIXIAN_CONVERSATION_MARKER, PREVIOUS_HEADER, POLICY_HEADER, ...HUIXIAN_CONVERSATION_RULES]);
  return base.split(/\r?\n/u).filter(line => !managed.has(line.trim())).join("\n").replace(/\n{3,}/gu, "\n\n").trim();
}

export function normalizeHuixianStyleRules(rules: string[]): string[] {
  return [...new Set(rules.filter(rule => !HUIXIAN_CONVERSATION_RULES.includes(rule)).map(rule =>
    rule === "像群里熟悉、可靠、有趣的人自然接话：短问题短答，复杂问题先给结论再给步骤。"
      ? "像群里熟悉、可靠、有趣的人自然接话。" : rule))];
}

/** Upgrade known managed content; administrator-owned fields remain intact. */
export function upgradeHuixianConversationProfile(profile: SkillDefinition): SkillDefinition {
  const next = structuredClone(profile);
  next.systemPrompt = `${stripManagedConversationSections(next.systemPrompt).trim()}\n\n${HUIXIAN_CONVERSATION_MARKER}\n${POLICY_HEADER}`;
  next.styleRules = [...normalizeHuixianStyleRules(next.styleRules), ...HUIXIAN_CONVERSATION_RULES];
  // Release examples must never become reusable group-chat scripts. Match both
  // sides so administrator-authored examples that happen to share a sentence
  // remain intact.
  const oldAnswers = new Set([
    "照片这题先留点神秘感吧。你想看偏清冷还是偏明艳？我给你写一版形象设定",
    "见面这件事先不安排啦。你是想找人喝酒聊天，还是单纯想热闹？我给你出几个不尴尬的玩法",
  ]);
  next.exampleExchanges = (next.exampleExchanges ?? []).filter(example =>
    !oldAnswers.has(example.assistant) &&
    !RELEASE_MANAGED_EXAMPLE_FINGERPRINTS.has(exampleFingerprint(example)),
  );
  return next;
}

function exampleFingerprint(example: { user: string; assistant: string }): string {
  return createHash("sha256").update(`${example.user}\u0000${example.assistant}`).digest("hex");
}
