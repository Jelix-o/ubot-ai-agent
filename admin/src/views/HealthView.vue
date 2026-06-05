<script setup lang="ts">
import { onMounted, shallowRef } from "vue";

import StatusCard from "../components/StatusCard.vue";
import { useRefreshEvents } from "../composables/useRefreshEvents";
import { api, type HealthStatus, type ModelHealthStatus } from "../services/api";
import { useAppStore } from "../stores/app";

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
const loading = shallowRef(false);

async function load(refresh = false): Promise<void> {
  loading.value = true;
  try {
    data.value = await api<HealthData>(`/api/health${refresh ? "?refresh=1" : ""}`);
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
  return { ok: true, detail: `${data.value.nodeVersion} · PID ${data.value.pid}`, checkedAt: `uptime ${data.value.uptimeSeconds}s`, latencyMs: 0 };
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
}
</style>
