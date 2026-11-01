import { renderAsync } from "@resvg/resvg-js";
import { fileURLToPath } from "node:url";
import { beijingClock, beijingDateKey } from "../utils/beijing-calendar.js";
import type { ChatRankingSnapshot } from "./chat-ranking-statistics.js";

const FONT = fileURLToPath(new URL("../../assets/fonts/NotoSansCJKsc-Regular.otf", import.meta.url));
const SEGMENTER = new Intl.Segmenter("zh", { granularity: "grapheme" });
export function rankingImageLabel(value: string, max = 22): string {
  const clean = value.normalize("NFC").replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}]/gu, "·")
    .replace(/[\p{Cc}\p{Cf}\uFE0F]/gu, " ").replace(/\s+/gu, " ").trim();
  const units = [...SEGMENTER.segment(clean)].map(part => part.segment);
  return units.length > max ? units.slice(0, max - 1).join("") + "…" : clean;
}
function xml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]!);
}

export function chatRankingSvg(snapshot: ChatRankingSnapshot): string {
  const width = 1080, rowHeight = 78, rows = Math.max(1, snapshot.entries.length);
  const selfY = 370 + rows * rowHeight, topicY = selfY + 145;
  const activityY = topicY + 105 + Math.max(1, snapshot.topics.length) * 68;
  const footerY = activityY + (snapshot.hourlyActivity?.length ? 280 : 0);
  const height = footerY + 136;
  const parts: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="1080" height="${height}" fill="#f2f7fb"/>`,
    `<path d="M0 0H1080V222C810 275 260 190 0 245Z" fill="#ddecf7"/>`,
    `<g font-family="Noto Sans CJK SC" fill="#18384e">`];
  const text = (x: number, y: number, value: string, size = 28, color = "#18384e", weight = 400, anchor = "start") =>
    parts.push(`<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${color}" text-anchor="${anchor}">${xml(value)}</text>`);
  text(66, 67, "大肥鱼 · 群聊看板", 25, "#537c96");
  const period = snapshot.periodLabel ?? "今日";
  text(66, 132, `${period}，谁最能聊？`, 48, "#173d57", 700);
  const rangeLabel = (value: string) => `${beijingDateKey(new Date(value))} ${beijingClock(new Date(value))}`;
  text(66, 184, snapshot.rangeStart && snapshot.rangeEnd ? `${rangeLabel(snapshot.rangeStart)}—${rangeLabel(snapshot.rangeEnd)}（北京时间）` : `${snapshot.dayKey}  ·  截至 ${beijingClock(new Date(snapshot.asOf))}（北京时间）`, 23, "#53758a");
  // Repo-native whale illustration; no remote images or generated artwork.
  parts.push('<g transform="translate(867 63)"><path d="M0 55C0 13 34 0 66 0C100 0 125 25 125 54L151 30L149 70L119 72C105 104 30 110 9 77Z" fill="#70adc9"/><path d="M24 75Q61 108 103 76Q74 122 24 75" fill="#dceff7"/><circle cx="35" cy="43" r="5" fill="#173d57"/><path d="M45 20Q60 11 72 20M52 4Q53 -12 65 -15" fill="none" stroke="#70adc9" stroke-width="9" stroke-linecap="round"/></g>');
  text(66, 275, snapshot.totalMessages.toLocaleString("en-US"), 46, "#1a668d", 700);
  text(300, 275, "条已收录消息", 25, "#53758a");
  text(650, 275, String(snapshot.participantCount), 46, "#1a668d", 700);
  text(770, 275, "位群友参与", 25, "#53758a");
  parts.push(`<path d="M66 305H1014" stroke="#c9dce8"/>`);
  text(66, 352, `发言 TOP ${snapshot.topCount}`, 31, "#173d57", 700);
  text(1014, 352, "所选时段已收录消息 · 条", 21, "#68879a", 400, "end");
  const maximum = Math.max(1, ...snapshot.entries.map(entry => entry.messageCount));
  snapshot.entries.forEach((entry, index) => {
    const y = 381 + index * rowHeight;
    parts.push(`<rect x="66" y="${y}" width="948" height="66" rx="12" fill="${index % 2 ? "#eaf2f8" : "#ffffff"}"/>`);
    const medal = ["#bb8540", "#6b8191", "#ad7959"][index] ?? "#68879a";
    text(95, y + 42, String(entry.rank).padStart(2, "0"), 29, medal, 700);
    const label = entry.userName.trim() && entry.userName !== entry.userId ? entry.userName : `群友 ${entry.userId.slice(-4)}`;
    text(165, y + 40, rankingImageLabel(label, 19), 27);
    parts.push(`<rect x="715" y="${y + 23}" width="170" height="16" rx="8" fill="#e1edf4"/><rect x="715" y="${y + 23}" width="${Math.max(3, Math.round(170 * entry.messageCount / maximum))}" height="16" rx="8" fill="${index < 3 ? "#61a1c4" : "#97bed5"}"/>`);
    text(987, y + 41, String(entry.messageCount), 29, "#1a668d", 700, "end");
  });
  if (!snapshot.entries.length) text(540, 424, "该时段暂无可统计的聊天记录", 27, "#68879a", 400, "middle");
  parts.push(`<rect x="66" y="${selfY + 30}" width="948" height="70" rx="14" fill="#dfedf5"/>`);
  text(94, selfY + 75, snapshot.self.rank ? `你的${period}发言  ${snapshot.self.messageCount} 条  ·  第 ${snapshot.self.rank} 名` : "你在该时段暂无已收录发言，本次查询不计入。", 27, "#255f80");
  text(66, topicY + 30, `${period}都在聊什么`, 33, "#173d57", 700);
  text(66, topicY + 72, `本地话题分类 · 均匀抽样 ${snapshot.sampleSize} 条 · 样本消息数`, 23, "#68879a");
  const topicMax = Math.max(1, ...snapshot.topics.map(topic => topic.count));
  snapshot.topics.forEach((topic, index) => {
    const y = topicY + 106 + index * 68;
    text(66, y + 26, topic.name, 25);
    parts.push(`<rect x="300" y="${y + 3}" width="620" height="28" rx="7" fill="#e0eaf2"/><rect x="300" y="${y + 3}" width="${Math.max(3, Math.round(topic.count / topicMax * 620))}" height="28" rx="7" fill="${topic.name === "其他" ? "#b2c5d0" : "#73acc8"}"/>`);
    text(1014, y + 28, `${topic.count} 条`, 26, "#255f80", 400, "end");
  });
  if (!snapshot.topics.length) text(66, topicY + 133, "暂无可展示的话题样本", 25, "#68879a");
  if (snapshot.hourlyActivity?.length) {
    const hours = snapshot.hourlyActivity, max = Math.max(1, ...hours.map(h => h.count)), step = 948 / hours.length;
    text(66, activityY + 55, "每小时活跃度", 33, "#173d57", 700);
    text(66, activityY + 92, "北京时间 · 全部已收录消息 · 首尾小时仅统计所选范围", 21, "#68879a");
    hours.forEach((hour,i) => {
      const x = 66 + i * step, bar = Math.round(hour.count / max * 100), w = Math.min(45, step - 8);
      parts.push(`<rect x="${x + (step-w)/2}" y="${activityY + 225 - bar}" width="${w}" height="${bar}" rx="3" fill="#73acc8"/>`);
      if (hour.count) text(x + step/2, activityY + 215 - bar, String(hour.count), 17, "#255f80",400,"middle");
      if (hours.length <= 8 || i % 3 === 0 || i === hours.length-1) text(x + step/2, activityY + 255, hour.label.slice(0,2), 19,"#68879a",400,"middle");
    });
  }
  parts.push(`<path d="M66 ${footerY + 15}H1014" stroke="#c9dce8"/>`);
  text(66, footerY + 55, "发言榜基于全部已收录消息；话题仅代表样本分布。", 23, "#68879a");
  text(66, footerY + 94, "按文字关键词归类 · 每条样本计入一个类别 · 不识别图片内容", 21, "#68879a");
  parts.push("</g></svg>");
  return parts.join("");
}

export async function renderChatRanking(snapshot: ChatRankingSnapshot): Promise<Buffer> {
  const rendered = await renderAsync(chatRankingSvg(snapshot), {
    font: { fontFiles: [FONT], loadSystemFonts: false, defaultFontFamily: "Noto Sans CJK SC" },
    background: "#f2f7fb",
  });
  return rendered.asPng();
}
