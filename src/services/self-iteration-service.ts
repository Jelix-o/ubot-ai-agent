import type { AdminOperationLogEntry } from "./admin-operation-log-service.js";
import type { RuntimeAiService } from "./configured-ai-service.js";
import type { IterationFeedbackRecord, IterationPlanEvidenceItem, IterationPlanRecommendation, IterationPlanRecord } from "../types.js";
import type { GroupConfigService } from "./group-config-service.js";
import type { GroupMemoryCandidateService } from "./group-memory-candidate-service.js";
import type { GroupMemoryStore } from "./group-memory-store.js";
import type { IterationFeedbackStore } from "./iteration-feedback-store.js";
import type { IterationPlanStore } from "./iteration-plan-store.js";
import type { KnowledgeBaseStore } from "./knowledge-base-store.js";
import type { ModelHealthHistoryStore } from "./model-health-history-store.js";
import type { SkillService } from "./skill-service.js";
import type { SystemSettingsStore } from "./system-settings-store.js";

const ITERATION_SKILL = {
  id: "self-iteration-planner",
  name: "UBot 自我迭代规划器",
  systemPrompt: [
    "你是 UBot 生产系统的自我迭代规划器。",
    "你只生成开发计划、配置调优建议和数据治理建议，不执行代码、不部署、不调用外部命令。",
    "输出必须是简体中文，结构清晰，能直接交给 Codex /goal 模式执行。",
  ].join("\n"),
  styleRules: [
    "优先基于证据，不编造不存在的生产状态。",
    "明确区分代码开发、配置调优、数据治理和部署验证。",
    "所有代码开发建议都必须要求构建、测试、推送 chatops/main、部署 /opt/ai-project 并验证生产。",
  ],
  knowledge: [],
  temperature: 0.2,
  maxContextTurns: 0,
};

export interface SelfIterationAnalyzeInput {
  operatorUserId: string;
  groupId?: string;
  title?: string;
}

export interface SelfIterationServiceOptions {
  feedbackStore: IterationFeedbackStore;
  planStore: IterationPlanStore;
  groupConfigService: GroupConfigService;
  groupMemoryStore: GroupMemoryStore;
  groupMemoryCandidateService: GroupMemoryCandidateService;
  knowledgeBaseStore: KnowledgeBaseStore;
  skillService: SkillService;
  systemSettingsStore: SystemSettingsStore;
  modelHealthHistoryStore?: ModelHealthHistoryStore;
  summaryAiService: RuntimeAiService;
  listOperationLogs?: (args: { groupId?: string; limit?: number }) => Promise<AdminOperationLogEntry[]>;
}

export class SelfIterationService {
  constructor(private readonly options: SelfIterationServiceOptions) {}

  async analyze(input: SelfIterationAnalyzeInput): Promise<IterationPlanRecord> {
    const evidence = await this.collectEvidence(input.groupId);
    const recommendations = buildRecommendations(evidence);
    const aiPlan = await this.tryGenerateAiPlan(input, evidence, recommendations);
    const title = input.title?.trim() || aiPlan?.title || "UBot 自我迭代 V1 开发优化计划";
    const summary = aiPlan?.summary || buildFallbackSummary(evidence, recommendations);
    const goalPrompt = aiPlan?.goalPrompt || buildGoalPrompt(title, summary, evidence, recommendations);
    const plan = await this.options.planStore.create({
      title,
      summary,
      generatedBy: aiPlan ? "ai" : "manual",
      scope: "mixed",
      goalPrompt,
      evidence,
      recommendations,
      riskLevel: inferRiskLevel(recommendations),
    });

    const openFeedback = evidence
      .filter((item) => item.type === "feedback" && item.entityId)
      .map((item) => item.entityId!);
    await Promise.all(openFeedback.map((id) => this.options.feedbackStore.updateStatus(id, "planned")));
    return plan;
  }

  private async collectEvidence(groupId?: string): Promise<IterationPlanEvidenceItem[]> {
    const [
      feedback,
      groups,
      pendingCandidates,
      knowledge,
      skills,
      settings,
      modelHistory,
      operationLogs,
    ] = await Promise.all([
      this.options.feedbackStore.list({ groupId, status: "open", limit: 80 }),
      this.options.groupConfigService.getAll(),
      this.options.groupMemoryCandidateService.list({ groupId, status: "pending" }),
      this.options.knowledgeBaseStore.list(groupId),
      this.options.skillService.getAllSkills(),
      this.options.systemSettingsStore.get(),
      this.options.modelHealthHistoryStore?.list().then((items) => items.slice(0, 20)) ?? Promise.resolve([]),
      this.options.listOperationLogs?.({ groupId, limit: 30 }) ?? Promise.resolve([]),
    ]);
    const effectiveGroups = groupId ? groups.filter((group) => group.groupId === groupId) : groups;
    const evidence: IterationPlanEvidenceItem[] = [];

    for (const item of feedback.slice(0, 30)) {
      evidence.push({
        type: "feedback",
        title: `${categoryLabel(item.category)}：${item.title}`,
        detail: item.content,
        groupId: item.groupId,
        entityId: item.id,
      });
    }

    for (const group of effectiveGroups.slice(0, 20)) {
      evidence.push({
        type: "group_config",
        title: `群配置 ${group.groupName || group.groupId}`,
        detail: [
          `当前技能：${group.currentSkillId}`,
          `回复模型：${group.replyModelMode || "default"}`,
          `允许技能数：${group.allowedSkillIds.length}`,
          `触发词数：${group.triggerKeywords?.length ?? 0}`,
          `待审记忆禁用人数：${group.memoryDisabledUserIds?.length ?? 0}`,
          `实时对话人数：${group.liveChatUserIds.length}`,
        ].join("；"),
        groupId: group.groupId,
      });
    }

    if (pendingCandidates.length > 0) {
      evidence.push({
        type: "data_quality",
        title: `待审记忆候选 ${pendingCandidates.length} 条`,
        detail: pendingCandidates
          .slice(0, 12)
          .map((item) => `${item.groupId}/${item.type}/${item.subjectUserId ?? "group"}：${item.title}，置信度 ${item.confidence}`)
          .join("\n"),
        groupId,
      });
    }

    const disabledKnowledge = knowledge.filter((item) => !item.enabled);
    const enabledKnowledge = knowledge.filter((item) => item.enabled);
    evidence.push({
      type: "knowledge",
      title: `知识库条目 ${knowledge.length} 条`,
      detail: `启用 ${enabledKnowledge.length} 条，停用 ${disabledKnowledge.length} 条。最近条目：${knowledge.slice(0, 8).map((item) => item.title).join("、") || "无"}`,
      groupId,
    });

    evidence.push({
      type: "skill",
      title: `技能定义 ${skills.length} 个`,
      detail: skills
        .slice(0, 12)
        .map((skill) => `${skill.id}：${skill.name}，temperature=${skill.temperature}，context=${skill.maxContextTurns}`)
        .join("\n") || "未发现技能定义",
    });

    const abnormalModels = modelHistory.filter((item) => item.ok === false);
    evidence.push({
      type: "model",
      title: `模型配置 ${settings.models.length} 个，异常记录 ${abnormalModels.length} 条`,
      detail: [
        `当前选中：${Object.entries(settings.selectedModelIds).map(([purpose, id]) => `${purpose}=${id}`).join("，") || "未配置"}`,
        abnormalModels.slice(0, 8).map((item) => `${item.id}/${item.purpose}：${item.detail}`).join("\n") || "最近模型健康记录未发现异常",
      ].join("\n"),
    });

    if (operationLogs.length > 0) {
      evidence.push({
        type: "ops",
        title: `最近管理操作 ${operationLogs.length} 条`,
        detail: operationLogs
          .slice(0, 12)
          .map((item) => `${item.timestamp} ${item.groupId} ${item.operatorUserId} ${item.action} ${item.target ?? ""} ${item.detail ?? ""}`.trim())
          .join("\n"),
        groupId,
      });
    }

    return evidence.slice(0, 80);
  }

  private async tryGenerateAiPlan(
    input: SelfIterationAnalyzeInput,
    evidence: IterationPlanEvidenceItem[],
    recommendations: IterationPlanRecommendation[],
  ): Promise<{ title: string; summary: string; goalPrompt: string } | null> {
    try {
      const reply = await this.options.summaryAiService.generateReply({
        skill: ITERATION_SKILL,
        history: [],
        userInput: [
          `操作者：${input.operatorUserId}`,
          `分析范围：${input.groupId ?? "全部群"}`,
          "证据：",
          JSON.stringify(evidence, null, 2),
          "可执行建议：",
          JSON.stringify(recommendations, null, 2),
          "请输出 JSON，不要 markdown。Schema: {\"title\":\"计划标题\",\"summary\":\"摘要\",\"goalPrompt\":\"完整 /goal Markdown\"}",
        ].join("\n\n"),
      });
      const json = extractJsonObject(reply.text);
      if (!json) return null;
      const parsed = JSON.parse(json) as { title?: unknown; summary?: unknown; goalPrompt?: unknown };
      const title = typeof parsed.title === "string" ? parsed.title.trim().slice(0, 120) : "";
      const summary = typeof parsed.summary === "string" ? parsed.summary.trim().slice(0, 2400) : "";
      const goalPrompt = typeof parsed.goalPrompt === "string" ? parsed.goalPrompt.trim().slice(0, 20000) : "";
      if (!title || !summary || !goalPrompt.includes("npm test") || !goalPrompt.includes("/opt/ai-project")) {
        return null;
      }
      return { title, summary, goalPrompt };
    } catch {
      return null;
    }
  }
}

function buildRecommendations(evidence: IterationPlanEvidenceItem[]): IterationPlanRecommendation[] {
  const recommendations: IterationPlanRecommendation[] = [];
  if (evidence.some((item) => item.type === "feedback")) {
    recommendations.push({
      type: "code",
      title: "把反馈整理为 /goal 开发任务",
      detail: "将 open 反馈、异常模型记录、待审数据质量问题整理为一个可交给 Codex /goal 的完整开发任务，要求开发、测试、部署和生产验证闭环。",
    });
  }
  if (evidence.some((item) => item.type === "data_quality")) {
    recommendations.push({
      type: "data",
      title: "批量治理待审记忆候选",
      detail: "对置信度高、证据完整的候选做人工复核后批准；对重复、过期或证据不足的候选拒绝，降低画像噪音。",
      action: "approve_candidates",
    });
  }
  if (evidence.some((item) => item.type === "model" && /异常|false|不可用|失败/.test(item.detail))) {
    recommendations.push({
      type: "config",
      title: "复核模型健康和用途选择",
      detail: "对异常模型运行连接检测，必要时将 reply/summary/profile 用途切换到最近可用模型，保留 API Key 不外显。",
      action: "group_config_patch",
    });
  }
  recommendations.push({
    type: "skill",
    title: "收敛技能回复长度与风格规则",
    detail: "针对用户反馈中提到的语气、过长、答非所问问题，在 skill 层优先调整 styleRules、maxContextTurns、maxReplyCharsPerMessage，而不是改全局代码。",
    action: "skill_patch",
  });
  return recommendations;
}

function buildFallbackSummary(evidence: IterationPlanEvidenceItem[], recommendations: IterationPlanRecommendation[]): string {
  return [
    `本次自我迭代共收集 ${evidence.length} 条证据，形成 ${recommendations.length} 条建议。`,
    "V1 重点是把运行反馈、模型健康、数据质量和技能配置整理为可审计、可审批、可交给 /goal 执行的开发计划。",
    "线上系统只执行低风险数据/配置治理，不直接执行源码修改或部署命令。",
  ].join("\n");
}

function buildGoalPrompt(
  title: string,
  summary: string,
  evidence: IterationPlanEvidenceItem[],
  recommendations: IterationPlanRecommendation[],
): string {
  return [
    `# ${title}`,
    "",
    "## 背景",
    summary,
    "",
    "## 证据",
    ...evidence.slice(0, 40).map((item, index) => `${index + 1}. [${item.type}] ${item.title}${item.groupId ? `（群 ${item.groupId}）` : ""}\n   ${item.detail.replace(/\n/g, "\n   ")}`),
    "",
    "## 目标",
    "基于以上证据实现一轮 UBot 开发优化和数据调优，优先解决用户反馈、模型异常、技能体验和数据质量问题。",
    "",
    "## 具体要求",
    ...recommendations.map((item, index) => `${index + 1}. ${item.title}：${item.detail}`),
    "",
    "## 生产约束",
    "- 不覆盖生产 `.env`、`data/`、`config/groups.json`、`node_modules/`、日志和运行态文件。",
    "- 不破坏现有 NapCat reverse WebSocket：生产应保持 `/opt/ai-project`、`ai-project.service`、端口 6199/6200。",
    "- 代码开发必须保留现有群内 per-group-per-user 上下文、@ 规则、黑名单和画像分享行为。",
    "",
    "## 验证命令",
    "- `npm run build`",
    "- `npm test`",
    "",
    "## 部署要求",
    "- 提交并推送 `chatops/main`。",
    "- 安全同步到生产 `/opt/ai-project`。",
    "- 远端执行构建并重启 `ai-project.service`。",
    "- 验证 `systemctl is-active ai-project.service`、端口 `6199|6200`、`NapCat reverse WebSocket connected.`、后台接口和新增功能入口。",
  ].join("\n");
}

function inferRiskLevel(recommendations: IterationPlanRecommendation[]): "low" | "medium" | "high" {
  if (recommendations.some((item) => item.type === "code")) return "medium";
  return recommendations.some((item) => item.type === "config") ? "medium" : "low";
}

function categoryLabel(category: IterationFeedbackRecord["category"]): string {
  return ({
    bug: "缺陷",
    behavior: "行为",
    data_quality: "数据质量",
    skill: "技能",
    model: "模型",
    feature: "功能",
    ops: "运维",
  } as Record<IterationFeedbackRecord["category"], string>)[category];
}

function extractJsonObject(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced?.[1]?.trim() ?? text.trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return raw.slice(start, end + 1);
}
