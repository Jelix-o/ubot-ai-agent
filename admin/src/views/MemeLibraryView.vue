<script setup lang="ts">
import { computed, onMounted, reactive, shallowRef } from "vue";

import { api, type MemeAsset, type MemeLibraryPolicy, type MemeLibrarySnapshot, type MemeScope, type MemeTag } from "../services/api";
import { useAppStore } from "../stores/app";
import { formatDateTime } from "../utils/format";

const app = useAppStore();
const loading = shallowRef(false);
const savingPolicy = shallowRef(false);
const uploading = shallowRef(false);
const savingAsset = shallowRef(false);
const deletingAssetId = shallowRef("");
const creatingTag = shallowRef(false);
const savingTagId = shallowRef("");
const deletingTagId = shallowRef("");
const selectedAssetId = shallowRef("");
const scopeFilter = shallowRef<"all" | MemeScope>("all");
const selectedFile = shallowRef<File>();
const MAX_TAG_KEYWORDS = 30;
const MAX_TAG_KEYWORD_LENGTH = 64;

const policy = reactive<MemeLibraryPolicy>({
  enabled: true,
  probabilityPercent: 30,
  cooldownSeconds: 600,
});
const tags = shallowRef<MemeTag[]>([]);
const assets = shallowRef<MemeAsset[]>([]);
const tagForm = reactive({ name: "", description: "", keywords: "" });
const tagEditingId = shallowRef("");
const tagEditForm = reactive({ name: "", description: "", keywords: "" });
const assetForm = reactive({ name: "", scope: "normal_chat" as MemeScope, tags: [] as string[], enabled: true });

const selectedAsset = computed(() => assets.value.find((asset) => asset.id === selectedAssetId.value));
const filteredAssets = computed(() => scopeFilter.value === "all"
  ? assets.value
  : assets.value.filter((asset) => asset.scope === scopeFilter.value));
const normalAssetCount = computed(() => assets.value.filter((asset) => asset.scope === "normal_chat").length);
const blacklistAssetCount = computed(() => assets.value.filter((asset) => asset.scope === "blacklisted_at").length);
const selectedScopeIsBlacklist = computed(() => assetForm.scope === "blacklisted_at");

function resetAssetForm(asset?: MemeAsset): void {
  if (asset) {
    assetForm.name = asset.name;
    assetForm.scope = asset.scope;
    assetForm.tags = [...asset.tags];
    assetForm.enabled = asset.enabled;
    return;
  }
  assetForm.name = "";
  assetForm.scope = "normal_chat";
  assetForm.tags = [];
  assetForm.enabled = true;
}

function applySnapshot(snapshot: MemeLibrarySnapshot): void {
  Object.assign(policy, snapshot.policy);
  tags.value = snapshot.tags;
  assets.value = snapshot.assets;
  const selected = snapshot.assets.find((asset) => asset.id === selectedAssetId.value);
  if (selected) {
    resetAssetForm(selected);
  } else {
    selectedAssetId.value = "";
    resetAssetForm();
  }
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    applySnapshot(await api<MemeLibrarySnapshot>("/api/meme-library"));
  } catch (error) {
    app.showToast(actionError(error), "error");
  } finally {
    loading.value = false;
  }
}

function actionError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const messages: Record<string, string> = {
    recent_mfa_required: "此操作需要近期 MFA 验证，请先到“账号与安全”完成验证。",
    meme_tag_keywords_required: "请至少填写一个触发关键词。",
    meme_tag_keywords_invalid: "触发关键词格式无效，请检查后重试。",
    meme_asset_tags_required: "普通对话素材至少选择一个标签。",
    meme_tag_in_use: "该标签仍被普通素材使用，请先修改素材关联后再删除。",
  };
  return messages[message] || message;
}

function normalizeKeywords(value: string): string[] {
  const seen = new Set<string>();
  for (const item of value.normalize("NFKC").split(/[\n\r,]+/)) {
    const keyword = item.trim().replace(/\s+/g, " ").toLocaleLowerCase("zh-CN");
    if (keyword) seen.add(keyword);
  }
  return [...seen];
}

function validateKeywords(value: string): string[] | undefined {
  const keywords = normalizeKeywords(value);
  if (!keywords.length) {
    app.showToast("请至少填写一个触发关键词", "error");
    return undefined;
  }
  if (keywords.length > MAX_TAG_KEYWORDS || keywords.some((keyword) => keyword.length > MAX_TAG_KEYWORD_LENGTH)) {
    app.showToast(`触发关键词最多 ${MAX_TAG_KEYWORDS} 个，每个最多 ${MAX_TAG_KEYWORD_LENGTH} 个字符`, "error");
    return undefined;
  }
  return keywords;
}

function keywordsText(keywords: string[]): string {
  return keywords.join(", ");
}

function scopeLabel(scope: MemeScope): string {
  return scope === "blacklisted_at" ? "黑名单 @ 专用" : "普通对话";
}

function scopeClass(scope: MemeScope): string {
  return scope === "blacklisted_at" ? "danger" : "";
}

function tagLabel(id: string): string {
  return tags.value.find((tag) => tag.id === id)?.name || id;
}

function previewUrl(asset: MemeAsset): string {
  return `/api/meme-library/assets/${encodeURIComponent(asset.id)}/preview`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

async function savePolicy(): Promise<void> {
  savingPolicy.value = true;
  try {
    const next = await api<MemeLibraryPolicy>("/api/meme-library/policy", {
      method: "PUT",
      body: JSON.stringify({
        enabled: policy.enabled,
        probabilityPercent: Math.max(0, Math.min(100, Number(policy.probabilityPercent) || 0)),
        cooldownSeconds: Math.max(0, Math.min(86_400, Number(policy.cooldownSeconds) || 0)),
      }),
    });
    Object.assign(policy, next);
    app.showToast("表情包随机策略已保存");
  } catch (error) {
    app.showToast(actionError(error), "error");
  } finally {
    savingPolicy.value = false;
  }
}

function selectAsset(asset: MemeAsset): void {
  selectedAssetId.value = asset.id;
  resetAssetForm(asset);
}

function clearAssetSelection(): void {
  selectedAssetId.value = "";
  resetAssetForm();
}

function onUploadFile(event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  selectedFile.value = file;
  if (file && !assetForm.name.trim()) {
    assetForm.name = file.name.replace(/\.[^.]+$/, "").slice(0, 100);
  }
}

function toggleUploadTag(tagId: string): void {
  assetForm.tags = assetForm.tags.includes(tagId)
    ? assetForm.tags.filter((id) => id !== tagId)
    : [...assetForm.tags, tagId];
}

async function upload(): Promise<void> {
  const file = selectedFile.value;
  if (!file) {
    app.showToast("请选择一张图片", "error");
    return;
  }
  if (!assetForm.name.trim()) {
    app.showToast("请填写素材名称", "error");
    return;
  }
  if (assetForm.scope === "normal_chat" && !assetForm.tags.length) {
    app.showToast("普通对话素材至少选择一个标签", "error");
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    app.showToast("单张图片不能超过 5 MiB", "error");
    return;
  }

  uploading.value = true;
  try {
    const params = new URLSearchParams({
      name: assetForm.name.trim(),
      scope: assetForm.scope,
      enabled: assetForm.enabled ? "1" : "0",
    });
    for (const tagId of assetForm.scope === "normal_chat" ? assetForm.tags : []) {
      params.append("tag", tagId);
    }
    const asset = await api<MemeAsset>(`/api/meme-library/assets?${params.toString()}`, {
      method: "POST",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: await file.arrayBuffer(),
    });
    assets.value = [asset, ...assets.value];
    selectedAssetId.value = asset.id;
    selectedFile.value = undefined;
    resetAssetForm(asset);
    app.showToast("表情包已加入图库");
  } catch (error) {
    app.showToast(actionError(error), "error");
  } finally {
    uploading.value = false;
  }
}

async function saveAsset(): Promise<void> {
  const asset = selectedAsset.value;
  if (!asset) return;
  if (!assetForm.name.trim()) {
    app.showToast("请填写素材名称", "error");
    return;
  }
  if (asset.scope === "normal_chat" && !assetForm.tags.length) {
    app.showToast("普通对话素材至少选择一个标签", "error");
    return;
  }
  savingAsset.value = true;
  try {
    const next = await api<MemeAsset>(`/api/meme-library/assets/${encodeURIComponent(asset.id)}`, {
      method: "PUT",
      body: JSON.stringify({
        name: assetForm.name.trim(),
        enabled: assetForm.enabled,
        tags: asset.scope === "normal_chat" ? assetForm.tags : [],
      }),
    });
    assets.value = assets.value.map((item) => item.id === next.id ? next : item);
    resetAssetForm(next);
    app.showToast("素材已保存");
  } catch (error) {
    app.showToast(actionError(error), "error");
  } finally {
    savingAsset.value = false;
  }
}

async function deleteAsset(asset: MemeAsset): Promise<void> {
  if (asset.protected) {
    app.showToast("内置黑名单素材不能删除", "error");
    return;
  }
  if (!confirm(`删除表情包「${asset.name}」？此操作不可恢复。`)) return;
  deletingAssetId.value = asset.id;
  try {
    await api<{ ok: boolean }>(`/api/meme-library/assets/${encodeURIComponent(asset.id)}`, { method: "DELETE" });
    assets.value = assets.value.filter((item) => item.id !== asset.id);
    if (selectedAssetId.value === asset.id) clearAssetSelection();
    app.showToast("表情包已删除");
  } catch (error) {
    app.showToast(actionError(error), "error");
  } finally {
    deletingAssetId.value = "";
  }
}

async function createTag(): Promise<void> {
  if (!tagForm.name.trim()) {
    app.showToast("请填写标签名称", "error");
    return;
  }
  const keywords = validateKeywords(tagForm.keywords);
  if (!keywords) return;
  creatingTag.value = true;
  try {
    const tag = await api<MemeTag>("/api/meme-library/tags", {
      method: "POST",
      body: JSON.stringify({ name: tagForm.name.trim(), description: tagForm.description.trim(), keywords }),
    });
    tags.value = [...tags.value, tag];
    tagForm.name = "";
    tagForm.description = "";
    tagForm.keywords = "";
    app.showToast("标签已创建");
  } catch (error) {
    app.showToast(actionError(error), "error");
  } finally {
    creatingTag.value = false;
  }
}

function beginTagEdit(tag: MemeTag): void {
  tagEditingId.value = tag.id;
  tagEditForm.name = tag.name;
  tagEditForm.description = tag.description;
  tagEditForm.keywords = keywordsText(tag.keywords);
}

function cancelTagEdit(): void {
  tagEditingId.value = "";
  tagEditForm.name = "";
  tagEditForm.description = "";
  tagEditForm.keywords = "";
}

async function saveTag(tag: MemeTag): Promise<void> {
  if (!tagEditForm.name.trim()) {
    app.showToast("请填写标签名称", "error");
    return;
  }
  const keywords = validateKeywords(tagEditForm.keywords);
  if (!keywords) return;
  savingTagId.value = tag.id;
  try {
    const next = await api<MemeTag>(`/api/meme-library/tags/${encodeURIComponent(tag.id)}`, {
      method: "PUT",
      body: JSON.stringify({ name: tagEditForm.name.trim(), description: tagEditForm.description.trim(), keywords }),
    });
    tags.value = tags.value.map((item) => item.id === next.id ? next : item);
    cancelTagEdit();
    app.showToast("标签已保存");
  } catch (error) {
    app.showToast(actionError(error), "error");
  } finally {
    savingTagId.value = "";
  }
}

async function deleteTag(tag: MemeTag): Promise<void> {
  if (!confirm(`删除标签「${tag.name}」？未被素材引用时才能删除。`)) return;
  deletingTagId.value = tag.id;
  try {
    await api<{ ok: boolean }>(`/api/meme-library/tags/${encodeURIComponent(tag.id)}`, { method: "DELETE" });
    tags.value = tags.value.filter((item) => item.id !== tag.id);
    assetForm.tags = assetForm.tags.filter((id) => id !== tag.id);
    app.showToast("标签已删除");
  } catch (error) {
    app.showToast(actionError(error), "error");
  } finally {
    deletingTagId.value = "";
  }
}

onMounted(() => {
  void load();
});
</script>

<template>
  <section class="page meme-page">
    <section class="panel">
      <div class="section-head">
        <div>
          <h2>随机发送策略</h2>
          <p>普通对话在文字回复后按此策略附加一张关键词匹配的表情包。黑名单 @ 专用图库不受此策略影响。</p>
        </div>
        <button class="ghost-btn" type="button" :disabled="loading" @click="load">{{ loading ? "刷新中..." : "刷新" }}</button>
      </div>

      <div class="policy-grid">
        <label class="policy-switch">
          <span>
            <strong>启用普通对话表情包</strong>
            <small>图库为空时会自动跳过，不影响文字回复。</small>
          </span>
          <input v-model="policy.enabled" type="checkbox" />
        </label>
        <label>发送概率
          <div class="number-input"><input v-model.number="policy.probabilityPercent" class="input" type="number" min="0" max="100" /><span>%</span></div>
        </label>
        <label>同群冷却
          <div class="number-input"><input v-model.number="policy.cooldownSeconds" class="input" type="number" min="0" max="86400" /><span>秒</span></div>
        </label>
        <div class="policy-action"><button class="btn" type="button" :disabled="savingPolicy" @click="savePolicy">{{ savingPolicy ? "保存中..." : "保存策略" }}</button></div>
      </div>
    </section>

    <div class="meme-layout">
      <div class="meme-main">
        <section class="panel">
          <div class="section-head">
            <div>
              <h2>上传表情包</h2>
              <p>支持 PNG、JPEG、GIF、WebP，单张最大 5 MiB。服务器会复核真实文件格式。</p>
            </div>
          </div>
          <div class="upload-form">
            <label class="wide">图片文件<input class="input file-input" type="file" accept="image/png,image/jpeg,image/gif,image/webp" @change="onUploadFile" /></label>
            <label>素材名称<input v-model="assetForm.name" class="input" maxlength="100" placeholder="例如：无语凝噎" /></label>
            <label>发送场景
              <select v-model="assetForm.scope" class="select">
                <option value="normal_chat">普通对话</option>
                <option value="blacklisted_at">黑名单 @ 专用</option>
              </select>
            </label>
            <label class="switch"> <input v-model="assetForm.enabled" type="checkbox" /> 上传后立即启用 </label>
            <div v-if="!selectedScopeIsBlacklist" class="wide tag-picker">
              <span>匹配标签（至少选择一个）</span>
              <div v-if="tags.length" class="tag-checkboxes">
                <label v-for="tag in tags" :key="tag.id"><input type="checkbox" :checked="assetForm.tags.includes(tag.id)" @change="toggleUploadTag(tag.id)" /> {{ tag.name }}</label>
              </div>
              <small v-if="tags.length">普通对话素材必须关联标签；用户消息命中标签关键词后才会发送。</small>
              <small v-else>先在右侧创建标签；普通对话素材必须关联至少一个标签才能上传。</small>
            </div>
            <p v-else class="wide muted">黑名单 @ 专用素材不使用普通对话标签，黑名单成员每次有效 @ 都会从该专用池随机选择。</p>
            <div class="wide upload-actions">
              <span class="muted">{{ selectedFile ? `${selectedFile.name} · ${formatBytes(selectedFile.size)}` : "尚未选择文件" }}</span>
              <button class="btn" type="button" :disabled="uploading || !selectedFile" @click="upload">{{ uploading ? "上传中..." : "上传到图库" }}</button>
            </div>
          </div>
        </section>

        <section class="panel library-panel">
          <div class="section-head">
            <div>
              <h2>图库 <span class="tag">{{ assets.length }}</span></h2>
              <p>普通对话 {{ normalAssetCount }} 张，黑名单 @ 专用 {{ blacklistAssetCount }} 张。</p>
            </div>
            <select v-model="scopeFilter" class="select scope-filter">
              <option value="all">全部场景</option>
              <option value="normal_chat">普通对话</option>
              <option value="blacklisted_at">黑名单 @ 专用</option>
            </select>
          </div>

          <div v-if="loading" class="empty">正在读取图库...</div>
          <div v-else-if="!filteredAssets.length" class="empty">当前场景还没有表情包。</div>
          <div v-else class="asset-grid">
            <button v-for="asset in filteredAssets" :key="asset.id" class="asset-card" :class="{ active: selectedAssetId === asset.id, disabled: !asset.enabled }" type="button" @click="selectAsset(asset)">
              <img :src="previewUrl(asset)" :alt="asset.name" loading="lazy" />
              <span class="asset-card-body">
                <strong>{{ asset.name }}</strong>
                <small>{{ formatBytes(asset.sizeBytes) }} · {{ asset.mimeType.replace("image/", "").toUpperCase() }}</small>
                <span class="asset-status"><span class="tag" :class="scopeClass(asset.scope)">{{ scopeLabel(asset.scope) }}</span><span v-if="!asset.enabled" class="tag neutral">已停用</span><span v-if="asset.protected" class="tag warn">内置</span></span>
              </span>
            </button>
          </div>
        </section>
      </div>

      <aside class="meme-side">
        <section class="panel tag-panel">
          <div class="section-head">
            <div><h2>标签目录</h2><p>用户消息按这里配置的关键词本地匹配，不会额外调用模型。</p></div>
          </div>
          <form class="tag-create" @submit.prevent="createTag">
            <input v-model="tagForm.name" class="input" maxlength="60" placeholder="标签名称" />
            <input v-model="tagForm.description" class="input" maxlength="200" placeholder="场景说明（可选），例如：吐槽、惊讶" />
            <textarea v-model="tagForm.keywords" class="textarea small tag-keywords-input" placeholder="触发关键词（必填；用逗号或换行分隔，最多 30 个）" />
            <button class="btn" type="submit" :disabled="creatingTag">{{ creatingTag ? "创建中..." : "新增标签" }}</button>
          </form>
          <div v-if="!tags.length" class="empty compact">暂无标签。</div>
          <div v-else class="tag-list">
            <article v-for="tag in tags" :key="tag.id" class="tag-row">
              <template v-if="tagEditingId === tag.id">
                <input v-model="tagEditForm.name" class="input" maxlength="60" aria-label="标签名称" />
                <input v-model="tagEditForm.description" class="input" maxlength="200" placeholder="场景说明（可选）" aria-label="场景说明" />
                <textarea v-model="tagEditForm.keywords" class="textarea small" placeholder="触发关键词（必填；用逗号或换行分隔，最多 30 个）" aria-label="触发关键词" />
                <div class="row-actions"><button class="ghost-btn" type="button" @click="cancelTagEdit">取消</button><button class="btn" type="button" :disabled="savingTagId === tag.id" @click="saveTag(tag)">{{ savingTagId === tag.id ? "保存中..." : "保存" }}</button></div>
              </template>
              <template v-else>
                <div>
                  <strong>{{ tag.name }}</strong>
                  <p>{{ tag.description || "未填写场景说明" }}</p>
                  <div class="keyword-list" aria-label="触发关键词"><span v-for="keyword in tag.keywords" :key="keyword" class="tag neutral">{{ keyword }}</span></div>
                </div>
                <div class="row-actions"><button class="ghost-btn" type="button" @click="beginTagEdit(tag)">编辑</button><button class="ghost-btn danger" type="button" :disabled="deletingTagId === tag.id" @click="deleteTag(tag)">{{ deletingTagId === tag.id ? "删除中..." : "删除" }}</button></div>
              </template>
            </article>
          </div>
        </section>

        <section class="panel asset-editor">
          <div class="section-head"><div><h2>素材详情</h2><p>素材变更会立即影响后续随机选择。</p></div><button v-if="selectedAsset" class="ghost-btn" type="button" @click="clearAssetSelection">×</button></div>
          <template v-if="selectedAsset">
            <img class="editor-preview" :src="previewUrl(selectedAsset)" :alt="selectedAsset.name" />
            <div class="editor-form">
              <label>素材名称<input v-model="assetForm.name" class="input" maxlength="100" :disabled="selectedAsset.protected" /></label>
              <label class="switch"><input v-model="assetForm.enabled" type="checkbox" :disabled="selectedAsset.protected" /> {{ assetForm.enabled ? "已启用" : "已停用" }}</label>
              <div v-if="selectedAsset.scope === 'normal_chat'" class="tag-picker">
                <span>匹配标签（至少选择一个）</span>
                <div class="tag-checkboxes"><label v-for="tag in tags" :key="tag.id"><input type="checkbox" :checked="assetForm.tags.includes(tag.id)" @change="toggleUploadTag(tag.id)" /> {{ tag.name }}</label></div>
                <small v-if="tags.length">普通对话素材必须关联至少一个标签。</small>
                <small v-else>没有可用标签，先创建标签后再保存。</small>
              </div>
              <p v-else class="muted">黑名单 @ 专用素材只用于黑名单成员有效 @ 机器人时的随机图片回复。</p>
              <p v-if="selectedAsset.protected" class="protected-note">这是随发布物初始化的内置素材，不能修改或删除。</p>
              <dl class="asset-meta"><div><dt>类型</dt><dd>{{ selectedAsset.mimeType }}</dd></div><div><dt>大小</dt><dd>{{ formatBytes(selectedAsset.sizeBytes) }}</dd></div><div><dt>创建</dt><dd>{{ formatDateTime(selectedAsset.createdAt) }}</dd></div><div><dt>校验</dt><dd class="hash">{{ selectedAsset.sha256 }}</dd></div></dl>
              <div class="editor-actions"><button class="ghost-btn danger" type="button" :disabled="selectedAsset.protected || deletingAssetId === selectedAsset.id" @click="deleteAsset(selectedAsset)">{{ selectedAsset.protected ? "内置素材不可删除" : deletingAssetId === selectedAsset.id ? "删除中..." : "删除" }}</button><button class="btn" type="button" :disabled="savingAsset || selectedAsset.protected" @click="saveAsset">{{ selectedAsset.protected ? "内置素材不可修改" : savingAsset ? "保存中..." : "保存素材" }}</button></div>
            </div>
          </template>
          <div v-else class="empty compact">从左侧图库选择一张素材进行管理。</div>
        </section>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.meme-page { gap: 18px; }
.policy-grid { display: grid; grid-template-columns: minmax(260px, 1.6fr) minmax(150px, .7fr) minmax(170px, .7fr) auto; gap: 14px; align-items: end; }
.policy-grid > label { display: grid; gap: 8px; color: var(--muted); font-size: 13px; font-weight: 800; }
.policy-switch { display: flex !important; align-items: center; justify-content: space-between; gap: 16px; min-height: 42px; }
.policy-switch span { display: grid; gap: 3px; }
.policy-switch strong { color: var(--text); }
.policy-switch small, .tag-picker > small { color: var(--muted); font-weight: 500; line-height: 1.45; }
.number-input { position: relative; }
.number-input input { padding-right: 40px; }
.number-input span { position: absolute; right: 13px; top: 10px; color: var(--muted); font-weight: 700; }
.policy-action { display: flex; justify-content: flex-end; }
.meme-layout { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(330px, .74fr); gap: 18px; align-items: start; }
.meme-main, .meme-side { display: grid; gap: 18px; min-width: 0; }
.upload-form, .editor-form { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.upload-form label, .editor-form label { display: grid; gap: 7px; color: var(--muted); font-size: 13px; font-weight: 800; }
.wide { grid-column: 1 / -1; }
.file-input { padding: 6px 10px; }
.switch { display: flex !important; align-items: center; gap: 8px; min-height: 38px; }
.tag-picker { display: grid; gap: 9px; color: var(--muted); font-size: 13px; font-weight: 800; }
.tag-checkboxes { display: flex; flex-wrap: wrap; gap: 8px; }
.tag-checkboxes label { display: inline-flex; align-items: center; gap: 6px; min-height: 30px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--surface-soft); color: var(--text); padding: 0 9px; font-size: 12px; font-weight: 700; }
.upload-actions, .editor-actions, .row-actions { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.library-panel { min-width: 0; }
.scope-filter { width: 160px; }
.asset-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px; }
.asset-card { overflow: hidden; min-width: 0; border: 1px solid var(--line); border-radius: var(--radius-md); background: var(--surface-raised); color: var(--text); padding: 0; text-align: left; }
.asset-card:hover, .asset-card.active { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }
.asset-card.disabled { opacity: .62; }
.asset-card img { display: block; width: 100%; aspect-ratio: 1; object-fit: contain; background: var(--surface-soft); }
.asset-card-body { display: grid; gap: 5px; min-width: 0; padding: 10px; }
.asset-card-body strong, .asset-card-body small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.asset-card-body small { color: var(--muted); font-size: 11px; }
.asset-status { display: flex; flex-wrap: wrap; gap: 5px; }
.asset-status .tag { min-height: 19px; padding: 0 6px; font-size: 10px; }
.tag-panel .section-head, .asset-editor .section-head { margin-bottom: 13px; }
.tag-create { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.35fr) auto; gap: 8px; align-items: start; margin-bottom: 14px; }
.tag-create .tag-keywords-input { grid-column: 1 / 3; min-height: 66px; resize: vertical; }
.tag-list { display: grid; gap: 8px; }
.tag-row { display: grid; gap: 9px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--surface-raised); padding: 11px; }
.tag-row > div:first-child { min-width: 0; }
.tag-row strong { font-size: 13px; }
.tag-row p { margin: 4px 0 0; color: var(--muted); font-size: 12px; line-height: 1.45; }
.keyword-list { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 8px; }
.keyword-list .tag { min-height: 20px; padding: 0 7px; font-size: 10px; }
.tag-row .row-actions { justify-content: flex-end; }
.editor-preview { display: block; width: 100%; max-height: 245px; object-fit: contain; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--surface-soft); margin-bottom: 14px; }
.asset-meta { display: grid; gap: 7px; margin: 0; }
.asset-meta div { display: grid; grid-template-columns: 48px minmax(0, 1fr); gap: 8px; font-size: 12px; }
.asset-meta dt { color: var(--muted); }
.asset-meta dd { overflow: hidden; margin: 0; text-overflow: ellipsis; white-space: nowrap; }
.asset-meta .hash { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; }
.protected-note { margin: 0; border: 1px solid color-mix(in oklch, var(--warning) 42%, var(--line)); border-radius: var(--radius-sm); background: var(--warning-soft); color: var(--warning); padding: 9px; font-size: 12px; line-height: 1.45; }
.empty.compact { min-height: 100px; padding: 14px; text-align: center; }
@media (max-width: 1080px) { .meme-layout { grid-template-columns: 1fr; } .meme-side { grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: start; } }
@media (max-width: 760px) { .policy-grid, .upload-form, .editor-form, .tag-create, .meme-side { grid-template-columns: 1fr; } .tag-create .tag-keywords-input { grid-column: auto; } .policy-action { justify-content: stretch; } .policy-action .btn { width: 100%; } .scope-filter { width: 100%; } }
</style>
