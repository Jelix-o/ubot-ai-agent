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
const recentCandidates = computed(() => data.value?.recent.candidates.slice(0, 10) || []);
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

function typeLabel(type: string): string {
  return type === "member_profile" ? "成员画像" : "群内事实";
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
      <MetricCard title="当前群待审记忆" :value="data?.stats.pendingCandidateCount ?? '-'" icon="health" tone="orange" />
      <MetricCard title="当前群长期记忆" :value="data?.stats.memoryCount ?? '-'" icon="memory" tone="blue" />
      <MetricCard title="当前群 FAQ" :value="data?.stats.knowledgeCount ?? '-'" icon="knowledge" tone="purple" />
    </div>

    <div class="overview-main-grid">
      <section class="panel overview-list-panel">
        <div class="section-head">
          <div>
            <h2>待处理候选记忆 <span class="tag">{{ data?.stats.pendingCandidateCount ?? 0 }}</span></h2>
            <p>优先处理待审候选，避免有价值的信息堆积。</p>
          </div>
          <RouterLink class="ghost-btn" to="/candidates">进入审核</RouterLink>
        </div>
        <div v-if="loading" class="empty">正在加载...</div>
        <div v-else-if="!recentCandidates.length" class="empty compact-empty">当前群没有待审候选。</div>
        <div v-else class="list overview-scroll-list">
          <article v-for="item in recentCandidates" :key="item.id" class="list-row candidate-row">
            <input type="checkbox" disabled />
            <div>
              <div class="row-top">
                <h3 class="row-title">{{ item.title }}</h3>
                <span class="tag warn">{{ typeLabel(item.type) }}</span>
              </div>
              <p class="row-content">{{ item.content }}</p>
              <span class="row-meta">来源：{{ item.subjectLabel?.label || item.subjectUserId || "群整体" }}</span>
            </div>
          </article>
        </div>
      </section>

      <section class="panel overview-list-panel">
        <div class="section-head">
          <div>
            <h2>最新长期记忆 <span class="tag">{{ data?.stats.memoryCount ?? 0 }}</span></h2>
          </div>
          <RouterLink class="ghost-btn" to="/memories">查看全部</RouterLink>
        </div>
        <div v-if="!recentMemories.length" class="empty compact-empty">暂无长期记忆。</div>
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
    </div>

    <div class="overview-side-grid">
      <section class="panel overview-status-panel">
        <div class="section-head">
          <div>
            <h2>系统状态</h2>
            <p>模型、传输层和服务器异常会影响画像、记忆或消息收发。</p>
          </div>
          <RouterLink class="ghost-btn" to="/health">查看系统状态</RouterLink>
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
            <p>帮助机器人更好地回答群成员问题。</p>
          </div>
          <RouterLink class="ghost-btn" to="/knowledge">管理知识库</RouterLink>
        </div>
        <div class="empty">已配置 {{ data?.stats.knowledgeCount ?? 0 }} 条 FAQ</div>
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
  min-height: 500px;
}

.overview-scroll-list {
  max-height: 430px;
  overflow-x: hidden;
  overflow-y: auto;
  padding-right: 4px;
}

.compact-empty {
  min-height: 100%;
}

.candidate-row {
  grid-template-columns: auto minmax(0, 1fr);
  align-items: start;
}

.health-mini {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
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
