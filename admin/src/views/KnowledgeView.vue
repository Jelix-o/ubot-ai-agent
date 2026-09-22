<script setup lang="ts">
import { computed, onMounted, reactive, shallowRef, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import { useRefreshEvents } from "../composables/useRefreshEvents";
import { api, queryString, type KnowledgeEntry, type Pagination } from "../services/api";
import { useAppStore } from "../stores/app";
import { formatDateTime } from "../utils/format";

const route = useRoute();
const router = useRouter();
const app = useAppStore();
const activeTab = shallowRef<"faq" | "ranking">(route.query.tab === "ranking" ? "ranking" : "faq");
interface RankingEntry {
  rank: number;
  name: string;
  province: string;
  revenueWan: number;
  headquarters?: { city: string; sourceUrl: string; asOf: string };
}
interface RankingMetadata {
  edition: number;
  revenueYear: number;
  publishedOn: string;
  rankingSource: string;
  screenshotSha256: string;
  rowsSha256: string;
  cityCoverage: number;
  cityReady: boolean;
  provinces: string[];
}
const rankingItems = shallowRef<RankingEntry[]>([]);
const rankingMetadata = shallowRef<RankingMetadata | null>(null);
const rankingPagination = reactive<Pagination>({ page: 1, pageSize: 20, total: 0, totalPages: 1 });
const rankingQuery = shallowRef("");
const rankingProvince = shallowRef("");
const rankingLoading = shallowRef(false);
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
const readonly = computed(() => app.readonly);
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

function ensureWritable(): boolean {
  if (!readonly.value) return true;
  app.showToast("只读模式不能修改知识库", "error");
  return false;
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
  if (!ensureWritable()) return;
  resetForm();
  formVisible.value = true;
}

function startEdit(item: KnowledgeEntry): void {
  if (!ensureWritable()) return;
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

async function loadRanking(): Promise<void> {
  rankingLoading.value = true;
  try {
    const data = await api<{ items: RankingEntry[]; metadata: RankingMetadata; pagination: Pagination }>(
      `/api/knowledge/rankings/2026${queryString({
        q: rankingQuery.value,
        province: rankingProvince.value,
        page: rankingPagination.page,
        pageSize: rankingPagination.pageSize,
      })}`,
    );
    rankingItems.value = data.items;
    rankingMetadata.value = data.metadata;
    Object.assign(rankingPagination, data.pagination);
  } catch (error) {
    app.showToast((error as Error).message, "error");
  } finally {
    rankingLoading.value = false;
  }
}

function applyRankingFilters(): void {
  rankingPagination.page = 1;
  void loadRanking();
}

function selectTab(tab: "faq" | "ranking"): void {
  activeTab.value = tab;
  void router.replace({ query: { ...route.query, tab: tab === "ranking" ? "ranking" : undefined } });
  if (tab === "ranking" && !rankingMetadata.value) void loadRanking();
}

async function save(): Promise<void> {
  if (!ensureWritable()) return;
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
  if (!ensureWritable()) return;
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
  if (!ensureWritable()) return;
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
  if (!ensureWritable()) return;
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
  if (!ensureWritable()) return;
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
  if (activeTab.value === "ranking") void loadRanking();
  else void load().catch((error) => app.showToast(error.message, "error"));
}

onMounted(() => {
  const q = typeof route.query.q === "string" ? route.query.q : "";
  if (q) query.value = q;
  if (activeTab.value === "ranking") void loadRanking();
  else void load();
});

useRefreshEvents({ refresh: onRefresh, groupChanged: onRefresh });

watch(() => [pagination.page, pagination.pageSize], () => {
  if (activeTab.value === "faq") void load();
});
watch(() => [rankingPagination.page, rankingPagination.pageSize], () => {
  if (activeTab.value === "ranking") void loadRanking();
});
watch(() => route.query.tab, (tab) => {
  activeTab.value = tab === "ranking" ? "ranking" : "faq";
  onRefresh();
});
</script>

<template>
  <nav class="knowledge-tabs" aria-label="知识库视图">
    <button type="button" :aria-current="activeTab === 'faq' ? 'page' : undefined" :class="{ active: activeTab === 'faq' }" @click="selectTab('faq')">群内 FAQ</button>
    <button type="button" :aria-current="activeTab === 'ranking' ? 'page' : undefined" :class="{ active: activeTab === 'ranking' }" @click="selectTab('ranking')">2026 民营企业 500 强</button>
  </nav>
  <section v-if="activeTab === 'faq'" class="panel">
    <div class="section-head">
      <div>
        <h2>知识库（FAQ）<span class="tag">{{ pagination.total }}</span></h2>
        <p>管理常见问题与标准答案，机器人会优先参考知识库内容回复。</p>
      </div>
      <button class="btn" type="button" :disabled="readonly" @click="startCreate">新建 FAQ</button>
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
          <button class="ghost-btn" type="button" :disabled="readonly || importLoading" @click="previewImport">
            {{ readonly ? "只读模式不可提取" : importLoading ? "处理中..." : "提取候选" }}
          </button>
          <button class="btn" type="button" :disabled="readonly || importLoading || !importCandidates.length" @click="applyImport">导入候选</button>
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
        <button class="btn" type="button" :disabled="readonly || loading" @click="save">{{ readonly ? "只读模式不可保存" : editingId ? "保存 FAQ" : "创建 FAQ" }}</button>
        <button class="ghost-btn" type="button" :disabled="loading" @click="formVisible = false; resetForm()">取消</button>
      </div>
    </section>

    <div v-if="loading" class="empty">正在加载知识库...</div>
    <div v-else-if="!items.length" class="empty-state">
      <div class="empty-visual">FAQ</div>
      <div>
        <h3>知识库为空</h3>
        <p>还没有任何 FAQ 内容。可以手动新增 FAQ，帮助机器人更准确地回答群内问题。</p>
        <button class="btn" type="button" :disabled="readonly" @click="startCreate">新建 FAQ</button>
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
          <button class="ghost-btn" type="button" :disabled="readonly || isBusy(item.id)" @click="startEdit(item)">编辑</button>
          <button class="ghost-btn" type="button" :disabled="readonly || isBusy(item.id)" @click="toggleEnabled(item)">{{ item.enabled ? "禁用" : "启用" }}</button>
          <button class="ghost-btn danger" type="button" :disabled="readonly || isBusy(item.id)" @click="deleteOne(item)">删除</button>
        </div>
      </article>
    </div>

    <div class="pager">
      <button class="ghost-btn" type="button" :disabled="pagination.page <= 1" @click="pagination.page -= 1">上一页</button>
      <span class="muted">第 {{ pagination.page }} / {{ pagination.totalPages }} 页</span>
      <button class="ghost-btn" type="button" :disabled="pagination.page >= pagination.totalPages" @click="pagination.page += 1">下一页</button>
    </div>
  </section>
  <section v-else class="panel ranking-panel">
    <div class="section-head">
      <div>
        <h2>2026 民营企业 500 强 <span class="tag">500</span></h2>
        <p>榜单省份与排名按 2025 年营业收入统计；总部城市为独立核验口径。</p>
      </div>
      <span class="tag">只读数据</span>
    </div>
    <div v-if="rankingMetadata" class="ranking-provenance">
      <span>发布：{{ rankingMetadata.publishedOn }}</span>
      <span>总部城市：{{ rankingMetadata.cityCoverage }}/500 已核验{{ rankingMetadata.cityReady ? '，可查询' : '，暂不开放精确统计' }}</span>
      <a :href="rankingMetadata.rankingSource" target="_blank" rel="noopener noreferrer">核对榜单来源</a>
      <span :title="rankingMetadata.screenshotSha256">截图校验：{{ rankingMetadata.screenshotSha256.slice(0, 12) }}…</span>
    </div>
    <div class="ranking-toolbar">
      <label>企业或名次<input v-model="rankingQuery" class="input" type="search" placeholder="搜索企业名称或名次" @change="applyRankingFilters" /></label>
      <label>榜单省份<select v-model="rankingProvince" class="select" @change="applyRankingFilters">
        <option value="">全部省份</option>
        <option v-for="province in rankingMetadata?.provinces ?? []" :key="province" :value="province">{{ province }}</option>
      </select></label>
      <label>每页<select v-model.number="rankingPagination.pageSize" class="select"><option :value="20">20 条</option><option :value="50">50 条</option></select></label>
      <button class="ghost-btn" type="button" @click="rankingQuery = ''; rankingProvince = ''; applyRankingFilters()">重置</button>
    </div>
    <div v-if="rankingLoading && !rankingMetadata" class="empty">正在加载榜单...</div>
    <div v-else-if="!rankingItems.length" class="empty">没有匹配的企业。</div>
    <div v-else class="ranking-table" :class="{ 'with-city': rankingMetadata?.cityReady }">
      <div class="ranking-row ranking-head"><span>名次</span><span>企业名称</span><span>榜单省份</span><span>营收（万元）</span><span v-if="rankingMetadata?.cityReady">总部城市</span></div>
      <div v-for="entry in rankingItems" :key="entry.rank" class="ranking-row">
        <span class="ranking-number">{{ entry.rank }}</span>
        <strong>{{ entry.name }}</strong>
        <span>{{ entry.province }}</span>
        <span class="ranking-revenue">{{ entry.revenueWan.toLocaleString('zh-CN') }}</span>
        <a v-if="rankingMetadata?.cityReady && entry.headquarters" :href="entry.headquarters.sourceUrl" target="_blank" rel="noopener noreferrer" :title="`核验截至 ${entry.headquarters.asOf}`">{{ entry.headquarters.city }}</a>
      </div>
    </div>
    <div class="pager">
      <button class="ghost-btn" type="button" :disabled="rankingPagination.page <= 1 || rankingLoading" @click="rankingPagination.page -= 1">上一页</button>
      <span class="muted">{{ rankingPagination.total }} 条 · 第 {{ rankingPagination.page }} / {{ rankingPagination.totalPages }} 页</span>
      <button class="ghost-btn" type="button" :disabled="rankingPagination.page >= rankingPagination.totalPages || rankingLoading" @click="rankingPagination.page += 1">下一页</button>
    </div>
  </section>
</template>

<style scoped>
.knowledge-tabs { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; border-bottom: 1px solid var(--line); }
.knowledge-tabs button { min-height: 44px; border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--muted); padding: 0 14px; font: inherit; cursor: pointer; }
.knowledge-tabs button.active { border-bottom-color: var(--accent); color: var(--text-strong); font-weight: 650; }
.knowledge-tabs button:focus-visible { outline: 2px solid var(--accent); outline-offset: -3px; }
.ranking-provenance { display: flex; flex-wrap: wrap; gap: 8px 20px; margin-bottom: 16px; color: var(--muted); font-size: 12.5px; }
.ranking-provenance a, .ranking-row a { color: var(--accent-strong); }
.ranking-toolbar { display: grid; grid-template-columns: minmax(220px, 1fr) minmax(150px, 210px) 120px auto; align-items: end; gap: 10px; margin-bottom: 14px; }
.ranking-toolbar label { display: grid; gap: 5px; color: var(--muted); font-size: 12.5px; font-weight: 650; }
.ranking-toolbar .ghost-btn { min-height: 38px; }
.ranking-table { border: 1px solid var(--line); border-radius: var(--radius-md); overflow: hidden; }
.ranking-row { display: grid; grid-template-columns: 72px minmax(260px, 1fr) minmax(110px, 0.4fr) minmax(140px, 0.4fr); align-items: center; gap: 12px; padding: 10px 14px; border-top: 1px solid var(--line); font-size: 13px; }
.ranking-row.with-city, .ranking-table.with-city .ranking-row { grid-template-columns: 72px minmax(230px, 1fr) minmax(100px, 0.35fr) minmax(130px, 0.4fr) minmax(110px, 0.35fr); }
.ranking-head { border-top: 0; background: var(--surface-soft); color: var(--muted); font-weight: 650; }
.ranking-number, .ranking-revenue { font-variant-numeric: tabular-nums; }
.ranking-row strong { min-width: 0; overflow-wrap: anywhere; color: var(--text-strong); font-weight: 650; }
.knowledge-toolbar {
  display: grid;
  grid-template-columns: minmax(260px, 1fr) 150px auto;
  gap: 10px;
  margin-bottom: 12px;
}

.import-panel {
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--surface);
  padding: 14px;
  margin-bottom: 12px;
}

.import-panel .section-head h3,
.form-panel .section-head h3 {
  font-size: 14px;
  font-weight: 650;
}

.compact {
  margin-bottom: 10px;
}

.import-textarea {
  min-height: 120px;
}

.import-candidates {
  display: grid;
  gap: 8px;
  margin-top: 10px;
}

.import-candidate {
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface-soft);
  padding: 12px 14px;
}

.import-candidate strong {
  margin: 0;
  font-size: 14px;
  font-weight: 650;
}

.import-candidate p {
  margin: 6px 0 0;
  color: var(--muted);
  font-size: 12.5px;
  line-height: 1.5;
}

.form-panel {
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--surface);
  padding: 14px;
  margin-bottom: 12px;
}

.form-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 260px;
  gap: 12px;
}

.form-grid label {
  display: grid;
  gap: 6px;
  color: var(--muted);
  font-size: 12.5px;
  font-weight: 650;
}

.wide {
  grid-column: 1 / -1;
}

.small {
  min-height: 78px;
}

.check-line {
  display: flex !important;
  align-items: center;
}

.empty-state {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr);
  align-items: center;
  gap: 24px;
  min-height: 220px;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--surface);
  padding: 24px;
}

.empty-state h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 650;
}

.empty-state p {
  margin: 6px 0 14px;
  color: var(--muted);
  font-size: 12.5px;
  line-height: 1.5;
}

.empty-visual {
  display: grid;
  place-items: center;
  aspect-ratio: 1.5;
  border: 1px solid color-mix(in oklch, var(--accent) 24%, var(--line));
  border-radius: var(--radius-md);
  background: color-mix(in oklch, var(--accent-soft) 55%, var(--surface));
  color: var(--accent-strong);
  font-size: 28px;
  font-weight: 700;
  letter-spacing: 0.04em;
}

.faq-table {
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  overflow: hidden;
  background: var(--surface);
}

.table-head,
.table-row {
  display: grid;
  grid-template-columns: minmax(280px, 1.4fr) minmax(180px, 0.8fr) minmax(150px, 0.7fr) 100px auto;
  gap: 12px;
  align-items: center;
  padding: 12px 14px;
}

.table-head {
  background: var(--surface-soft);
  color: var(--muted);
  font-size: 12.5px;
  font-weight: 650;
}

.table-row {
  border-top: 1px solid var(--line);
  background: var(--surface);
}

.table-row strong,
.table-row p {
  margin: 0;
}

.table-row strong {
  font-size: 14px;
  font-weight: 650;
  color: var(--text-strong);
}

.table-row p {
  margin-top: 4px;
  color: var(--muted);
  font-size: 12.5px;
  line-height: 1.5;
}

.table-row > span {
  color: var(--muted);
  font-size: 12.5px;
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
  gap: 6px;
}

.keyword-list .tag {
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-actions .danger {
  color: var(--danger);
}

.pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  margin-top: 14px;
}

.pager .ghost-btn {
  min-height: 30px;
  padding: 0 10px;
  font-size: 12px;
}

.pager .muted {
  font-size: 12.5px;
}

@media (max-width: 1180px) {
  .ranking-toolbar { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .ranking-row, .ranking-table.with-city .ranking-row { grid-template-columns: 54px minmax(0, 1fr); gap: 5px 12px; }
  .ranking-row > :nth-child(n + 3) { grid-column: 2; }
  .ranking-head { display: none; }
  .knowledge-toolbar,
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
@media (max-width: 600px) { .ranking-toolbar { grid-template-columns: 1fr; } }
</style>
