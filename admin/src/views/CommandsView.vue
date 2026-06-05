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
  <div class="commands-page">
    <section class="panel command-list-panel">
      <div class="command-toolbar">
        <input v-model="query" class="input" placeholder="搜索指令名称、主命令或别名" />
        <select v-model="permission" class="select">
          <option value="">全部权限</option>
          <option value="member">成员</option>
          <option value="group_admin">群管理员</option>
          <option value="super_admin">超级管理员</option>
        </select>
        <label class="switch"><span>仅看启用</span><input v-model="onlyEnabled" type="checkbox" /></label>
        <button class="ghost-btn" type="button" :disabled="loading" @click="load">刷新</button>
        <button class="btn" type="button" :disabled="saving" @click="save">{{ saving ? "保存中..." : "保存全部修改" }}</button>
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
          <label class="switch"><input v-model="command.enabled" type="checkbox" @click.stop /> {{ command.enabled ? "启用" : "停用" }}</label>
          <span>{{ formatDateTime(command.updatedAt) }}</span>
        </article>
      </div>
      <div class="table-footer">
        <span class="muted">共 {{ filtered.length }} 条指令</span>
        <button class="btn" type="button" :disabled="saving" @click="save">{{ saving ? "保存中..." : "保存全部修改" }}</button>
      </div>
    </section>

    <aside class="panel command-editor sticky-detail-panel">
      <div class="section-head">
        <div>
          <h2>指令编辑</h2>
          <p>只维护系统内置指令的名称、主命令、别名和开关。</p>
        </div>
        <button class="ghost-btn" type="button" @click="activeId = ''">×</button>
      </div>
      <template v-if="activeCommand">
        <div class="warn-box">底层行为不可修改；停用后群内对应指令不会触发。</div>
        <div class="form-grid">
          <label>指令名称<input v-model="activeCommand.title" class="input" /></label>
          <label>主命令<input v-model="activeCommand.primary" class="input" /></label>
          <label class="wide">别名<input class="input" :value="activeCommand.aliases.join('\n')" placeholder="支持换行、逗号、空格" @input="activeCommand.aliases = splitAliases(($event.target as HTMLInputElement).value)" /></label>
          <label>权限级别<input class="input" :value="permissionLabel(activeCommand.permission)" disabled /></label>
          <label class="switch editor-switch"><input v-model="activeCommand.enabled" type="checkbox" /> {{ activeCommand.enabled ? "已启用" : "已停用" }}</label>
          <label class="wide">帮助文案<textarea v-model="activeCommand.help" class="textarea" maxlength="400" /></label>
        </div>
        <div class="editor-footer">
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
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(330px, 390px);
  gap: 18px;
}

.command-toolbar {
  display: grid;
  grid-template-columns: minmax(210px, 1fr) 150px auto auto auto;
  gap: 10px;
  align-items: center;
  border-bottom: 1px solid var(--line);
  margin: 0 -22px;
  padding: 8px 22px 18px;
}

.command-table {
  overflow: hidden;
  margin: 0 -22px;
}

.table-head,
.table-row {
  display: grid;
  grid-template-columns: minmax(92px, 0.8fr) minmax(90px, 0.7fr) minmax(120px, 1fr) 92px 88px 136px;
  gap: 10px;
  align-items: center;
  min-height: 58px;
  border-bottom: 1px solid var(--line);
  padding: 0 22px;
}

.table-row > span,
.table-row > strong {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.table-head {
  min-height: 48px;
  background: var(--surface-soft);
  color: var(--muted);
  font-size: 13px;
  font-weight: 800;
}

.table-row {
  cursor: pointer;
  background: var(--surface-raised);
}

.table-row.active {
  background: color-mix(in oklch, var(--accent-soft) 62%, var(--surface-raised));
}

.table-footer,
.editor-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 16px;
}

.command-editor {
  min-height: 320px;
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.wide {
  grid-column: 1 / -1;
}

.switch {
  display: flex;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
}

.editor-switch {
  align-self: end;
  min-height: 40px;
}

.warn-box {
  border: 1px solid color-mix(in oklch, var(--warning) 45%, var(--line));
  border-radius: var(--radius-sm);
  background: color-mix(in oklch, var(--warning) 16%, var(--surface));
  color: oklch(0.48 0.12 72);
  padding: 12px;
  margin-bottom: 16px;
}

@media (max-width: 900px) {
  .commands-page,
  .command-toolbar,
  .table-head,
  .table-row,
  .form-grid {
    grid-template-columns: 1fr;
  }

}
</style>
