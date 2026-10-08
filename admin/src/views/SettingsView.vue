<script setup lang="ts">
import { computed, onMounted, reactive, shallowRef } from "vue";
import { useRoute, useRouter } from "vue-router";

import AdminDialog from "../components/AdminDialog.vue";
import { confirmAction } from "../composables/useConfirm";
import { useUnsavedChanges } from "../composables/useUnsavedChanges";
import { api, type GroupConfig, type ModelHealthStatus, type SystemModelConfig, type SystemModelPurpose, type SystemSettings } from "../services/api";
import { useAppStore } from "../stores/app";

const app = useAppStore();
const route = useRoute();
const router = useRouter();
const activeTab = computed({ get: () => route.query.tab === "runtime" ? "runtime" : "models", set: (tab) => { void router.replace({ query: { ...route.query, tab } }); } });
const revision = shallowRef("");
const originalSettings = shallowRef<Record<string, unknown>>({});
const loadError = shallowRef("");
const modelQuery = shallowRef(typeof route.query.q === "string" ? route.query.q : "");
const modelStatus = computed({ get: () => route.query.status === "enabled" || route.query.status === "disabled" ? route.query.status : "all", set: (status) => { void router.replace({ query: { ...route.query, status: status === "all" ? undefined : status } }); } });
const editingModel = shallowRef<SystemModelConfig | null>(null);
const loading = shallowRef(false);
const saving = shallowRef(false);
const testingModelId = shallowRef("");
const testingAllModels = shallowRef(false);
const groupQuery = shallowRef("");
const allGroups = shallowRef<GroupConfig[]>([]);
const activePurpose = computed<SystemModelPurpose>({
  get: () => ["reply", "image", "summary", "knowledge", "custom"].includes(String(route.query.purpose)) ? route.query.purpose as SystemModelPurpose : "reply",
  set: (purpose) => { void router.replace({ query: { ...route.query, purpose } }); },
});
const modelSettingsDirty = shallowRef(false);
const modelHealthById = shallowRef<Record<string, ModelHealthStatus>>({});
const modelRowKeys = new WeakMap<SystemModelConfig, string>();
let modelRowKeySeed = 0;
const settings = reactive<SystemSettings>({
  onlineLookupEnabled: false,
  tokenCostControl: {
    dailyReportAiQuipEnabled: false,
    chatSummaryAiEnabled: false,
    scheduledReminderAiRewriteEnabled: false,
    modelHealthAutoProbeEnabled: false,
  },
  defaultTriggerKeywords: [{ keyword: "乘风", enabled: true }],
  models: [],
  selectedModelIds: {},
  commands: [],
  updatedAt: "",
});
const editableFields = ["onlineLookupEnabled", "tokenCostControl", "defaultTriggerKeywords", "models", "selectedModelIds"] as const;
function settingValues(): Record<string, unknown> { return Object.fromEntries(editableFields.map((key) => [key, settings[key]])); }
const dirty = computed(() => Boolean(revision.value) && JSON.stringify(settingValues()) !== JSON.stringify(originalSettings.value));
useUnsavedChanges(dirty);
const filteredModels = computed(() => activePurposeModels.value.filter((model) => {
  const q = typeof route.query.q === "string" ? route.query.q.toLowerCase().trim() : "";
  return (!q || `${model.name} ${model.shortName} ${model.id} ${model.model} ${model.baseUrl}`.toLowerCase().includes(q)) && (modelStatus.value === "all" || model.enabled === (modelStatus.value === "enabled"));
}));
function setModelQuery(): void { void router.replace({ query: { ...route.query, q: modelQuery.value || undefined } }); }
function rememberSettings(next: SystemSettings & { revision: string }): void {
  Object.assign(settings, next);
  revision.value = next.revision;
  originalSettings.value = JSON.parse(JSON.stringify(settingValues()));
  modelSettingsDirty.value = false;
}

const modelPurposeOptions: Array<{ value: SystemModelPurpose; label: string; detail: string }> = [
  { value: "reply", label: "对话回复", detail: "普通群聊回复、实时对话和群内 #模型 切换列表" },
  { value: "image", label: "图片生成", detail: "#画图 使用；主模型失败时按列表顺序切换备用" },
  { value: "summary", label: "总结", detail: "已有总结模型配置" },
  { value: "knowledge", label: "知识", detail: "已有知识模型配置" },
  { value: "custom", label: "自定义", detail: "已有自定义模型配置" },
];
const visiblePurposeOptions = computed(() => modelPurposeOptions.filter((item) => item.value === "reply" || item.value === "image" || item.value === activePurpose.value || settings.models.some((model) => model.purpose === item.value)));

const modelIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/;
const modelPurposeDefaultNames: Record<SystemModelPurpose, string> = {
  reply: "Reply Model",
  summary: "Summary Model",
  knowledge: "Knowledge Model",
  image: "Image Model",
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
    apiProtocol: "openai",
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

function applyLowTokenPreset(): void {
  settings.tokenCostControl = {
    dailyReportAiQuipEnabled: false,
    chatSummaryAiEnabled: false,
    scheduledReminderAiRewriteEnabled: false,
    modelHealthAutoProbeEnabled: false,
  };
  app.showToast("已应用低 Token 配置，保存后生效");
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
  loadError.value = "";
  try {
    const [next, groupData] = await Promise.all([
      api<SystemSettings & { revision: string }>("/api/system-settings"),
      api<{ groups: GroupConfig[] }>("/api/groups?includeDisabled=1"),
    ]);
    rememberSettings(next);
    allGroups.value = groupData.groups;
    const history = await api<{ models: ModelHealthStatus[] }>("/api/model-health-history");
    applyModelStatuses(history.models);
  } catch (error) {
    loadError.value = (error as Error).message || "系统设置加载失败";
    app.showToast(loadError.value, "error");
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
    const patch = Object.fromEntries(Object.entries(settingValues()).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(originalSettings.value[key])));
    if (!Object.keys(patch).length) { app.showToast("配置没有变化"); return; }
    const next = await api<SystemSettings & { revision: string }>("/api/system-settings", {
      method: "PATCH",
      body: JSON.stringify({ expectedRevision: revision.value, patch }),
    });
    rememberSettings(next);
    editingModel.value = null;
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
    const current = await api<GroupConfig & { revision: string }>(`/api/groups/${encodeURIComponent(group.groupId)}/config`);
    const next = await api<GroupConfig>(`/api/groups/${encodeURIComponent(group.groupId)}/config`, {
      method: "PATCH",
      body: JSON.stringify({ expectedRevision: current.revision, patch: { enabled: group.enabled !== false } }),
    });
    Object.assign(group, next);
    allGroups.value = allGroups.value.map((item) => item.groupId === next.groupId ? next : item);
    await app.loadGroups();
    app.showToast(next.enabled === false ? "群已隐藏并禁用机器人" : "群已显示并启用机器人");
  } catch (error) {
    group.enabled = group.enabled === false;
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
  editingModel.value = model;
  app.showToast("模型已添加，保存模型配置后才会生效。");
}

async function removeModel(index: number, model: SystemModelConfig): Promise<void> {
  if (!await confirmAction({ title: "删除模型配置", message: `删除「${model.name || model.id}」后需保存才能生效。`, confirmText: "删除配置", danger: true })) return;
  settings.models.splice(index, 1);
  if (settings.selectedModelIds[model.purpose] === model.id) {
    delete settings.selectedModelIds[model.purpose];
  }
  const { [model.id]: _removed, ...remainingHealth } = modelHealthById.value;
  modelHealthById.value = remainingHealth;
  markModelsDirty();
  if (editingModel.value === model) editingModel.value = null;
}

function moveImageModel(model: SystemModelConfig, direction: -1 | 1): void {
  if (model.purpose !== "image") return;
  const imageModels = settings.models.filter((item) => item.purpose === "image");
  const currentIndex = imageModels.indexOf(model);
  const target = imageModels[currentIndex + direction];
  if (!target) return;
  const sourceIndex = settings.models.indexOf(model);
  const targetIndex = settings.models.indexOf(target);
  settings.models.splice(sourceIndex, 1, target);
  settings.models.splice(targetIndex, 1, model);
  markModelsDirty();
}

function canMoveImageModel(model: SystemModelConfig, direction: -1 | 1): boolean {
  if (model.purpose !== "image") return false;
  const models = settings.models.filter((item) => item.purpose === "image");
  const index = models.indexOf(model);
  return index >= 0 && index + direction >= 0 && index + direction < models.length;
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
  if (modelSettingsDirty.value || dirty.value && JSON.stringify(settings.models) !== JSON.stringify(originalSettings.value.models)) {
    app.showToast("请先保存模型配置，再检测连接。", "error"); return;
  }
  if (model.purpose === "image" && !await confirmAction({ title: "检测图片模型", message: "将实际生成一张低质量测试图片，上游可能收取费用。", confirmText: "开始检测" })) return;
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
  if (dirty.value && JSON.stringify(settings.models) !== JSON.stringify(originalSettings.value.models)) { app.showToast("请先保存模型配置，再检测连接。", "error"); return; }
  if (settings.models.some(model => model.enabled && model.purpose === "image") && !await confirmAction({ title: "检测全部模型", message: "检测包含已启用的图片模型，将生成测试图片，上游可能收取费用。", confirmText: "开始检测" })) return;
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
  <section class="page system-page">
    <header class="page-heading"><div><h1>{{ activeTab === 'models' ? '模型配置' : '运行策略' }}</h1><p>{{ activeTab === 'models' ? '维护模型连接、使用范围和图片备用顺序。' : '管理自动查询、Token 控制与群启用状态。' }}</p></div><div class="heading-actions"><span v-if="dirty" class="dirty-hint">有未保存的更改</span><button class="btn" type="button" :disabled="loading || saving || !dirty" @click="save">{{ saving ? '保存中…' : '保存配置' }}</button></div></header>
    <div v-if="loading" class="panel empty" aria-live="polite">正在加载系统配置…</div>
    <div v-else-if="loadError" class="panel empty" role="alert"><p>{{ loadError }}</p><button class="ghost-btn" type="button" @click="load">重试</button></div>
    <template v-else-if="activeTab === 'runtime'">
      <div class="runtime-layout">
        <section class="panel policy-card"><div class="section-intro"><h2>Token 消耗控制</h2><p>根据运营需要决定哪些辅助功能调用 AI。</p></div><button class="ghost-btn preset-btn" type="button" @click="applyLowTokenPreset">应用低 Token 配置</button><div class="policy-list"><label class="policy-toggle"><span><strong>日报 / 倒计时 AI 文案</strong><small>生成日报和节日倒计时的补充文案。</small></span><input v-model="settings.tokenCostControl.dailyReportAiQuipEnabled" type="checkbox" /></label><label class="policy-toggle"><span><strong>群聊总结调用 AI</strong><small>允许使用模型总结群聊内容。</small></span><input v-model="settings.tokenCostControl.chatSummaryAiEnabled" type="checkbox" /></label><label class="policy-toggle"><span><strong>定时提醒 AI 润色</strong><small>使用模型改写定时提醒的表达。</small></span><input v-model="settings.tokenCostControl.scheduledReminderAiRewriteEnabled" type="checkbox" /></label><label class="policy-toggle"><span><strong>自动检测模型健康</strong><small>定期检测模型可用性，检测也会产生模型调用。</small></span><input v-model="settings.tokenCostControl.modelHealthAutoProbeEnabled" type="checkbox" /></label></div></section>
        <section class="panel policy-card"><div class="section-intro"><h2>自动查询与默认触发词</h2><p>这些设置作用于系统运行策略。</p></div><label class="policy-toggle"><span><strong>自动查询实时资料</strong><small>全局允许模型查询网络中的实时资料。</small></span><input v-model="settings.onlineLookupEnabled" type="checkbox" /></label><div class="section-head keywords-head"><h3>默认触发词</h3><button class="ghost-btn" type="button" @click="settings.defaultTriggerKeywords.push({ keyword: '', enabled: true })">＋ 新增</button></div><div v-for="(item,index) in settings.defaultTriggerKeywords" :key="index" class="keyword-row"><input v-model="item.keyword" class="input" :aria-label="'默认触发词 ' + (index + 1)" placeholder="输入触发词" /><label><input v-model="item.enabled" type="checkbox" /> 启用</label><button class="link-btn danger" type="button" @click="settings.defaultTriggerKeywords.splice(index,1)">删除</button></div></section>
      </div>
      <section class="panel groups-panel"><div class="section-head"><div class="section-intro"><h2>群启用状态</h2><p>群开关立即保存。停用的群可在此重新启用。</p></div><button class="ghost-btn" type="button" @click="syncGroups">同步群聊</button></div><input v-model="groupQuery" class="input group-search" placeholder="搜索群名或群号" aria-label="搜索群聊" /><div v-if="!visibleGroups().length" class="empty compact">没有匹配的群聊。</div><div v-else class="group-list"><label v-for="group in visibleGroups()" :key="group.groupId" class="group-row"><span><strong>{{ group.groupName || '群 ' + group.groupId }}</strong><small>{{ group.groupId }}</small></span><input v-model="group.enabled" type="checkbox" @change="toggleGroup(group)" /></label></div></section>
    </template>
    <section v-else class="panel models-panel">
      <div class="purpose-tabs" aria-label="模型用途"><button v-for="item in visiblePurposeOptions" :key="item.value" type="button" :class="{ active: activePurpose === item.value, failed: purposeHasFailure(item.value) }" :aria-current="activePurpose === item.value ? 'page' : undefined" @click="activePurpose = item.value">{{ item.label }}<span>{{ settings.models.filter(model => model.purpose === item.value).length }}</span></button></div>
      <p class="model-purpose-description">{{ activePurposeMeta.detail }}。</p>
      <div class="model-toolbar"><button class="btn" type="button" @click="addModel">＋ 新增模型</button><div class="model-filters"><form @submit.prevent="setModelQuery"><input v-model="modelQuery" class="input" aria-label="搜索模型" placeholder="搜索名称、标识或模型名…" @change="setModelQuery" /></form><select v-model="modelStatus" class="select" aria-label="模型启用状态"><option value="all">全部状态</option><option value="enabled">已启用</option><option value="disabled">已停用</option></select><button class="ghost-btn" type="button" :disabled="testingAllModels" @click="testAllModels">{{ testingAllModels ? '检测中…' : '检测全部' }}</button></div></div>
      <div v-if="!filteredModels.length" class="empty compact">{{ activePurposeModels.length ? '没有匹配的模型。' : '此用途暂无模型，新增配置后保存即可使用。' }}</div>
      <div v-else class="model-table"><table><thead><tr><th>模型名称 / 标识</th><th>上游模型 / 连接</th><th>协议</th><th>{{ usageColumnLabel() }}</th><th>状态</th><th class="actions-cell">操作</th></tr></thead><tbody><tr v-for="model in filteredModels" :key="modelRowKey(model)" :class="{ disabled: !model.enabled }"><td><strong class="table-model-name">{{ model.name || '未命名模型' }}</strong><small class="muted">{{ model.shortName }} · {{ model.id }}</small></td><td><span>{{ model.model || '尚未设置' }}</span><small class="endpoint" :title="model.baseUrl">{{ model.baseUrl || '尚未设置连接' }}</small></td><td>{{ model.apiProtocol === 'anthropic' ? 'Anthropic' : 'OpenAI' }}</td><td><span v-if="isReplyModel(model)" class="tag" :class="{ danger: !model.enabled || !model.hasApiKey }">{{ model.enabled && model.hasApiKey ? '群可选' : '不可用' }}</span><label v-else class="default-control"><input type="radio" name="default-model" :checked="settings.selectedModelIds[model.purpose] === model.id" :disabled="!model.enabled" @change="selectModel(model)" /> 默认</label></td><td><span class="status-dot" :class="{ on: model.enabled }">{{ model.enabled ? '已启用' : '已停用' }}</span><small v-if="modelHealthById[model.id]" class="health-text" :class="{ failed: modelHasFailure(model) }" :title="modelHealthLabel(model)">{{ modelHealthLabel(model) }}</small></td><td class="actions-cell"><div class="row-actions"><button class="link-btn" type="button" @click="editingModel = model">编辑</button><button class="link-btn" type="button" :disabled="testingModelId === model.id" @click="testModel(model)">{{ testingModelId === model.id ? '检测中' : '检测' }}</button><template v-if="model.purpose === 'image'"><button class="link-btn sort-button" type="button" :aria-label="'提高 ' + model.name + ' 的备用顺序'" :disabled="!canMoveImageModel(model,-1)" @click="moveImageModel(model,-1)">↑</button><button class="link-btn sort-button" type="button" :aria-label="'降低 ' + model.name + ' 的备用顺序'" :disabled="!canMoveImageModel(model,1)" @click="moveImageModel(model,1)">↓</button></template></div></td></tr></tbody></table></div>
      <footer class="model-list-footer"><span>共 {{ filteredModels.length }} 个模型</span><span>API Key 使用掩码显示，留空保留已保存的值。</span></footer>
    </section>
    <div v-if="!loading && !loadError" class="save-footer"><span class="muted">{{ dirty ? '更改尚未保存' : '配置已同步' }}</span><button class="btn" type="button" :disabled="saving || !dirty" @click="save">{{ saving ? '保存中…' : '保存配置' }}</button></div>
    <AdminDialog v-if="editingModel" title="编辑模型" drawer description="修改暂存于当前页面，保存配置后生效。" :busy="saving" @close="editingModel = null"><fieldset class="model-edit-fields" :disabled="saving"><label>模型名称<input v-model="editingModel.name" class="input" placeholder="便于辨认的名称" /></label><div class="edit-field-pair"><label>简称<input v-model="editingModel.shortName" class="input" placeholder="简称" /></label><label>模型标识<input :value="editingModel.id" class="input" placeholder="reply-model" @input="updateModelId(editingModel, $event)" /></label></div><label>Base URL<input v-model="editingModel.baseUrl" class="input" placeholder="https://api.example.com/v1" /><small>服务商提供的 API 地址。</small></label><label>上游模型名<input v-model="editingModel.model" class="input" placeholder="model-name" /></label><label>API 协议<select v-model="editingModel.apiProtocol" class="select" :disabled="editingModel.purpose === 'image'"><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option></select></label><label>API Key<input v-model="editingModel.apiKey" class="input" type="password" autocomplete="new-password" :placeholder="editingModel.hasApiKey ? '已保存，留空保留' : '尚未设置'" /><small>{{ editingModel.hasApiKey ? '服务器已有密钥，此处不会显示原值。' : '填写服务商提供的密钥。' }}</small></label><label class="policy-toggle"><span><strong>启用模型</strong><small>停用后无法选择或调用该模型。</small></span><input v-model="editingModel.enabled" type="checkbox" /></label><label v-if="!isReplyModel(editingModel)" class="default-control"><input type="radio" name="drawer-default-model" :checked="settings.selectedModelIds[editingModel.purpose] === editingModel.id" :disabled="!editingModel.enabled" @change="selectModel(editingModel)" /> 设为此用途的默认模型</label><p v-if="isReplyModel(editingModel)" class="muted">启用且配置密钥的对话模型可在群配置中选择。</p><button class="ghost-btn danger delete-model" type="button" @click="removeModel(modelIndex(editingModel), editingModel)">删除模型配置</button></fieldset><template #footer><button class="ghost-btn" type="button" :disabled="saving" @click="editingModel = null">完成编辑</button><button class="btn" type="button" :disabled="saving || !dirty" @click="save">{{ saving ? '保存中…' : '保存配置' }}</button></template></AdminDialog>
  </section>
</template>

<style scoped>
.page-heading { display:flex; justify-content:space-between; gap:20px; align-items:flex-start; }
.page-heading h1 { margin:0; font-size:28px; letter-spacing:-.6px; }
.page-heading p,.section-intro p { margin:7px 0 0; color:var(--muted); line-height:1.7; }
.heading-actions { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
.dirty-hint { border:1px solid var(--line); border-radius:6px; padding:9px 12px; color:var(--warning); background:var(--warning-soft); font-size:12px; }
.section-intro h2 { margin:0; font-size:16px; }
.runtime-layout { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:20px; }
.policy-card { padding:24px; display:grid; align-content:start; gap:18px; }
.policy-toggle { display:flex; align-items:center; justify-content:space-between; padding:16px 0; gap:20px; border-bottom:1px solid var(--line); }
.policy-toggle strong { display:block; font-weight:600; }
.policy-toggle small { display:block; color:var(--muted); line-height:1.65; margin-top:5px; font-size:12px; }
.preset-btn { justify-self:start; }
.keyword-row { display:grid; grid-template-columns:minmax(0,1fr) 60px 35px; align-items:center; gap:12px; }
.keyword-row label { display:flex; gap:6px; align-items:center; font-size:12px; }
.keywords-head h3 { margin:0; font-size:14px; }
.groups-panel { padding:24px; }
.group-search { max-width:340px; margin:18px 0; }
.group-list { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); column-gap:24px; }
.group-row { padding:15px 0; display:flex; justify-content:space-between; gap:12px; align-items:center; border-bottom:1px solid var(--line); }
.group-row strong { display:block; font-size:13px; font-weight:550; }
.group-row small { display:block; margin-top:4px; color:var(--muted); font-size:12px; }
.models-panel { padding:0; overflow:hidden; }
.purpose-tabs { display:flex; gap:16px; padding:0 24px; border-bottom:1px solid var(--line); overflow:auto; }
.purpose-tabs button { display:flex; align-items:center; gap:8px; padding:16px 8px 14px; border:0; border-bottom:2px solid transparent; border-radius:0; background:transparent; color:var(--muted); white-space:nowrap; }
.purpose-tabs button.active { border-bottom-color:var(--accent); color:var(--accent-strong); font-weight:650; }
.purpose-tabs button.failed { color:var(--danger); }
.purpose-tabs span { background:var(--surface-soft); color:var(--muted); font-size:11px; padding:2px 6px; border-radius:5px; }
.model-purpose-description { margin:18px 24px 0; font-size:12px; color:var(--muted); line-height:1.6; }
.model-toolbar { display:flex; align-items:center; justify-content:space-between; gap:15px; padding:20px 24px; }
.model-filters { display:flex; align-items:center; gap:10px; }
.model-filters form { width:250px; }
.model-filters .select { width:115px; }
.model-table { overflow:auto; padding:0 24px; }
.model-table table { width:100%; min-width:860px; border-collapse:collapse; font-size:12px; }
.model-table th { text-align:left; padding:13px 14px; color:var(--muted); background:var(--surface-soft); border-bottom:1px solid var(--line); font-weight:550; }
.model-table td { border-bottom:1px solid var(--line); padding:17px 14px; }
.model-table tbody tr:hover { background:var(--surface-soft); }
.model-table tr.disabled { color:var(--muted); }
.model-table small { display:block; margin-top:5px; font-size:11px; }
.table-model-name { display:block; font-size:13px; font-weight:600; }
.endpoint { overflow:hidden; text-overflow:ellipsis; max-width:210px; white-space:nowrap; color:var(--muted); }
.default-control { display:flex; align-items:center; gap:7px; font-size:12px; white-space:nowrap; }
.status-dot { display:flex; align-items:center; gap:6px; white-space:nowrap; }
.status-dot::before { content:''; width:6px; height:6px; border-radius:50%; background:var(--muted); }
.status-dot.on::before { background:var(--accent); }
.health-text { color:var(--muted); max-width:100px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.health-text.failed { color:var(--danger); }
.row-actions { display:flex; gap:12px; flex-wrap:wrap; align-items:center; }
.link-btn { padding:0; border:0; background:transparent; color:var(--accent-strong); font-size:12px; white-space:nowrap; }
.danger { color:var(--danger); }
.sort-button { font-size:16px; }
.actions-cell { min-width:110px; }
.model-list-footer { display:flex; gap:12px; justify-content:space-between; padding:20px 24px; color:var(--muted); font-size:12px; }
.save-footer { display:flex; justify-content:space-between; align-items:center; gap:15px; font-size:12px; }
.model-edit-fields { display:grid; gap:22px; padding:0; border:0; min-width:0; }
.model-edit-fields > label,.edit-field-pair label { display:grid; gap:8px; font-size:13px; font-weight:550; }
.model-edit-fields small { color:var(--muted); font-size:12px; font-weight:400; line-height:1.6; }
.edit-field-pair { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
.model-edit-fields .policy-toggle { display:flex; }
.model-edit-fields .default-control { display:flex; }
.delete-model { justify-self:start; }
.compact { min-height:120px; }
@media(max-width:1100px) { .model-toolbar { flex-wrap:wrap; } .model-filters { flex:1; justify-content:flex-end; } .model-filters form { flex:1; max-width:320px; } .group-list { grid-template-columns:repeat(2,minmax(0,1fr)); } }
@media(max-width:800px) { .runtime-layout { grid-template-columns:1fr; } .page-heading { flex-direction:column; gap:14px; } .heading-actions { justify-content:space-between; width:100%; } }
@media(max-width:600px) { .page-heading h1 { font-size:24px; } .policy-card,.groups-panel { padding:18px; } .purpose-tabs { gap:8px; padding:0 16px; } .model-toolbar { padding:18px 16px; align-items:stretch; } .model-filters { flex-wrap:wrap; gap:8px; width:100%; justify-content:space-between; } .model-filters form { flex:1 1 100%; max-width:none; } .model-filters .select { flex:1; } .model-table { padding:0 16px; } .group-list { grid-template-columns:1fr; } .model-list-footer { padding:18px 16px; flex-direction:column; } .keyword-row { gap:8px; } .edit-field-pair { grid-template-columns:1fr; } }
</style>
