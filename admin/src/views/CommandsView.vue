<script setup lang="ts">
import { computed, onMounted, shallowRef } from "vue";

import { api, type SystemCommandConfig } from "../services/api";
import { useAppStore } from "../stores/app";
import { formatDateTime } from "../utils/format";

const app = useAppStore();
const commands = shallowRef<SystemCommandConfig[]>([]);
const loading = shallowRef(false);
const saving = shallowRef(false);
const query = shallowRef("");
const permission = shallowRef("");
const onlyEnabled = shallowRef(false);
const activeId = shallowRef("");
const readonly = computed(() => app.role !== "super_admin");

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  return commands.value
    .filter((item) => !permission.value || item.permission === permission.value)
    .filter((item) => !onlyEnabled.value || item.enabled)
    .filter((item) => !q || [item.title, item.primary, item.help, item.aliases.join(" ")].some((value) => value.toLowerCase().includes(q)));
});
const activeCommand = computed(() => commands.value.find((item) => item.id === activeId.value) || filtered.value[0]);

async function load(): Promise<void> {
  loading.value = true;
  try {
    const data = await api<{ commands: SystemCommandConfig[] }>("/api/commands");
    commands.value = data.commands;
    if (!activeId.value && data.commands[0]) activeId.value = data.commands[0].id;
  } catch (error) {
    app.showToast((error as Error).message || "指令配置加载失败", "error");
  } finally {
    loading.value = false;
  }
}

async function save(): Promise<void> {
  saving.value = true;
  try {
    const data = await api<{ commands: SystemCommandConfig[] }>("/api/commands", {
      method: "PUT",
      body: JSON.stringify({ commands: commands.value }),
    });
    commands.value = data.commands;
    app.showToast("指令配置已保存");
  } catch (error) {
    app.showToast((error as Error).message, "error");
  } finally {
    saving.value = false;
  }
}

function permissionLabel(value: SystemCommandConfig["permission"]): string {
  return ({ member: "成员", group_admin: "群管理员", super_admin: "超级管理员" } as const)[value];
}

function splitAliases(value: string): string[] {
  return value.split(/[,\s，、]+/).map((item) => item.trim()).filter(Boolean);
}

function selectCommand(command: SystemCommandConfig): void {
  activeId.value = command.id;
}

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="page commands-page">
    <section class="panel command-list-panel">
      <div class="section-head">
        <div>
          <h2>指令配置</h2>
          <p>查看与维护系统内置指令的名称、主命令、别名和开关。</p>
        </div>
      </div>
      <div class="filter-bar command-toolbar">
        <input v-model="query" class="input" placeholder="搜索指令名称、主命令或别名" />
        <select v-model="permission" class="select">
          <option value="">全部权限</option>
          <option value="member">成员</option>
          <option value="group_admin">群管理员</option>
          <option value="super_admin">超级管理员</option>
        </select>
        <label class="switch"><span>仅看启用</span><input v-model="onlyEnabled" type="checkbox" /></label>
        <div class="toolbar-actions">
          <button class="ghost-btn" type="button" :disabled="loading" @click="load">刷新</button>
          <button v-if="!readonly" class="btn" type="button" :disabled="saving" @click="save">{{ saving ? "保存中..." : "保存全部修改" }}</button>
          <span v-else class="tag">只读</span>
        </div>
      </div>

      <div v-if="loading" class="empty">正在加载指令...</div>
      <div v-else class="command-table">
        <div class="table-head">
          <span>指令名称</span>
          <span>主命令</span>
          <span>别名</span>
          <span>权限级别</span>
          <span>启用状态</span>
          <span>更新时间</span>
        </div>
        <article v-for="command in filtered" :key="command.id" class="table-row" :class="{ active: activeCommand?.id === command.id }" @click="selectCommand(command)">
          <strong>{{ command.title }}</strong>
          <span>{{ command.primary }}</span>
          <span>{{ command.aliases.join("、") || "-" }}</span>
          <span class="tag" :class="{ warn: command.permission === 'group_admin', danger: command.permission === 'super_admin' }">{{ permissionLabel(command.permission) }}</span>
          <span>{{ command.enabled ? "启用" : "停用" }}</span>
          <span>{{ formatDateTime(command.updatedAt) }}</span>
        </article>
      </div>
      <div class="table-footer">
        <span class="muted">共 {{ filtered.length }} 条指令</span>
        <button v-if="!readonly" class="btn" type="button" :disabled="saving" @click="save">{{ saving ? "保存中..." : "保存全部修改" }}</button>
      </div>
    </section>

    <aside class="panel command-editor sticky-detail-panel">
      <div class="section-head">
        <div>
          <h2>{{ readonly ? "指令详情" : "指令编辑" }}</h2>
          <p>{{ readonly ? "当前账号可以查看指令配置，但不能修改。" : "只维护系统内置指令的名称、主命令、别名和开关。" }}</p>
        </div>
        <button class="ghost-btn" type="button" @click="activeId = ''">×</button>
      </div>
      <template v-if="activeCommand">
        <div class="warn-box">底层行为不可修改；停用后群内对应指令不会触发。</div>
        <div class="form-grid">
          <label>指令名称<input v-model="activeCommand.title" class="input" :disabled="readonly" /></label>
          <label>主命令<input v-model="activeCommand.primary" class="input" :disabled="readonly" /></label>
          <label class="wide">别名<input class="input" :value="activeCommand.aliases.join('\n')" :disabled="readonly" placeholder="支持换行、逗号、空格" @input="activeCommand.aliases = splitAliases(($event.target as HTMLInputElement).value)" /></label>
          <label>权限级别<input class="input" :value="permissionLabel(activeCommand.permission)" disabled /></label>
          <label class="switch editor-switch"><input v-model="activeCommand.enabled" type="checkbox" :disabled="readonly" /> {{ activeCommand.enabled ? "已启用" : "已停用" }}</label>
          <label class="wide">帮助文案<textarea v-model="activeCommand.help" class="textarea" maxlength="400" :disabled="readonly" /></label>
        </div>
        <div v-if="!readonly" class="editor-footer">
          <button class="ghost-btn" type="button" @click="load">取消</button>
          <button class="btn" type="button" :disabled="saving" @click="save">保存</button>
        </div>
      </template>
      <div v-else class="empty">请选择一条指令。</div>
    </aside>
  </div>
</template>

<style scoped>
.commands-page {
  grid-template-columns: minmax(0, 1fr) minmax(320px, 380px);
}

.command-toolbar {
  margin-bottom: 12px;
}

.command-toolbar .input {
  min-width: 220px;
  max-width: 280px;
}

.command-toolbar .select {
  width: auto;
  min-width: 140px;
}

.toolbar-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

.command-table {
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--surface);
  font-variant-numeric: tabular-nums;
}

.table-head,
.table-row {
  display: grid;
  grid-template-columns: minmax(96px, 0.85fr) minmax(88px, 0.7fr) minmax(120px, 1fr) 96px 80px 140px;
  gap: 8px;
  align-items: center;
  border-bottom: 1px solid var(--line);
  padding: 0 12px;
}

.table-row > span,
.table-row > strong {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}

.table-row > strong {
  font-weight: 650;
  color: var(--text-strong);
}

.table-head {
  min-height: 36px;
  background: var(--surface-soft);
  color: var(--muted);
  font-size: 12px;
  font-weight: 600;
}

.table-row {
  min-height: 48px;
  cursor: pointer;
  background: var(--surface);
  transition: background 0.12s ease, border-color 0.12s ease;
}

.table-row:hover {
  background: color-mix(in oklch, var(--surface-soft) 65%, transparent);
}

.table-row.active {
  background: var(--accent-soft);
  box-shadow: inset 2px 0 0 var(--accent);
}

.table-row.active > strong {
  color: var(--accent-strong);
}

.table-row:last-child,
.table-head:last-child {
  border-bottom: 0;
}

.table-footer,
.editor-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 12px;
}

.table-footer .muted {
  margin: 0;
  font-size: 12.5px;
}

.command-editor {
  min-height: 320px;
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.form-grid label {
  display: grid;
  gap: 6px;
  color: var(--muted);
  font-size: 12px;
  font-weight: 600;
}

.wide {
  grid-column: 1 / -1;
}

.switch {
  display: flex;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
  color: var(--text);
  font-size: 13px;
  font-weight: 600;
}

.editor-switch {
  align-self: end;
  min-height: 36px;
}

.warn-box {
  border: 1px solid color-mix(in oklch, var(--warning) 40%, var(--line));
  border-radius: var(--radius-md);
  background: var(--warning-soft);
  color: var(--warning);
  padding: 10px 12px;
  margin-bottom: 16px;
  font-size: 12.5px;
  line-height: 1.5;
}

@media (max-width: 900px) {
  .commands-page {
    grid-template-columns: 1fr;
  }

  .form-grid,
  .toolbar-actions {
    display: grid;
    grid-template-columns: 1fr;
  }

  .toolbar-actions {
    margin-left: 0;
  }

  .toolbar-actions .btn,
  .toolbar-actions .ghost-btn {
    width: 100%;
  }

  .command-toolbar .input,
  .command-toolbar .select {
    max-width: none;
    width: 100%;
  }

  .table-head {
    display: none;
  }

  .table-row {
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    padding: 12px;
  }
}
</style>
