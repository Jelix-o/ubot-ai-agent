<script setup lang="ts">
import { computed, onMounted, reactive, shallowRef } from "vue";
import { api } from "../services/api";
import { useAppStore } from "../stores/app";
import { useUnsavedChanges } from "../composables/useUnsavedChanges";
import { useRefreshEvents } from "../composables/useRefreshEvents";
import { confirmAction } from "../composables/useConfirm";
import { formatDateTime } from "../utils/format";
interface Settings { enabled:boolean; automaticVoiceEnabled:boolean; hasApiKey:boolean; revision:string; model:string; dailySeconds:number }
interface Usage { day:string; chargedSeconds:number; reservedSeconds:number; queued:number; running:number; recent:Array<{id:string;groupId:string;kind:string;status:string;createdAt:number;chargedSeconds?:number;errorCode?:string}> }
const app=useAppStore(), settings=shallowRef<Settings>(), usage=shallowRef<Usage>(), loading=shallowRef(false), saving=shallowRef(false), error=shallowRef("");
const form=reactive({enabled:false,automaticVoiceEnabled:true,apiKey:"",clearKey:false});
const dirty=computed(() => Boolean(settings.value) && (form.enabled!==settings.value?.enabled || form.automaticVoiceEnabled!==settings.value?.automaticVoiceEnabled || Boolean(form.apiKey) || form.clearKey));
useUnsavedChanges(dirty);
async function load() {
  loading.value=true;error.value="";
  try { const [s,u]=await Promise.all([api<Settings>("/api/audio/settings"),api<Usage>("/api/audio/usage")]);settings.value=s;usage.value=u;Object.assign(form,{enabled:s.enabled,automaticVoiceEnabled:s.automaticVoiceEnabled,apiKey:"",clearKey:false}); }
  catch(e){error.value=(e as Error).message;} finally{loading.value=false;}
}
async function save() {
  if(!settings.value) return;saving.value=true;error.value="";
  try { settings.value=await api<Settings>("/api/audio/settings",{method:"PUT",body:JSON.stringify({expectedRevision:settings.value.revision,enabled:form.enabled,automaticVoiceEnabled:form.automaticVoiceEnabled,...(form.clearKey ? {apiKey:""} : form.apiKey ? {apiKey:form.apiKey} : {})})});form.apiKey="";form.clearKey=false;app.showToast("音频设置已保存"); }
  catch(e){error.value=(e as Error).message;} finally{saving.value=false;}
}
async function testAudio() {
  if(!app.groupId || !await confirmAction({title:"向当前群发送测试语音",message:"将真实调用音频服务并发送一条测试语音，计入每日预算。请先在群配置中开启语音。",confirmText:"调用并发送"}))return;
  try{await api("/api/audio/test",{method:"POST",body:JSON.stringify({groupId:app.groupId,requestId:crypto.randomUUID()})});app.showToast("测试已加入音频队列");}catch(e){error.value=(e as Error).message;}
}
onMounted(load);useRefreshEvents({refresh:()=>{if(!dirty.value)void load();}});
const statusNames:Record<string,string>={queued:"等待生成",running:"正在生成",queued_delivery:"等待发送",succeeded:"已发送",failed:"失败",unknown:"结果未确认",skipped:"已跳过"};
</script>
<template>
  <div class="audio-page">
    <section class="panel audio-settings">
      <div class="section-head"><div><h2>音频服务</h2><p class="muted">豆包 seed-audio-1.0 · 语音回复与原创短歌共用独立额度。</p></div><button class="btn" :disabled="!dirty || loading || saving" @click="save">{{ saving ? '保存中…' : '保存设置' }}</button></div>
      <p v-if="error" class="error-state" role="alert">{{ error }}</p>
      <p v-if="loading" class="empty">正在读取音频设置…</p>
      <template v-else-if="settings">
        <label class="switch-line"><span><strong>启用音频服务</strong><small>群内语音和唱歌仍需要分别开启群开关。</small></span><input v-model="form.enabled" type="checkbox" aria-label="启用音频服务" /></label>
        <label class="switch-line"><span><strong>允许偶尔语音</strong><small>短闲聊有 10% 概率附加语音，每群间隔五分钟；北京时间 01:00–07:00 暂停。字幕先发送。</small></span><input v-model="form.automaticVoiceEnabled" type="checkbox" aria-label="允许偶尔语音" /></label>
        <label class="key-field">独立音频 API Key<input v-model="form.apiKey" class="input" type="password" autocomplete="new-password" spellcheck="false" :placeholder="settings.hasApiKey ? '已配置；留空保留现有密钥' : '输入豆包语音新版控制台的 API Key'" :disabled="form.clearKey" /><small class="muted">使用 X-Api-Key；与聊天模型密钥分开保存，加密存储，读取接口不返回密钥。</small></label>
        <label v-if="settings.hasApiKey" class="mini-check"><input v-model="form.clearKey" type="checkbox" @change="form.clearKey && (form.enabled=false)" /> 删除已保存密钥并关闭服务</label>
        <div class="actions"><button class="ghost-btn" :disabled="!app.groupId || !settings.enabled || dirty" @click="testAudio">向当前群发送测试语音</button><a href="https://docs.volcengine.com/docs/doubao-voice/audio-generation-http?lang=zh" target="_blank" rel="noopener noreferrer">查看接入说明</a></div>
      </template>
    </section>
    <section v-if="usage" class="panel audio-settings">
      <div class="section-head"><div><h2>今日用量</h2><p class="muted">{{ usage.day }} · 北京时间换日 · 共 30 分钟／天；每群 20 条语音、3 首短歌。</p></div><button class="ghost-btn" :disabled="dirty || loading" @click="load">刷新</button></div>
      <div class="usage"><p><strong>{{ usage.chargedSeconds }}</strong> 秒已确认</p><p><strong>{{ usage.reservedSeconds }}</strong> 秒预留或未确认</p><p><strong>{{ usage.running }} / {{ usage.queued }}</strong> 生成中／等待中</p></div>
      <p class="muted">每次先预留最多 120 秒，再按原始时长结算；超时或断线不会自动重试，未确认的预留保留至当日结束。原始音频最多保留 24 小时，确认发送后清理。</p>
      <div v-if="usage.recent.length" class="table-wrap"><table><thead><tr><th>时间</th><th>群</th><th>类型</th><th>状态</th><th>用量／错误</th></tr></thead><tbody><tr v-for="job in usage.recent" :key="job.id"><td>{{ formatDateTime(new Date(job.createdAt).toISOString()) }}</td><td>{{ job.groupId }}</td><td>{{ job.kind==='song'?'短歌':'语音' }}</td><td>{{ statusNames[job.status] || job.status }}</td><td>{{ job.errorCode || (job.chargedSeconds===undefined?'—':`${job.chargedSeconds} 秒`) }}</td></tr></tbody></table></div>
      <p v-else class="empty">还没有音频调用记录。</p>
    </section>
  </div>
</template>
<style scoped>
.switch-line{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:18px 0;border-bottom:1px solid var(--line)}.switch-line>span{display:grid;gap:6px;min-width:0}.switch-line small{display:block;line-height:1.6;color:var(--muted)}.switch-line input{flex:none;width:18px;height:18px;accent-color:var(--accent)}.mini-check{display:flex;align-items:center;gap:8px;line-height:1.6}
.audio-page{display:grid;gap:20px}.audio-settings{padding:24px}.key-field{display:grid;gap:8px;margin:24px 0 12px}.actions{display:flex;align-items:center;gap:20px;flex-wrap:wrap;margin-top:24px}.usage{display:flex;gap:40px;flex-wrap:wrap}.usage strong{font-size:24px}.table-wrap{overflow-x:auto}table{width:100%;border-collapse:collapse;text-align:left}th,td{padding:12px;border-bottom:1px solid var(--line);white-space:nowrap}@media(max-width:760px){.audio-settings{padding:16px}.usage{gap:16px}}
</style>
