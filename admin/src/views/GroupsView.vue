<script setup lang="ts">
import { computed, onMounted, reactive, shallowRef, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import AppIcon from "../components/AppIcon.vue";
import DateRulePicker from "../components/DateRulePicker.vue";
import MultiTagSelect from "../components/MultiTagSelect.vue";
import { useRefreshEvents } from "../composables/useRefreshEvents";
import { confirmAction } from "../composables/useConfirm";
import { useUnsavedChanges } from "../composables/useUnsavedChanges";
import { api, queryString, type GroupConfig, type MemberProfile, type ModelOption, type Pagination, type ScheduleDateRule, type SchedulePreviewDay, type ScheduledReminderTask } from "../services/api";
import { useAppStore } from "../stores/app";
import { formatDateTime } from "../utils/format";

const app = useAppStore();
const route = useRoute();
const router = useRouter();
const loading = shallowRef(false);
const saving = shallowRef(false);
const remindersLoading = shallowRef(false);
const reminders = shallowRef<ScheduledReminderTask[]>([]);
const schedulePreview = shallowRef<SchedulePreviewDay[]>([]);
const remindersError = shallowRef("");
const schedulePreviewError = shallowRef("");
const replyModels = shallowRef<ModelOption[]>([]);
const memberOptions = shallowRef<MemberProfile[]>([]);
const editingReminderId = shallowRef<string | null>(null);
type ConfigTab = "reply" | "capabilities" | "schedule" | "permissions";
const configTabs: Array<{ value: ConfigTab; label: string }> = [
  { value: "reply", label: "回复" },
  { value: "capabilities", label: "能力" },
  { value: "permissions", label: "权限" },
  { value: "schedule", label: "排程" },
];
const activeTab = computed<ConfigTab>({
  get: () => configTabs.some((tab) => tab.value === route.query.tab) ? route.query.tab as ConfigTab : "reply",
  set: (tab) => { void router.replace({ query: { ...route.query, tab } }); },
});
const revision = shallowRef("");
const originalConfig = shallowRef<Record<string, unknown>>({});
const loadError = shallowRef("");
let loadSerial = 0;
const reminderForm = reactive({
  intervalMinutes: 60,
  topic: "",
  executionStartTime: "09:00",
  executionEndTime: "18:00",
  executionIntervalMinutes: 60,
  dateRule: "all" as ScheduleDateRule,
  weekdays: [] as number[],
  enabled: true,
});
const form = reactive<GroupConfig>(defaultGroupConfig());
const editableFields = ["enabled", "replyModelMode", "participationMode", "liveChatDelaySeconds", "liveChatUserIds", "roastModeUserIds", "blacklistedUserIds", "botMuted", "opsAlertsEnabled", "triggerKeywords", "onlineLookupEnabled", "visionEnabled", "ambientGroupContextEnabled", "htmlPreviewEnabled", "dailyReportEnabled", "dailyReportTime", "dailyReportDateRule", "dailyReportWeekdays", "dailyReportTopUserCount", "holidayCountdownEnabled", "holidayCountdownTime", "holidayCountdownDateRule", "holidayCountdownWeekdays", "scheduledRemindersEnabled"] as const;
function configValues(): Record<string, unknown> {
  return Object.fromEntries(editableFields.map((key) => [key, key === "triggerKeywords" ? (form.triggerKeywords || []).filter((item) => item.keyword.trim()).map((item) => ({ ...item, keyword: item.keyword.trim() })) : form[key]]));
}
const dirty = computed(() => Boolean(revision.value) && JSON.stringify(configValues()) !== JSON.stringify(originalConfig.value));
const reminderBaseline = shallowRef(JSON.stringify(reminderForm));
const reminderDirty = computed(() => JSON.stringify(reminderForm) !== reminderBaseline.value);
useUnsavedChanges(computed(() => dirty.value || reminderDirty.value));
const capabilities = [
  { key: "onlineLookupEnabled", label: "自动查询实时资料", detail: "回答需要最新资料的问题时查询网络。" },
  { key: "visionEnabled", label: "图片理解", detail: "理解群聊中提供的图片。" },
  { key: "ambientGroupContextEnabled", label: "短时群聊语境", detail: "使用近期群聊上下文组织回复。" },
  { key: "htmlPreviewEnabled", label: "静态网页预览", detail: "允许生成并分享网页预览。" },
  { key: "opsAlertsEnabled", label: "运维告警", detail: "向当前群发送运行告警。" },
] as const;

const currentReplyModelLabel = computed(() => replyModels.value.find((model) => model.id === form.replyModelMode)?.label || form.replyModelMode || "-");
const hasReplyModels = computed(() => replyModels.value.length > 0);
const memberSelectOptions = computed(() => memberOptions.value.map((member) => ({
  value: member.userId,
  label: `${member.displayName} / ${member.userId}`,
  hint: member.note || member.role || undefined,
})));
const scheduleTimezone = computed(() => "Asia/Shanghai");
const scheduleEffectText = computed(() => [
  form.dailyReportEnabled ? `日报 ${form.dailyReportTime}` : undefined,
  form.holidayCountdownEnabled ? `节日倒计时 ${form.holidayCountdownTime}` : undefined,
  form.scheduledRemindersEnabled ? "定时提醒已启用" : undefined,
  `时区 ${scheduleTimezone.value}`,
].filter(Boolean).join(" · "));
const readonly = computed(() => !app.sessionLoaded);
const reminderSubmitLabel = computed(() => editingReminderId.value ? "保存任务" : "添加任务");

function defaultGroupConfig(): GroupConfig {
  return {
    groupId: "",
    enabled: true,
    currentSkillId: "",
    replyModelMode: "gpt",
    participationMode: "mentions_only",
    allowedSkillIds: [],
    switcherUserIds: [],
    liveChatUserIds: [],
    roastModeUserIds: [],
    liveChatDelaySeconds: 30,
    dailyReportEnabled: false,
    dailyReportTime: "10:00",
    dailyReportDateRule: "all",
    dailyReportWeekdays: [],
    dailyReportTopUserCount: 3,
    holidayCountdownEnabled: false,
    holidayCountdownTime: "09:00",
    holidayCountdownDateRule: "all",
    holidayCountdownWeekdays: [],
    botMuted: false,
    scheduledRemindersEnabled: false,
    blacklistedUserIds: [],
    opsAlertsEnabled: false,
    triggerKeywords: [{ keyword: "乘风", enabled: true }],
    onlineLookupEnabled: false,
    visionEnabled: true,
    ambientGroupContextEnabled: true,
    htmlPreviewEnabled: true,
  };
}

function resetForm(data: GroupConfig): void {
  Object.assign(form, defaultGroupConfig(), data, {
    allowedSkillIds: [...(data.allowedSkillIds || [])],
    switcherUserIds: [...(data.switcherUserIds || [])],
    liveChatUserIds: [...(data.liveChatUserIds || [])],
    roastModeUserIds: [...(data.roastModeUserIds || [])],
    blacklistedUserIds: [...(data.blacklistedUserIds || [])],
    triggerKeywords: (data.triggerKeywords || []).map((item) => ({ ...item })),
    dailyReportDateRule: data.dailyReportDateRule || "all",
    dailyReportWeekdays: [...(data.dailyReportWeekdays || [])],
    holidayCountdownDateRule: data.holidayCountdownDateRule || "all",
    holidayCountdownWeekdays: [...(data.holidayCountdownWeekdays || [])],
  });
  reconcileReplyModelSelection();
  originalConfig.value = JSON.parse(JSON.stringify(configValues()));
}

async function load(): Promise<void> {
  if (!app.groupId) return;
  const groupId = app.groupId;
  const serial = ++loadSerial;
  loading.value = true;
  loadError.value = "";
  try {
    const [data] = await Promise.all([
      api<GroupConfig & { revision: string }>(`/api/groups/${encodeURIComponent(groupId)}/config`),
      loadModelOptions(),
      loadMemberOptions(groupId),
    ]);
    if (serial !== loadSerial || groupId !== app.groupId) return;
    revision.value = data.revision;
    resetForm(data);
    resetReminderForm();
    await Promise.all([
      loadReminders(groupId, serial).then(() => { remindersError.value = ""; }).catch((error) => {
        remindersError.value = (error as Error).message || "定时任务暂不可用";
      }),
      loadSchedulePreview(groupId, serial).then(() => { schedulePreviewError.value = ""; }).catch((error) => {
        schedulePreviewError.value = (error as Error).message || "执行预览暂不可用";
      }),
    ]);
  } catch (error) {
    if (serial === loadSerial) {
      loadError.value = (error as Error).message || "群配置加载失败";
      app.showToast(loadError.value, "error");
    }
  } finally {
    if (serial === loadSerial) loading.value = false;
  }
}

async function loadSchedulePreview(groupId = app.groupId, serial = loadSerial): Promise<void> {
  if (!groupId) return;
  const data = await api<{ previews: SchedulePreviewDay[] }>(`/api/groups/${encodeURIComponent(groupId)}/schedule-preview?days=7`);
  if (serial === loadSerial && groupId === app.groupId) schedulePreview.value = data.previews;
}

async function retryReminders(): Promise<void> {
  remindersLoading.value = true;
  try {
    await loadReminders();
    remindersError.value = "";
  } catch (error) {
    remindersError.value = (error as Error).message || "定时任务暂不可用";
  } finally {
    remindersLoading.value = false;
  }
}

async function retrySchedulePreview(): Promise<void> {
  try {
    await loadSchedulePreview();
    schedulePreviewError.value = "";
  } catch (error) {
    schedulePreviewError.value = (error as Error).message || "执行预览暂不可用";
  }
}

async function loadModelOptions(): Promise<void> {
  const data = await api<{ replyModels: ModelOption[] }>("/api/model-options");
  replyModels.value = data.replyModels;
  reconcileReplyModelSelection();
}

function reconcileReplyModelSelection(): void {
  if (!replyModels.value.length) return;
  if (!replyModels.value.some((model) => model.id === form.replyModelMode)) {
    form.replyModelMode = replyModels.value[0]?.id || "";
  }
}

async function loadMemberOptions(groupId = app.groupId): Promise<void> {
  if (!groupId) return;
  let data = await api<{ members: MemberProfile[]; cacheStatus?: string }>(
    `/api/groups/${encodeURIComponent(groupId)}/members?all=1`,
  );
  if (data.cacheStatus === "unloaded" || (!data.members?.length && app.groupId === groupId)) {
    try {
      await api(`/api/groups/${encodeURIComponent(groupId)}/members/refresh`, { method: "POST", body: "{}" });
      data = await api<{ members: MemberProfile[]; cacheStatus?: string }>(
        `/api/groups/${encodeURIComponent(groupId)}/members?all=1`,
      );
    } catch {
      // ignore
    }
  }
  if (groupId === app.groupId) memberOptions.value = data.members || [];
}

async function loadReminders(groupId = app.groupId, serial = loadSerial): Promise<void> {
  if (!groupId) return;
  remindersLoading.value = true;
  try {
    const data = await api<{ reminders: ScheduledReminderTask[] }>(`/api/groups/${encodeURIComponent(groupId)}/reminders`);
    if (serial === loadSerial && groupId === app.groupId) reminders.value = data.reminders;
  } finally {
    if (serial === loadSerial) remindersLoading.value = false;
  }
}

async function save(): Promise<void> {
  if (!app.groupId) return;
  if (readonly.value) {
    app.showToast("会话尚未就绪，无法保存群配置", "error");
    return;
  }
  saving.value = true;
  try {
    const patch = Object.fromEntries(Object.entries(configValues()).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(originalConfig.value[key])));
    if (!Object.keys(patch).length) { app.showToast("配置没有变化"); return; }
    const next = await api<GroupConfig & { revision: string }>(`/api/groups/${encodeURIComponent(app.groupId)}/config`, {
      method: "PATCH",
      body: JSON.stringify({ expectedRevision: revision.value, patch }),
    });
    revision.value = next.revision;
    resetForm(next);
    await app.loadGroups();
    app.showToast("群配置已保存");
  } catch (error) {
    app.showToast((error as Error).message, "error");
  } finally {
    saving.value = false;
  }
}

function addTriggerKeyword(): void {
  if (readonly.value) return;
  form.triggerKeywords = [...(form.triggerKeywords || []), { keyword: "", enabled: true }];
}

function removeTriggerKeyword(index: number): void {
  if (readonly.value) return;
  form.triggerKeywords = (form.triggerKeywords || []).filter((_, itemIndex) => itemIndex !== index);
}

function scheduleRuleLabel(rule?: ScheduleDateRule, weekdays: number[] = []): string {
  if (rule === "workday") return "智能工作日";
  if (rule === "holiday") return "智能非工作日";
  if (rule === "custom") {
    const labels = weekdays.map(weekdayLabel).filter(Boolean);
    return labels.length ? `自定义（${labels.join("/")}）` : "自定义";
  }
  return "全部日期";
}

function scheduleRuleClass(rule?: ScheduleDateRule): string {
  return rule === "workday" ? "workday" : rule === "holiday" ? "holiday" : rule === "custom" ? "custom" : "all";
}

function weekdayLabel(value: number): string {
  return ({ 1: "一", 2: "二", 3: "三", 4: "四", 5: "五", 6: "六", 0: "日" } as Record<number, string>)[value] || "";
}

function resetReminderForm(): void {
  if (readonly.value) return;
  editingReminderId.value = null;
  reminderForm.topic = "";
  reminderForm.executionStartTime = "09:00";
  reminderForm.executionEndTime = "18:00";
  reminderForm.executionIntervalMinutes = 60;
  reminderForm.intervalMinutes = 60;
  reminderForm.dateRule = "all";
  reminderForm.weekdays = [];
  reminderForm.enabled = true;
  reminderBaseline.value = JSON.stringify(reminderForm);
}

function fillReminderForm(reminder: ScheduledReminderTask, mode: "edit" | "copy"): void {
  editingReminderId.value = mode === "edit" ? reminder.id : null;
  reminderForm.topic = reminder.topic;
  reminderForm.executionStartTime = reminder.executionStartTime || reminder.scheduledTime || reminderTimeLabel(reminder);
  reminderForm.executionEndTime = reminder.executionEndTime || reminder.executionStartTime || reminder.scheduledTime || reminderTimeLabel(reminder);
  reminderForm.executionIntervalMinutes = reminder.executionIntervalMinutes ?? reminder.intervalMinutes;
  reminderForm.intervalMinutes = reminder.intervalMinutes;
  reminderForm.dateRule = reminder.dateRule || "all";
  reminderForm.weekdays = [...(reminder.weekdays || [])];
  reminderForm.enabled = reminder.enabled;
  reminderBaseline.value = JSON.stringify(reminderForm);
}

function editReminder(reminder: ScheduledReminderTask): void {
  if (readonly.value) return;
  fillReminderForm(reminder, "edit");
  app.showToast("已载入任务，可在上方表单编辑");
}

function copyReminder(reminder: ScheduledReminderTask): void {
  if (readonly.value) return;
  fillReminderForm(reminder, "copy");
  app.showToast("已复制到新增任务表单");
}

function reminderTimeLabel(reminder: ScheduledReminderTask): string {
  if (reminder.executionStartTime && reminder.executionEndTime) {
    return `${reminder.executionStartTime} - ${reminder.executionEndTime}`;
  }
  if (reminder.scheduledTime) return reminder.scheduledTime;
  const date = new Date(reminder.nextRunAt);
  if (Number.isNaN(date.getTime())) return "--:--";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function reminderIntervalLabel(reminder: ScheduledReminderTask): string {
  const minutes = reminder.executionIntervalMinutes ?? reminder.intervalMinutes;
  return `${minutes} 分钟`;
}

function reminderStatusClass(reminder: ScheduledReminderTask): string {
  return reminder.enabled ? "enabled" : "paused";
}

async function submitReminder(): Promise<void> {
  if (readonly.value) {
    app.showToast("会话尚未就绪，无法修改定时任务", "error");
    return;
  }
  if (!app.groupId || !reminderForm.topic.trim()) {
    app.showToast("请填写定时任务内容", "error");
    return;
  }
  if (!/^\d{2}:\d{2}$/.test(reminderForm.executionStartTime) || !/^\d{2}:\d{2}$/.test(reminderForm.executionEndTime)) {
    app.showToast("请选择执行开始时间和结束时间", "error");
    return;
  }
  if (reminderForm.executionStartTime > reminderForm.executionEndTime) {
    app.showToast("执行开始时间不能晚于结束时间", "error");
    return;
  }
  remindersLoading.value = true;
  try {
    const intervalMinutes = Math.max(1, Number(reminderForm.executionIntervalMinutes) || 1);
    const payload = {
      intervalMinutes,
      topic: reminderForm.topic.trim(),
      executionStartTime: reminderForm.executionStartTime,
      executionEndTime: reminderForm.executionEndTime,
      executionIntervalMinutes: intervalMinutes,
      dateRule: reminderForm.dateRule,
      weekdays: reminderForm.weekdays,
      enabled: reminderForm.enabled,
    };
    const url = editingReminderId.value
      ? `/api/groups/${encodeURIComponent(app.groupId)}/reminders/${encodeURIComponent(editingReminderId.value)}`
      : `/api/groups/${encodeURIComponent(app.groupId)}/reminders`;
    const wasEditing = Boolean(editingReminderId.value);
    await api<ScheduledReminderTask>(url, {
      method: editingReminderId.value ? "PUT" : "POST",
      body: JSON.stringify(payload),
    });
    resetReminderForm();
    await loadReminders();
    await loadSchedulePreview();
    app.showToast(wasEditing ? "定时任务已保存" : "定时任务已创建");
  } catch (error) {
    app.showToast((error as Error).message, "error");
  } finally {
    remindersLoading.value = false;
  }
}

async function createReminder(): Promise<void> {
  await submitReminder();
}

async function updateReminder(reminder: ScheduledReminderTask): Promise<void> {
  if (readonly.value) return;
  remindersLoading.value = true;
  try {
    await api<ScheduledReminderTask>(`/api/groups/${encodeURIComponent(app.groupId)}/reminders/${encodeURIComponent(reminder.id)}`, {
      method: "PUT",
      body: JSON.stringify({
        intervalMinutes: Number(reminder.executionIntervalMinutes ?? reminder.intervalMinutes),
        topic: reminder.topic,
        executionStartTime: reminder.executionStartTime,
        executionEndTime: reminder.executionEndTime,
        executionIntervalMinutes: reminder.executionIntervalMinutes ?? reminder.intervalMinutes,
        dateRule: reminder.dateRule || "all",
        weekdays: reminder.weekdays || [],
        enabled: reminder.enabled,
      }),
    });
    await loadReminders();
    await loadSchedulePreview();
    app.showToast("定时任务已保存");
  } catch (error) {
    app.showToast((error as Error).message, "error");
  } finally {
    remindersLoading.value = false;
  }
}

async function deleteReminder(reminder: ScheduledReminderTask): Promise<void> {
  if (readonly.value) return;
  if (!await confirmAction({ title: "删除定时任务", message: `删除「${reminder.topic}」后将停止后续提醒。`, confirmText: "删除任务", danger: true })) return;
  remindersLoading.value = true;
  try {
    await api(`/api/groups/${encodeURIComponent(app.groupId)}/reminders/${encodeURIComponent(reminder.id)}`, { method: "DELETE" });
    await loadReminders();
    await loadSchedulePreview();
    app.showToast("定时任务已删除");
  } catch (error) {
    app.showToast((error as Error).message, "error");
  } finally {
    remindersLoading.value = false;
  }
}

async function reload(): Promise<void> {
  if ((dirty.value || reminderDirty.value) && !await confirmAction({ title: "重新读取配置", message: "当前尚有未保存的更改，重新读取将丢弃这些更改。", confirmText: "丢弃并读取", danger: true })) return;
  await load();
}
function onRefresh(): void {
  void reload().catch((error) => app.showToast(error.message, "error"));
}

onMounted(() => {
  void load();
});

useRefreshEvents({ refresh: onRefresh });

watch(() => app.groupId, () => {
  void load();
});

</script>

<template>
  <section class="page group-page">
    <header class="page-heading">
      <div><h1>群配置</h1><p>管理回复规则、能力、成员权限与定时任务。</p></div>
      <div class="heading-actions">
        <span v-if="dirty" class="dirty-hint"><AppIcon name="bell" :size="15" /> 有未保存的更改</span>
        <button class="btn" type="button" :disabled="readonly || loading || saving || !dirty" @click="save">{{ saving ? "保存中…" : "保存配置" }}</button>
      </div>
    </header>
    <nav class="config-tabs" aria-label="群配置分类">
      <button v-for="tab in configTabs" :key="tab.value" type="button" :class="{ active: activeTab === tab.value }" :aria-current="activeTab === tab.value ? 'page' : undefined" @click="activeTab = tab.value">{{ tab.label }}</button>
    </nav>
    <div v-if="loading" class="panel empty" aria-live="polite">正在加载群配置…</div>
    <div v-else-if="loadError" class="panel empty" role="alert"><p>{{ loadError }}</p><button class="ghost-btn" type="button" @click="reload">重试</button></div>
    <div v-else-if="!app.groupId" class="panel empty">暂无获授权群聊。</div>
    <div v-else class="config-layout" :class="{ scheduling: activeTab === 'schedule' }">
      <form class="settings-grid" @submit.prevent="save">
        <template v-if="activeTab === 'reply'">
          <section class="panel group-config-card">
            <div class="section-intro"><h2>回复规则</h2><p>设置机器人在当前群的参与方式。</p></div>
            <div class="field-grid">
              <label class="switch-line wide"><span><strong>显示并启用该群</strong><small>停用后机器人不再处理当前群的消息。</small></span><input v-model="form.enabled" :disabled="readonly" type="checkbox" /></label>
              <label class="switch-line wide"><span><strong>机器人静音</strong><small>保留群配置，暂停机器人发言。</small></span><input v-model="form.botMuted" :disabled="readonly" type="checkbox" /></label>
              <label>回复模型<select v-model="form.replyModelMode" class="select" :disabled="readonly || !hasReplyModels"><option v-if="!hasReplyModels" value="">请先启用对话模型</option><option v-for="model in replyModels" :key="model.id" :value="model.id">{{ model.label }}</option></select></label>
              <label>参与方式<select v-model="form.participationMode" class="select" :disabled="readonly"><option value="mentions_only">仅在 @ / 引用时回复</option><option value="mentions_and_keywords">@ / 引用 + 关键词</option><option value="selected_members">@ / 引用 + 关键词 + 指定成员低频参与</option></select></label>
              <label>实时对话延迟<input v-model.number="form.liveChatDelaySeconds" class="input" type="number" min="0" :disabled="readonly || form.participationMode !== 'selected_members'" /><small>单位为秒，仅指定成员低频参与时生效。</small></label>
              <label>当前人格<div class="fixed-persona">{{ form.currentSkillId || '尚未设置' }}</div><small>人格内容在「内容与表达」工作区维护。</small></label>
            </div>
          </section>
          <section class="panel group-config-card">
            <div class="section-head"><div class="section-intro"><h2>触发关键词</h2><p>按参与方式，启用的关键词可触发回复。</p></div><button class="ghost-btn" type="button" :disabled="readonly" @click="addTriggerKeyword">＋ 新增关键词</button></div>
            <div v-if="!form.triggerKeywords?.length" class="empty compact">尚未配置触发关键词。</div>
            <div v-else class="keyword-list">
              <div class="keyword-header"><span>关键词</span><span>状态</span><span>操作</span></div>
              <div v-for="(item, index) in form.triggerKeywords" :key="index" class="keyword-row"><input v-model="item.keyword" class="input" :aria-label="'关键词 ' + (index + 1)" placeholder="例如：乘风" :disabled="readonly" /><label class="mini-check"><input v-model="item.enabled" :disabled="readonly" type="checkbox" /> 启用</label><button class="link-btn danger" type="button" :disabled="readonly" @click="removeTriggerKeyword(index)">删除</button></div>
            </div>
          </section>
        </template>
        <section v-else-if="activeTab === 'capabilities'" class="panel group-config-card">
          <div class="section-intro"><h2>能力开关</h2><p>为当前群选择需要的能力，保存后生效。</p></div>
          <div class="capability-list">
            <label v-for="capability in capabilities" :key="capability.key" class="switch-line"><span><strong>{{ capability.label }}</strong><small>{{ capability.detail }}</small></span><input v-model="form[capability.key]" :disabled="readonly" type="checkbox" /></label>
          </div>
          <p class="muted">日报、节日倒计时和定时提醒在「排程」中配置。</p>
        </section>
        <section v-else-if="activeTab === 'permissions'" class="panel group-config-card">
          <div class="section-intro"><h2>成员权限</h2><p>成员身份、备注和隐私退出在成员详情中维护。</p></div>
          <div class="field-grid">
            <label class="wide">低频参与成员<MultiTagSelect v-model="form.liveChatUserIds" :options="memberSelectOptions" :disabled="readonly || form.participationMode !== 'selected_members'" placeholder="搜索成员昵称或 QQ" /><small>需先将参与方式设置为指定成员低频参与。</small></label>
            <label class="wide">嘴臭模式成员<MultiTagSelect v-model="form.roastModeUserIds" :options="memberSelectOptions" :disabled="readonly" placeholder="搜索成员昵称或 QQ" /></label>
            <label class="wide">黑名单成员<MultiTagSelect v-model="form.blacklistedUserIds" :options="memberSelectOptions" :disabled="readonly" placeholder="搜索成员昵称或 QQ" /></label>
          </div>
        </section>
      <template v-else-if="activeTab === 'schedule'">

      <section class="panel group-config-card schedule-card">
        <div class="schedule-head">
          <div class="schedule-title">
            <span class="schedule-icon"><AppIcon name="bell" /></span>
            <div>
              <h3>定时规则</h3>

            </div>
          </div>
          <span class="schedule-effect"><AppIcon name="check" :size="16" /> 当前生效：{{ scheduleEffectText }}</span>
        </div>

        <div class="schedule-layout">
          <section class="schedule-column schedule-basic">
            <h4>基础参数</h4>
            <label>日报时间<input v-model="form.dailyReportTime" class="input" type="time" :disabled="readonly" /></label>
            <label>节日倒计时<input v-model="form.holidayCountdownTime" class="input" type="time" :disabled="readonly" /></label>
            <label>日报人数<input v-model.number="form.dailyReportTopUserCount" class="input" type="number" min="1" :disabled="readonly" /></label>
            <label>使用时区<input class="input" :value="scheduleTimezone" disabled /></label>
          </section>

          <section class="schedule-column schedule-abilities">
            <h4>启用能力</h4>
            <label class="ability-card">
              <AppIcon name="tasks" />
              <span><strong>群聊日报</strong><small>按规则定时发送群聊日报</small></span>
              <input v-model="form.dailyReportEnabled" :disabled="readonly" type="checkbox" />
            </label>
            <label class="ability-card">
              <AppIcon name="health" />
              <span><strong>节日倒计时</strong><small>按规则发送节日倒计时提醒</small></span>
              <input v-model="form.holidayCountdownEnabled" :disabled="readonly" type="checkbox" />
            </label>
            <label class="ability-card">
              <AppIcon name="bell" />
              <span><strong>定时提醒</strong><small>执行自定义群定时任务提醒</small></span>
              <input v-model="form.scheduledRemindersEnabled" :disabled="readonly" type="checkbox" />
            </label>
          </section>

          <section class="schedule-column schedule-rules">
            <h4>执行日期规则</h4>
            <div class="date-rule-panel">
              <DateRulePicker
                title="日报日期规则"
                :rule="form.dailyReportDateRule"
                :weekdays="form.dailyReportWeekdays || []"
                :disabled="readonly"
                @update:rule="form.dailyReportDateRule = $event"
                @update:weekdays="form.dailyReportWeekdays = $event"
              />
              <DateRulePicker
                title="节日倒计时日期规则"
                :rule="form.holidayCountdownDateRule"
                :weekdays="form.holidayCountdownWeekdays || []"
                :disabled="readonly"
                @update:rule="form.holidayCountdownDateRule = $event"
                @update:weekdays="form.holidayCountdownWeekdays = $event"
              />
            </div>
          </section>
        </div>

        <section class="schedule-preview">
          <div class="sub-head">
            <div>
              <h4>未来 7 天执行预览</h4>

            </div>
            <button class="ghost-btn" type="button" @click="retrySchedulePreview">刷新预览</button>
          </div>
          <div v-if="schedulePreviewError" class="error-state schedule-error" role="alert"><span>执行预览暂不可用</span><button class="ghost-btn" type="button" @click="retrySchedulePreview">重试预览</button></div>
          <div v-else class="preview-days">
            <article v-for="day in schedulePreview" :key="day.date" class="preview-day">
              <strong>{{ day.date }}</strong>
              <div v-if="day.items.length" class="preview-items">
                <span v-for="item in day.items" :key="`${day.date}:${item.type}:${item.taskId || item.title}:${item.time}`" :class="{ disabled: !item.enabled }">
                  {{ item.time }} {{ item.title }}
                </span>
              </div>
              <small v-else class="muted">无计划任务</small>
            </article>
          </div>
        </section>
      </section>

      <section class="panel reminders-card">
        <div class="reminder-card-head">
          <div class="reminder-heading">
            <span class="reminder-heading-icon"><AppIcon name="list" :size="32" /></span>
            <div>
              <h3>群定时任务</h3>
              <p>管理当前群的重要提醒任务，保存后按服务端时区计算下一次执行。</p>
            </div>
          </div>
          <div class="reminder-head-actions">
            <span class="reminder-count">共 {{ reminders.length }} 个任务</span>
            <button class="btn reminder-new-top" type="button" :disabled="readonly || remindersLoading || Boolean(remindersError)" @click="resetReminderForm">新增任务</button>
          </div>
        </div>
        <div v-if="remindersError" class="error-state reminder-error" role="alert"><span>群定时任务暂不可用</span><button class="ghost-btn" type="button" :disabled="remindersLoading" @click="retryReminders">重试加载</button></div>
        <div class="reminder-form" :class="{ editing: Boolean(editingReminderId) }">
          <div class="reminder-main-fields">
            <label class="reminder-topic">
              <span class="reminder-field-label">提醒内容</span>
                <input v-model="reminderForm.topic" class="input" placeholder="输入提醒内容，例如喝水、整理日报" :disabled="readonly || Boolean(remindersError)" />
            </label>
            <label class="reminder-time">
              <span class="reminder-field-label">执行开始时间</span>
                <input v-model="reminderForm.executionStartTime" class="input" type="time" :disabled="readonly || Boolean(remindersError)" />
            </label>
            <label class="reminder-time">
              <span class="reminder-field-label">执行结束时间</span>
                <input v-model="reminderForm.executionEndTime" class="input" type="time" :disabled="readonly || Boolean(remindersError)" />
            </label>
            <label class="reminder-advance">
              <span class="reminder-field-label">执行间隔</span>
              <div class="suffix-input">
                <input v-model.number="reminderForm.executionIntervalMinutes" class="input interval-input" type="number" min="1" :disabled="readonly || Boolean(remindersError)" />
                <span>分钟</span>
              </div>
            </label>
            <label class="reminder-toggle-field">
              <span>启用</span>
              <span class="toggle-switch">
                <input v-model="reminderForm.enabled" :disabled="readonly || Boolean(remindersError)" type="checkbox" />
                <i></i>
              </span>
            </label>
            <div class="reminder-form-actions">
              <button class="btn reminder-add" type="button" :disabled="readonly || remindersLoading || Boolean(remindersError)" @click="submitReminder">{{ readonly ? "只读模式" : reminderSubmitLabel }}</button>
              <button v-if="editingReminderId" class="ghost-btn reminder-cancel" type="button" :disabled="readonly || remindersLoading" @click="resetReminderForm">取消</button>
            </div>
          </div>
          <section class="reminder-rule-card">
            <div class="reminder-rule-head">
              <span>日期规则</span>
              <small>选择任务在哪些日期执行</small>
            </div>
            <DateRulePicker
              v-model:rule="reminderForm.dateRule"
              v-model:weekdays="reminderForm.weekdays"
              compact
              show-weekday-preview
              :disabled="readonly || Boolean(remindersError)"
            />
          </section>
        </div>
        <div v-if="remindersError" class="muted reminder-unavailable">定时任务编辑暂不可用。</div>
        <div v-else-if="remindersLoading" class="empty compact">正在加载定时任务...</div>
        <div v-else-if="!reminders.length" class="empty compact">当前群暂无定时任务。</div>
        <div v-else class="reminder-table">
          <div class="reminder-table-head">
            <span>任务内容</span>
            <span>日期规则</span>
            <span>执行范围</span>
            <span>间隔</span>
            <span>状态</span>
            <span>下次执行</span>
            <span>操作</span>
          </div>
          <article v-for="reminder in reminders" :key="reminder.id" class="reminder-row">
            <strong class="reminder-topic-text">{{ reminder.topic }}</strong>
            <span class="rule-tag" :class="scheduleRuleClass(reminder.dateRule)">
              {{ scheduleRuleLabel(reminder.dateRule, reminder.weekdays || []) }}
            </span>
            <span>{{ reminderTimeLabel(reminder) }}</span>
            <span>{{ reminderIntervalLabel(reminder) }}</span>
            <span class="status-pill" :class="reminderStatusClass(reminder)">
              <i></i>{{ reminder.enabled ? "启用" : "暂停" }}
            </span>
            <span class="muted next-run">{{ formatDateTime(reminder.nextRunAt) }}</span>
            <div class="reminder-actions">
              <button class="link-btn" type="button" :disabled="readonly || remindersLoading" @click="editReminder(reminder)">编辑</button>
              <button class="link-btn" type="button" :disabled="readonly" @click="copyReminder(reminder)">复制</button>
              <button class="link-btn danger" type="button" :disabled="readonly || remindersLoading" @click="deleteReminder(reminder)">删除</button>
            </div>
          </article>
        </div>
      </section>
      </template>


        <div class="save-bar"><span class="muted">{{ dirty ? '更改尚未保存' : '配置已同步' }}</span><div><button class="ghost-btn" type="button" :disabled="loading || saving" @click="reload">重新读取</button><button class="btn" type="submit" :disabled="readonly || loading || saving || !dirty">{{ saving ? "保存中…" : "保存配置" }}</button></div></div>
      </form>
      <aside v-if="activeTab !== 'schedule'" class="panel config-summary">
        <h2>群配置摘要</h2><div class="summary-group"><span class="summary-icon"><AppIcon name="users" /></span><div><strong>{{ app.currentGroup?.groupName || '群 ' + app.groupId }}</strong><small>{{ app.groupId }}</small></div></div>
        <dl><div><dt>群状态</dt><dd><span class="tag" :class="{ danger: form.enabled === false || form.botMuted }">{{ form.enabled === false ? "已停用" : form.botMuted ? "已静音" : "已启用" }}</span></dd></div><div><dt>回复模型</dt><dd>{{ currentReplyModelLabel }}</dd></div><div><dt>参与方式</dt><dd>{{ form.participationMode === 'selected_members' ? '指定成员低频参与' : form.participationMode === 'mentions_and_keywords' ? '@ / 引用 + 关键词' : '@ / 引用' }}</dd></div><div><dt>关键词</dt><dd>{{ form.triggerKeywords?.filter(item => item.enabled && item.keyword.trim()).length || 0 }} 个已启用</dd></div><div><dt>能力</dt><dd>{{ capabilities.filter(item => form[item.key]).length }} / {{ capabilities.length }} 项已启用</dd></div><div><dt>定时任务</dt><dd>{{ reminders.filter(item => item.enabled).length }} 个已启用</dd></div></dl>
        <p class="summary-note">{{ dirty ? '摘要包含当前尚未保存的修改。' : '仅显示当前群的实际配置。' }}</p>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.tabs-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  padding: 4px 6px;
  margin-top: 0;
  flex-wrap: wrap;
}

.tabs-group {
  display: flex;
  align-items: center;
  gap: 2px;
}

.tab-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  border-radius: var(--radius-md);
  font-size: 12.5px;
  font-weight: 600;
  color: var(--muted);
  background: transparent;
  border: none;
  cursor: pointer;
}

.tab-btn:hover {
  color: var(--text);
  background: var(--surface-soft);
}

.tab-btn.active {
  color: var(--accent-strong);
  background: var(--accent-soft);
  font-weight: 650;
}

.tab-save-btn {
  min-height: 32px;
  padding: 0 14px;
}

.group-top {
  display: grid;
  grid-template-columns: 260px minmax(0, 1fr);
  gap: 14px;
}

.group-picker {
  display: grid;
  gap: 8px;
}

.group-picker label,
.group-config-card label,
.json-card label {
  display: grid;
  gap: 6px;
  font-weight: 600;
  font-size: 12.5px;
  color: var(--muted);
}

.group-summary {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) minmax(260px, 0.85fr);
  gap: 16px;
  align-items: center;
}

.summary-icon {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  border-radius: var(--radius-md);
  background: var(--accent-soft);
  color: var(--accent-strong);
  font-weight: 700;
  font-size: 14px;
  border: 1px solid color-mix(in oklch, var(--accent) 22%, var(--line));
}

.group-summary h2 {
  display: inline-flex;
  margin: 0 12px 8px 0;
}

.group-summary p {
  margin: 0;
  color: var(--muted);
}

dl {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
}

dt {
  color: var(--muted);
}

dd {
  margin: 6px 0 0;
  font-weight: 800;
}

.settings-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 18px;
  padding-bottom: 18px;
}

.group-config-card {
  display: grid;
  align-content: start;
  gap: 18px;
}

.group-config-card h3,
.json-card h3 {
  margin: 0;
}

.field-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.switch-line {
  display: flex !important;
  align-items: center;
  gap: 8px;
}

.wide {
  grid-column: 1 / -1;
}

.switch-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
  margin-top: 14px;
}

.switch-grid .switch-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  transition: all 0.15s ease;
  cursor: pointer;
}

.switch-grid .switch-card:hover {
  border-color: var(--line-strong);
  background: var(--surface-soft);
}

.switch-grid .switch-card.checked {
  border-color: color-mix(in srgb, var(--accent) 35%, var(--line));
  background: color-mix(in srgb, var(--accent-soft) 40%, var(--surface));
}

.switch-grid .switch-card strong {
  display: block;
  font-size: 13.5px;
  color: var(--text);
  font-weight: 600;
}

.switch-grid .switch-card small {
  display: block;
  font-size: 11.5px;
  margin-top: 2px;
}

.switch-grid .switch-card.disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.fixed-persona {
  min-height: 40px;
  display: flex;
  align-items: center;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface-soft);
  color: var(--accent-strong);
  padding: 0 12px;
  font-weight: 800;
}

.multi-select {
  min-height: 122px;
  overflow: auto;
}

.tag-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

.json-card,
.reminders-card,
.schedule-card,
.save-bar {
  grid-column: 1 / -1;
}

.keyword-list,
.reminder-list {
  display: grid;
  gap: 10px;
}

.keyword-row {
  display: grid;
  grid-template-columns: minmax(220px, 1fr) auto auto;
  gap: 10px;
  align-items: center;
}

.schedule-card {
  gap: 20px;
}

.schedule-head,
.schedule-title,
.schedule-effect {
  display: flex;
  align-items: center;
  gap: 12px;
}

.schedule-head {
  justify-content: space-between;
  border-bottom: 1px solid var(--line);
  padding-bottom: 18px;
}

.schedule-title h3,
.schedule-title p {
  margin: 0;
}

.schedule-title p {
  margin-top: 4px;
}

.schedule-icon {
  display: grid;
  place-items: center;
  width: 42px;
  height: 42px;
  border-radius: 999px;
  border: 1px solid var(--line);
  color: var(--accent-strong);
  background: var(--surface-soft);
}

.schedule-effect {
  min-height: 40px;
  border-radius: var(--radius-sm);
  background: var(--surface-soft);
  color: var(--muted);
  padding: 0 14px;
  font-size: 13px;
  font-weight: 800;
}

.schedule-layout {
  display: grid;
  grid-template-columns: minmax(220px, 0.72fr) minmax(260px, 0.85fr) minmax(460px, 1.5fr);
  gap: 18px;
  align-items: stretch;
}

.schedule-column {
  display: grid;
  align-content: start;
  gap: 14px;
  border-right: 1px solid var(--line);
  padding-right: 18px;
}

.schedule-column:last-child {
  border-right: 0;
  padding-right: 0;
}

.schedule-column h4 {
  margin: 0 0 2px;
  font-size: 15px;
}

.schedule-basic label {
  display: grid;
  grid-template-columns: 86px minmax(0, 1fr);
  align-items: center;
  gap: 12px;
  color: var(--muted);
  font-weight: 800;
}

.schedule-basic .input {
  min-height: 38px;
}

.schedule-abilities {
  gap: 12px;
}

.ability-card {
  display: grid !important;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px !important;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--surface-raised);
  padding: 13px 14px;
}

.ability-card > svg {
  color: var(--accent-strong);
}

.ability-card span {
  display: grid;
  gap: 3px;
}

.ability-card small {
  color: var(--muted);
  font-weight: 600;
}

.date-rule-panel {
  display: grid;
  grid-template-columns: 1fr;
  gap: 14px;
}

.schedule-preview {
  display: grid;
  gap: 14px;
  border-top: 1px solid var(--line);
  padding-top: 18px;
}

.sub-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.sub-head h4,
.sub-head p {
  margin: 0;
}

.sub-head p {
  margin-top: 5px;
}

.preview-days {
  display: grid;
  grid-template-columns: repeat(7, minmax(130px, 1fr));
  gap: 10px;
  overflow: auto;
}

.preview-day {
  display: grid;
  align-content: start;
  gap: 8px;
  min-height: 128px;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--surface-raised);
  padding: 12px;
}

.preview-day strong {
  font-size: 13px;
}

.preview-items {
  display: grid;
  gap: 6px;
}

.preview-items span {
  border-radius: 7px;
  background: var(--accent-soft);
  color: var(--accent-strong);
  padding: 6px 8px;
  font-size: 12px;
  font-weight: 800;
  line-height: 1.35;
}

.preview-items span.disabled {
  background: var(--surface-soft);
  color: var(--muted);
  text-decoration: line-through;
}

.reminders-card {
  overflow: hidden;
  padding: 26px 26px 28px;
  border-radius: 14px;
  background: color-mix(in oklch, var(--surface) 96%, var(--surface-soft));
}

.reminder-card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
  margin-bottom: 26px;
}

.reminder-heading {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  min-width: 0;
}

.reminder-heading-icon {
  display: grid;
  place-items: center;
  width: 42px;
  height: 42px;
  margin-top: 1px;
  color: var(--text);
}

.reminder-heading h3 {
  margin: 0;
  color: var(--text);
  font-size: 23px;
  line-height: 1.18;
}

.reminder-heading p {
  margin: 8px 0 0;
  color: var(--muted);
  font-size: 14px;
  font-weight: 700;
}

.reminder-head-actions {
  display: flex;
  align-items: center;
  gap: 18px;
  flex: none;
}

.reminder-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 46px;
  border-radius: 10px;
  background: color-mix(in oklch, var(--surface-soft) 76%, var(--surface));
  color: var(--muted);
  padding: 0 24px;
  font-size: 15px;
  font-weight: 700;
  box-shadow: none;
  white-space: nowrap;
}

.reminder-new-top {
  min-width: 126px;
  min-height: 46px;
  border-radius: 8px;
  font-size: 15px;
}

.reminder-form {
  display: grid;
  gap: 16px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: color-mix(in oklch, var(--surface) 94%, var(--surface-soft));
  padding: 18px 20px;
  margin-bottom: 20px;
  box-shadow: inset 0 1px 0 color-mix(in oklch, var(--surface) 74%, oklch(1 0 0) 26%);
}

.reminder-main-fields {
  display: grid;
  grid-template-columns: minmax(260px, 1fr) 148px 148px 132px 96px 126px;
  gap: 14px;
  align-items: end;
}

.reminder-form.editing .reminder-main-fields {
  grid-template-columns: minmax(260px, 1fr) 148px 148px 132px 96px 230px;
}

.reminder-form label {
  display: grid;
  gap: 6px;
  color: var(--muted);
  font-size: 12.5px;
  font-weight: 600;
}

.reminder-field-label {
  color: var(--muted);
  line-height: 1;
}

.reminder-form .input {
  min-height: 44px;
  border-radius: 8px;
  font-size: 15px;
  font-weight: 800;
}

.reminder-topic {
  min-width: 0;
}

.reminder-time,
.reminder-advance {
  min-width: 0;
}

.suffix-input {
  position: relative;
  display: flex;
  align-items: center;
}

.suffix-input .input {
  padding-right: 48px;
}

.suffix-input span {
  position: absolute;
  right: 12px;
  color: var(--muted);
  font-size: 13px;
  font-weight: 800;
  pointer-events: none;
}

.reminder-toggle-field {
  display: flex !important;
  align-items: center;
  justify-content: center;
  gap: 10px !important;
  min-height: 44px;
  color: var(--muted);
  padding-bottom: 1px;
}

.reminder-toggle-field > span:first-child {
  white-space: nowrap;
}

.reminder-form-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.reminder-rule-card {
  display: grid;
  grid-template-columns: 170px minmax(0, 1fr);
  gap: 18px;
  align-items: start;
  border-top: 1px solid color-mix(in oklch, var(--line) 76%, transparent);
  padding-top: 15px;
}

.reminder-rule-head {
  display: grid;
  gap: 6px;
  padding-top: 4px;
}

.reminder-rule-head span {
  color: var(--text-strong);
  font-size: 13.5px;
  font-weight: 650;
}

.reminder-rule-head small {
  color: var(--muted);
  font-size: 12px;
  font-weight: 500;
}

.reminder-rule-card :deep(.date-rule-picker) {
  max-width: 560px;
}

.reminder-rule-card :deep(.rule-segment) {
  height: 44px;
}

.reminder-rule-card :deep(.weekday-preview) {
  min-height: 32px;
}

.toggle-switch {
  position: relative;
  display: inline-flex;
  width: 48px;
  height: 28px;
  flex: none;
}

.toggle-switch input {
  position: absolute;
  inset: 0;
  margin: 0;
  opacity: 0;
}

.toggle-switch i {
  position: absolute;
  inset: 0;
  border: 1px solid color-mix(in oklch, var(--accent) 34%, var(--line));
  border-radius: 999px;
  background: color-mix(in oklch, var(--muted) 18%, var(--surface));
  transition: background 0.18s ease, border-color 0.18s ease;
}

.toggle-switch i::after {
  position: absolute;
  top: 4px;
  left: 4px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--surface);
  box-shadow: none;
  content: "";
  transition: transform 0.18s ease;
}

.toggle-switch input:checked + i {
  border-color: var(--accent-strong);
  background: var(--accent-strong);
}

.toggle-switch input:checked + i::after {
  transform: translateX(20px);
}

.reminder-add,
.reminder-cancel {
  min-height: 44px;
  border-radius: 8px;
  font-size: 15px;
  white-space: nowrap;
}

.reminder-add {
  min-width: 112px;
  box-shadow: 0 11px 22px oklch(0.55 0.16 164 / 22%);
}

.reminder-cancel {
  padding-inline: 14px;
}

.reminder-table {
  max-height: 360px;
  overflow: auto;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--surface);
}

.reminder-table-head,
.reminder-row {
  display: grid;
  grid-template-columns: minmax(170px, 1fr) 142px 144px 106px 106px 210px 144px;
  gap: 16px;
  align-items: center;
  min-width: 1050px;
  border-bottom: 1px solid var(--line);
  padding: 13px 24px;
}

.reminder-table-head {
  position: sticky;
  top: 0;
  z-index: 1;
  min-height: 52px;
  background: color-mix(in oklch, var(--surface-soft) 50%, var(--surface));
  color: var(--muted);
  font-size: 12px;
  font-weight: 650;
}

.reminder-row {
  min-height: 52px;
  background: var(--surface);
  font-size: 13px;
  font-weight: 550;
}

.reminder-row:hover {
  background: color-mix(in oklch, var(--surface-soft) 62%, var(--surface));
}

.reminder-row:last-child {
  border-bottom: 0;
}

.reminder-topic-text {
  min-width: 0;
  overflow: hidden;
  color: var(--text);
  font-size: 14px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rule-tag {
  justify-self: start;
  border-radius: 8px;
  padding: 6px 10px;
  font-size: 12px;
  font-weight: 650;
  white-space: nowrap;
}

.rule-tag.all,
.rule-tag.workday {
  background: var(--accent-soft);
  color: var(--accent-strong);
}

.rule-tag.holiday {
  background: var(--accent-soft);
  color: var(--accent-strong);
}

.rule-tag.custom {
  background: color-mix(in oklch, var(--orange) 18%, var(--surface));
  color: oklch(0.55 0.13 58);
}

.status-pill,
.reminder-actions {
  display: flex;
  align-items: center;
}

.status-pill {
  justify-self: start;
  gap: 7px;
  border-radius: 8px;
  padding: 6px 10px;
  font-size: 12px;
  font-weight: 650;
  white-space: nowrap;
}

.status-pill i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

.status-pill.enabled {
  background: var(--accent-soft);
  color: var(--accent-strong);
}

.status-pill.paused {
  background: color-mix(in oklch, var(--orange) 14%, var(--surface));
  color: oklch(0.58 0.15 62);
}

.interval-input {
  width: 100%;
}

.next-run {
  font-size: 13px;
}

.reminder-actions {
  gap: 18px;
  justify-content: flex-end;
  white-space: nowrap;
}

.link-btn {
  background: transparent;
  color: var(--accent-strong);
  font-weight: 650;
  padding: 0;
}

.mini-check {
  display: flex !important;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
}

.danger {
  color: var(--danger);
}

.compact {
  min-height: 100px;
}

.json-editor {
  min-height: 260px;
  font-family: "Cascadia Code", Consolas, monospace;
}

.save-bar {
  position: static;
  display: flex;
  align-items: center;
  gap: 14px;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--surface-raised);
  box-shadow: var(--shadow-sm);
  padding: 14px 16px;
}

@media (max-width: 980px) {
  .group-top,
  .group-summary,
  .settings-grid,
  .keyword-row,
  .schedule-layout,
  .reminder-main-fields,
  .reminder-rule-card,
  .date-rule-panel,
  .field-grid {
    grid-template-columns: 1fr;
  }

  .schedule-head {
    display: grid;
  }

  .schedule-column {
    border-right: 0;
    border-bottom: 1px solid var(--line);
    padding-right: 0;
    padding-bottom: 16px;
  }

  .schedule-column:last-child {
    border-bottom: 0;
    padding-bottom: 0;
  }

  .schedule-basic label {
    grid-template-columns: 1fr;
  }

  dl {
    grid-template-columns: 1fr;
  }
}

/* Shared console layout: broad form column and compact factual summary. */
.page-heading { display:flex; justify-content:space-between; align-items:flex-start; gap:20px; }
.page-heading h1 { margin:0; font-size:28px; letter-spacing:-.6px; }
.page-heading p,.section-intro p { margin:7px 0 0; color:var(--muted); line-height:1.7; }
.heading-actions { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
.dirty-hint { display:inline-flex; align-items:center; gap:7px; border:1px solid var(--line); color:var(--warning); background:var(--warning-soft); border-radius:6px; padding:9px 12px; font-size:12px; }
.config-tabs { display:flex; gap:20px; border-bottom:1px solid var(--line); }
.config-tabs button { padding:13px 15px; border:0; border-bottom:2px solid transparent; border-radius:0; color:var(--muted); background:transparent; }
.config-tabs button.active { border-bottom-color:var(--accent); color:var(--accent-strong); font-weight:650; }
.config-layout { display:grid; grid-template-columns:minmax(0,1fr) 280px; gap:20px; align-items:start; }
.config-layout.scheduling { grid-template-columns:minmax(0,1fr); }
.settings-grid { grid-template-columns:minmax(0,1fr); min-width:0; gap:18px; }
.group-config-card { padding:24px; gap:22px; }
.group-config-card h2,.config-summary h2 { margin:0; font-size:16px; }
.field-grid { gap:20px; }
.group-config-card label { font-size:13px; color:var(--text); }
.field-grid small,.switch-line small { display:block; color:var(--muted); font-weight:400; font-size:12px; line-height:1.65; }
.group-config-card .switch-line { display:flex; justify-content:space-between; align-items:center; padding:14px 0; border-bottom:1px solid var(--line); gap:20px; }
.switch-line strong { font-weight:600; font-size:14px; }
.switch-line small { margin-top:4px; }
.keyword-list { gap:0; border:1px solid var(--line); border-radius:7px; overflow:hidden; }
.keyword-header,.keyword-row { display:grid; grid-template-columns:minmax(0,1fr) 80px 48px; gap:12px; padding:11px 14px; align-items:center; }
.keyword-header { background:var(--surface-soft); color:var(--muted); font-size:12px; }
.keyword-row + .keyword-row { border-top:1px solid var(--line); }
.keyword-row label { display:flex; align-items:center; gap:5px; }
.link-btn { background:transparent; color:var(--accent-strong); padding:0; }
.link-btn.danger { color:var(--danger); }
.capability-list { display:grid; }
.config-summary { position:sticky; top:20px; padding:22px; }
.summary-group { display:flex; align-items:center; gap:12px; padding:22px 0; border-bottom:1px solid var(--line); }
.summary-group strong,.summary-group small { display:block; }
.summary-group small { color:var(--muted); margin-top:6px; font-size:12px; }
.config-summary dl { display:grid; grid-template-columns:1fr; gap:18px; margin:22px 0; }
.config-summary dl div { display:flex; gap:15px; justify-content:space-between; font-size:12px; align-items:center; }
.config-summary dd { text-align:right; margin:0; font-weight:500; max-width:65%; overflow-wrap:anywhere; }
.summary-note { border-top:1px solid var(--line); padding-top:18px; font-size:12px; color:var(--muted); line-height:1.7; }
.save-bar { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:0; }
.save-bar > div { display:flex; gap:10px; }
.save-bar > span { font-size:12px; }
.schedule-layout { grid-template-columns:minmax(0,1fr) minmax(0,1fr); }
.schedule-rules { grid-column:1 / -1; border-top:1px solid var(--line); padding-top:20px; }
.date-rule-panel { grid-template-columns:minmax(0,1fr) minmax(0,1fr); }
.reminders-card { padding:24px; border-radius:8px; }
.reminder-heading h3 { font-size:18px; }
.reminder-heading p { font-size:12px; font-weight:400; }
.reminder-heading-icon { width:28px; height:28px; }
.reminder-count { min-height:36px; font-size:12px; padding:0 12px; }
.reminder-new-top { min-height:38px; min-width:100px; font-size:13px; }
.reminder-main-fields,.reminder-form.editing .reminder-main-fields { grid-template-columns:minmax(0,2fr) repeat(3,minmax(0,1fr)); }
.reminder-form { border-radius:7px; box-shadow:none; padding:18px; }
.reminder-form .input { min-height:40px; font-size:13px; font-weight:400; }
.reminder-form-actions { grid-column:3 / -1; justify-content:flex-end; }
.reminder-add { box-shadow:none; }
.schedule-effect { font-size:12px; font-weight:500; }
@media(max-width:1100px) { .config-layout { grid-template-columns:minmax(0,1fr) 250px; gap:16px; } .field-grid { grid-template-columns:minmax(0,1fr); } }
@media(max-width:900px) { .config-layout { grid-template-columns:minmax(0,1fr); } .config-summary { position:static; } .config-summary dl { grid-template-columns:repeat(2,minmax(0,1fr)); } .schedule-layout,.date-rule-panel { grid-template-columns:minmax(0,1fr); } .schedule-column { border-right:0; padding-right:0; } .schedule-rules { grid-column:auto; } .schedule-head,.reminder-card-head { flex-wrap:wrap; gap:15px; } .reminder-rule-card { grid-template-columns:minmax(0,1fr); } }
@media(max-width:600px) { .page-heading { flex-direction:column; gap:14px; } .page-heading h1 { font-size:24px; } .heading-actions { width:100%; justify-content:space-between; } .config-tabs { gap:0; justify-content:space-between; } .config-tabs button { padding-inline:13px; } .group-config-card,.config-summary,.reminders-card { padding:18px; } .config-summary dl { grid-template-columns:1fr; } .keyword-header,.keyword-row { grid-template-columns:minmax(0,1fr) 60px 32px; padding:10px; gap:8px; } .keyword-row { font-size:12px; } .reminder-main-fields,.reminder-form.editing .reminder-main-fields { grid-template-columns:repeat(2,minmax(0,1fr)); } .reminder-topic { grid-column:1 / -1; } .reminder-form-actions { grid-column:1 / -1; } .save-bar { align-items:flex-start; flex-direction:column; } .save-bar > div { width:100%; justify-content:flex-end; } }

</style>
