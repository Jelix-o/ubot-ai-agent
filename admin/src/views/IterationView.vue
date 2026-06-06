<script setup lang="ts">
import { computed, onMounted, reactive, shallowRef, watch } from "vue";

import { useRefreshEvents } from "../composables/useRefreshEvents";
import {
  api,
  queryString,
  type IterationAnalyzeResponse,
  type IterationApplyResponse,
  type IterationFeedbackCategory,
  type IterationFeedbackRecord,
  type IterationFeedbackStatus,
  type IterationPlanRecord,
  type IterationPlanScope,
  type IterationPlanStatus,
  type Pagination,
} from "../services/api";
import { useAppStore } from "../stores/app";
import { formatDateTime } from "../utils/format";

const app = useAppStore();
const feedback = shallowRef<IterationFeedbackRecord[]>([]);
const plans = shallowRef<IterationPlanRecord[]>([]);
const activePlan = shallowRef<IterationPlanRecord | null>(null);
const feedbackLoading = shallowRef(false);
const plansLoading = shallowRef(false);
const generating = shallowRef(false);
const applyingId = shallowRef("");
const copiedPlanId = shallowRef("");
const feedbackPagination = reactive<Pagination>({ page: 1, pageSize: 20, total: 0, totalPages: 1 });
const planPagination = reactive<Pagination>({ page: 1, pageSize: 10, total: 0, totalPages: 1 });
const feedbackFilters = reactive({
  q: "",
  scope: "all" as "current" | "all",
  category: "" as "" | IterationFeedbackCategory,
  status: "" as "" | IterationFeedbackStatus,
});
const planFilters = reactive({
  q: "",
  status: "" as "" | IterationPlanStatus,
  scope: "" as "" | IterationPlanScope,
});
const feedbackForm = reactive({
  groupId: "",
  category: "behavior" as IterationFeedbackCategory,
  title: "",
  content: "",
});
const analyzeForm = reactive({
  title: "",
  groupId: "",
});

const currentGroupLabel = computed(() => {
  const group = app.groups.find((item) => item.groupId === app.groupId);
  return group?.groupName ? `${group.groupName} / ${group.groupId}` : app.groupId || "未选择群";
});
const openFeedbackCount = computed(() => feedback.value.filter((item) => item.status === "open").length);
const plannedFeedbackCount = computed(() => feedback.value.filter((item) => item.status === "planned").length);
const approvedPlanCount = computed(() => plans.value.filter((item) => item.status === "approved").length);
const activePlanGoal = computed(() => activePlan.value?.goalPrompt || "");
const activePlanMeta = computed(() => {
  const plan = activePlan.value;
  if (!plan) return [];
  return [
    { label: "计划 ID", value: plan.id },
    { label: "状态", value: planStatusLabel(plan.status) },
    { label: "范围", value: planScopeLabel(plan.scope) },
    { label: "风险", value: riskLabel(plan.riskLevel) },
    { label: "来源", value: plan.generatedBy === "ai" ? "AI 生成" : "本地规则生成" },
    { label: "创建时间", value: formatDateTime(plan.createdAt) },
    { label: "更新时间", value: formatDateTime(plan.updatedAt) },
  ];
});

async function loadFeedback(): Promise<void> {
  feedbackLoading.value = true;
  try {
    const groupId = feedbackFilters.scope === "current" ? app.groupId : undefined;
    const data = await api<{ feedback: IterationFeedbackRecord[]; pagination: Pagination }>(`/api/iteration/feedback${queryString({
      groupId,
      q: feedbackFilters.q.trim(),
      category: feedbackFilters.category,
      status: feedbackFilters.status,
      page: feedbackPagination.page,
      pageSize: feedbackPagination.pageSize,
    })}`);
    feedback.value = data.feedback;
    Object.assign(feedbackPagination, data.pagination);
  } finally {
    feedbackLoading.value = false;
  }
}

async function loadPlans(): Promise<void> {
  plansLoading.value = true;
  try {
    const data = await api<{ plans: IterationPlanRecord[]; pagination: Pagination }>(`/api/iteration/plans${queryString({
      q: planFilters.q.trim(),
      status: planFilters.status,
      scope: planFilters.scope,
      page: planPagination.page,
      pageSize: planPagination.pageSize,
    })}`);
    plans.value = data.plans;
    Object.assign(planPagination, data.pagination);
    if (activePlan.value) {
      const updated = data.plans.find((plan) => plan.id === activePlan.value?.id);
      if (updated) activePlan.value = updated;
    } else if (data.plans[0]) {
      activePlan.value = data.plans[0];
    }
  } finally {
    plansLoading.value = false;
  }
}

async function createFeedback(): Promise<void> {
  if (!feedbackForm.content.trim()) {
    app.showToast("请填写反馈内容", "error");
    return;
  }
  const groupId = feedbackForm.groupId || app.groupId;
  if (!groupId) {
    app.showToast("请先选择反馈归属群", "error");
    return;
  }
  const created = await api<IterationFeedbackRecord>("/api/iteration/feedback", {
    method: "POST",
    body: JSON.stringify({
      groupId,
      category: feedbackForm.category,
      title: feedbackForm.title.trim(),
      content: feedbackForm.content.trim(),
    }),
  });
  feedbackForm.title = "";
  feedbackForm.content = "";
  feedback.value = [created, ...feedback.value].slice(0, feedbackPagination.pageSize);
  feedbackPagination.total += 1;
  app.showToast("反馈已记录");
}

async function updateFeedbackStatus(item: IterationFeedbackRecord, status: IterationFeedbackStatus): Promise<void> {
  const updated = await api<IterationFeedbackRecord>(`/api/iteration/feedback/${encodeURIComponent(item.id)}`, {
    method: "PUT",
    body: JSON.stringify({ status }),
  });
  feedback.value = feedback.value.map((current) => current.id === updated.id ? updated : current);
  app.showToast("反馈状态已更新");
}

async function generatePlan(): Promise<void> {
  generating.value = true;
  try {
    const data = await api<IterationAnalyzeResponse>("/api/iteration/analyze", {
      method: "POST",
      body: JSON.stringify({
        title: analyzeForm.title.trim(),
        groupId: analyzeForm.groupId || undefined,
      }),
    });
    activePlan.value = data.plan;
    planFilters.status = "";
    planPagination.page = 1;
    await Promise.all([loadPlans(), loadFeedback()]);
    app.showToast(data.task ? "计划生成任务已完成" : "计划已生成");
  } finally {
    generating.value = false;
  }
}

async function updatePlanStatus(plan: IterationPlanRecord, status: Exclude<IterationPlanStatus, "applied">): Promise<void> {
  const updated = await api<IterationPlanRecord>(`/api/iteration/plans/${encodeURIComponent(plan.id)}/status`, {
    method: "PUT",
    body: JSON.stringify({ status }),
  });
  patchPlan(updated);
  app.showToast("计划状态已更新");
}

async function applyPlan(plan: IterationPlanRecord): Promise<void> {
  applyingId.value = plan.id;
  try {
    const data = await api<IterationApplyResponse>(`/api/iteration/plans/${encodeURIComponent(plan.id)}/apply`, {
      method: "POST",
    });
    patchPlan(data.plan);
    await loadFeedback();
    app.showToast(`已标记 ${data.appliedFeedbackCount} 条反馈完成`);
  } finally {
    applyingId.value = "";
  }
}

async function copyGoal(plan: IterationPlanRecord): Promise<void> {
  await navigator.clipboard.writeText(plan.goalPrompt);
  copiedPlanId.value = plan.id;
  window.setTimeout(() => {
    if (copiedPlanId.value === plan.id) copiedPlanId.value = "";
  }, 1800);
  app.showToast("已复制 /goal 开发计划");
}

function patchPlan(plan: IterationPlanRecord): void {
  plans.value = plans.value.map((item) => item.id === plan.id ? plan : item);
  activePlan.value = plan;
}

function applyFeedbackFilters(): void {
  feedbackPagination.page = 1;
  void loadFeedback().catch((error) => app.showToast(error.message, "error"));
}

function applyPlanFilters(): void {
  planPagination.page = 1;
  void loadPlans().catch((error) => app.showToast(error.message, "error"));
}

function resetFeedbackFilters(): void {
  feedbackFilters.q = "";
  feedbackFilters.scope = "all";
  feedbackFilters.category = "";
  feedbackFilters.status = "";
  feedbackPagination.page = 1;
  void loadFeedback().catch((error) => app.showToast(error.message, "error"));
}

function resetPlanFilters(): void {
  planFilters.q = "";
  planFilters.status = "";
  planFilters.scope = "";
  planPagination.page = 1;
  void loadPlans().catch((error) => app.showToast(error.message, "error"));
}

function categoryLabel(value: IterationFeedbackCategory): string {
  return ({
    bug: "缺陷",
    behavior: "行为",
    data_quality: "数据质量",
    skill: "技能",
    model: "模型",
    feature: "功能",
    ops: "运维",
  } as Record<IterationFeedbackCategory, string>)[value];
}

function feedbackStatusLabel(value: IterationFeedbackStatus): string {
  return ({
    open: "待规划",
    planned: "已规划",
    applied: "已完成",
    rejected: "已拒绝",
  } as Record<IterationFeedbackStatus, string>)[value];
}

function planStatusLabel(value: IterationPlanStatus): string {
  return ({
    draft: "草稿",
    approved: "已批准",
    applied: "已应用",
    rejected: "已拒绝",
  } as Record<IterationPlanStatus, string>)[value];
}

function planScopeLabel(value: IterationPlanScope): string {
  return ({
    code: "代码",
    config: "配置",
    data: "数据",
    mixed: "混合",
  } as Record<IterationPlanScope, string>)[value];
}

function riskLabel(value: IterationPlanRecord["riskLevel"]): string {
  return ({ low: "低", medium: "中", high: "高" } as const)[value];
}

function statusClass(value: IterationFeedbackStatus | IterationPlanStatus): Record<string, boolean> {
  return {
    warn: value === "open" || value === "planned" || value === "draft" || value === "approved",
    danger: value === "rejected",
    ok: value === "applied",
  };
}

function onRefresh(): void {
  void Promise.all([loadFeedback(), loadPlans()]).catch((error) => app.showToast(error.message, "error"));
}

onMounted(() => {
  if (!feedbackForm.groupId) feedbackForm.groupId = app.groupId;
  void Promise.all([loadFeedback(), loadPlans()]);
});

useRefreshEvents({ refresh: onRefresh, groupChanged: onRefresh });

watch(() => app.groupId, (groupId) => {
  if (!feedbackForm.groupId) feedbackForm.groupId = groupId;
});

watch(() => [feedbackPagination.page, feedbackPagination.pageSize], () => {
  void loadFeedback().catch((error) => app.showToast(error.message, "error"));
});

watch(() => [planPagination.page, planPagination.pageSize], () => {
  void loadPlans().catch((error) => app.showToast(error.message, "error"));
});
</script>

<template>
  <section class="iteration-page">
    <section class="panel iteration-main">
      <div class="section-head">
        <div>
          <h2>自我迭代工作台 <span class="tag">V1</span></h2>
          <p>把群内反馈、后台证据和运行状态沉淀成可审批、可复制到 /goal 的开发计划。</p>
        </div>
        <button class="btn" type="button" :disabled="generating" @click="generatePlan">
          {{ generating ? "生成中..." : "生成开发计划" }}
        </button>
      </div>

      <div class="iteration-summary">
        <article>
          <span>待规划反馈</span>
          <strong>{{ openFeedbackCount }}</strong>
        </article>
        <article>
          <span>已纳入计划</span>
          <strong>{{ plannedFeedbackCount }}</strong>
        </article>
        <article>
          <span>可应用计划</span>
          <strong>{{ approvedPlanCount }}</strong>
        </article>
        <article>
          <span>当前群</span>
          <strong>{{ currentGroupLabel }}</strong>
        </article>
      </div>

      <div class="compose-grid">
        <form class="compose-box" @submit.prevent="createFeedback">
          <div class="mini-head">
            <strong>记录反馈</strong>
            <span>后台录入或 QQ 使用 #迭代 反馈</span>
          </div>
          <div class="form-grid compact-form">
            <label>归属群
              <select v-model="feedbackForm.groupId" class="select">
                <option value="">当前群</option>
                <option v-for="group in app.groups" :key="group.groupId" :value="group.groupId">
                  {{ group.groupName || group.groupId }}
                </option>
              </select>
            </label>
            <label>分类
              <select v-model="feedbackForm.category" class="select">
                <option value="behavior">行为</option>
                <option value="bug">缺陷</option>
                <option value="data_quality">数据质量</option>
                <option value="skill">技能</option>
                <option value="model">模型</option>
                <option value="feature">功能</option>
                <option value="ops">运维</option>
              </select>
            </label>
            <label class="wide">标题<input v-model="feedbackForm.title" class="input" maxlength="100" placeholder="可选，默认截取内容前半段" /></label>
            <label class="wide">内容<textarea v-model="feedbackForm.content" class="textarea" maxlength="1600" placeholder="描述异常、期望行为、证据或调优方向" /></label>
          </div>
          <div class="compose-actions">
            <button class="btn" type="submit">保存反馈</button>
          </div>
        </form>

        <form class="compose-box" @submit.prevent="generatePlan">
          <div class="mini-head">
            <strong>生成 /goal 计划</strong>
            <span>会读取待规划反馈、群配置、模型健康、技能和操作日志</span>
          </div>
          <div class="form-grid compact-form">
            <label class="wide">计划标题<input v-model="analyzeForm.title" class="input" maxlength="120" placeholder="默认：UBot 自我迭代 V1 开发优化计划" /></label>
            <label class="wide">分析范围
              <select v-model="analyzeForm.groupId" class="select">
                <option value="">全部群</option>
                <option v-for="group in app.groups" :key="group.groupId" :value="group.groupId">
                  {{ group.groupName || group.groupId }}
                </option>
              </select>
            </label>
          </div>
          <div class="compose-actions">
            <button class="ghost-btn" type="button" :disabled="feedbackLoading || plansLoading" @click="onRefresh">刷新证据</button>
            <button class="btn" type="submit" :disabled="generating">{{ generating ? "生成中..." : "生成计划" }}</button>
          </div>
        </form>
      </div>

      <div class="iteration-columns">
        <section class="iteration-block">
          <div class="section-head tight">
            <div>
              <h3>反馈池 <span class="tag">{{ feedbackPagination.total }}</span></h3>
              <p>待规划、已规划、已完成反馈统一管理。</p>
            </div>
          </div>
          <div class="filter-card compact-filter">
            <input v-model="feedbackFilters.q" class="input" placeholder="搜索反馈内容、群、操作者" @keyup.enter="applyFeedbackFilters" />
            <select v-model="feedbackFilters.scope" class="select" @change="applyFeedbackFilters">
              <option value="all">全部群</option>
              <option value="current">当前群</option>
            </select>
            <select v-model="feedbackFilters.category" class="select" @change="applyFeedbackFilters">
              <option value="">全部分类</option>
              <option value="bug">缺陷</option>
              <option value="behavior">行为</option>
              <option value="data_quality">数据质量</option>
              <option value="skill">技能</option>
              <option value="model">模型</option>
              <option value="feature">功能</option>
              <option value="ops">运维</option>
            </select>
            <select v-model="feedbackFilters.status" class="select" @change="applyFeedbackFilters">
              <option value="">全部状态</option>
              <option value="open">待规划</option>
              <option value="planned">已规划</option>
              <option value="applied">已完成</option>
              <option value="rejected">已拒绝</option>
            </select>
            <button class="ghost-btn" type="button" @click="resetFeedbackFilters">重置</button>
          </div>

          <div v-if="feedbackLoading" class="empty compact">正在加载反馈...</div>
          <div v-else-if="!feedback.length" class="empty compact">暂无匹配反馈。</div>
          <div v-else class="feedback-list">
            <article v-for="item in feedback" :key="item.id" class="feedback-row">
              <div class="row-title">
                <strong>{{ item.title }}</strong>
                <span class="tag" :class="statusClass(item.status)">{{ feedbackStatusLabel(item.status) }}</span>
                <span class="tag">{{ categoryLabel(item.category) }}</span>
              </div>
              <p>{{ item.content }}</p>
              <div class="row-meta">
                <span>{{ item.groupId }}</span>
                <span>{{ item.operatorUserId }}</span>
                <span>{{ item.source === "admin" ? "后台" : "QQ" }}</span>
                <span>{{ formatDateTime(item.updatedAt) }}</span>
              </div>
              <div class="row-actions">
                <button class="link-btn" type="button" :disabled="item.status === 'open'" @click="updateFeedbackStatus(item, 'open')">重开</button>
                <button class="link-btn" type="button" :disabled="item.status === 'rejected'" @click="updateFeedbackStatus(item, 'rejected')">拒绝</button>
                <button class="link-btn" type="button" :disabled="item.status === 'applied'" @click="updateFeedbackStatus(item, 'applied')">完成</button>
              </div>
            </article>
          </div>
        </section>

        <section class="iteration-block">
          <div class="section-head tight">
            <div>
              <h3>开发计划 <span class="tag">{{ planPagination.total }}</span></h3>
              <p>审批后可标记低风险反馈完成，源码开发仍交给 /goal 执行。</p>
            </div>
          </div>
          <div class="filter-card compact-filter plan-filter">
            <input v-model="planFilters.q" class="input" placeholder="搜索计划、证据、建议" @keyup.enter="applyPlanFilters" />
            <select v-model="planFilters.status" class="select" @change="applyPlanFilters">
              <option value="">全部状态</option>
              <option value="draft">草稿</option>
              <option value="approved">已批准</option>
              <option value="applied">已应用</option>
              <option value="rejected">已拒绝</option>
            </select>
            <select v-model="planFilters.scope" class="select" @change="applyPlanFilters">
              <option value="">全部范围</option>
              <option value="code">代码</option>
              <option value="config">配置</option>
              <option value="data">数据</option>
              <option value="mixed">混合</option>
            </select>
            <button class="ghost-btn" type="button" @click="resetPlanFilters">重置</button>
          </div>

          <div v-if="plansLoading" class="empty compact">正在加载计划...</div>
          <div v-else-if="!plans.length" class="empty compact">暂无开发计划。</div>
          <div v-else class="plan-list">
            <article v-for="plan in plans" :key="plan.id" class="plan-row" :class="{ active: activePlan?.id === plan.id }" @click="activePlan = plan">
              <div class="row-title">
                <strong>{{ plan.title }}</strong>
                <span class="tag" :class="statusClass(plan.status)">{{ planStatusLabel(plan.status) }}</span>
              </div>
              <p>{{ plan.summary }}</p>
              <div class="row-meta">
                <span>{{ planScopeLabel(plan.scope) }}</span>
                <span>风险 {{ riskLabel(plan.riskLevel) }}</span>
                <span>{{ plan.evidence.length }} 条证据</span>
                <span>{{ formatDateTime(plan.updatedAt) }}</span>
              </div>
              <div class="row-actions">
                <button class="link-btn" type="button" @click.stop="copyGoal(plan)">{{ copiedPlanId === plan.id ? "已复制" : "复制 /goal" }}</button>
                <button class="link-btn" type="button" :disabled="plan.status === 'approved'" @click.stop="updatePlanStatus(plan, 'approved')">批准</button>
                <button class="link-btn" type="button" :disabled="plan.status === 'rejected'" @click.stop="updatePlanStatus(plan, 'rejected')">拒绝</button>
                <button class="link-btn" type="button" :disabled="plan.status !== 'approved' || applyingId === plan.id" @click.stop="applyPlan(plan)">
                  {{ applyingId === plan.id ? "应用中" : "应用" }}
                </button>
              </div>
            </article>
          </div>
        </section>
      </div>
    </section>

    <aside class="panel plan-detail sticky-detail-panel">
      <div class="section-head">
        <div>
          <h2>计划详情</h2>
          <p>{{ activePlan ? activePlan.title : "选择计划查看证据和 /goal 内容" }}</p>
        </div>
      </div>
      <template v-if="activePlan">
        <dl class="detail-list">
          <template v-for="item in activePlanMeta" :key="item.label">
            <dt>{{ item.label }}</dt>
            <dd>{{ item.value }}</dd>
          </template>
        </dl>

        <section class="detail-section">
          <h3>执行摘要</h3>
          <p>{{ activePlan.summary }}</p>
        </section>

        <section class="detail-section">
          <h3>建议动作</h3>
          <article v-for="item in activePlan.recommendations" :key="`${item.type}:${item.title}`" class="mini-item">
            <strong>{{ item.title }}</strong>
            <p>{{ item.detail }}</p>
            <span class="tag">{{ item.type }}</span>
          </article>
        </section>

        <section class="detail-section">
          <h3>证据</h3>
          <article v-for="item in activePlan.evidence" :key="`${item.type}:${item.title}:${item.entityId || ''}`" class="mini-item">
            <strong>{{ item.title }}</strong>
            <p>{{ item.detail }}</p>
            <span class="tag">{{ item.type }}</span>
          </article>
        </section>

        <section class="detail-section">
          <div class="detail-toolbar">
            <h3>/goal 执行稿</h3>
            <button class="ghost-btn" type="button" @click="copyGoal(activePlan)">{{ copiedPlanId === activePlan.id ? "已复制" : "复制" }}</button>
          </div>
          <pre class="goal-prompt">{{ activePlanGoal }}</pre>
        </section>
      </template>
      <div v-else class="empty compact">暂无选中的开发计划。</div>
    </aside>
  </section>
</template>

<style scoped>
.iteration-page {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(360px, 430px);
  gap: 18px;
}

.iteration-main,
.plan-detail {
  min-width: 0;
}

.iteration-summary {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  margin-bottom: 18px;
}

.iteration-summary article {
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface-soft);
  padding: 13px 14px;
}

.iteration-summary span,
.mini-head span,
.row-meta {
  color: var(--muted);
  font-size: 12px;
}

.iteration-summary strong {
  display: block;
  margin-top: 6px;
  font-size: 20px;
  line-height: 1.2;
}

.compose-grid,
.iteration-columns {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.compose-grid {
  margin-bottom: 18px;
}

.compose-box,
.iteration-block {
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface-raised);
  padding: 14px;
}

.mini-head,
.compose-actions,
.row-title,
.row-actions,
.detail-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.mini-head {
  margin-bottom: 12px;
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.wide {
  grid-column: 1 / -1;
}

.compact-form label {
  min-width: 0;
}

.compose-actions {
  justify-content: flex-end;
  margin-top: 12px;
}

.tight {
  margin-bottom: 10px;
}

.tight h3 {
  margin: 0;
  font-size: 16px;
}

.compact-filter {
  display: grid;
  grid-template-columns: minmax(160px, 1fr) 110px 120px 110px auto;
  gap: 8px;
  margin-bottom: 12px;
  padding: 10px;
}

.plan-filter {
  grid-template-columns: minmax(170px, 1fr) 108px 108px auto;
}

.feedback-list,
.plan-list {
  display: grid;
  gap: 10px;
  max-height: 720px;
  overflow: auto;
  padding-right: 2px;
}

.feedback-row,
.plan-row {
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface);
  padding: 12px;
}

.plan-row {
  cursor: pointer;
}

.plan-row.active {
  border-color: color-mix(in oklch, var(--accent) 48%, var(--line));
  background: color-mix(in oklch, var(--accent-soft) 52%, var(--surface));
}

.row-title strong,
.feedback-row p,
.plan-row p,
.mini-item p,
.detail-section p {
  min-width: 0;
  overflow-wrap: anywhere;
}

.feedback-row p,
.plan-row p {
  margin: 9px 0;
  color: var(--text);
  line-height: 1.55;
}

.row-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 12px;
}

.row-actions {
  justify-content: flex-start;
  margin-top: 10px;
}

.tag.ok {
  background: color-mix(in oklch, var(--success) 18%, var(--surface));
  color: var(--success);
}

.detail-section {
  border-top: 1px solid var(--line);
  padding-top: 14px;
  margin-top: 14px;
}

.detail-section h3 {
  margin: 0 0 10px;
  font-size: 15px;
}

.mini-item {
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  padding: 10px;
  margin-bottom: 8px;
}

.mini-item p {
  margin: 6px 0 8px;
  color: var(--muted);
  line-height: 1.5;
}

.goal-prompt {
  max-height: 460px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface-soft);
  padding: 12px;
  font-size: 12px;
  line-height: 1.55;
}

@media (max-width: 1180px) {
  .iteration-page,
  .compose-grid,
  .iteration-columns,
  .iteration-summary {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 720px) {
  .compact-filter,
  .plan-filter,
  .form-grid {
    grid-template-columns: 1fr;
  }
}
</style>
