import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import type { GroupBotConfig } from "../types.js";
import { buildChatRankingSnapshot, chatRankingText, classifyChatTopic } from "./chat-ranking-statistics.js";
import { chatRankingSvg, rankingImageLabel, renderChatRanking } from "./chat-ranking-renderer.js";
import { isNaturalChatRankingRequest } from "../utils/chat-ranking-request.js";

const now = new Date("2026-10-31T03:00:00Z");
const group: GroupBotConfig = { groupId: "group-a", currentSkillId: "huixian", allowedSkillIds: ["huixian"], switcherUserIds: [], liveChatUserIds: [], liveChatDelayMinutes: 5, dailyReportTopUserCount: 3 };
const message = (userId: string, text: string, timestamp = "2026-10-31T01:00:00Z") => ({ groupId: group.groupId, userId, userName: `成员${userId}`, text, timestamp });

test("ranking uses full Beijing-day records and existing top count, identity names, tie order and own rank", () => {
  const messages = [message("a", "代码", "2026-10-30T16:00:00Z"), message("a", "服务器"), message("2", "工作", "2026-10-31T01:01:00Z"), message("2", "上班", "2026-10-31T01:02:00Z"), message("c", "午饭"), message("d", "天气"), message("yesterday", "昨日", "2026-10-30T15:59:59Z"), message("future", "未来", "2026-10-31T03:00:01Z"), { ...message("other", "他群"), groupId: "group-b" }];
  const snapshot = buildChatRankingSnapshot({ group: { ...group, manualIdentities: [{ userIds: ["a"], names: ["成员甲"] }] }, messages, userId: "d", now, members: [{ user_id: 2, nickname: "成员乙" }] });
  assert.equal(snapshot.totalMessages, 6); assert.equal(snapshot.participantCount, 4);
  assert.deepEqual(snapshot.entries.map(e => [e.userId, e.userName, e.messageCount]), [["2", "成员乙", 2], ["a", "成员甲", 2], ["c", "成员c", 1]]);
  assert.deepEqual(snapshot.self, { rank: 4, messageCount: 1 });
  assert.equal(snapshot.topics.reduce((n, topic) => n + topic.count, 0), 6);
  assert.match(chatRankingText(snapshot), /2\. 成员甲（a） 2 条/u);
  assert.match(chatRankingText(snapshot), /排名第 4/u);
});

test("topic overview samples the full day uniformly and never extrapolates counts", () => {
  const messages = Array.from({ length: 180 }, (_, i) => message(String(i % 30), i < 90 ? "GPT 大模型" : "游戏副本", new Date(Date.parse("2026-10-30T16:00:00Z") + i * 60_000).toISOString()));
  const snapshot = buildChatRankingSnapshot({ group, messages, userId: "missing", now });
  assert.equal(snapshot.totalMessages, 180); assert.equal(snapshot.sampleSize, 60);
  assert.deepEqual(snapshot.topics.map(t => t.count), [30, 30]);
  assert.equal(snapshot.topics.reduce((sum, topic) => sum + topic.count, 0), snapshot.sampleSize);
  assert.deepEqual(snapshot.self, { messageCount: 0 });
  assert.match(chatRankingSvg(snapshot), /均匀抽样 60 条/u);
  assert.match(chatRankingSvg(snapshot), /话题仅代表样本分布/u);
});

test("local topic rules count one category, ignore URLs and mentions and preserve image/unknown categories", () => {
  assert.equal(classifyChatTopic("GPT 模型怎么写工作代码"), "AI 与模型");
  assert.equal(classifyChatTopic("https://example.test/stock/ai @GPT"), "其他");
  assert.equal(classifyChatTopic("[图片消息]"), "图片／表情");
  assert.equal(classifyChatTopic("没有可识别的词"), "其他");
  assert.equal(classifyChatTopic("今天午饭吃外卖"), "饮食");
});

test("topic categories beyond six merge into other without losing sample messages", () => {
  const samples = ["GPT", "代码", "游戏", "电影", "足球", "股票", "考试", "上班", "外卖", "下雨", "哈哈", "[图片消息]", "你好啊杂项"];
  const snapshot = buildChatRankingSnapshot({ group, messages: samples.map((text, i) => message(String(i), text)), userId: "a", now });
  assert.ok(snapshot.topics.length <= 7);
  assert.equal(snapshot.topics.at(-1)?.name, "其他");
  assert.equal(snapshot.topics.reduce((n, t) => n + t.count, 0), samples.length);
});

test("PNG renderer supports empty and twenty-row charts, Chinese names, XML text and emoji fallback", async () => {
  const empty = buildChatRankingSnapshot({ group, messages: [], userId: "a", now });
  const emptyPng = await renderChatRanking(empty);
  assert.equal(emptyPng.readUInt32BE(16), 1080);
  assert.match(chatRankingText(empty), /暂无可统计/u);
  const snapshot = buildChatRankingSnapshot({ group: { ...group, dailyReportTopUserCount: 20 }, messages: Array.from({ length: 20 }, (_, i) => ({ ...message(String(i), "GPT"), userName: i === 0 ? '<成员甲 & "乙">🌸'.repeat(5) : `成员${i}` })), userId: "1", now });
  const svg = chatRankingSvg(snapshot), png = await renderChatRanking(snapshot);
  assert.match(svg, /&lt;成员甲 &amp; &quot;乙&quot;&gt;/u); assert.doesNotMatch(svg, /<成员甲/u);
  assert.ok(png.length > 1000 && png.length < 10 * 1024 * 1024);
  assert.ok(png.readUInt32BE(20) > emptyPng.readUInt32BE(20));
  assert.equal(rankingImageLabel("成员🌸甲"), "成员·甲");
});

test("UTC hosts still count the Beijing day on both sides of midnight", () => {
  const url = new URL("./chat-ranking-statistics.js", import.meta.url).href;
  const script = `import {buildChatRankingSnapshot} from ${JSON.stringify(url)};const group=${JSON.stringify(group)};const records=[{groupId:group.groupId,userId:'a',userName:'成员甲',text:'代码',timestamp:'2026-10-30T16:00:00Z'}];console.log(JSON.stringify([buildChatRankingSnapshot({group,messages:records,userId:'a',now:new Date('2026-10-30T15:59:59Z')}),buildChatRankingSnapshot({group,messages:records,userId:'a',now:new Date('2026-10-30T16:00:01Z')})]));`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env: { ...process.env, TZ: "UTC" } });
  assert.equal(result.status, 0, result.stderr);
  const snapshots = JSON.parse(result.stdout);
  assert.equal(snapshots[0].dayKey, "2026-10-30"); assert.equal(snapshots[0].totalMessages, 0);
  assert.equal(snapshots[1].dayKey, "2026-10-31"); assert.equal(snapshots[1].totalMessages, 1);
});

test("only clear group speech ranking language uses the local lane", () => {
  for (const text of ["今天群聊排行榜", "看看今日发言榜", "今天谁聊得最多", "看看群聊排行榜", "今日群里谁发言最多"]) assert.equal(isNaturalChatRankingRequest(text), true, text);
  for (const text of ["股票排行榜", "企业排行榜", "游戏段位排行", "画一张今天群聊排行榜海报", "昨天群聊排行榜", "总结今天群聊", "谁是首富"]) assert.equal(isNaturalChatRankingRequest(text), false, text);
});
