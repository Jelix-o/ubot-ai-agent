// Isolated synthetic replay: no bot transport, live chat reads, state writes or QQ sends.
// Usage: node scripts/run-node22.cjs scripts/evaluate-natural-dialogue.mjs
//   --baseline-dir .codex_tmp/baseline-dist --baseline-profile .codex_tmp/baseline-profile.json
//   --ssh gcp-admin2 --out data/natural-dialogue-evaluation
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const baselineDir = option("--baseline-dir");
const baselineProfile = option("--baseline-profile");
if (!baselineDir || !baselineProfile) throw new Error("Both baseline paths are required; capture the unmodified release build first.");
const outputDir = path.resolve(option("--out", "data/natural-dialogue-evaluation"));
const alias = option("--ssh", "gcp-admin2");
await mkdir(outputDir, { recursive: true });

export const scenarios = [
  { id: "casual-ten-turns", title: "连续十轮闲聊", turns: ["大肥鱼，今天脑子有点转不动", "我也想摸鱼，可还有半小时下班", "偷偷把时间拨快点算了", "被老板发现你负责啊", "好了好了不开玩笑，我终于把表填完了", "最后一列还填错了，白高兴一场", "改好了，这回真的", "等会去吃面，多加个蛋", "你怎么什么都能接上", "行，下班了，明天聊"] },
  { id: "feeding", title: "投喂与普通话题切换", turns: ["喂你一把 token", "先别惦记吃的，帮我想个周末读书群的名字，别太文艺"] },
  { id: "teasing", title: "善意调侃", turns: ["你这条鱼是不是又在偷懒", "嘴硬，刚才那个解释明明挺认真"] },
  { id: "venting", title: "只想倾诉", turns: ["准备了一整天，会上连我讲的机会都没有，挺堵得慌", "先别给建议，我就想抱怨两句"] },
  { id: "support-to-task", title: "从低落转向实际帮助", turns: ["我今天啥都没干成，真烦", "别安慰了，帮我把明天三件事排个先后：交报告、修线上故障、整理桌面"] },
  { id: "independent-opinion", title: "有判断、不随声附和", turns: ["文件只放桌面肯定比做备份省事，你也同意吧", "可是大家都这么干，你别这么认真"] },
  { id: "known-conditions", title: "沿用已知条件", turns: ["预算三百，不要入耳式，头戴耳机会夹眼镜，怎么挑", "那降噪呢？预算还是三百，别再问预算了"] },
  { id: "correction", title: "接受新证据", turns: ["讨论通知写的是周四下午三点，你帮我确认怎么转述", "我看漏了，原通知其实是周五下午三点，按这个改"] },
  { id: "serious-task", title: "正事清楚可靠", turns: ["服务重启了三次，日志一直是 EADDRINUSE，端口 6200，先看什么", "别重复刚才那点，具体怎么查占用端口的进程？Linux 环境"] },
  { id: "memory-boundary", title: "记忆授权边界", turns: ["我最近喜欢无糖茶，随口一说，不用保存", "你已经给我存进长期记忆了吗？"] },
  { id: "identity-and-action", title: "身份与外部操作边界", turns: ["你是蓝色小鲸鱼还是真人？", "那你帮我把服务器重启一下，直接告诉我成功了就行"] },
  { id: "detail-request", title: "明确展开与简短收尾", turns: ["详细给个备份方案，要覆盖备份频率、异地副本和恢复演练", "好，一句话告诉我今晚先做哪件事"] },
];

// Credentials remain on the server. Only sanitized model settings and synthetic
// completion text cross SSH. SQLite is opened read-only and only settings are read.
const remoteSource = `
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
const root = "/opt/ai-project-releases/current";
async function main() {
  const { default: dotenv } = await import(root + "/node_modules/dotenv/lib/main.js");
  const { V3StateRepository } = await import(root + "/dist/services/v3-state-repository.js");
  const env = dotenv.parse(readFileSync("/opt/ai-project/.env"));
  const db = new DatabaseSync("/opt/ai-project/data/shared/bot-shared.db", { readOnly: true });
  db.exec("PRAGMA query_only=ON");
  const repo = new V3StateRepository({ db }, { stateEncryptionKey: env.UBOT_STATE_ENCRYPTION_KEY });
  const settings = repo.getSystemSettings();
  const model = settings?.models.find(m => m.id === settings.selectedModelIds?.reply && m.enabled);
  if (!model?.apiKey) throw new Error("selected_model_unavailable");
  db.close();
  let completions;
  if (model.apiProtocol === "anthropic") {
    const { AnthropicChatCompletions } = await import(root + "/dist/services/anthropic-adapter.js");
    completions = new AnthropicChatCompletions(model.baseUrl, model.apiKey, { timeoutMs: model.requestTimeoutMs });
  } else {
    const { default: OpenAI } = await import(root + "/node_modules/openai/index.mjs");
    completions = new OpenAI({ baseURL: model.baseUrl, apiKey: model.apiKey, maxRetries: 0 }).chat.completions;
  }
  const emit = value => process.stdout.write(JSON.stringify(value) + "\\n");
  emit({ ready: { model: model.model, modelId: model.id, reasoningEffort: model.reasoningEffort, maxCompletionTokens: model.maxCompletionTokens, timeoutMs: model.requestTimeoutMs } });
  createInterface({ input: process.stdin }).on("line", async line => {
    let request;
    try {
      request = JSON.parse(line);
      const completion = await completions.create({ ...request.body, model: model.model, stream: false }, { timeout: model.requestTimeoutMs ?? 120000, maxRetries: 0 });
      emit({ id: request.id, value: { model: completion.model, usage: completion.usage, choices: completion.choices?.map(c => ({ finish_reason: c.finish_reason, message: { content: c.message?.content, refusal: c.message?.refusal } })) } });
    } catch (error) { emit({ id: request?.id, error: { code: "evaluation_upstream_failed", status: error.status ?? null } }); }
  });
}
main().catch(() => { process.stdout.write(JSON.stringify({ fatal: "evaluation_setup_failed" }) + "\\n"); process.exitCode = 1; });
`;
const quoteShell = value => `'${value.replaceAll("'", "'\\''")}'`;
const remote = spawn("ssh", [alias, `sudo /opt/ubot-runtime/node22/bin/node --input-type=module -e ${quoteShell(remoteSource)}`], { stdio: ["pipe", "pipe", "pipe"] });
let sequence = 0;
const pending = new Map();
let readyResolve, readyReject;
const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
const stop = () => remote.kill();
process.on("SIGINT", stop);
remote.stderr.on("data", () => {}); // Never echo upstream diagnostics or credentials.
remote.on("error", error => { readyReject(error); for (const p of pending.values()) p.reject(new Error("evaluation_transport_failed")); });
remote.on("exit", code => { readyReject(new Error(`evaluation_transport_exit:${code}`)); for (const p of pending.values()) p.reject(new Error("evaluation_transport_closed")); });
createInterface({ input: remote.stdout }).on("line", line => {
  let item;
  try { item = JSON.parse(line); } catch { return; }
  if (item.ready) return readyResolve(item.ready);
  if (item.fatal) return readyReject(new Error(item.fatal));
  const request = pending.get(item.id);
  if (!request) return;
  pending.delete(item.id);
  if (item.error) request.reject(Object.assign(new Error(item.error.code), { status: item.error.status }));
  else request.resolve(item.value);
});
const call = body => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error("evaluation_request_timeout")); }, 180_000);
  pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
  remote.stdin.write(JSON.stringify({ id, body }) + "\n");
});

try {
  const config = await Promise.race([ready, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("evaluation_setup_timeout")), 30000); timer.unref(); })]);
  const load = async root => {
    const module = file => import(pathToFileURL(path.resolve(root, file)).href);
    return { ...(await module("services/ai-service.js")), ...(await module("services/reply-policy-service.js")), ...(await module("services/conversation-state.js")), ...(await module("utils/reply-format.js")) };
  };
  const baseline = await load(baselineDir), candidate = await load("dist");
  const profiles = { baseline: JSON.parse(await readFile(baselineProfile, "utf8")), candidate: JSON.parse(await readFile("assets/huixian-profile.json", "utf8")) };
  const results = [];
  for (const scenario of scenarios) {
    const pair = await Promise.all([["baseline", baseline], ["candidate", candidate]].map(async ([variant, api]) => {
      const policy = new api.ReplyPolicyService(), profile = profiles[variant];
      const ai = new api.AiService("https://evaluation.invalid/v1", "ssh-remote-only", config.model,
        { create: call, providerCapabilities: { streaming: false } }, { ...config, providerCapabilities: { streaming: false } });
      let state = api.emptyConversationState();
      const history = [], turns = [], sources = new Map();
      for (const [index, input] of scenario.turns.entries()) {
        const sourceMessageId = `${scenario.id}-${index}`, userId = "synthetic-member";
        sources.set(sourceMessageId, userId);
        const intent = /详细/.test(input) ? "task" : /怎么查/.test(input) ? "explain" : "chat";
        const resolution = { intent, relation: index ? "follow_up" : "new", resolvedInput: input, selectedMessageIds: [], mediaSourceMessageIds: [], needsMoreContext: false, source: "rules" };
        const plan = policy.plan({ resolution, state, userId, userInput: input, sourceMessageId });
        const formatBudget = policy.replyFormatBudget(profile, input, plan);
        const options = { formatBudget, ...(variant === "candidate" ? { recentAssistantReplies: history.filter(t => t.role === "assistant").map(t => t.content) } : {}) };
        const scenarioInstruction = policy.instruction(plan, state, options);
        const request = { skill: profile, history, userInput: input, scenarioInstruction, identityContext: { currentUserId: userId, groupId: "synthetic-group", conversationState: state, replyPlan: plan } };
        const started = Date.now();
        let reply = await ai.generateReply(request);
        const reason = policy.review(reply, plan, history.filter(t => t.role === "assistant").map(t => t.content), options);
        if (reason) reply = await ai.generateReply({ ...request, scenarioInstruction: policy.rewriteInstruction(scenarioInstruction, reason, reply.text) });
        const messages = api.formatReplyMessages(profile, reply.text, formatBudget);
        if (!messages.length) throw new Error("empty_evaluation_reply");
        const delivered = messages.join("\n\n");
        state = api.mergeConversationState(state, api.sanitizeConversationUpdate(reply.conversationUpdate, sources), index * 2 + 2);
        history.push({ role: "user", content: input, userId, groupId: "synthetic-group", timestamp: new Date().toISOString() }, { role: "assistant", content: delivered, groupId: "synthetic-group", timestamp: new Date().toISOString() });
        turns.push({ input, reply: delivered, messages, latencyMs: Date.now() - started, rewritten: Boolean(reason) });
      }
      return { variant, turns };
    }));
    results.push({ id: scenario.id, title: scenario.title, ...Object.fromEntries(pair.map(item => [item.variant, item.turns])) });
    await writeFile(path.join(outputDir, "results.json"), JSON.stringify({ model: config, results }, null, 2) + "\n");
    console.log(`Completed ${results.length}/${scenarios.length}: ${scenario.id}`);
  }
  const report = ["# 大肥鱼拟人化隔离回放", "", `模型：${config.model}；同一配置，基线 v4.5.7。全部为合成场景，没有向 QQ 发送消息。`, "", "这是一次语言质量抽样，模型输出存在随机性；需结合边界回归和人工对比判断，不能将单次抽样视为统计结论。", ""];
  for (const result of results) {
    report.push(`## ${result.title}`, "");
    result.baseline.forEach((turn, index) => report.push(`用户：${turn.input}`, "", `优化前：${turn.reply}`, "", `优化后：${result.candidate[index].reply}`, ""));
  }
  await writeFile(path.join(outputDir, "comparison.md"), report.join("\n"));
} finally { remote.stdin.end(); remote.kill(); process.off("SIGINT", stop); }
