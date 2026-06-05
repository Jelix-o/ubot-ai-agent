<script setup lang="ts">
import { onMounted, reactive, shallowRef, watch } from "vue";
import { useRoute } from "vue-router";

import { useRefreshEvents } from "../composables/useRefreshEvents";
import { api, queryString, type KnowledgeEntry, type Pagination } from "../services/api";
import { useAppStore } from "../stores/app";
import { formatDateTime } from "../utils/format";

const route = useRoute();
const app = useAppStore();
const items = shallowRef<KnowledgeEntry[]>([]);
const pagination = reactive<Pagination>({ page: 1, pageSize: 20, total: 0, totalPages: 1 });
const query = shallowRef("");
const loading = shallowRef(false);
const editingId = shallowRef("");
const busyIds = shallowRef<Set<string>>(new Set());
const formVisible = shallowRef(false);
const importText = shallowRef("");
const importLoading = shallowRef(false);
const importCandidates = shallowRef<Array<{ title: string; question: string; answer: string; keywords: string[]; enabled?: boolean }>>([]);
const form = reactive({
  title: "",
  question: "",
  answer: "",
  keywordsText: "",
  enabled: true,
});

function isBusy(id: string): boolean {
  return busyIds.value.has(id);
}

function setBusy(id: string, busy: boolean): void {
  const next = new Set(busyIds.value);
  if (busy) next.add(id);
  else next.delete(id);
  busyIds.value = next;
}

function parseKeywords(text: string): string[] {
  return text.split(/[\n,，、\s]+/).map((item) => item.trim()).filter(Boolean);
}

function resetForm(): void {
  editingId.value = "";
  form.title = "";
  form.question = "";
  form.answer = "";
  form.keywordsText = "";
  form.enabled = true;
}

function startCreate(): void {
  resetForm();
  formVisible.value = true;
}

function startEdit(item: KnowledgeEntry): void {
  editingId.value = item.id;
  formVisible.value = true;
  form.title = item.title;
  form.question = item.question;
  form.answer = item.answer;
  form.keywordsText = item.keywords.join("\n");
  form.enabled = item.enabled;
}

async function load(): Promise<void> {
  if (!app.groupId) return;
  loading.value = true;
  try {
    const data = await api<{ entries: KnowledgeEntry[]; pagination: Pagination }>(`/api/knowledge${queryString({
      groupId: app.groupId,
      q: query.value,
      page: pagination.page,
      pageSize: pagination.pageSize,
    })}`);
    items.value = data.entries;
    Object.assign(pagination, data.pagination);
  } finally {
    loading.value = false;
  }
}

function applyFilters(): void {
  pagination.page = 1;
  void load().catch((error) => app.showToast(error.message, "error"));
}

async function save(): Promise<void> {
  if (!form.title.trim() || !form.question.trim() || !form.answer.trim()) {
    app.showToast("标题、问题和答案不能为空", "error");
    return;
  }
  const payload = {
    groupId: app.groupId,
    title: form.title.trim(),
    question: form.question.trim(),
    answer: form.answer.trim(),
    keywords: parseKeywords(form.keywordsText),
    enabled: form.enabled,
  };
  const id = editingId.value;
  if (id) setBusy(id, true);
  loading.value = !id;
  try {
    if (id) {
      await api<KnowledgeEntry>(`/api/knowledge/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
    } else {
      await api<KnowledgeEntry>("/api/knowledge", {
        method: "POST",
        body: JSON.stringify(payload),
      });
    }
    resetForm();
    formVisible.value = false;
    await load();
    app.showToast(id ? "FAQ 已保存" : "FAQ 已新建");
  } catch (error) {
    app.showToast((error as Error).message, "error");
  } finally {
    if (id) setBusy(id, false);
    loading.value = false;
  }
}

async function toggleEnabled(item: KnowledgeEntry): Promise<void> {
  setBusy(item.id, true);
  try {
    await api<KnowledgeEntry>(`/api/knowledge/${encodeURIComponent(item.id)}`, {
      method: "PUT",
      body: JSON.stringify({ enabled: !item.enabled }),
    });
    await load();
    app.showToast(item.enabled ? "FAQ 已禁用" : "FAQ 已启用");
  } catch (error) {
    app.showToast((error as Error).message, "error");
  } finally {
    setBusy(item.id, false);
  }
}

async function deleteOne(item: KnowledgeEntry): Promise<void> {
  if (!confirm(`删除 FAQ「${item.title}」？`)) return;
  setBusy(item.id, true);
  try {
    await api(`/api/knowledge/${encodeURIComponent(item.id)}`, { method: "DELETE" });
    await load();
    app.showToast("FAQ 已删除");
  } catch (error) {
    app.showToast((error as Error).message, "error");
  } finally {
    setBusy(item.id, false);
  }
}

async function previewImport(): Promise<void> {
  if (!app.groupId) return;
  if (!importText.value.trim()) {
    app.showToast("请先粘贴历史聊天记录", "error");
    return;
  }
  importLoading.value = true;
  try {
    const data = await api<{ candidates: Array<{ title: string; question: string; answer: string; keywords: string[]; enabled?: boolean }> }>("/api/knowledge/import/preview", {
      method: "POST",
      body: JSON.stringify({ groupId: app.groupId, text: importText.value }),
    });
    importCandidates.value = data.candidates;
    app.showToast(`提取到 ${data.candidates.length} 条 FAQ 候选`);
  } catch (error) {
    app.showToast((error as Error).message, "error");
  } finally {
    importLoading.value = false;
  }
}

async function applyImport(): Promise<void> {
  if (!app.groupId || !importCandidates.value.length) return;
  importLoading.value = true;
  try {
    const result = await api<{ createdCount: number; skippedCount?: number }>("/api/knowledge/import/apply", {
      method: "POST",
      body: JSON.stringify({ groupId: app.groupId, candidates: importCandidates.value }),
    });
    importText.value = "";
    importCandidates.value = [];
    await load();
    app.showToast(`导入完成：新增 ${result.createdCount} 条，跳过 ${result.skippedCount ?? 0} 条`);
  } catch (error) {
    app.showToast((error as Error).message, "error");
  } finally {
    importLoading.value = false;
  }
}

function onRefresh(): void {
  void load().catch((error) => app.showToast(error.message, "error"));
}

onMounted(() => {
  const q = typeof route.query.q === "string" ? route.query.q : "";
  if (q) query.value = q;
  void load();
});

useRefreshEvents({ refresh: onRefresh, groupChanged: onRefresh });

watch(() => [pagination.page, pagination.pageSize], () => {
  void load();
});
</script>

<template>
  <section class="panel">
    <div class="section-head">
      <div>
        <h2>知识库（FAQ）<span class="tag">{{ pagination.total }}</span></h2>
        <p>管理常见问题与标准答案，机器人会优先参考知识库内容回复。</p>
      </div>
      <button class="btn" type="button" @click="startCreate">新建 FAQ</button>
    </div>

    <div class="knowledge-toolbar">
      <input v-model="query" class="input" placeholder="搜索问题或关键词" @change="applyFilters" />
      <select v-model="pagination.pageSize" class="select">
        <option :value="10">10 条/页</option>
        <option :value="20">20 条/页</option>
        <option :value="50">50 条/页</option>
      </select>
      <button class="ghost-btn" type="button" @click="query = ''; applyFilters()">重置</button>
    </div>

    <section class="import-panel">
      <div class="section-head compact">
        <div>
          <h3>历史聊天导入</h3>
          <p>先从聊天记录里提取 FAQ 候选，确认后再写入知识库，避免原始聊天全文污染知识库。</p>
        </div>
        <div class="row-actions">
          <button class="ghost-btn" type="button" :disabled="importLoading" @click="previewImport">
            {{ importLoading ? "处理中..." : "提取候选" }}
          </button>
          <button class="btn" type="button" :disabled="importLoading || !importCandidates.length" @click="applyImport">导入候选</button>
        </div>
      </div>
      <textarea v-model="importText" class="textarea import-textarea" placeholder="粘贴群聊历史记录，建议包含问答上下文。"></textarea>
      <div v-if="importCandidates.length" class="import-candidates">
        <article v-for="candidate in importCandidates.slice(0, 5)" :key="`${candidate.title}:${candidate.question}`" class="import-candidate">
          <strong>{{ candidate.title }}</strong>
          <p>{{ candidate.question }}</p>
          <p class="answer">{{ candidate.answer }}</p>
          <div class="keyword-list">
            <span v-for="keyword in candidate.keywords" :key="keyword" class="tag">{{ keyword }}</span>
          </div>
        </article>
      </div>
    </section>

    <section v-if="formVisible" class="form-panel">
      <div class="section-head">
        <div>
          <h3>{{ editingId ? "编辑 FAQ" : "新增 FAQ" }}</h3>
          <p>标准答案应尽量明确、简短，可用关键词提升命中率。</p>
        </div>
      </div>
      <div class="form-grid">
        <label>标题<input v-model="form.title" class="input" /></label>
        <label>关键词<textarea v-model="form.keywordsText" class="textarea small" placeholder="一行一个，或用逗号分隔" /></label>
        <label class="wide">问题<textarea v-model="form.question" class="textarea small" /></label>
        <label class="wide">答案<textarea v-model="form.answer" class="textarea" /></label>
        <label class="check-line"><input v-model="form.enabled" type="checkbox" /> 启用</label>
      </div>
      <div class="row-actions">
        <button class="btn" type="button" :disabled="loading" @click="save">{{ editingId ? "保存 FAQ" : "创建 FAQ" }}</button>
        <button class="ghost-btn" type="button" :disabled="loading" @click="formVisible = false; resetForm()">取消</button>
      </div>
    </section>

    <div v-if="loading" class="empty">正在加载知识库...</div>
    <div v-else-if="!items.length" class="empty-state">
      <div class="empty-visual">FAQ</div>
      <div>
        <h3>知识库为空</h3>
        <p>还没有任何 FAQ 内容。可以手动新增 FAQ，帮助机器人更准确地回答群内问题。</p>
        <button class="btn" type="button" @click="startCreate">新建 FAQ</button>
      </div>
    </div>
    <div v-else class="faq-table">
      <div class="table-head">
        <span>问题</span>
        <span>关键词</span>
        <span>更新时间</span>
        <span>状态</span>
        <span>操作</span>
      </div>
      <article v-for="item in items" :key="item.id" class="table-row">
        <div>
          <strong>{{ item.title }}</strong>
          <p>{{ item.question }}</p>
          <p class="answer">{{ item.answer }}</p>
        </div>
        <div class="keyword-list">
          <span v-for="keyword in item.keywords" :key="keyword" class="tag">{{ keyword }}</span>
          <span v-if="!item.keywords.length" class="muted">无关键词</span>
        </div>
        <span>{{ formatDateTime(item.updatedAt || item.createdAt) }}</span>
        <span class="tag" :class="{ danger: !item.enabled }">{{ item.enabled ? "已启用" : "已禁用" }}</span>
        <div class="row-actions">
          <button class="ghost-btn" type="button" :disabled="isBusy(item.id)" @click="startEdit(item)">编辑</button>
          <button class="ghost-btn" type="button" :disabled="isBusy(item.id)" @click="toggleEnabled(item)">{{ item.enabled ? "禁用" : "启用" }}</button>
          <button class="ghost-btn danger" type="button" :disabled="isBusy(item.id)" @click="deleteOne(item)">删除</button>
        </div>
      </article>
    </div>

    <div class="pager">
      <button class="ghost-btn" type="button" :disabled="pagination.page <= 1" @click="pagination.page -= 1">上一页</button>
      <span class="muted">第 {{ pagination.page }} / {{ pagination.totalPages }} 页</span>
      <button class="ghost-btn" type="button" :disabled="pagination.page >= pagination.totalPages" @click="pagination.page += 1">下一页</button>
    </div>
  </section>
</template>

<style scoped>
.knowledge-toolbar {
  display: grid;
  grid-template-columns: minmax(260px, 1fr) 150px auto;
  gap: 12px;
  margin-bottom: 16px;
}

.import-panel {
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--surface-raised);
  padding: 18px;
  margin-bottom: 16px;
}

.compact {
  margin-bottom: 12px;
}

.import-textarea {
  min-height: 130px;
}

.import-candidates {
  display: grid;
  gap: 10px;
  margin-top: 12px;
}

.import-candidate {
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface-soft);
  padding: 12px;
}

.import-candidate strong,
.import-candidate p {
  margin: 0;
}

.import-candidate p {
  margin-top: 6px;
  color: var(--muted);
}

.form-panel {
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--surface-raised);
  padding: 18px;
  margin-bottom: 16px;
}

.form-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 260px;
  gap: 14px;
}

.form-grid label {
  display: grid;
  gap: 8px;
  color: var(--muted);
  font-weight: 700;
}

.wide {
  grid-column: 1 / -1;
}

.small {
  min-height: 82px;
}

.check-line {
  display: flex !important;
  align-items: center;
}

.empty-state {
  display: grid;
  grid-template-columns: 280px minmax(0, 1fr);
  align-items: center;
  gap: 34px;
  min-height: 310px;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--surface-raised);
  padding: 36px;
}

.empty-visual {
  display: grid;
  place-items: center;
  aspect-ratio: 1.35;
  border-radius: var(--radius-md);
  background: color-mix(in oklch, var(--accent-soft) 72%, var(--surface));
  color: var(--accent-strong);
  font-size: 36px;
  font-weight: 900;
}

.faq-table {
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  overflow: hidden;
}

.table-head,
.table-row {
  display: grid;
  grid-template-columns: minmax(280px, 1.4fr) minmax(180px, 0.8fr) minmax(160px, 0.7fr) 110px auto;
  gap: 16px;
  align-items: center;
  padding: 14px 16px;
}

.table-head {
  background: var(--surface-soft);
  color: var(--muted);
  font-weight: 800;
}

.table-row {
  border-top: 1px solid var(--line);
  background: var(--surface-raised);
}

.table-row strong,
.table-row p {
  margin: 0;
}

.table-row p {
  margin-top: 6px;
  color: var(--muted);
}

.answer {
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.keyword-list,
.row-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.row-actions .danger {
  color: var(--danger);
}

.pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 14px;
  margin-top: 18px;
}

@media (max-width: 1180px) {
  .knowledge-toolbar,
  .compact,
  .form-grid,
  .empty-state,
  .table-head,
  .table-row {
    grid-template-columns: 1fr;
  }

  .table-head {
    display: none;
  }
}
</style>
