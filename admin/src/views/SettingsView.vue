<script setup lang="ts">
import { computed, onMounted, reactive, shallowRef } from "vue";

import { api, type GroupConfig, type SystemModelConfig, type SystemModelPurpose, type SystemSettings } from "../services/api";
import { useAppStore } from "../stores/app";

const app = useAppStore();
const loading = shallowRef(false);
const saving = shallowRef(false);
const testingModelId = shallowRef("");
const groupQuery = shallowRef("");
const activePurpose = shallowRef<SystemModelPurpose>("reply");
const secretForm = reactive({ adminSecret: "", groupAdminSecret: "" });
const settings = reactive<SystemSettings>({
  profileSummaryMaxChars: 1800,
  profileShortSummaryMaxChars: 140,
  dailyProfileReviewEnabled: true,
  dailyProfileReviewTime: "00:00",
  memoryDedupEnabled: true,
  memoryDedupTime: "23:00",
  adminSecretConfigured: false,
  groupAdminSecretConfigured: false,
  defaultTriggerKeywords: [{ keyword: "乘风", enabled: true }],
  models: [],
  selectedModelIds: {},
  commands: [],
  updatedAt: "",
});

const modelPurposeOptions: Array<{ value: SystemModelPurpose; label: string; detail: string }> = [
  { value: "reply", label: "对话回复", detail: "普通群聊回复、实时对话和群内 #模型 切换列表" },
  { value: "memory", label: "记忆提取", detail: "候选记忆提炼、入库前整理和候选中文化" },
  { value: "profile", label: "画像总结", detail: "群聊画像、昨日画像和公开画像生成" },
  { value: "dedup", label: "去重处理", detail: "长期记忆去重和语义合并判断" },
  { value: "summary", label: "群聊总结", detail: "日报分析、群聊时段总结和定时文案" },
  { value: "knowledge", label: "知识库处理", detail: "历史聊天清洗、FAQ 提炼和知识导入" },
  { value: "tts", label: "语音", detail: "语音回复和 TTS 相关模型" },
  { value: "custom", label: "自定义", detail: "预留模型，不自动接管系统能力" },
];

const activePurposeMeta = computed(() => modelPurposeOptions.find((item) => item.value === activePurpose.value)!);
const activePurposeModels = computed(() => settings.models.filter((model) => model.purpose === activePurpose.value));

function modelTemplate(purpose = activePurpose.value): SystemModelConfig {
  const now = new Date().toISOString();
  return {
    id: `${purpose}-${Date.now()}`,
    name: "",
    shortName: "",
    baseUrl: "",
    model: "",
    purpose,
    hasApiKey: false,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const [next] = await Promise.all([
      api<SystemSettings>("/api/system-settings"),
      app.loadGroups({ includeDisabled: true }),
    ]);
    Object.assign(settings, next);
  } finally {
    loading.value = false;
  }
}

async function save(): Promise<void> {
  saving.value = true;
  try {
    const next = await api<SystemSettings>("/api/system-settings", {
      method: "PUT",
      body: JSON.stringify(settings),
    });
    Object.assign(settings, next);
    await app.loadGroups();
    app.showToast("系统设置已保存");
  } catch (error) {
    app.showToast((error as Error).message, "error");
  } finally {
    saving.value = false;
  }
}

async function resetSecret(kind: "admin" | "group"): Promise<void> {
  const secret = kind === "admin" ? secretForm.adminSecret : secretForm.groupAdminSecret;
  if (secret.trim().length < 6) {
    app.showToast("秘钥至少 6 位", "error");
    return;
  }
  try {
    const next = await api<SystemSettings>(kind === "admin" ? "/api/system-settings/admin-secret" : "/api/system-settings/group-admin-secret", {
      method: "POST",
      body: JSON.stringify({ secret }),
    });
    Object.assign(settings, next);
    if (kind === "admin") secretForm.adminSecret = "";
    else secretForm.groupAdminSecret = "";
    app.showToast(kind === "admin" ? "超级管理员秘钥已更新" : "管理员秘钥已更新");
  } catch (error) {
    app.showToast((error as Error).message, "error");
  }
}

async function syncGroups(): Promise<void> {
  try {
    const data = await api<{ syncedCount: number; groups: GroupConfig[] }>("/api/groups/sync", { method: "POST", body: "{}" });
    app.groups = data.groups;
    app.showToast(`已同步 ${data.syncedCount} 个机器人群聊`);
  } catch (error) {
    app.showToast((error as Error).message, "error");
  }
}

async function toggleGroup(group: GroupConfig): Promise<void> {
  try {
    const next = await api<GroupConfig>(`/api/groups/${encodeURIComponent(group.groupId)}/config`, {
      method: "PUT",
      body: JSON.stringify({ enabled: group.enabled !== false }),
    });
    Object.assign(group, next);
    app.showToast(next.enabled === false ? "群已隐藏并禁用机器人" : "群已显示并启用机器人");
  } catch (error) {
    app.showToast((error as Error).message, "error");
  }
}

function addModel(): void {
  settings.models.push(modelTemplate());
}

function removeModel(index: number, model: SystemModelConfig): void {
  settings.models.splice(index, 1);
  if (settings.selectedModelIds[model.purpose] === model.id) {
    delete settings.selectedModelIds[model.purpose];
  }
}

function selectModel(model: SystemModelConfig): void {
  settings.selectedModelIds[model.purpose] = model.id;
}

async function testModel(model: SystemModelConfig): Promise<void> {
  testingModelId.value = model.id;
  try {
    const result = await api<{ ok: boolean; detail: string; latencyMs?: number }>(`/api/models/${encodeURIComponent(model.id)}/test`, {
      method: "POST",
      body: "{}",
    });
    app.showToast(result.ok ? `检测通过，延迟 ${result.latencyMs ?? 0}ms` : `检测不通过：${result.detail}`, result.ok ? "ok" : "error");
  } catch (error) {
    app.showToast(`检测不通过：${(error as Error).message}`, "error");
  } finally {
    testingModelId.value = "";
  }
}

function modelIndex(model: SystemModelConfig): number {
  return settings.models.findIndex((item) => item === model);
}

function visibleGroups(): GroupConfig[] {
  const q = groupQuery.value.trim().toLowerCase();
  return app.groups.filter((group) => {
    if (!q) return true;
    return `${group.groupName || ""} ${group.groupId}`.toLowerCase().includes(q);
  });
}

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="page">
    <section class="panel">
      <div class="section-head">
        <div>
          <h2>系统管理</h2>
          <p>统一管理群启用状态、登录秘钥、模型配置和记忆画像策略。</p>
        </div>
        <div class="toolbar">
          <button class="ghost-btn" type="button" @click="syncGroups">同步群聊</button>
          <button class="btn" type="button" :disabled="saving" @click="save">{{ saving ? "保存中..." : "保存设置" }}</button>
        </div>
      </div>
      <div v-if="loading" class="empty">正在加载系统设置...</div>
      <div v-else class="settings-grid">
        <div class="card setting-card">
          <h3>群显示 / 隐藏</h3>
          <p class="muted">隐藏群会禁用机器人回复、语音、日报、定时任务和记忆收集。</p>
          <input v-model="groupQuery" class="input" placeholder="搜索群名或群号" />
          <div class="compact-list">
            <label v-for="group in visibleGroups()" :key="group.groupId" class="switch-row">
              <span>
                <strong>{{ group.groupName || group.groupId }}</strong>
                <small>{{ group.groupId }}</small>
              </span>
              <input v-model="group.enabled" type="checkbox" @change="toggleGroup(group)" />
            </label>
          </div>
        </div>

        <div class="card setting-card policy-card">
          <h3>记忆与画像策略</h3>
          <div class="policy-grid">
            <label>完整画像字数上限<input v-model.number="settings.profileSummaryMaxChars" class="input" type="number" min="100" max="6000" /></label>
            <label>群内短摘要字数上限<input v-model.number="settings.profileShortSummaryMaxChars" class="input" type="number" min="40" max="600" /></label>
            <label class="policy-row"><span>自动生成昨日画像</span><input v-model="settings.dailyProfileReviewEnabled" type="checkbox" /></label>
            <label class="policy-row"><span>昨日画像触发时间</span><input v-model="settings.dailyProfileReviewTime" class="input" type="time" /></label>
            <label class="policy-row"><span>自动成员记忆去重</span><input v-model="settings.memoryDedupEnabled" type="checkbox" /></label>
            <label class="policy-row"><span>记忆去重触发时间</span><input v-model="settings.memoryDedupTime" class="input" type="time" /></label>
          </div>
        </div>

        <div class="card setting-card secret-card">
          <h3>管理员秘钥</h3>
          <p class="muted">admin + 超级管理员秘钥登录超级管理员；群管理员 QQ + 管理员秘钥登录群管理员账号。</p>
          <div class="secret-grid">
            <label>超级管理员秘钥
              <input v-model="secretForm.adminSecret" class="input" type="password" :placeholder="settings.adminSecretConfigured ? '已配置，输入新秘钥后更新' : '未配置'" />
            </label>
            <button class="ghost-btn" type="button" @click="resetSecret('admin')">更新超级管理员秘钥</button>
            <label>管理员秘钥
              <input v-model="secretForm.groupAdminSecret" class="input" type="password" :placeholder="settings.groupAdminSecretConfigured ? '已配置，输入新秘钥后更新' : '未配置'" />
            </label>
            <button class="ghost-btn" type="button" @click="resetSecret('group')">更新管理员秘钥</button>
          </div>
        </div>
      </div>
    </section>

    <section class="panel">
      <div class="section-head">
        <div>
          <h2>模型配置</h2>
          <p>按模型分类维护配置。每个分类只能选择一个正在使用的模型，API Key 留空表示保留旧值。</p>
        </div>
        <button class="ghost-btn" type="button" @click="addModel">新增 {{ activePurposeMeta.label }} 模型</button>
      </div>
      <div class="purpose-tabs">
        <button v-for="item in modelPurposeOptions" :key="item.value" type="button" :class="{ active: activePurpose === item.value }" @click="activePurpose = item.value">
          <strong>{{ item.label }}</strong>
          <small>{{ item.detail }}</small>
        </button>
      </div>
      <div v-if="!activePurposeModels.length" class="empty compact">当前分类暂无模型。</div>
      <div v-else class="model-table">
        <div class="table-head">
          <span>使用</span>
          <span>模型信息</span>
          <span>Base URL</span>
          <span>模型名</span>
          <span>启用</span>
          <span>API Key</span>
          <span>操作</span>
        </div>
        <article v-for="model in activePurposeModels" :key="model.id" class="table-row">
          <label class="radio-cell"><input type="radio" :checked="settings.selectedModelIds[model.purpose] === model.id" :disabled="!model.enabled" @change="selectModel(model)" /></label>
          <div class="model-name">
            <input v-model="model.id" class="input" placeholder="reply-pro" />
            <input v-model="model.name" class="input" placeholder="名称" />
            <input v-model="model.shortName" class="input" placeholder="简称" />
          </div>
          <input v-model="model.baseUrl" class="input" placeholder="https://api.example.com/v1" />
          <input v-model="model.model" class="input" placeholder="model-name" />
          <label class="mini-check"><input v-model="model.enabled" type="checkbox" /> 启用</label>
          <input v-model="model.apiKey" class="input" type="password" :placeholder="model.hasApiKey ? '已保存，留空保留' : '未设置'" />
          <div class="row-actions">
            <button class="link-btn" type="button" :disabled="testingModelId === model.id" @click="testModel(model)">{{ testingModelId === model.id ? "检测中" : "检测连接" }}</button>
            <button class="link-btn danger" type="button" @click="removeModel(modelIndex(model), model)">删除</button>
          </div>
        </article>
      </div>
    </section>
  </div>
</template>

<style scoped>
.toolbar,
.switch-row,
.row-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.settings-grid {
  display: grid;
  grid-template-columns: minmax(280px, 0.95fr) minmax(340px, 1.05fr);
  gap: 16px;
}

.setting-card {
  display: grid;
  align-content: start;
  gap: 12px;
  padding: 16px;
}

.secret-card {
  grid-column: 1 / -1;
}

.compact-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  max-height: 320px;
  overflow: auto;
}

.switch-row,
.policy-row {
  justify-content: space-between;
}

.switch-row span {
  display: grid;
  gap: 2px;
}

.switch-row small {
  color: var(--muted);
}

.policy-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  align-items: end;
}

.policy-grid label {
  display: grid;
  gap: 8px;
}

.policy-row {
  display: grid !important;
  grid-template-columns: minmax(150px, 1fr) minmax(130px, 0.72fr);
  align-items: center;
  gap: 12px;
}

.policy-row input[type="checkbox"] {
  justify-self: end;
}

.secret-grid {
  display: grid;
  grid-template-columns: minmax(220px, 1fr) auto;
  gap: 12px;
  align-items: end;
}

.secret-grid label {
  display: grid;
  gap: 8px;
  color: var(--muted);
  font-weight: 700;
}

.purpose-tabs {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 14px;
}

.purpose-tabs button {
  display: grid;
  gap: 6px;
  min-height: 82px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface-soft);
  color: var(--text);
  padding: 12px;
  text-align: left;
}

.purpose-tabs button.active {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent-strong);
}

.purpose-tabs small {
  color: var(--muted);
  line-height: 1.45;
}

.model-table {
  overflow: auto;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
}

.table-head,
.table-row {
  display: grid;
  grid-template-columns: 64px minmax(180px, 0.9fr) minmax(190px, 1fr) minmax(130px, 0.7fr) 78px minmax(150px, 0.75fr) 156px;
  gap: 12px;
  align-items: center;
  min-width: 1120px;
  border-bottom: 1px solid var(--line);
  padding: 12px;
}

.table-head {
  position: sticky;
  top: 0;
  z-index: 2;
  min-height: 48px;
  background: var(--surface-soft);
  color: var(--muted);
  font-size: 13px;
  font-weight: 800;
}

.table-row {
  background: var(--surface-raised);
}

.table-row:last-child {
  border-bottom: 0;
}

.model-name {
  display: grid;
  gap: 8px;
}

.radio-cell,
.mini-check {
  display: flex;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
}

.row-actions {
  justify-content: flex-start;
  white-space: nowrap;
}

.link-btn {
  background: transparent;
  color: var(--blue);
  font-weight: 900;
  padding: 0;
}

.danger {
  color: var(--danger);
}

.compact {
  min-height: 120px;
}

@media (max-width: 1100px) {
  .settings-grid,
  .policy-grid,
  .compact-list,
  .secret-grid,
  .purpose-tabs {
    grid-template-columns: 1fr;
  }

  .policy-row {
    grid-template-columns: minmax(0, 1fr) auto;
  }
}
</style>
