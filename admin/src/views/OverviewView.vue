<script setup lang="ts">
import { computed, onMounted, shallowRef } from "vue";
import { RouterLink } from "vue-router";

import MetricCard from "../components/MetricCard.vue";
import StatusCard from "../components/StatusCard.vue";
import { useRefreshEvents } from "../composables/useRefreshEvents";
import { api, queryString, type OverviewData } from "../services/api";
import { useAppStore } from "../stores/app";
import { formatDateTime } from "../utils/format";

const app = useAppStore();
const data = shallowRef<OverviewData>();
const loading = shallowRef(false);
const recentMemories = computed(() => data.value?.recent.memories.slice(0, 10) || []);
const modelDetectionStatus = computed(() => ({
  ok: (data.value?.modelStatusSummary?.abnormal ?? 0) === 0,
  detail: (data.value?.modelStatusSummary?.abnormal ?? 0) === 0
    ? `已检测 ${data.value?.modelStatusSummary?.total ?? 0} 个模型，暂无异常`
    : `${data.value?.modelStatusSummary?.abnormal ?? 0} 个模型异常，请进入系统状态查看`,
  checkedAt: data.value?.modelStatusSummary?.checkedAt,
  latencyMs: 0,
  cached: true,
}));

async function load(): Promise<void> {
  loading.value = true;
  try {
    data.value = await api<OverviewData>(`/api/overview${queryString({ groupId: app.groupId })}`);
  } finally {
    loading.value = false;
  }
}

function onRefresh(): void {
  void load().catch((error) => app.showToast(error.message, "error"));
}

onMounted(() => {
  void load();
});

useRefreshEvents({ refresh: onRefresh, groupChanged: onRefresh });
</script>

<template>
  <section class="overview-page">
    <div class="metric-grid">
      <MetricCard title="已配置群" :value="data?.stats.groupCount ?? '-'" icon="users" tone="green" />
      <MetricCard title="当前群记忆" :value="data?.stats.memoryCount ?? '-'" icon="memory" tone="blue" />
      <MetricCard title="当前群 FAQ" :value="data?.stats.knowledgeCount ?? '-'" icon="knowledge" tone="purple" />
      <MetricCard title="核心服务" :value="data?.transportHealth?.ok ? '运行中' : '检查中'" icon="health" tone="orange" />
    </div>

    <div class="overview-main-grid">
      <section class="panel overview-list-panel">
        <div class="section-head">
          <div>
            <h2>最近保存的记忆 <span class="tag">{{ data?.stats.memoryCount ?? 0 }}</span></h2>
            <p>仅展示成员或管理员明确要求保存的信息。</p>
          </div>
          <RouterLink class="ghost-btn" to="/memories">管理记忆</RouterLink>
        </div>
        <div v-if="loading" class="empty">正在加载...</div>
        <div v-else-if="!recentMemories.length" class="empty compact-empty">当前群暂无记忆。</div>
        <div v-else class="list overview-scroll-list">
          <article v-for="item in recentMemories" :key="item.id" class="list-row">
            <div class="row-top">
              <h3 class="row-title">{{ item.title }}</h3>
              <span class="tag">{{ item.subjectLabel?.label || "群组信息" }}</span>
            </div>
            <p class="row-content">{{ item.content }}</p>
            <span class="row-meta">{{ item.source }} · {{ formatDateTime(item.createdAt) }}</span>
          </article>
        </div>
      </section>

      <section class="panel overview-list-panel persona-summary">
        <div class="section-head">
          <div>
            <h2>会仙人格</h2>
            <p>当前群统一使用会仙。她会自然参与、认真帮忙；现实证明类问题会简短转场，不编造可核验事实。</p>
          </div>
          <RouterLink v-if="app.role === 'super_admin'" class="ghost-btn" to="/persona">编辑人格</RouterLink>
        </div>
        <div class="empty compact-empty">会仙通过成员明确保存的记忆维持对话连续性；不会从普通聊天自动收集个人信息。</div>
      </section>
    </div>

    <div class="overview-side-grid">
      <section class="panel overview-status-panel">
        <div class="section-head">
          <div>
            <h2>系统状态</h2>
            <p>模型、传输层和服务器异常会影响消息收发与排程任务。</p>
          </div>
          <RouterLink v-if="app.role === 'super_admin'" class="ghost-btn" to="/health">查看系统状态</RouterLink>
        </div>
        <div class="health-mini">
          <StatusCard title="NapCat 连接" :status="data?.transportHealth" />
          <StatusCard title="模型检测" :status="modelDetectionStatus" />
        </div>
      </section>

      <section class="panel overview-status-panel knowledge-summary">
        <div class="section-head">
          <div>
            <h2>知识库（FAQ）<span class="tag">{{ data?.stats.knowledgeCount ?? 0 }}</span></h2>
            <p>维护群专属问答与高频知识，加速精准应答。</p>
          </div>
          <RouterLink class="ghost-btn" to="/knowledge">管理知识库</RouterLink>
        </div>
        <div class="faq-summary-box">
          <div class="faq-summary-count">
            <strong>{{ data?.stats.knowledgeCount ?? 0 }}</strong>
            <span>条群知识条目</span>
          </div>
          <p class="muted">可进入知识库页面查看条目明细、添加新问答或调整匹配关键词。</p>
        </div>
      </section>
    </div>
  </section>
</template>

<style scoped>
.overview-page {
  display: grid;
  gap: 18px;
  min-height: 100%;
  height: auto;
  overflow: visible;
}

.overview-main-grid,
.overview-side-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 18px;
  min-height: 0;
}

.overview-list-panel,
.overview-status-panel {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  min-height: 260px;
}

.overview-list-panel {
  min-height: 580px;
}

.overview-scroll-list {
  max-height: 500px;
  overflow-x: hidden;
  overflow-y: auto;
  padding-right: 4px;
}

.overview-scroll-list .row-content {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.compact-empty {
  min-height: 100%;
}

.health-mini {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.faq-summary-box {
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  gap: 10px;
  padding: 24px 20px;
  background: var(--surface-soft);
  border: 1px dashed var(--line);
  border-radius: var(--radius-md);
  text-align: center;
}

.faq-summary-count {
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.faq-summary-count strong {
  font-size: 32px;
  font-weight: 800;
  color: var(--purple);
  line-height: 1;
}

.faq-summary-count span {
  font-size: 13px;
  color: var(--muted);
  font-weight: 500;
}

@media (max-width: 760px) {
  .overview-page {
    height: auto;
    min-height: 0;
    overflow: visible;
  }

  .overview-main-grid,
  .overview-side-grid {
    grid-template-columns: 1fr;
  }

  .health-mini {
    grid-template-columns: 1fr;
  }
}
</style>
