import type { GroupBotConfig, NapcatGroupMember } from "../types.js";
import { beijingClock, beijingDateKey, beijingDayStart } from "../utils/beijing-calendar.js";
import { normalizeDailyReportTopUserCount } from "../utils/daily-report-config.js";
import type { DailyReportMessageRecord } from "./daily-report-store.js";

export interface ChatRankingEntry {
  rank: number;
  userId: string;
  userName: string;
  messageCount: number;
}
export interface ChatRankingSnapshot {
  groupId: string;
  dayKey: string;
  asOf: string;
  topCount: number;
  totalMessages: number;
  participantCount: number;
  entries: ChatRankingEntry[];
  self: { rank?: number; messageCount: number };
  sampleSize: number;
  topics: Array<{ name: string; count: number }>;
}

// Distinct rule matches determine one primary topic. This fixed order breaks
// ties; broad workplace vocabulary must not override a specific AI/game topic.
const TOPIC_RULES: Array<{ name: string; rules: RegExp[] }> = [
  { name: "AI 与模型", rules: [/\b(?:ai|gpt\w*|chatgpt|claude|gemini|deepseek|codex|token|llm|agent)\b/iu, /人工智能|大模型|豆包|通义|千问|模型额度|提示词|生图/u] },
  { name: "技术编程", rules: [/代码|编程|前端|后端|全栈|架构|数据库|服务器|开源|程序员/u, /\b(?:javascript|typescript|python|java|rust|linux|sql|github|docker|api)\b/iu] },
  { name: "游戏", rules: [/游戏|打野|段位|副本|王者|原神|崩铁|星铁|鸣潮|英雄联盟|抽卡|排位|开黑/u, /\b(?:steam|lol|dota|cs2)\b/iu] },
  { name: "影视动漫", rules: [/电影|电视剧|动漫|动画|番剧|追剧|演员|导演|漫画/u] },
  { name: "赛事运动", rules: [/比赛|决赛|晋级|比分|足球|篮球|羽毛球|乒乓球|跑步|健身/u] },
  { name: "投资理财", rules: [/股票|基金|理财|投资|股市|涨停|跌停|比特币|加密货币/u] },
  { name: "学习考试", rules: [/学习|考试|作业|考研|证书|上课|复习|论文|高考/u] },
  { name: "工作", rules: [/工作|上班|加班|辞职|离职|跳槽|裁员|降薪|岗位|面试|工资|开会|摸鱼/u] },
  { name: "饮食", rules: [/吃饭|午饭|晚饭|早饭|早餐|外卖|火锅|奶茶|咖啡|午餐|晚餐/u] },
  { name: "天气", rules: [/天气|下雨|台风|降温|升温|气温|暴雨|下雪/u] },
  { name: "日常闲聊", rules: [/哈哈|笑死|早安|晚安|你好|晚上好|下午好|中午好|早上好|周末|放假/u] },
];

export function classifyChatTopic(text: string): string {
  const clean = text.replace(/\[CQ:[^\]]*\]|https?:\/\/\S+|[@＠][^\s，,。！？!；;、:：]+/gu, " ").trim();
  if (/^\[图片消息\]$/u.test(clean)) return "图片／表情";
  let best = "其他", score = 0;
  for (const topic of TOPIC_RULES) {
    const next = topic.rules.filter(rule => rule.test(clean)).length;
    if (next > score) { best = topic.name; score = next; }
  }
  return best;
}

export function buildChatRankingSnapshot(args: {
  group: GroupBotConfig;
  messages: DailyReportMessageRecord[];
  userId: string;
  now: Date;
  members?: readonly NapcatGroupMember[];
}): ChatRankingSnapshot {
  const start = beijingDayStart(args.now).getTime(), end = args.now.getTime();
  const messages = args.messages.filter(m => m.groupId === args.group.groupId && m.text.trim() &&
    Date.parse(m.timestamp) >= start && Date.parse(m.timestamp) <= end)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const names = new Map<string, string>();
  // Keep the scheduled report's explicit identity and nickname resolution.
  for (const member of args.members ?? []) if (member.nickname?.trim()) names.set(String(member.user_id), member.nickname.trim());
  for (const identity of args.group.manualIdentities ?? []) {
    const name = identity.names[0]?.trim();
    if (name) for (const id of identity.userIds) names.set(id, name);
  }
  const counts = new Map<string, { userId: string; userName: string; messageCount: number; latestTimestamp: string }>();
  for (const message of messages) {
    const entry = counts.get(message.userId);
    if (!entry) counts.set(message.userId, { userId: message.userId, userName: message.userName, messageCount: 1, latestTimestamp: message.timestamp });
    else {
      entry.messageCount++;
      const incoming = message.userName.trim(), current = entry.userName.trim();
      if (incoming && (current === message.userId || incoming !== message.userId && incoming.length >= current.length)) entry.userName = incoming;
      entry.latestTimestamp = message.timestamp;
    }
  }
  const all = [...counts.values()].sort((a, b) => b.messageCount - a.messageCount || b.latestTimestamp.localeCompare(a.latestTimestamp))
    .map((entry, index) => ({ rank: index + 1, userId: entry.userId, userName: names.get(entry.userId) ?? entry.userName, messageCount: entry.messageCount }));
  const topCount = normalizeDailyReportTopUserCount(args.group.dailyReportTopUserCount);
  const self = all.find(entry => entry.userId === args.userId);
  const sampleSize = Math.min(messages.length, 60);
  const topicCounts = new Map<string, number>();
  for (let index = 0; index < sampleSize; index++) {
    const message = messages[Math.round(index * (messages.length - 1) / Math.max(1, sampleSize - 1))]!;
    const topic = classifyChatTopic(message.text);
    topicCounts.set(topic, (topicCounts.get(topic) ?? 0) + 1);
  }
  const rankedTopics = [...topicCounts].filter(([name]) => name !== "其他").sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-Hans-CN"));
  const topics = rankedTopics.slice(0, 6).map(([name, count]) => ({ name, count }));
  const others = (topicCounts.get("其他") ?? 0) + rankedTopics.slice(6).reduce((sum, [, count]) => sum + count, 0);
  if (others) topics.push({ name: "其他", count: others });
  return { groupId: args.group.groupId, dayKey: beijingDateKey(args.now), asOf: args.now.toISOString(), topCount,
    totalMessages: messages.length, participantCount: all.length, entries: all.slice(0, topCount),
    self: self ? { rank: self.rank, messageCount: self.messageCount } : { messageCount: 0 }, sampleSize, topics };
}

export function chatRankingText(snapshot: ChatRankingSnapshot): string {
  return [`【本群今日发言榜】${snapshot.dayKey}`, `截至 ${beijingClock(new Date(snapshot.asOf))}（北京时间）`,
    `今日消息 ${snapshot.totalMessages} 条`, `活跃人数 ${snapshot.participantCount} 人`, `发言 TOP${snapshot.topCount}`,
    ...(snapshot.entries.length ? snapshot.entries.map(entry => {
      const name = entry.userName.trim(), label = name && name !== entry.userId ? `${name}（${entry.userId}）` : entry.userId;
      return `${entry.rank}. ${label} ${entry.messageCount} 条`;
    }) : ["今天暂无可统计的聊天记录"]),
    snapshot.self.rank ? `你今日发言 ${snapshot.self.messageCount} 条，排名第 ${snapshot.self.rank}。` : "你今天暂无已收录发言（本次查询不计入）。",
  ].join("\n");
}
