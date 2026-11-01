import { beijingDayStart } from "./beijing-calendar.js";

export type ChatRankingPeriod = "today" | "yesterday" | "recent_hour";
export function parseChatRankingPeriod(text: string): ChatRankingPeriod | undefined {
  if (/^(?:今天|今日)?$/u.test(text.trim())) return "today";
  if (/^(?:昨天|昨日)$/u.test(text.trim())) return "yesterday";
  if (/^最近(?:一|1|一个|1个)?小时$/u.test(text.trim())) return "recent_hour";
  return undefined;
}
export function chatRankingRange(period: ChatRankingPeriod, now: Date): { start: number; end: number; label: string } {
  if (period === "yesterday") return { start: beijingDayStart(now,-1).getTime(), end: beijingDayStart(now).getTime(), label: "昨日" };
  if (period === "recent_hour") return { start: now.getTime() - 3600000, end: now.getTime() + 1, label: "最近一小时" };
  return { start: beijingDayStart(now).getTime(), end: now.getTime() + 1, label: "今日" };
}

/** Only bounded speech rankings own this lane; creative and unrelated rankings
 * retain their original routes. */
export function naturalChatRankingPeriod(text: string): ChatRankingPeriod | undefined {
  const clean = text.trim().replace(/[？?。！!吧呢呀]+$/u, "");
  if (/画|绘制|制作|生成|海报|企业|公司|股票|股市|游戏|段位|前天|本周|这周|上周|本月/u.test(clean)) return undefined;
  const time = "(?:今天|今日|现在|当前|昨天|昨日|最近(?:一|1|一个|1个)?小时)?";
  const ranking = new RegExp(`^(?:(?:请|帮我|给我|麻烦)?(?:看(?:看|一下)?|查(?:看|一下)?|发(?:个|一下|一份)?|来(?:个|一份)?)?\\s*)?${time}(?:的)?(?:本群|群聊|群里|聊天|发言|水群)(?:的|今日|今天|实时|聊天|发言)*(?:排行榜|排行|排名|榜单|榜)$`, "u");
  const who = new RegExp(`^(?:(?:请|帮我)?(?:看看|查看|统计一下))?${time}(?:本群|群里)?谁(?:今天|今日)?(?:聊得最多|说话最多|发言最多|最能聊|最活跃)$`, "u");
  if (!ranking.test(clean) && !who.test(clean)) return undefined;
  if (/最近/u.test(clean)) return "recent_hour";
  return /昨天|昨日/u.test(clean) ? "yesterday" : "today";
}
export function isNaturalChatRankingRequest(text: string): boolean { return naturalChatRankingPeriod(text) !== undefined; }
