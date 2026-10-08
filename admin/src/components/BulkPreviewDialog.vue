<script setup lang="ts">
import { computed } from "vue";
import AdminDialog from "./AdminDialog.vue";
const props = defineProps<{ preview: any; busy?: boolean }>();
defineEmits<{ close: []; execute: [] }>();
const expires = computed(() => new Date(props.preview.expiresAt).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai" }));
const labels: Record<string,string> = { enabled:"启用",tags:"标签",replyModelMode:"回复模型",participationMode:"参与方式",triggerKeywords:"触发词",deleted:"删除",onlineLookupEnabled:"实时查询",visionEnabled:"图片理解",ambientGroupContextEnabled:"短时语境",htmlPreviewEnabled:"网页生成",dailyReportEnabled:"日报",dailyReportTime:"日报时间",scheduledRemindersEnabled:"定时提醒",holidayCountdownEnabled:"节日倒计时",botMuted:"静音" };
function lines(value: any): string { if (value === null || value === undefined) return "—"; if (typeof value !== "object") return String(value); return Object.entries(value).map(([key,item]) => `${labels[key] || key}：${typeof item === 'boolean' ? item ? '是' : '否' : typeof item === 'object' ? JSON.stringify(item) : item}`).join("\n"); }
</script>
<template>
  <AdminDialog title="确认批量变更" :busy="busy" description="逐项检查变更后执行，结果将进入任务中心。" @close="$emit('close')">
    <div class="notice"><strong>{{ preview.targets.length }} 个目标</strong> · 预览有效至 {{ expires }}（北京时间）</div>
    <div class="table-wrap"><table><thead><tr><th>目标</th><th>当前值</th><th>变更后</th></tr></thead><tbody><tr v-for="target in preview.targets" :key="target.id"><td><strong>{{ target.label }}</strong><small class="muted block">{{ target.groupId || '全局' }}</small></td><td><pre class="diff-value">{{ lines(target.before) }}</pre></td><td><pre class="diff-value after">{{ lines(target.after) }}</pre></td></tr></tbody></table></div>
    <p class="muted">执行时会重新检查权限和版本。目标已变化或预览过期时，需要重新预览。</p>
    <template #footer><button class="ghost-btn" type="button" :disabled="busy" @click="$emit('close')">返回修改</button><button class="btn" type="button" :disabled="busy" @click="$emit('execute')">{{ busy ? '提交中…' : '确认并创建任务' }}</button></template>
  </AdminDialog>
</template>
