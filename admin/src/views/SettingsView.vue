<script setup lang="ts">
import { computed, onMounted, reactive, shallowRef } from "vue";

import { api, type GroupConfig, type ModelHealthStatus, type SystemModelConfig, type SystemModelPurpose, type SystemSettings } from "../services/api";
import { useAppStore } from "../stores/app";

const app = useAppStore();
const loading = shallowRef(false);
const saving = shallowRef(false);
const testingModelId = shallowRef("");
const testingAllModels = shallowRef(false);
const groupQuery = shallowRef("");
const allGroups = shallowRef<GroupConfig[]>([]);
const activePurpose = shallowRef<SystemModelPurpose>("reply");
const modelSettingsDirty = shallowRef(false);
const modelHealthById = shallowRef<Record<string, ModelHealthStatus>>({});
const secretForm = reactive({ adminSecret: "", groupAdminSecret: "" });
const modelRowKeys = new WeakMap<SystemModelConfig, string>();
let modelRowKeySeed = 0;
const settings = reactive<SystemSettings>({
  profileSummaryMaxChars: 1800,
  profileShortSummaryMaxChars: 140,
  dailyProfileReviewEnabled: true,
  dailyProfileReviewTime: "00:00",
  memoryDedupEnabled: true,
  memoryDedupTime: "23:00",
  memoryDedupSemanticTimeoutMinutes: 10,
  memoryCandidateConfidenceThreshold: 60,
  memoryAutoApproveConfidenceThreshold: 80,
  memoryUnattendedModeEnabled: false,
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

const modelIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/;
const modelPurposeDefaultNames: Record<SystemModelPurpose, string> = {
  reply: "Reply Model",
  profile: "Profile Model",
  memory: "Memory Model",
  dedup: "Dedup Model",
  summary: "Summary Model",
  knowledge: "Knowledge Model",
  tts: "TTS Model",
  custom: "Custom Model",
};

const activePurposeMeta = computed(() => modelPurposeOptions.find((item) => item.value === activePurpose.value)!);
const activePurposeModels = computed(() => settings.models.filter((model) => model.purpose === activePurpose.value));
const modelPurposeHealth = computed(() => {
  const result: Partial<Record<SystemModelPurpose, { failed: number; total: number }>> = {};
  for (const model of settings.models) {
    if (!model.enabled) continue;
    const health = modelHealthById.value[model.id];
    const current = result[model.purpose] ?? { failed: 0, total: 0 };
    current.total += 1;
    if (health && !health.ok && !health.skipped) current.failed += 1;
    result[model.purpose] = current;
  }
  return result;
});

function modelTemplate(purpose = activePurpose.value): SystemModelConfig {
  const now = new Date().toISOString();
  const id = createUniqueModelId(`${purpose}-model`);
  return {
    id,
    name: modelPurposeDefaultNames[purpose],
    shortName: purpose,
    baseUrl: "",
    model: "",
    purpose,
    hasApiKey: false,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
}

function createUniqueModelId(base: string): string {
  const normalizedBase = normalizeUiModelId(base);
  const existingIds = new Set(settings.models.map((model) => model.id.trim()).filter(Boolean));
  if (!existingIds.has(normalizedBase)) return normalizedBase;
  for (let index = 2; index < 1000; index += 1) {
    const id = `${normalizedBase}-${index}`;
    if (!existingIds.has(id)) return id;
  }
  return `${normalizedBase}-${Date.now()}`;
}

function normalizeUiModelId(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 64);
  return normalized || "model";
}

function modelRowKey(model: SystemModelConfig): string {
  const existing = modelRowKeys.get(model);
  if (existing) return existing;
  modelRowKeySeed += 1;
  const key = `model-row-${modelRowKeySeed}`;
  modelRowKeys.set(model, key);
  return key;
}

function modelPurposeLabel(purpose: SystemModelPurpose): string {
  const meta = modelPurposeOptions.find((item) => item.value === purpose);
  return meta ? `${meta.label} / ${meta.value}` : purpose;
}

function markModelsDirty(): void {
  modelSettingsDirty.value = true;
}

function updateModelId(model: SystemModelConfig, event: Event): void {
  const previousId = model.id;
  const nextId = (event.target as HTMLInputElement).value;
  model.id = nextId;
  if (settings.selectedModelIds[model.purpose] === previousId) {
    settings.selectedModelIds[model.purpose] = nextId.trim();
  }
  if (previousId && previousId !== nextId) {
    const { [previousId]: _removed, ...remainingHealth } = modelHealthById.value;
    modelHealthById.value = remainingHealth;
  }
  markModelsDirty();
}

function applyModelStatuses(statuses: ModelHealthStatus[]): void {
  modelHealthById.value = statuses.reduce<Record<string, ModelHealthStatus>>((result, status) => {
    result[status.id] = status;
    return result;
  }, { ...modelHealthById.value });
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const [next, groupData] = await Promise.all([
      api<SystemSettings>("/api/system-settings"),
      api<{ groups: GroupConfig[] }>("/api/groups?includeDisabled=1"),
    ]);
    Object.assign(settings, next);
    allGroups.value = groupData.groups;
    const history = await api<{ models: ModelHealthStatus[] }>("/api/model-health-history");
    applyModelStatuses(history.models);
  } finally {
    loading.value = false;
  }
}

async function save(): Promise<void> {
  normalizeModelFieldsBeforeSave();
  if (!validateMemoryPolicyBeforeSave()) return;
  if (!validateModelsBeforeSave()) return;
  saving.value = true;
  try {
    const next = await api<SystemSettings>("/api/system-settings", {
      method: "PUT",
      body: JSON.stringify(settings),
    });
    Object.assign(settings, next);
    await app.loadGroups();
    const groupData = await api<{ groups: GroupConfig[] }>("/api/groups?includeDisabled=1");
    allGroups.value = groupData.groups;
    modelSettingsDirty.value = false;
    app.showToast("系统设置已保存");
  } catch (error) {
    app.showToast((error as Error).message, "error");
  } finally {
    saving.value = false;
  }
}

function validateMemoryPolicyBeforeSave(): boolean {
  const candidateThreshold = settings.memoryCandidateConfidenceThreshold;
  const autoApproveThreshold = settings.memoryAutoApproveConfidenceThreshold;
  if (!Number.isInteger(candidateThreshold) || candidateThreshold < 0 || candidateThreshold > 100) {
    app.showToast("候选记忆阈值必须是 0-100 的整数百分比", "error");
    return false;
  }
  if (!Number.isInteger(autoApproveThreshold) || autoApproveThreshold < 0 || autoApproveThreshold > 100) {
    app.showToast("长期记忆阈值必须是 0-100 的整数百分比", "error");
    return false;
  }
  if (candidateThreshold >= autoApproveThreshold) {
    app.showToast("候选记忆阈值必须低于长期记忆阈值", "error");
    return false;
  }
  return true;
}

function normalizeModelFieldsBeforeSave(): void {
  for (const model of settings.models) {
    model.id = model.id.trim();
    model.name = model.name.trim();
    model.shortName = model.shortName.trim();
    model.baseUrl = model.baseUrl.trim();
    model.model = model.model.trim();
    if (typeof model.apiKey === "string") {
      model.apiKey = model.apiKey.trim();
    }
  }
}

function validateModelsBeforeSave(): boolean {
  const seenIds = new Set<string>();
  for (const model of settings.models) {
    const id = model.id.trim();
    if (!modelIdPattern.test(id)) {
      activePurpose.value = model.purpose;
      app.showToast(`模型 ID 无效：${id || "空"}`, "error");
      return false;
    }
    if (seenIds.has(id)) {
      activePurpose.value = model.purpose;
      app.showToast(`模型 ID 重复：${id}`, "error");
      return false;
    }
    seenIds.add(id);
    const missing = [
      !model.name.trim() ? "名称" : "",
      !model.shortName.trim() ? "简称" : "",
      !model.baseUrl.trim() ? "Base URL" : "",
      !model.model.trim() ? "模型名" : "",
    ].filter(Boolean);
    if (missing.length) {
      activePurpose.value = model.purpose;
      app.showToast(`${modelPurposeLabel(model.purpose)} ${id} 缺少：${missing.join("、")}`, "error");
      return false;
    }
  }
  return true;
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
    allGroups.value = data.groups;
    await app.loadGroups();
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
    allGroups.value = allGroups.value.map((item) => item.groupId === next.groupId ? next : item);
    await app.loadGroups();
    app.showToast(next.enabled === false ? "群已隐藏并禁用机器人" : "群已显示并启用机器人");
  } catch (error) {
    app.showToast((error as Error).message, "error");
  }
}

function addModel(): void {
  const model = modelTemplate();
  settings.models.push(model);
  if (model.purpose !== "reply") {
    settings.selectedModelIds[model.purpose] = model.id;
  }
  markModelsDirty();
  app.showToast("模型已添加，保存模型配置后才会生效。");
}

function removeModel(index: number, model: SystemModelConfig): void {
  settings.models.splice(index, 1);
  if (settings.selectedModelIds[model.purpose] === model.id) {
    delete settings.selectedModelIds[model.purpose];
  }
  const { [model.id]: _removed, ...remainingHealth } = modelHealthById.value;
  modelHealthById.value = remainingHealth;
  markModelsDirty();
}

function selectModel(model: SystemModelConfig): void {
  if (model.purpose === "reply") return;
  settings.selectedModelIds[model.purpose] = model.id;
  markModelsDirty();
}

function usageColumnLabel(): string {
  return activePurpose.value === "reply" ? "群可选" : "默认使用";
}

function isReplyModel(model: SystemModelConfig): boolean {
  return model.purpose === "reply";
}

async function testModel(model: SystemModelConfig): Promise<void> {
  testingModelId.value = model.id;
  try {
    const result = await api<ModelHealthStatus>(`/api/models/${encodeURIComponent(model.id)}/test`, {
      method: "POST",
      body: "{}",
    });
    applyModelStatuses([result]);
    app.showToast(result.ok ? `检测通过，延迟 ${result.latencyMs ?? 0}ms` : `检测不通过：${result.detail}`, result.ok ? "ok" : "error");
  } catch (error) {
    app.showToast(`检测不通过：${(error as Error).message}`, "error");
  } finally {
    testingModelId.value = "";
  }
}

async function testAllModels(): Promise<void> {
  testingAllModels.value = true;
  try {
    const result = await api<{ statuses: ModelHealthStatus[]; summary: { total: number; abnormal: number } }>("/api/models/test-all", {
      method: "POST",
      body: "{}",
    });
    applyModelStatuses(result.statuses);
    const passed = Math.max(0, result.summary.total - result.summary.abnormal);
    app.showToast(result.summary.abnormal > 0
      ? `模型检测完成：${passed}/${result.summary.total} 通过，${result.summary.abnormal} 个异常`
      : `模型检测全部通过：${result.summary.total} 个模型`,
    result.summary.abnormal > 0 ? "error" : "ok");
  } catch (error) {
    app.showToast(`全部模型检测失败：${(error as Error).message}`, "error");
  } finally {
    testingAllModels.value = false;
  }
}

function purposeHasFailure(purpose: SystemModelPurpose): boolean {
  return (modelPurposeHealth.value[purpose]?.failed ?? 0) > 0;
}

function modelHasFailure(model: SystemModelConfig): boolean {
  const health = modelHealthById.value[model.id];
  return model.enabled && Boolean(health && !health.ok && !health.skipped);
}

function modelHasPassed(model: SystemModelConfig): boolean {
  const health = modelHealthById.value[model.id];
  return model.enabled && Boolean(health?.ok && !health.skipped);
}

function modelHealthLabel(model: SystemModelConfig): string {
  const health = modelHealthById.value[model.id];
  if (!health) return "";
  if (health.skipped || !model.enabled) return "已停用，跳过检测";
  return health.ok ? `通过 ${health.latencyMs ?? 0}ms` : health.detail;
}

function modelIndex(model: SystemModelConfig): number {
  return settings.models.findIndex((item) => item === model);
}

function visibleGroups(): GroupConfig[] {
  const q = groupQuery.value.trim().toLowerCase();
  return allGroups.value.filter((group) => {
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
            <div class="policy-row policy-wide">
              <label class="policy-toggle"><span>自动生成昨日画像</span><input v-model="settings.dailyProfileReviewEnabled" type="checkbox" /></label>
              <label>昨日画像触发时间<input v-model="settings.dailyProfileReviewTime" class="input" type="time" /></label>
            </div>
            <div class="policy-row policy-wide">
              <label class="policy-toggle"><span>自动成员记忆去重</span><input v-model="settings.memoryDedupEnabled" type="checkbox" /></label>
              <label>记忆去重触发时间<input v-model="settings.memoryDedupTime" class="input" type="time" /></label>
              <label>去重模型单次判断超时（分钟）<input v-model.number="settings.memoryDedupSemanticTimeoutMinutes" class="input" type="number" min="1" max="60" /></label>
            </div>
            <div class="policy-row policy-wide memory-policy-row">
              <label>候选记忆阈值（%）<input v-model.number="settings.memoryCandidateConfidenceThreshold" class="input" type="number" min="0" max="100" step="1" /></label>
              <label>长期记忆阈值（%）<input v-model.number="settings.memoryAutoApproveConfidenceThreshold" class="input" type="number" min="0" max="100" step="1" /></label>
              <label class="policy-toggle"><span>无人值守候选入库</span><input v-model="settings.memoryUnattendedModeEnabled" type="checkbox" /></label>
            </div>
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
          <p>按模型分类维护配置。对话回复可启用多个模型供群配置选择，其它分类仍按默认模型使用；API Key 留空表示保留旧值。</p>
        </div>
        <div class="model-actions">
          <button class="ghost-btn" type="button" @click="addModel">新增 {{ activePurposeMeta.label }} 模型</button>
          <button class="ghost-btn" type="button" :disabled="testingAllModels" @click="testAllModels">{{ testingAllModels ? "检测中..." : "检测全部模型" }}</button>
          <button class="btn" type="button" :disabled="saving" @click="save">{{ saving ? "保存中..." : "保存模型配置" }}</button>
        </div>
      </div>
      <p v-if="modelSettingsDirty" class="dirty-hint">模型配置尚未保存，保存后才会进入群配置和 #模型 切换列表。</p>
      <div class="purpose-tabs">
        <button v-for="item in modelPurposeOptions" :key="item.value" type="button" :class="{ active: activePurpose === item.value, failed: purposeHasFailure(item.value) }" @click="activePurpose = item.value">
          <strong>{{ item.label }}</strong>
          <small>{{ item.detail }}</small>
        </button>
      </div>
      <div v-if="!activePurposeModels.length" class="empty compact">当前分类暂无模型。</div>
      <div v-else class="model-table">
        <div class="table-head">
          <span>{{ usageColumnLabel() }}</span>
          <span>模型类型</span>
          <span>模型信息</span>
          <span>Base URL</span>
          <span>模型名</span>
          <span>启用</span>
          <span>API Key</span>
          <span>操作</span>
        </div>
        <article v-for="model in activePurposeModels" :key="modelRowKey(model)" class="table-row" :class="{ disabled: !model.enabled, failed: modelHasFailure(model), passed: modelHasPassed(model) }">
          <div class="radio-cell">
            <span v-if="isReplyModel(model)" class="tag" :class="{ danger: !model.enabled || !model.hasApiKey }">
              {{ model.enabled && model.hasApiKey ? "可选择" : "不可用" }}
            </span>
            <input v-else type="radio" :checked="settings.selectedModelIds[model.purpose] === model.id" :disabled="!model.enabled" @change="selectModel(model)" />
          </div>
          <span class="purpose-cell">{{ modelPurposeLabel(model.purpose) }}</span>
          <div class="model-name">
            <input :value="model.id" class="input" placeholder="reply-pro" @input="updateModelId(model, $event)" />
            <input v-model="model.name" class="input" placeholder="名称" @input="markModelsDirty" />
            <input v-model="model.shortName" class="input" placeholder="简称" @input="markModelsDirty" />
          </div>
          <input v-model="model.baseUrl" class="input" placeholder="https://api.example.com/v1" @input="markModelsDirty" />
          <input v-model="model.model" class="input" placeholder="model-name" @input="markModelsDirty" />
          <label class="mini-check"><input v-model="model.enabled" type="checkbox" @change="markModelsDirty" /> 启用</label>
          <input v-model="model.apiKey" class="input" type="password" :placeholder="model.hasApiKey ? '已保存，留空保留' : '未设置'" @input="markModelsDirty" />
          <div class="row-actions">
            <button class="link-btn" type="button" :disabled="testingModelId === model.id" @click="testModel(model)">{{ testingModelId === model.id ? "检测中" : "检测连接" }}</button>
            <button class="link-btn danger" type="button" @click="removeModel(modelIndex(model), model)">删除</button>
            <small v-if="modelHealthById[model.id]" class="model-health-text" :class="{ failed: modelHasFailure(model), skipped: modelHealthById[model.id]?.skipped || !model.enabled }">{{ modelHealthLabel(model) }}</small>
          </div>
        </article>
      </div>
    </section>
  </div>
</template>

<style scoped>
.toolbar,
.switch-row,
.model-actions,
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
.policy-toggle {
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
  display: grid;
  align-items: end;
}

.policy-wide {
  grid-column: 1 / -1;
  grid-template-columns: minmax(220px, 1fr) minmax(160px, 0.7fr);
  align-items: center;
  gap: 12px;
}

.memory-policy-row {
  grid-template-columns: repeat(3, minmax(150px, 1fr));
}

.policy-toggle {
  display: flex !important;
  align-items: center;
  min-height: 40px;
}

.policy-toggle input[type="checkbox"] {
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

.purpose-tabs button.failed {
  border-color: color-mix(in oklch, var(--danger) 58%, var(--line));
  background: color-mix(in oklch, var(--danger-soft) 74%, var(--surface));
  color: var(--danger);
}

.purpose-tabs button.active.failed {
  box-shadow: 0 0 0 2px color-mix(in oklch, var(--danger) 18%, transparent);
}

.purpose-tabs small {
  color: var(--muted);
  line-height: 1.45;
}

.purpose-tabs button.failed small {
  color: color-mix(in oklch, var(--danger) 72%, var(--muted));
}

.model-actions {
  flex-wrap: wrap;
  justify-content: flex-end;
}

.dirty-hint {
  margin: 0 0 12px;
  border: 1px solid rgba(217, 119, 6, 0.28);
  border-radius: var(--radius-sm);
  background: rgba(245, 158, 11, 0.12);
  color: #92400e;
  padding: 10px 12px;
  font-weight: 800;
}

.model-table {
  overflow: auto;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
}

.table-head,
.table-row {
  display: grid;
  grid-template-columns: 64px minmax(130px, 0.55fr) minmax(180px, 0.9fr) minmax(190px, 1fr) minmax(130px, 0.7fr) 78px minmax(150px, 0.75fr) 156px;
  gap: 12px;
  align-items: center;
  min-width: 1260px;
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

.table-row.disabled {
  background: color-mix(in oklch, var(--surface-soft) 42%, var(--surface-raised));
  color: color-mix(in oklch, var(--muted) 78%, var(--text));
}

.table-row.failed {
  border-color: color-mix(in oklch, var(--danger) 42%, var(--line));
  background: color-mix(in oklch, var(--danger-soft) 46%, var(--surface-raised));
}

.table-row.passed {
  background: color-mix(in oklch, var(--accent-soft) 28%, var(--surface-raised));
}

.table-row:last-child {
  border-bottom: 0;
}

.model-name {
  display: grid;
  gap: 8px;
}

.purpose-cell {
  color: var(--muted);
  font-size: 13px;
  font-weight: 800;
  line-height: 1.4;
}

.radio-cell,
.mini-check {
  display: flex;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
}

.row-actions {
  display: grid;
  grid-template-columns: auto auto;
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

.model-health-text {
  grid-column: 1 / -1;
  max-width: 140px;
  overflow: hidden;
  color: var(--muted);
  font-size: 12px;
  font-weight: 800;
  text-overflow: ellipsis;
}

.model-health-text.failed {
  color: var(--danger);
}

.model-health-text.skipped {
  color: var(--muted);
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
