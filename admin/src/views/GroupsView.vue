<script setup lang="ts">
import { computed, onMounted, reactive, shallowRef, watch } from "vue";

import AppIcon from "../components/AppIcon.vue";
import DateRulePicker from "../components/DateRulePicker.vue";
import MultiTagSelect from "../components/MultiTagSelect.vue";
import { useRefreshEvents } from "../composables/useRefreshEvents";
import { api, queryString, type GroupConfig, type MemberProfile, type ModelOption, type Pagination, type ScheduleDateRule, type SchedulePreviewDay, type ScheduledReminderTask, type SkillOption } from "../services/api";
import { useAppStore } from "../stores/app";
import { formatDateTime } from "../utils/format";

const app = useAppStore();
const loading = shallowRef(false);
const saving = shallowRef(false);
const remindersLoading = shallowRef(false);
const manualIdentitiesText = shallowRef("[]");
const reminders = shallowRef<ScheduledReminderTask[]>([]);
const schedulePreview = shallowRef<SchedulePreviewDay[]>([]);
const replyModels = shallowRef<ModelOption[]>([]);
const skillOptions = shallowRef<SkillOption[]>([]);
const memberOptions = shallowRef<MemberProfile[]>([]);
const editingReminderId = shallowRef<string | null>(null);
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

const identityCount = computed(() => form.manualIdentities?.length || 0);
const currentReplyModelLabel = computed(() => replyModels.value.find((model) => model.id === form.replyModelMode)?.label || form.replyModelMode || "-");
const hasReplyModels = computed(() => replyModels.value.length > 0);
const skillSelectOptions = computed(() => skillOptions.value.map((skill) => ({
  value: skill.id,
  label: `${skill.name} / ${skill.id}`,
})));
const memberSelectOptions = computed(() => memberOptions.value.map((member) => ({
  value: member.userId,
  label: `${member.displayName} / ${member.userId}`,
  hint: member.note || member.role || undefined,
})));
const scheduleTimezone = computed(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai");
const scheduleEffectText = computed(() => [
  form.dailyReportEnabled ? `日报 ${form.dailyReportTime}` : undefined,
  form.holidayCountdownEnabled ? `节日倒计时 ${form.holidayCountdownTime}` : undefined,
  form.scheduledRemindersEnabled ? "定时提醒已启用" : undefined,
  `时区 ${scheduleTimezone.value}`,
].filter(Boolean).join(" · "));
const readonly = computed(() => app.readonly);
const reminderSubmitLabel = computed(() => editingReminderId.value ? "保存任务" : "添加任务");

function defaultGroupConfig(): GroupConfig {
  return {
    groupId: "",
    enabled: true,
    currentSkillId: "",
    replyModelMode: "gpt",
    allowedSkillIds: [],
    switcherUserIds: [],
    liveChatUserIds: [],
    manualIdentities: [],
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
    scheduledRemindersEnabled: true,
    blacklistedUserIds: [],
    opsAlertsEnabled: true,
    triggerKeywords: [{ keyword: "乘风", enabled: true }],
    voiceReplyEnabled: true,
    defaultVoiceReplyEnabled: false,
    memoryDisabledUserIds: [],
  };
}

function resetForm(data: GroupConfig): void {
  Object.assign(form, defaultGroupConfig(), data, {
    allowedSkillIds: [...(data.allowedSkillIds || [])],
    switcherUserIds: [...(data.switcherUserIds || [])],
    liveChatUserIds: [...(data.liveChatUserIds || [])],
    manualIdentities: [...(data.manualIdentities || [])],
    blacklistedUserIds: [...(data.blacklistedUserIds || [])],
    triggerKeywords: [...(data.triggerKeywords || [])],
    memoryDisabledUserIds: [...(data.memoryDisabledUserIds || [])],
    dailyReportDateRule: data.dailyReportDateRule || "all",
    dailyReportWeekdays: [...(data.dailyReportWeekdays || [])],
    holidayCountdownDateRule: data.holidayCountdownDateRule || "all",
    holidayCountdownWeekdays: [...(data.holidayCountdownWeekdays || [])],
  });
  reconcileReplyModelSelection();
}

async function load(): Promise<void> {
  if (!app.groupId) return;
  const groupId = app.groupId;
  const serial = ++loadSerial;
  loading.value = true;
  try {
    const [data] = await Promise.all([
      api<GroupConfig>(`/api/groups/${encodeURIComponent(groupId)}/config`),
      loadModelOptions(),
      loadSkillOptions(),
      loadMemberOptions(groupId),
    ]);
    if (serial !== loadSerial || groupId !== app.groupId) return;
    resetForm(data);
    manualIdentitiesText.value = JSON.stringify(data.manualIdentities || [], null, 2);
    await loadReminders(groupId, serial);
    await loadSchedulePreview(groupId, serial);
  } finally {
    if (serial === loadSerial) loading.value = false;
  }
}

async function loadSchedulePreview(groupId = app.groupId, serial = loadSerial): Promise<void> {
  if (!groupId) return;
  const data = await api<{ previews: SchedulePreviewDay[] }>(`/api/groups/${encodeURIComponent(groupId)}/schedule-preview?days=7`);
  if (serial === loadSerial && groupId === app.groupId) schedulePreview.value = data.previews;
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

async function loadSkillOptions(): Promise<void> {
  const data = await api<{ skills: SkillOption[] }>("/api/skill-options");
  skillOptions.value = data.skills;
}

async function loadMemberOptions(groupId = app.groupId): Promise<void> {
  if (!groupId) return;
  const data = await api<{ members: MemberProfile[]; pagination: Pagination }>(`/api/groups/${encodeURIComponent(groupId)}/members${queryString({
    includeNapcat: 1,
    page: 1,
    pageSize: 1000,
  })}`);
  if (groupId === app.groupId) memberOptions.value = data.members;
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
    app.showToast("普通用户只读模式不能保存群配置", "error");
    return;
  }
  saving.value = true;
  try {
    let manualIdentities: GroupConfig["manualIdentities"];
    try {
      manualIdentities = JSON.parse(manualIdentitiesText.value || "[]") as GroupConfig["manualIdentities"];
      if (!Array.isArray(manualIdentities)) throw new Error("not_array");
    } catch {
      app.showToast("人工身份 JSON 格式不正确", "error");
      return;
    }
    const payload = {
      ...form,
      manualIdentities,
      triggerKeywords: (form.triggerKeywords || []).filter((item) => item.keyword.trim()),
    };
    await api<GroupConfig>(`/api/groups/${encodeURIComponent(app.groupId)}/config`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    await app.loadGroups();
    app.showToast("群配置已保存");
    await load();
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
    app.showToast("普通用户只读模式不能修改定时任务", "error");
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
  if (!confirm(`删除定时任务「${reminder.topic}」？`)) return;
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

function onRefresh(): void {
  void load().catch((error) => app.showToast(error.message, "error"));
}

onMounted(() => {
  void load();
});

useRefreshEvents({ refresh: onRefresh, groupChanged: onRefresh });

watch(() => app.groupId, () => {
  void load();
});

watch(() => form.voiceReplyEnabled, (enabled) => {
  if (!enabled) {
    form.defaultVoiceReplyEnabled = false;
  }
});

watch(() => form.defaultVoiceReplyEnabled, (enabled) => {
  if (enabled && !form.voiceReplyEnabled) {
    form.defaultVoiceReplyEnabled = false;
  }
});
</script>

<template>
  <section class="page">
    <div class="group-top">
      <article class="panel group-picker">
        <label>
          选择群聊
          <select v-model="app.groupId" class="select">
            <option v-for="group in app.groups" :key="group.groupId" :value="group.groupId">群 {{ group.groupId }}</option>
          </select>
        </label>
        <span class="muted">仅允许编辑已有群配置，不新增或删除群。</span>
      </article>

      <article class="panel group-summary">
        <div class="summary-icon">群</div>
        <div>
          <h2>群 {{ form.groupId || app.groupId }}</h2>
          <span class="tag" :class="{ danger: form.enabled === false || form.botMuted }">{{ form.enabled === false ? "已隐藏" : form.botMuted ? "已静音" : "运行中" }}</span>
          <p>当前技能 {{ form.currentSkillId || "-" }} · 回复模型 {{ currentReplyModelLabel }}</p>
        </div>
        <dl>
          <div><dt>人工身份</dt><dd>{{ identityCount }} 条</dd></div>
          <div><dt>管理员</dt><dd>{{ form.switcherUserIds.length }} 人</dd></div>
          <div><dt>日报时间</dt><dd>{{ form.dailyReportTime || "-" }}</dd></div>
          <div><dt>触发词</dt><dd>{{ form.triggerKeywords?.filter((item) => item.enabled).length || 0 }} 个</dd></div>
        </dl>
      </article>
    </div>

    <form class="settings-grid" @submit.prevent="save">
      <section class="panel group-config-card">
        <h3>基础设置</h3>
        <div class="field-grid">
          <label class="switch-line"><input v-model="form.enabled" :disabled="readonly" type="checkbox" /> 显示并启用该群</label>
          <label>当前技能
            <select v-model="form.currentSkillId" class="select" :disabled="readonly">
              <option value="">未选择</option>
              <option v-for="skill in skillOptions" :key="skill.id" :value="skill.id">
                {{ skill.name }} / {{ skill.id }}
              </option>
            </select>
          </label>
          <label>回复模型
            <select v-model="form.replyModelMode" class="select" :disabled="readonly || !hasReplyModels">
              <option v-if="!hasReplyModels" value="">请先在系统设置启用对话模型</option>
              <option v-for="model in replyModels" :key="model.id" :value="model.id">
                {{ model.label }}
              </option>
            </select>
            <small class="muted">系统设置中启用的对话模型会同步进入群内 #模型 切换列表</small>
          </label>
          <label>实时对话延迟秒数<input v-model.number="form.liveChatDelaySeconds" class="input" type="number" min="0" :disabled="readonly" /></label>
          <label>日报人数<input v-model.number="form.dailyReportTopUserCount" class="input" type="number" min="1" :disabled="readonly" /></label>
          <label>日报时间<input v-model="form.dailyReportTime" class="input" type="time" :disabled="readonly" /></label>
          <label>节日倒计时时间<input v-model="form.holidayCountdownTime" class="input" type="time" :disabled="readonly" /></label>
        </div>
      </section>

      <section class="panel group-config-card">
        <h3>回复策略</h3>
        <label>允许技能 ID
          <MultiTagSelect v-model="form.allowedSkillIds" :options="skillSelectOptions" :disabled="readonly" placeholder="搜索技能名称或 ID" />
        </label>
        <div class="switch-grid">
          <label><input v-model="form.dailyReportEnabled" :disabled="readonly" type="checkbox" /> 群聊日报</label>
          <label><input v-model="form.holidayCountdownEnabled" :disabled="readonly" type="checkbox" /> 节日倒计时</label>
          <label><input v-model="form.scheduledRemindersEnabled" :disabled="readonly" type="checkbox" /> 定时提醒</label>
          <label><input v-model="form.opsAlertsEnabled" :disabled="readonly" type="checkbox" /> 运维告警</label>
          <label><input v-model="form.botMuted" :disabled="readonly" type="checkbox" /> 机器人静音</label>
          <label><input v-model="form.voiceReplyEnabled" :disabled="readonly" type="checkbox" /> 语音功能</label>
          <label class="voice-child" :class="{ disabled: !form.voiceReplyEnabled }">
            <input v-model="form.defaultVoiceReplyEnabled" :disabled="readonly || !form.voiceReplyEnabled" type="checkbox" /> 默认语音回复
          </label>
        </div>
      </section>

      <section class="panel group-config-card">
        <h3>触发关键词</h3>
        <div class="keyword-list">
          <div v-for="(item, index) in form.triggerKeywords" :key="index" class="keyword-row">
            <input v-model="item.keyword" class="input" placeholder="例如：乘风" :disabled="readonly" />
            <label class="mini-check"><input v-model="item.enabled" :disabled="readonly" type="checkbox" /> 启用</label>
            <button class="ghost-btn danger" type="button" :disabled="readonly" @click="removeTriggerKeyword(index)">删除</button>
          </div>
        </div>
        <button class="ghost-btn" type="button" :disabled="readonly" @click="addTriggerKeyword">新增关键词</button>
      </section>

      <section class="panel group-config-card">
        <h3>群管理</h3>
        <div class="field-grid">
          <label>管理员 QQ
            <MultiTagSelect v-model="form.switcherUserIds" :options="memberSelectOptions" :disabled="readonly" placeholder="搜索成员昵称或 QQ" />
          </label>
          <label>实时对话 QQ
            <MultiTagSelect v-model="form.liveChatUserIds" :options="memberSelectOptions" :disabled="readonly" placeholder="搜索成员昵称或 QQ" />
          </label>
          <label class="wide">黑名单 QQ
            <MultiTagSelect v-model="form.blacklistedUserIds" :options="memberSelectOptions" :disabled="readonly" placeholder="搜索成员昵称或 QQ" />
          </label>
          <label class="wide">禁用记忆收集成员 QQ
            <MultiTagSelect v-model="form.memoryDisabledUserIds" :options="memberSelectOptions" :disabled="readonly" placeholder="搜索成员昵称或 QQ" />
          </label>
        </div>
      </section>

      <section class="panel group-config-card schedule-card">
        <div class="schedule-head">
          <div class="schedule-title">
            <span class="schedule-icon"><AppIcon name="bell" /></span>
            <div>
              <h3>定时规则</h3>
              <p class="muted">配置日报、节日倒计时和定时提醒的基础参数与执行规则。</p>
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
              <AppIcon name="candidate" />
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
              <p class="muted">服务端按当前日报、节日倒计时和群定时任务规则计算。</p>
            </div>
            <button class="ghost-btn" type="button" @click="loadSchedulePreview()">刷新预览</button>
          </div>
          <div class="preview-days">
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
            <button class="btn reminder-new-top" type="button" :disabled="readonly" @click="resetReminderForm">新增任务</button>
          </div>
        </div>
        <div class="reminder-form" :class="{ editing: Boolean(editingReminderId) }">
          <div class="reminder-main-fields">
            <label class="reminder-topic">
              <span class="reminder-field-label">提醒内容</span>
              <input v-model="reminderForm.topic" class="input" placeholder="输入提醒内容，例如喝水、整理日报" :disabled="readonly" />
            </label>
            <label class="reminder-time">
              <span class="reminder-field-label">执行开始时间</span>
              <input v-model="reminderForm.executionStartTime" class="input" type="time" :disabled="readonly" />
            </label>
            <label class="reminder-time">
              <span class="reminder-field-label">执行结束时间</span>
              <input v-model="reminderForm.executionEndTime" class="input" type="time" :disabled="readonly" />
            </label>
            <label class="reminder-advance">
              <span class="reminder-field-label">执行间隔</span>
              <div class="suffix-input">
                <input v-model.number="reminderForm.executionIntervalMinutes" class="input interval-input" type="number" min="1" :disabled="readonly" />
                <span>分钟</span>
              </div>
            </label>
            <label class="reminder-toggle-field">
              <span>启用</span>
              <span class="toggle-switch">
                <input v-model="reminderForm.enabled" :disabled="readonly" type="checkbox" />
                <i></i>
              </span>
            </label>
            <div class="reminder-form-actions">
              <button class="btn reminder-add" type="button" :disabled="readonly || remindersLoading" @click="submitReminder">{{ readonly ? "只读模式" : reminderSubmitLabel }}</button>
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
              :disabled="readonly"
            />
          </section>
        </div>
        <div v-if="remindersLoading" class="empty compact">正在加载定时任务...</div>
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

      <section class="panel json-card">
        <div class="section-head">
          <div>
            <h3>人工身份 JSON</h3>
            <p>配置机器人理解成员身份的信息，影响回复风格与画像归属。</p>
          </div>
        </div>
        <textarea v-model="manualIdentitiesText" class="textarea json-editor" spellcheck="false" :readonly="readonly" />
      </section>

      <div class="save-bar">
        <button class="btn" type="submit" :disabled="readonly || loading || saving">{{ readonly ? "只读模式不可保存" : saving ? "保存中..." : "保存群配置" }}</button>
        <button class="ghost-btn" type="button" :disabled="loading || saving" @click="load">重新读取</button>
        <span class="muted">保存后机器人会按最新配置运行。</span>
      </div>
    </form>
  </section>
</template>

<style scoped>
.group-top {
  display: grid;
  grid-template-columns: 280px minmax(0, 1fr);
  gap: 18px;
}

.group-picker {
  display: grid;
  gap: 10px;
}

.group-picker label,
.group-config-card label,
.json-card label {
  display: grid;
  gap: 8px;
  font-weight: 800;
}

.group-summary {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) minmax(320px, 0.9fr);
  gap: 22px;
  align-items: center;
}

.summary-icon {
  display: grid;
  place-items: center;
  width: 72px;
  height: 72px;
  border-radius: 50%;
  background: var(--accent-soft);
  color: var(--accent-strong);
  font-weight: 900;
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
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.switch-grid label {
  display: flex;
  align-items: center;
  gap: 8px;
}

.switch-grid .voice-child {
  margin-left: 18px;
  color: var(--muted);
}

.switch-grid .voice-child.disabled {
  opacity: 0.58;
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
  font-weight: 900;
  box-shadow: 0 8px 18px oklch(0.48 0.04 220 / 5%);
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
  gap: 10px;
  color: var(--muted);
  font-size: 14px;
  font-weight: 900;
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
  color: var(--text);
  font-size: 15px;
  font-weight: 900;
}

.reminder-rule-head small {
  color: var(--muted);
  font-size: 13px;
  font-weight: 700;
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
  box-shadow: 0 2px 7px oklch(0.35 0.04 220 / 22%);
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
  font-size: 14px;
  font-weight: 900;
}

.reminder-row {
  min-height: 58px;
  background: var(--surface);
  font-size: 14px;
  font-weight: 800;
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
  padding: 7px 14px;
  font-size: 13px;
  font-weight: 900;
  white-space: nowrap;
}

.rule-tag.all,
.rule-tag.workday {
  background: var(--accent-soft);
  color: var(--accent-strong);
}

.rule-tag.holiday {
  background: color-mix(in oklch, var(--blue) 14%, var(--surface));
  color: var(--blue);
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
  padding: 7px 14px;
  font-size: 13px;
  font-weight: 900;
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
  color: var(--blue);
  font-weight: 900;
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
</style>


