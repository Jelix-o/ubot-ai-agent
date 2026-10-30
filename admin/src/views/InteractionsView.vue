<script setup lang="ts">
import { onMounted, shallowRef, watch } from "vue";
import { api } from "../services/api";
import { useAppStore } from "../stores/app";
import { useRefreshEvents } from "../composables/useRefreshEvents";
import { formatDateTime } from "../utils/format";
interface Diagnostic { at:number; feature:string; reason:string; metrics:Record<string,number> }
interface Status { ambientEnabled:boolean; pokeEnabled:boolean; quietHours:boolean; pendingReply:boolean; botQuietRemainingSeconds:number; ambientRemainingSeconds:number; pokeProbabilityPercent:number; recent:Diagnostic[]; reasonLabels:Record<string,string> }
const app = useAppStore(), data = shallowRef<Status>(), loading = shallowRef(false), error = shallowRef("");
let serial = 0;
async function load() {
  const request = ++serial; data.value = undefined; error.value = "";
  if (!app.groupId) return;
  loading.value = true;
  try { const result = await api<Status>(`/api/interactions?groupId=${encodeURIComponent(app.groupId)}`); if (request === serial) data.value = result; }
  catch (e) { if (request === serial) error.value = (e as Error).message; }
  finally { if (request === serial) loading.value = false; }
}
const names:Record<string,string> = {meme:"表情",ambient:"读空气",poke:"回戳",audio:"语音"};
onMounted(load); watch(() => app.groupId,load); useRefreshEvents({refresh:()=>void load()});
</script>
<template>
  <section class="panel diagnostics">
    <div class="section-head"><div><h2>互动诊断</h2><p class="muted">查看本群互动条件及最近结果。仅保存状态与计数，最长保留七天。</p></div><button class="ghost-btn" :disabled="loading || !app.groupId" @click="load">刷新</button></div>
    <p v-if="!app.groupId" class="empty">请先选择一个群。</p>
    <p v-else-if="error" class="error-state" role="alert">{{ error }}</p>
    <p v-else-if="loading" class="empty">正在读取互动状态…</p>
    <template v-else-if="data">
      <dl class="conditions">
        <div><dt>读空气</dt><dd>{{ data.ambientEnabled ? '已开启' : '已关闭' }}</dd></div>
        <div><dt>机器人静默等待</dt><dd>{{ data.botQuietRemainingSeconds }} 秒</dd></div>
        <div><dt>主动接话冷却</dt><dd>{{ data.ambientRemainingSeconds }} 秒</dd></div>
        <div><dt>免打扰 01:00–07:00</dt><dd>{{ data.quietHours ? '当前生效' : '未生效' }}</dd></div>
        <div><dt>已有回复处理中</dt><dd>{{ data.pendingReply ? '是' : '否' }}</dd></div>
        <div><dt>回戳</dt><dd>{{ data.pokeEnabled ? `已开启 · ${data.pokeProbabilityPercent}%` : '已关闭' }}</dd></div>
      </dl>
      <p class="muted">读空气需要近两分钟至少三条有效消息、两位成员参与，机器人安静一分钟；每分钟最多判断一次。回戳会受随机概率和成员、群冷却约束。</p>
      <div v-if="data.recent.length" class="table-wrap"><table><thead><tr><th>时间</th><th>互动</th><th>结果与原因</th><th>计数</th></tr></thead><tbody><tr v-for="(item,index) in data.recent" :key="`${item.at}:${index}`"><td>{{ formatDateTime(new Date(item.at).toISOString()) }}</td><td>{{ names[item.feature] || item.feature }}</td><td>{{ data.reasonLabels[item.reason] || item.reason }}</td><td>{{ Object.entries(item.metrics).map(([k,v]) => `${k}: ${v}`).join(' · ') || '—' }}</td></tr></tbody></table></div>
      <p v-else class="empty">还没有互动诊断记录。新互动发生后会在这里显示。</p>
    </template>
  </section>
</template>
<style scoped>
.diagnostics{padding:24px}.conditions{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px;margin:24px 0}.conditions div{border-bottom:1px solid var(--line);padding-bottom:12px}dt{font-size:13px;color:var(--muted)}dd{margin:8px 0 0;font-size:19px;font-weight:600}.table-wrap{overflow-x:auto}table{width:100%;text-align:left;border-collapse:collapse}th,td{padding:12px;border-bottom:1px solid var(--line);white-space:nowrap}td:nth-child(3){white-space:normal;min-width:220px}@media(max-width:760px){.conditions{grid-template-columns:repeat(2,minmax(0,1fr))}.diagnostics{padding:16px}}
</style>
