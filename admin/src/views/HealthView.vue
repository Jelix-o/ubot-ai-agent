<script setup lang="ts">
import { computed, onMounted, shallowRef } from "vue";

import StatusCard from "../components/StatusCard.vue";
import { useRefreshEvents } from "../composables/useRefreshEvents";
import { api, type HealthStatus, type ModelHealthHistoryEntry, type ModelHealthStatus } from "../services/api";
import { useAppStore } from "../stores/app";
import { formatDateTime } from "../utils/format";

interface HealthData {
  transportHealth: HealthStatus;
  profileAiHealth: HealthStatus;
  modelStatuses: ModelHealthStatus[];
  abnormalModelStatuses: ModelHealthStatus[];
  modelStatusSummary: {
    total: number;
    abnormal: number;
    checkedAt: string;
  };
  uptimeSeconds: number;
  nodeVersion: string;
  pid: number;
  memory: { rss: number; heapUsed: number };
}

const app = useAppStore();
const data = shallowRef<HealthData>();
const modelHistory = shallowRef<ModelHealthHistoryEntry[]>([]);
const activeModel = shallowRef<ModelHealthHistoryEntry | null>(null);
const loading = shallowRef(false);

const activeModelMeta = computed(() => {
  const model = activeModel.value;
  if (!model) return [];
  return [
    { label: "模型 ID", value: model.id },
    { label: "模型分类", value: purposeLabel(model.purpose) },
    { label: "检测状态", value: model.ok ? "正常" : "异常" },
    { label: "连接延迟", value: `${model.latencyMs || 0}ms` },
    { label: "检测来源", value: sourceLabel(model.source) },
    { label: "检测时间", value: formatDateTime(model.checkedAt) },
    { label: "缓存状态", value: model.cached ? "缓存结果" : "实时检测" },
    { label: "模型名称", value: model.model || "-" },
    { label: "服务地址", value: model.baseUrl || "-" },
  ];
});

async function load(refresh = false): Promise<void> {
  loading.value = true;
  try {
    data.value = await api<HealthData>(`/api/health${refresh ? "?refresh=1" : ""}`);
    if (app.role === "super_admin") {
      const history = await api<{ models: ModelHealthHistoryEntry[] }>("/api/model-health-history");
      modelHistory.value = history.models;
    }
    if (refresh) app.showToast("系统状态检测已完成");
  } finally {
    loading.value = false;
  }
}

function memoryStatus(): HealthStatus {
  if (!data.value) return { ok: true, detail: "暂无数据" };
  return {
    ok: true,
    detail: `RSS ${Math.round(data.value.memory.rss / 1024 / 1024)}MB，堆内存 ${Math.round(data.value.memory.heapUsed / 1024 / 1024)}MB`,
    checkedAt: new Date().toISOString(),
    latencyMs: 0,
  };
}

function nodeStatus(): HealthStatus {
  if (!data.value) return { ok: true, detail: "暂无数据" };
  return { ok: true, detail: `${data.value.nodeVersion} / PID ${data.value.pid}`, checkedAt: `uptime ${data.value.uptimeSeconds}s`, latencyMs: 0 };
}

function purposeLabel(purpose: ModelHealthHistoryEntry["purpose"]): string {
  return ({
    reply: "回复模型",
    profile: "画像模型",
    memory: "记忆模型",
    dedup: "去重模型",
    summary: "总结模型",
    knowledge: "知识库模型",
    tts: "语音模型",
    custom: "自定义",
  } as Record<ModelHealthHistoryEntry["purpose"], string>)[purpose] || purpose;
}

function sourceLabel(source: ModelHealthHistoryEntry["source"]): string {
  return ({
    manual: "手动检测",
    overview: "总览刷新",
    health: "系统状态",
    runtime: "运行时",
  } as Record<ModelHealthHistoryEntry["source"], string>)[source] || source;
}

function openModelDetail(model: ModelHealthHistoryEntry): void {
  activeModel.value = model;
}

function closeModelDetail(): void {
  activeModel.value = null;
}

function onRefresh(): void {
  void load(true).catch((error) => app.showToast(error.message, "error"));
}

onMounted(() => {
  void load();
});

useRefreshEvents({ refresh: onRefresh });
</script>

<template>
  <section class="panel">
    <div class="section-head">
      <div>
        <h2>系统状态</h2>
        <p>模型检测每小时缓存一次，手动检测会刷新所有已启用模型。</p>
      </div>
      <button class="btn" type="button" :disabled="loading" @click="load(true)">
        {{ loading ? "检测中..." : "立即检测" }}
      </button>
    </div>

    <section class="status-section">
      <div class="sub-head">
        <div>
          <h3>模型检测</h3>
          <p>只展示检测不正常的模型，全部正常时保持空状态。</p>
        </div>
        <span class="tag" :class="{ danger: (data?.modelStatusSummary?.abnormal ?? 0) > 0 }">
          异常 {{ data?.modelStatusSummary?.abnormal ?? 0 }} / {{ data?.modelStatusSummary?.total ?? 0 }}
        </span>
      </div>
      <div v-if="loading && !data" class="empty compact">正在检测模型...</div>
      <div v-else-if="!(data?.abnormalModelStatuses || []).length" class="empty compact">当前没有异常模型。</div>
      <div v-else class="health-grid">
        <StatusCard
          v-for="model in data?.abnormalModelStatuses"
          :key="model.id"
          :title="`${model.shortName || model.name}（${model.purpose}）`"
          :status="model"
          :model-service="true"
        />
      </div>
    </section>

    <section class="status-section">
      <div class="sub-head">
        <div>
          <h3>服务器状态</h3>
          <p>展示消息连接、Node 进程和内存占用。</p>
        </div>
      </div>
      <div class="health-grid">
        <StatusCard title="NapCat 连接" :status="data?.transportHealth" />
        <StatusCard title="Node 运行时" :status="nodeStatus()" />
        <StatusCard title="内存占用" :status="memoryStatus()" />
      </div>
    </section>

    <section v-if="app.role === 'super_admin'" class="status-section">
      <div class="sub-head">
        <div>
          <h3>最近检测历史</h3>
          <p>记录每个模型最近一次检测来源、延迟和结果。</p>
        </div>
      </div>
      <div v-if="!modelHistory.length" class="empty compact">暂无模型检测历史。</div>
      <div v-else class="history-table">
        <div class="history-head">
          <span>模型</span>
          <span>分类</span>
          <span>状态</span>
          <span>延迟</span>
          <span>来源</span>
          <span>检测时间</span>
          <span>操作</span>
        </div>
        <article v-for="model in modelHistory" :key="model.id" class="history-row" :class="{ active: activeModel?.id === model.id }">
          <strong>{{ model.shortName || model.name }}</strong>
          <span>{{ purposeLabel(model.purpose) }}</span>
          <span class="tag" :class="{ danger: !model.ok }">{{ model.ok ? "OK" : "Fail" }}</span>
          <span>{{ model.latencyMs || 0 }}ms</span>
          <span>{{ sourceLabel(model.source) }}</span>
          <span class="muted">{{ formatDateTime(model.checkedAt) }}</span>
          <button class="link-btn row-action" type="button" @click="openModelDetail(model)">查看详情</button>
        </article>
      </div>

      <section v-if="activeModel" class="model-detail" aria-live="polite">
        <div class="detail-head">
          <div>
            <h3>{{ activeModel.shortName || activeModel.name }}</h3>
            <p>{{ purposeLabel(activeModel.purpose) }} / {{ activeModel.ok ? "连接正常" : "连接异常" }}</p>
          </div>
          <button class="ghost-btn" type="button" @click="closeModelDetail">收起</button>
        </div>
        <div class="detail-body">
          <dl class="detail-list">
            <template v-for="item in activeModelMeta" :key="item.label">
              <dt>{{ item.label }}</dt>
              <dd>{{ item.value }}</dd>
            </template>
          </dl>
          <div class="detail-text">
            <h4>完整详情</h4>
            <p>{{ activeModel.detail || "暂无详情。" }}</p>
          </div>
        </div>
      </section>
    </section>

    <details class="diagnostics">
      <summary>查看原始诊断 JSON</summary>
      <pre>{{ JSON.stringify(data, null, 2) }}</pre>
    </details>
  </section>
</template>

<style scoped>
.health-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 16px;
}

.status-section {
  display: grid;
  gap: 14px;
  border-top: 1px solid var(--line);
  padding-top: 18px;
  margin-top: 18px;
}

.status-section:first-of-type {
  border-top: 0;
  padding-top: 0;
  margin-top: 0;
}

.sub-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.sub-head h3,
.sub-head p {
  margin: 0;
}

.sub-head p {
  margin-top: 5px;
  color: var(--muted);
}

.history-table {
  overflow: auto;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
}

.history-head,
.history-row {
  display: grid;
  grid-template-columns: minmax(180px, 1fr) 110px 90px 90px 110px 180px 90px;
  gap: 12px;
  align-items: center;
  min-width: 920px;
  border-bottom: 1px solid var(--line);
  padding: 12px 14px;
}

.history-head {
  background: var(--surface-soft);
  color: var(--muted);
  font-size: 13px;
  font-weight: 900;
}

.history-row:last-child {
  border-bottom: 0;
}

.history-row.active {
  background: var(--surface-soft);
}

.model-detail {
  display: grid;
  gap: 14px;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--surface-raised);
  padding: 16px;
}

.detail-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.detail-head h3,
.detail-head p,
.detail-text h4,
.detail-text p {
  margin: 0;
}

.detail-head p {
  margin-top: 5px;
  color: var(--muted);
}

.detail-body {
  display: grid;
  grid-template-columns: minmax(260px, 0.9fr) minmax(320px, 1.1fr);
  gap: 14px;
}

.detail-list {
  display: grid;
  grid-template-columns: 88px minmax(0, 1fr);
  gap: 10px 12px;
  margin: 0;
}

.detail-list dt {
  color: var(--muted);
  font-weight: 800;
}

.detail-list dd {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
}

.detail-text {
  display: grid;
  gap: 8px;
  min-width: 0;
  border-left: 1px solid var(--line);
  padding-left: 14px;
}

.detail-text p {
  color: var(--muted);
  line-height: 1.7;
  overflow-wrap: anywhere;
}

.compact {
  min-height: 120px;
}

.diagnostics {
  margin-top: 18px;
  color: var(--muted);
}

pre {
  overflow: auto;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  padding: 14px;
  background: var(--surface-soft);
}

@media (max-width: 760px) {
  .health-grid {
    grid-template-columns: 1fr;
  }

  .detail-body {
    grid-template-columns: 1fr;
  }

  .detail-text {
    border-left: 0;
    border-top: 1px solid var(--line);
    padding-left: 0;
    padding-top: 14px;
  }
}
</style>
