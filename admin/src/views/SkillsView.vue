<script setup lang="ts">
import { computed, onMounted, reactive, shallowRef } from "vue";

import AppIcon from "../components/AppIcon.vue";
import { api, type SkillDefinition, type SkillTtsConfig } from "../services/api";
import { useAppStore } from "../stores/app";

const app = useAppStore();
const skills = shallowRef<SkillDefinition[]>([]);
const selectedId = shallowRef("");
const editorOpen = shallowRef(false);
const restoreOpen = shallowRef(false);
const loading = shallowRef(false);
const saving = shallowRef(false);
const backupsLoading = shallowRef(false);
const query = shallowRef("");
const fileInput = shallowRef<HTMLInputElement>();
const backups = shallowRef<Array<{ id: string; createdAt: string; files: string[] }>>([]);
const form = reactive<SkillDefinition>(blankSkill());

const selected = computed(() => skills.value.find((item) => item.id === selectedId.value));
const filteredSkills = computed(() => {
  const q = query.value.trim().toLowerCase();
  return skills.value.filter((skill) => {
    if (!q) return true;
    return [
      skill.id,
      skill.name,
      skill.systemPrompt,
      ...skill.styleRules,
      ...skill.knowledge,
    ].some((value) => value.toLowerCase().includes(q));
  });
});
const jsonPreview = computed(() => JSON.stringify(buildSkillPayload(), null, 2));
const ttsVoiceOptions = ["mimo_default", "冰糖", "茉莉", "苏打", "白桦", "Mia", "Chloe", "Milo", "Dean"];
const ttsDialectOptions = ["东北话", "四川话", "河南话", "粤语"];
const ttsPersonaToneOptions = ["夹子音", "御姐音", "正太音", "大叔音", "台湾腔"];

function blankSkill(): SkillDefinition {
  return {
    id: "",
    name: "",
    systemPrompt: "",
    styleRules: [],
    knowledge: [],
    temperature: 0.7,
    maxContextTurns: 12,
    maxReplyCharsPerMessage: undefined,
    maxTotalReplyChars: undefined,
    maxReplyMessages: undefined,
    preferredMaxReplyMessages: undefined,
    ttsConfig: {},
    sourceSkillLines: [],
    exampleExchanges: [],
    stripAsterisks: true,
    singleSentencePerMessage: false,
    stripTerminalPunctuation: true,
    respectLineBreaks: true,
    allowBurstOnHighEmotion: false,
    highEmotionKeywords: [],
  };
}

function cloneSkill(skill: SkillDefinition): SkillDefinition {
  return {
    ...blankSkill(),
    ...skill,
    styleRules: [...skill.styleRules],
    knowledge: [...skill.knowledge],
    sourceSkillLines: [...(skill.sourceSkillLines || [])],
    ttsConfig: { ...(skill.ttsConfig || {}) },
    highEmotionKeywords: [...(skill.highEmotionKeywords || [])],
    exampleExchanges: (skill.exampleExchanges || []).map((item) => ({
      user: item.user,
      assistant: item.assistant,
    })),
  };
}

function fillForm(skill?: SkillDefinition): void {
  Object.assign(form, skill ? cloneSkill(skill) : blankSkill());
}

function buildSkillPayload(): SkillDefinition {
  return {
    ...form,
    styleRules: [...form.styleRules],
    knowledge: [...form.knowledge],
    sourceSkillLines: [...(form.sourceSkillLines || [])],
    ttsConfig: cleanTtsConfig(form.ttsConfig),
    highEmotionKeywords: [...(form.highEmotionKeywords || [])],
    exampleExchanges: (form.exampleExchanges || []).map((item) => ({ ...item })),
  };
}

function cleanTtsConfig(config: SkillTtsConfig | undefined): SkillTtsConfig {
  const next = Object.fromEntries(
    Object.entries(config || {}).filter(([key, value]) =>
      ["stylePrompt", "voice", "dialect", "personaTone"].includes(key) &&
      typeof value === "string" &&
      value.trim(),
    ),
  ) as SkillTtsConfig;
  return next;
}

function ttsConfig(): SkillTtsConfig {
  form.ttsConfig ||= {};
  return form.ttsConfig;
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const data = await api<{ skills: SkillDefinition[] }>("/api/skills");
    skills.value = data.skills;
    if (selectedId.value) {
      fillForm(skills.value.find((item) => item.id === selectedId.value));
    }
  } finally {
    loading.value = false;
  }
}

async function save(): Promise<void> {
  saving.value = true;
  try {
    const payload = buildSkillPayload();
    const isNew = !skills.value.some((item) => item.id === payload.id);
    const skill = await api<SkillDefinition>(isNew ? "/api/skills" : `/api/skills/${encodeURIComponent(payload.id)}`, {
      method: isNew ? "POST" : "PUT",
      body: JSON.stringify(payload),
    });
    selectedId.value = skill.id;
    await load();
    app.showToast(isNew ? "Skill 已创建" : "Skill 已保存");
  } catch (error) {
    app.showToast((error as Error).message, "error");
  } finally {
    saving.value = false;
  }
}

async function removeSkill(skill: SkillDefinition): Promise<void> {
  if (!confirm(`删除 Skill「${skill.name}」？`)) return;
  try {
    await api(`/api/skills/${encodeURIComponent(skill.id)}`, { method: "DELETE" });
    selectedId.value = "";
    await load();
    app.showToast("Skill 已删除");
  } catch (error) {
    app.showToast((error as Error).message, "error");
  }
}

async function exportSkill(skill: SkillDefinition): Promise<void> {
  const data = await api<{ raw: string }>(`/api/skills/export?id=${encodeURIComponent(skill.id)}`);
  downloadJson(`${skill.id || "skill"}.json`, data.raw);
  app.showToast("Skill JSON 已导出");
}

async function importRawSkill(raw: string): Promise<void> {
  if (!raw.trim()) return;
  try {
    const skill = await api<SkillDefinition>("/api/skills/import", {
      method: "POST",
      body: JSON.stringify({ raw }),
    });
    selectedId.value = skill.id;
    await load();
    app.showToast("Skill 已导入");
  } catch (error) {
    app.showToast((error as Error).message, "error");
  }
}

function openImportPicker(): void {
  fileInput.value?.click();
}

async function importSkillFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  try {
    await importRawSkill(await file.text());
  } finally {
    input.value = "";
  }
}

function downloadJson(filename: string, raw: string): void {
  const blob = new Blob([raw], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function backup(): Promise<void> {
  const data = await api<{ backupDir: string; files: string[] }>("/api/skills/backup", { method: "POST", body: "{}" });
  app.showToast(`已备份 ${data.files.length} 个 Skill`);
  if (restoreOpen.value) await loadBackups();
}

async function loadBackups(): Promise<void> {
  backupsLoading.value = true;
  try {
    const data = await api<{ backups: Array<{ id: string; createdAt: string; files: string[] }> }>("/api/skills/backups");
    backups.value = data.backups;
  } catch (error) {
    app.showToast((error as Error).message, "error");
  } finally {
    backupsLoading.value = false;
  }
}

async function openRestore(): Promise<void> {
  restoreOpen.value = true;
  await loadBackups();
}

async function restoreBackup(backupId: string): Promise<void> {
  if (!confirm(`恢复备份 ${backupId}？当前 skills 目录会先自动备份。`)) return;
  backupsLoading.value = true;
  try {
    const data = await api<{ restoredCount: number }>(`/api/skills/backups/${encodeURIComponent(backupId)}/restore`, {
      method: "POST",
      body: "{}",
    });
    await load();
    await loadBackups();
    app.showToast(`已恢复 ${data.restoredCount} 个 Skill`);
  } catch (error) {
    app.showToast((error as Error).message, "error");
  } finally {
    backupsLoading.value = false;
  }
}

function createNew(): void {
  selectedId.value = "";
  editorOpen.value = true;
  fillForm();
}

function duplicateAsNew(): void {
  const originalName = form.name || selected.value?.name || "Skill";
  fillForm({ ...buildSkillPayload(), id: "", name: `${originalName} 副本` });
  selectedId.value = "";
  editorOpen.value = true;
}

function duplicateSkill(skill: SkillDefinition): void {
  fillForm({ ...cloneSkill(skill), id: "", name: `${skill.name || skill.id} 副本` });
  selectedId.value = "";
  editorOpen.value = true;
}

function selectSkill(skill: SkillDefinition): void {
  selectedId.value = skill.id;
  editorOpen.value = true;
  fillForm(skill);
}

function splitLines(value: string): string[] {
  return value.split("\n").map((item) => item.trim()).filter(Boolean);
}

function optionalNumberValue(value: number | undefined): string {
  return value === undefined ? "" : String(value);
}

function updateOptionalNumber(key: "maxReplyCharsPerMessage" | "maxTotalReplyChars" | "maxReplyMessages" | "preferredMaxReplyMessages", value: string): void {
  const trimmed = value.trim();
  form[key] = trimmed ? Number(trimmed) : undefined;
}

function addExampleExchange(): void {
  form.exampleExchanges = [...(form.exampleExchanges || []), { user: "", assistant: "" }];
}

function removeExampleExchange(index: number): void {
  form.exampleExchanges = (form.exampleExchanges || []).filter((_, currentIndex) => currentIndex !== index);
}

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="skills-page">
    <div class="page-actions">
      <button class="btn" type="button" @click="createNew">
        <AppIcon name="plus" />
        创建 Skill
      </button>
      <input ref="fileInput" class="sr-only-file" type="file" accept="application/json,.json" @change="importSkillFile" />
      <button class="ghost-btn" type="button" @click="openImportPicker">
        <AppIcon name="candidate" />
        导入 JSON
      </button>
      <button class="ghost-btn" type="button" :disabled="!selected" @click="selected && exportSkill(selected)">
        <AppIcon name="memory" />
        导出当前
      </button>
      <button class="ghost-btn" type="button" @click="backup">
        <AppIcon name="health" />
        备份
      </button>
      <button class="ghost-btn" type="button" @click="openRestore">
        <AppIcon name="refresh" />
        恢复备份
      </button>
    </div>

    <section class="panel skills-table-panel">
      <div class="section-head">
        <div>
          <h2>技能模板</h2>
          <p>维护机器人运行时读取的 SkillDefinition JSON，保存后立即按系统配置生效。</p>
        </div>
        <span class="tag">{{ skills.length }} 个</span>
      </div>
      <div class="table-toolbar">
        <input v-model="query" class="input" placeholder="搜索名称、ID、提示词、规则或知识..." />
        <span class="muted">显示 {{ filteredSkills.length }} / {{ skills.length }}</span>
      </div>
      <div v-if="loading" class="empty">正在加载 Skills...</div>
      <div v-else class="skill-table">
        <div class="table-head">
          <span>技能名称</span>
          <span>ID</span>
          <span>温度</span>
          <span>上下文</span>
          <span>操作</span>
        </div>
        <article
          v-for="skill in filteredSkills"
          :key="skill.id"
          class="table-row"
          :class="{ active: selectedId === skill.id }"
          @click="selectSkill(skill)"
        >
          <strong>{{ skill.name }}</strong>
          <span class="mono">{{ skill.id }}</span>
          <span>{{ skill.temperature }}</span>
          <span>{{ skill.maxContextTurns }} 轮</span>
          <div class="row-actions">
            <button class="link-btn" type="button" @click.stop="duplicateSkill(skill)">复制 Skill</button>
            <button class="link-btn" type="button" @click.stop="exportSkill(skill)">导出</button>
            <button class="link-btn danger" type="button" @click.stop="removeSkill(skill)">删除</button>
          </div>
        </article>
        <div v-if="!filteredSkills.length" class="empty small-empty">没有匹配的 Skill。</div>
      </div>
    </section>

    <section v-if="editorOpen" class="panel editor-panel">
      <div class="section-head">
        <div>
          <h2>技能详情 / 编辑面板</h2>
          <p>字段严格按系统 SkillDefinition 保存，后端会校验 ID、提示词和参数范围。</p>
        </div>
      </div>

      <div class="form-block">
        <div class="block-title">
          <h3>基础信息</h3>
          <small>保存后写入 skills 目录下对应 JSON 文件</small>
        </div>
        <div class="form-grid">
          <label>ID<input v-model="form.id" class="input" :disabled="Boolean(selected)" placeholder="assistant" /></label>
          <label>名称<input v-model="form.name" class="input" placeholder="通用对话" /></label>
          <label>温度<input v-model.number="form.temperature" class="input" type="number" step="0.1" min="0" max="2" /></label>
          <label>上下文轮数<input v-model.number="form.maxContextTurns" class="input" type="number" min="1" max="50" /></label>
        </div>
      </div>

      <div class="form-block">
        <div class="block-title">
          <h3>提示词与知识</h3>
          <small>多行字段会按行拆分、去空行、保留顺序</small>
        </div>
        <div class="form-grid">
          <label class="wide">系统提示词<textarea v-model="form.systemPrompt" class="textarea large" placeholder="定义这个 Skill 的身份、边界和工作方式" /></label>
          <label class="wide">风格规则<textarea class="textarea large" :value="form.styleRules.join('\n')" placeholder="一行一条风格规则" @input="form.styleRules = splitLines(($event.target as HTMLTextAreaElement).value)" /></label>
          <label class="wide">知识片段<textarea class="textarea large" :value="form.knowledge.join('\n')" placeholder="一行一条知识片段" @input="form.knowledge = splitLines(($event.target as HTMLTextAreaElement).value)" /></label>
          <label class="wide">原始技能行<textarea class="textarea large" :value="(form.sourceSkillLines || []).join('\n')" placeholder="可选：保留迁移前的原始技能内容" @input="form.sourceSkillLines = splitLines(($event.target as HTMLTextAreaElement).value)" /></label>
        </div>
      </div>

      <div class="form-block">
        <div class="block-title">
          <h3>回复控制</h3>
          <small>留空表示不写入该可选字段，继续使用系统默认策略</small>
        </div>
        <div class="form-grid">
          <label>单条最长字符<input class="input" type="number" min="20" max="4000" :value="optionalNumberValue(form.maxReplyCharsPerMessage)" @input="updateOptionalNumber('maxReplyCharsPerMessage', ($event.target as HTMLInputElement).value)" /></label>
          <label>总回复字符<input class="input" type="number" min="20" max="8000" :value="optionalNumberValue(form.maxTotalReplyChars)" @input="updateOptionalNumber('maxTotalReplyChars', ($event.target as HTMLInputElement).value)" /></label>
          <label>最多消息数<input class="input" type="number" min="1" max="20" :value="optionalNumberValue(form.maxReplyMessages)" @input="updateOptionalNumber('maxReplyMessages', ($event.target as HTMLInputElement).value)" /></label>
          <label>偏好消息数<input class="input" type="number" min="1" max="20" :value="optionalNumberValue(form.preferredMaxReplyMessages)" @input="updateOptionalNumber('preferredMaxReplyMessages', ($event.target as HTMLInputElement).value)" /></label>
        </div>
        <div class="switch-grid">
          <label><input v-model="form.stripAsterisks" type="checkbox" /> 去除星号</label>
          <label><input v-model="form.singleSentencePerMessage" type="checkbox" /> 单句一条</label>
          <label><input v-model="form.stripTerminalPunctuation" type="checkbox" /> 去除句末标点</label>
          <label><input v-model="form.respectLineBreaks" type="checkbox" /> 尊重换行</label>
        </div>
      </div>

      <div class="form-block tts-form-block">
        <div class="block-title">
          <h3>语音与情绪</h3>
          <small>只维护稳定的整体风格、音色和口音，句子情绪由系统按语义自动处理</small>
        </div>
        <div class="form-grid">
          <label class="wide">整体 TTS 风格提示<textarea v-model="ttsConfig().stylePrompt" class="textarea compact" placeholder="例如：角色、场景、语速、停顿、共鸣位置和情绪起伏" /></label>
          <label>TTS 音色
            <select v-model="ttsConfig().voice" class="select">
              <option value="">跟随系统默认</option>
              <option v-for="item in ttsVoiceOptions" :key="item" :value="item">{{ item }}</option>
            </select>
          </label>
          <label>方言
            <select v-model="ttsConfig().dialect" class="select">
              <option value="">不指定</option>
              <option v-for="item in ttsDialectOptions" :key="item" :value="item">{{ item }}</option>
            </select>
          </label>
          <label>人设腔调
            <select v-model="ttsConfig().personaTone" class="select">
              <option value="">不指定</option>
              <option v-for="item in ttsPersonaToneOptions" :key="item" :value="item">{{ item }}</option>
            </select>
          </label>
          <label>高情绪关键词<textarea class="textarea compact" :value="(form.highEmotionKeywords || []).join('\n')" placeholder="一行一个关键词" @input="form.highEmotionKeywords = splitLines(($event.target as HTMLTextAreaElement).value)" /></label>
          <label class="wide switch-line"><input v-model="form.allowBurstOnHighEmotion" type="checkbox" /> 高情绪命中时允许多条回复</label>
        </div>
      </div>

      <div class="form-block">
        <div class="box-head">
          <div class="block-title flat">
            <h3>示例对话</h3>
            <small>用于约束模型模仿该 Skill 的对话风格</small>
          </div>
          <button class="ghost-btn" type="button" @click="addExampleExchange">新增示例</button>
        </div>
        <div v-if="!(form.exampleExchanges || []).length" class="empty small-empty">暂无示例对话。</div>
        <article v-for="(exchange, index) in form.exampleExchanges" :key="index" class="example-row">
          <label>用户<textarea v-model="exchange.user" class="textarea compact" /></label>
          <label>机器人<textarea v-model="exchange.assistant" class="textarea compact" /></label>
          <button class="ghost-btn danger" type="button" @click="removeExampleExchange(index)">删除</button>
        </article>
      </div>

      <div class="import-box">
        <div class="box-head">
          <h3>参数预览</h3>
          <span class="tag">SkillDefinition</span>
        </div>
        <pre class="json-preview">{{ jsonPreview }}</pre>
      </div>

      <div class="save-footer">
        <button class="btn" type="button" :disabled="saving" @click="save">
          <AppIcon name="check" />
          {{ saving ? "保存中..." : "保存修改" }}
        </button>
        <button class="ghost-btn" type="button" @click="duplicateAsNew">复制为新 Skill</button>
        <button class="ghost-btn" type="button" @click="selected ? fillForm(selected) : fillForm()">重置</button>
      </div>
    </section>

    <aside v-if="restoreOpen" class="modal-overlay" @click.self="restoreOpen = false">
      <section class="restore-modal panel" role="dialog" aria-modal="true">
        <div class="section-head">
          <div>
            <h2>恢复 Skill 备份</h2>
            <p>选择一个备份时间点恢复，恢复前系统会自动创建当前版本备份。</p>
          </div>
          <button class="icon-close" type="button" @click="restoreOpen = false">×</button>
        </div>
        <div v-if="backupsLoading" class="empty small-empty">正在读取备份...</div>
        <div v-else-if="!backups.length" class="empty small-empty">暂无备份。</div>
        <div v-else class="backup-list">
          <article v-for="backupItem in backups" :key="backupItem.id" class="backup-row">
            <div>
              <strong>{{ backupItem.id }}</strong>
              <span class="muted">{{ backupItem.createdAt }} · {{ backupItem.files.length }} 个文件</span>
            </div>
            <button class="btn" type="button" :disabled="backupsLoading" @click="restoreBackup(backupItem.id)">恢复</button>
          </article>
        </div>
      </section>
    </aside>
  </div>
</template>

<style scoped>
.skills-page {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 18px;
}

.page-actions {
  grid-column: 1 / -1;
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.sr-only-file {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
}

.row-actions,
.box-head,
.save-footer {
  display: flex;
  align-items: center;
  gap: 10px;
}

.row-actions {
  justify-content: flex-start;
  white-space: nowrap;
}

.skills-table-panel {
  min-height: 420px;
}

.table-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border-bottom: 1px solid var(--line);
  margin: 0 -22px;
  padding: 0 22px 18px;
}

.table-toolbar .input {
  max-width: 520px;
}

.skill-table {
  margin: 0 -22px;
  overflow: auto;
}

.table-head,
.table-row {
  display: grid;
  grid-template-columns: minmax(180px, 0.9fr) minmax(220px, 1fr) 86px 96px 180px;
  gap: 14px;
  align-items: center;
  min-height: 62px;
  border-bottom: 1px solid var(--line);
  padding: 0 22px;
}

.table-head {
  min-height: 48px;
  color: var(--muted);
  font-size: 13px;
  font-weight: 800;
  background: var(--surface-soft);
}

.table-row {
  cursor: pointer;
  background: var(--surface-raised);
}

.table-row strong,
.mono {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.table-row.active {
  background: color-mix(in oklch, var(--accent-soft) 62%, var(--surface-raised));
}

.mono {
  font-family: ui-monospace, "SFMono-Regular", Consolas, monospace;
  color: var(--muted);
}

.link-btn {
  background: transparent;
  color: var(--blue);
  font-weight: 800;
  padding: 0;
}

.editor-panel,
.form-block,
.form-grid,
.import-box {
  display: grid;
  gap: 14px;
}

.editor-panel {
  min-width: 0;
  max-width: none;
}

.editor-panel .section-head {
  display: grid;
}

.editor-panel .section-head p {
  max-width: 56ch;
}

.form-block {
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--surface-raised);
  padding: 16px;
}

.block-title {
  display: grid;
  gap: 5px;
}

.block-title.flat {
  gap: 4px;
}

.block-title h3,
.box-head h3 {
  margin: 0;
  font-size: 16px;
}

.block-title small {
  color: var(--muted);
}

.form-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.switch-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px 16px;
}

.switch-grid label,
.switch-line {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--muted);
  font-weight: 700;
}

.wide {
  grid-column: 1 / -1;
}

.large {
  min-height: 180px;
}

.compact {
  min-height: 88px;
}

.example-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
  gap: 12px;
  align-items: end;
}

.small-empty {
  min-height: 54px;
  padding: 14px;
}

.json-preview {
  overflow: auto;
  max-height: 180px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface-soft);
  color: var(--text);
  padding: 12px;
}

.box-head {
  justify-content: space-between;
}

.save-footer {
  position: sticky;
  bottom: 0;
  border-top: 1px solid var(--line);
  background: color-mix(in oklch, var(--surface) 95%, transparent);
  padding-top: 14px;
}

.modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 70;
  display: grid;
  place-items: start center;
  background: color-mix(in oklch, var(--text) 18%, transparent);
  padding: 10vh 16px 16px;
}

.restore-modal {
  width: min(620px, 100%);
  max-height: 78dvh;
  overflow: auto;
  background: var(--surface);
}

.backup-list {
  display: grid;
  gap: 10px;
}

.backup-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 12px;
  align-items: center;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--surface-raised);
  padding: 12px;
}

.backup-row div {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.backup-row strong,
.backup-row span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.icon-close {
  width: 34px;
  height: 34px;
  border-radius: 999px;
  background: var(--surface-soft);
  color: var(--muted);
  font-size: 22px;
}

.danger {
  color: var(--danger);
}

@media (max-width: 1180px) {
  .skills-page,
  .table-head,
  .table-row,
  .form-grid {
    grid-template-columns: 1fr;
  }

  .table-row {
    align-items: start;
    padding: 14px 22px;
  }
}

@media (max-width: 620px) {
  .switch-grid,
  .example-row {
    grid-template-columns: 1fr;
  }
}
</style>
