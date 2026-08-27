<script setup lang="ts">
import { computed, onMounted, reactive, shallowRef } from "vue";

import AppIcon from "../components/AppIcon.vue";
import { api, type SkillDefinition, type SkillTtsConfig } from "../services/api";
import { useAppStore } from "../stores/app";

const app = useAppStore();
const loading = shallowRef(false);
const saving = shallowRef(false);
const form = reactive<SkillDefinition>(blankPersona());

function blankPersona(): SkillDefinition {
  return {
    id: "huixian",
    name: "会仙",
    systemPrompt: "",
    styleRules: [],
    knowledge: [],
    temperature: 0.78,
    maxContextTurns: 48,
    maxReplyCharsPerMessage: 500,
    maxTotalReplyChars: 3000,
    maxReplyMessages: 8,
    preferredMaxReplyMessages: 4,
    ttsConfig: {},
    exampleExchanges: [],
    stripAsterisks: false,
    singleSentencePerMessage: false,
    stripTerminalPunctuation: false,
    respectLineBreaks: true,
    allowBurstOnHighEmotion: true,
    highEmotionKeywords: [],
  };
}

function clonePersona(persona: SkillDefinition): SkillDefinition {
  return {
    ...blankPersona(),
    ...persona,
    id: "huixian",
    styleRules: [...persona.styleRules],
    knowledge: [...persona.knowledge],
    ttsConfig: { ...(persona.ttsConfig || {}) },
    highEmotionKeywords: [...(persona.highEmotionKeywords || [])],
    exampleExchanges: (persona.exampleExchanges || []).map((item) => ({ ...item })),
  };
}

function splitLines(value: string): string[] {
  return value.split("\n").map((item) => item.trim()).filter(Boolean);
}

function config(): SkillTtsConfig {
  form.ttsConfig ||= {};
  return form.ttsConfig;
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    Object.assign(form, clonePersona(await api<SkillDefinition>("/api/persona/huixian")));
  } catch (error) {
    app.showToast((error as Error).message, "error");
  } finally {
    loading.value = false;
  }
}

async function save(): Promise<void> {
  if (!form.name.trim() || !form.systemPrompt.trim()) {
    app.showToast("人格名称和身份说明不能为空", "error");
    return;
  }
  saving.value = true;
  try {
    const persona = await api<SkillDefinition>("/api/persona/huixian", {
      method: "PUT",
      body: JSON.stringify({
        ...form,
        id: "huixian",
        styleRules: [...form.styleRules],
        knowledge: [...form.knowledge],
        highEmotionKeywords: [...(form.highEmotionKeywords || [])],
        exampleExchanges: (form.exampleExchanges || []).map((item) => ({ ...item })),
      }),
    });
    Object.assign(form, clonePersona(persona));
    app.showToast("会仙人格已保存，新的对话会自动使用最新版本");
  } catch (error) {
    app.showToast((error as Error).message, "error");
  } finally {
    saving.value = false;
  }
}

function reset(): void {
  void load();
}

const ttsVoiceOptions = ["", "mimo_default", "冰糖", "茉莉", "苏打", "白桦", "Mia", "Chloe", "Milo", "Dean"];
const ttsDialectOptions = ["", "东北话", "四川话", "河南话", "粤语"];
const ttsPersonaToneOptions = ["", "夹子音", "御姐音", "正太音", "大叔音", "台湾腔"];
const exampleCount = computed(() => form.exampleExchanges?.length || 0);

function addExample(): void {
  form.exampleExchanges = [...(form.exampleExchanges || []), { user: "", assistant: "" }];
}

function removeExample(index: number): void {
  form.exampleExchanges = (form.exampleExchanges || []).filter((_, itemIndex) => itemIndex !== index);
}

onMounted(() => void load());
</script>

<template>
  <section class="persona-page">
    <div class="persona-hero panel">
      <div class="persona-mark">会</div>
      <div>
        <p class="eyebrow">唯一运行时人格</p>
        <h2>会仙人格</h2>
        <p>会仙是原创、成年的虚拟聊天伙伴。自然、温柔、有趣，但不会伪造照片、线下活动、现实身体或真实身份。</p>
      </div>
      <span class="tag">huixian</span>
    </div>

    <form class="persona-form" @submit.prevent="save">
      <section class="panel">
        <div class="section-head">
          <div>
            <h2>身份与边界</h2>
            <p>这里是会仙稳定人格的唯一来源。不要把真实个人资料、群聊原文、密码或第三方隐私写入人格设定。</p>
          </div>
        </div>
        <div class="form-grid">
          <label>显示名称<input v-model="form.name" class="input" maxlength="80" /></label>
          <label>语气温度<input v-model.number="form.temperature" class="input" type="number" min="0" max="2" step="0.05" /></label>
          <label>上下文轮数<input v-model.number="form.maxContextTurns" class="input" type="number" min="1" max="50" /></label>
          <label>普通回复偏好条数<input v-model.number="form.preferredMaxReplyMessages" class="input" type="number" min="1" max="20" /></label>
          <label class="wide">身份说明<textarea v-model="form.systemPrompt" class="textarea large" /></label>
          <label class="wide">表达规则<textarea class="textarea" :value="form.styleRules.join('\n')" placeholder="一行一条，例如：承接上下文，不重复自我介绍。" @input="form.styleRules = splitLines(($event.target as HTMLTextAreaElement).value)" /></label>
          <label class="wide">知识与诚实边界<textarea class="textarea" :value="form.knowledge.join('\n')" placeholder="一行一条，例如：没有真实私人照片或线下行程。" @input="form.knowledge = splitLines(($event.target as HTMLTextAreaElement).value)" /></label>
        </div>
      </section>

      <section class="panel">
        <div class="section-head">
          <div>
            <h2>回复节奏与语音</h2>
            <p>会仙可以轻松、俏皮或认真，但不以幼态、羞辱、操控或虚假承诺制造亲密感。</p>
          </div>
        </div>
        <div class="form-grid">
          <label>单条字数上限<input v-model.number="form.maxReplyCharsPerMessage" class="input" type="number" min="20" max="4000" /></label>
          <label>总字数上限<input v-model.number="form.maxTotalReplyChars" class="input" type="number" min="20" max="8000" /></label>
          <label>最多消息数<input v-model.number="form.maxReplyMessages" class="input" type="number" min="1" max="20" /></label>
          <label>TTS 音色<select v-model="config().voice" class="select"><option v-for="item in ttsVoiceOptions" :key="item" :value="item">{{ item || "跟随系统默认" }}</option></select></label>
          <label>方言<select v-model="config().dialect" class="select"><option v-for="item in ttsDialectOptions" :key="item" :value="item">{{ item || "不指定" }}</option></select></label>
          <label>声线风格<select v-model="config().personaTone" class="select"><option v-for="item in ttsPersonaToneOptions" :key="item" :value="item">{{ item || "不指定" }}</option></select></label>
          <label class="wide">TTS 风格提示<textarea v-model="config().stylePrompt" class="textarea compact" placeholder="描述稳定、自然的说话节奏；不要编造真人声线来源。" /></label>
        </div>
        <div class="switch-grid">
          <label><input v-model="form.respectLineBreaks" type="checkbox" /> 尊重换行</label>
          <label><input v-model="form.stripAsterisks" type="checkbox" /> 去除星号</label>
          <label><input v-model="form.allowBurstOnHighEmotion" type="checkbox" /> 高情绪时允许自然分段</label>
        </div>
      </section>

      <section class="panel">
        <div class="section-head">
          <div>
            <h2>示例对话 <span class="tag">{{ exampleCount }}</span></h2>
            <p>用少量典型场景校准会仙的语气。建议包含群聊圆场、照片/线下诚实回应和专业帮助，而不是大量固定口头禅。</p>
          </div>
          <button class="ghost-btn" type="button" @click="addExample">新增示例</button>
        </div>
        <div v-if="!exampleCount" class="empty">暂无示例对话。</div>
        <article v-for="(exchange, index) in form.exampleExchanges" :key="index" class="example-row">
          <label>用户<textarea v-model="exchange.user" class="textarea compact" /></label>
          <label>会仙<textarea v-model="exchange.assistant" class="textarea compact" /></label>
          <button class="ghost-btn danger" type="button" @click="removeExample(index)">删除</button>
        </article>
      </section>

      <div class="save-bar">
        <button class="btn" type="submit" :disabled="saving || loading"><AppIcon name="check" />{{ saving ? "保存中..." : "保存会仙人格" }}</button>
        <button class="ghost-btn" type="button" :disabled="saving || loading" @click="reset">重新读取</button>
      </div>
    </form>
  </section>
</template>

<style scoped>
.persona-page, .persona-form { display: grid; gap: 18px; }
.persona-hero { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 18px; align-items: center; }
.persona-hero h2, .persona-hero p { margin: 0; }
.persona-hero p { color: var(--muted); margin-top: 6px; max-width: 72ch; }
.persona-mark { display: grid; place-items: center; width: 68px; height: 68px; border-radius: 22px; background: linear-gradient(145deg, var(--accent), var(--purple)); color: white; font-size: 28px; font-weight: 900; }
.eyebrow { color: var(--accent-strong); font-weight: 800; }
.form-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }
.form-grid label { display: grid; gap: 8px; color: var(--muted); font-weight: 700; }
.wide { grid-column: 1 / -1; }
.large { min-height: 210px; }
.compact { min-height: 84px; }
.switch-grid { display: flex; flex-wrap: wrap; gap: 14px 24px; margin-top: 16px; }
.switch-grid label { display: flex; align-items: center; gap: 8px; color: var(--muted); font-weight: 700; }
.example-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto; gap: 12px; align-items: end; margin-top: 12px; }
.example-row label { display: grid; gap: 8px; color: var(--muted); font-weight: 700; }
.save-bar { display: flex; gap: 12px; position: sticky; bottom: 0; padding: 14px 0; background: color-mix(in oklch, var(--surface) 94%, transparent); }
.danger { color: var(--danger); }
@media (max-width: 980px) { .form-grid, .example-row, .persona-hero { grid-template-columns: 1fr; } }
</style>
