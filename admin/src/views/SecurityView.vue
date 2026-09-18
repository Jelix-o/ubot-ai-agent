<script setup lang="ts">
import { computed, onMounted, reactive, shallowRef } from "vue";

import { useRefreshEvents } from "../composables/useRefreshEvents";
import { api, type AdminAccount, type AdminAuthAuditEntry, type AdminInvite, type GroupConfig } from "../services/api";
import { useAppStore } from "../stores/app";
import { formatDateTime } from "../utils/format";

const app = useAppStore();
const loading = shallowRef(false);
const busyAction = shallowRef("");
const accounts = shallowRef<AdminAccount[]>([]);
const invites = shallowRef<AdminInvite[]>([]);
const authAudit = shallowRef<AdminAuthAuditEntry[]>([]);
const allGroups = shallowRef<GroupConfig[]>([]);
const inviteUrl = shallowRef("");
const grantDrafts = reactive<Record<string, string[]>>({});
const qqDrafts = reactive<Record<string, string>>({});
const securityForm = reactive({ reauthPassword: "", currentPassword: "", nextPassword: "", confirmPassword: "" });
const inviteForm = reactive({ role: "group_admin" as "super_admin" | "group_admin", groupIds: [] as string[], expiresHours: 24 });

const isSuperAdmin = computed(() => app.role === "super_admin");
const activeInvites = computed(() => invites.value.filter((invite) => !invite.revokedAt && !invite.usedAt && new Date(invite.expiresAt).getTime() > Date.now()));
const inactiveInvites = computed(() => invites.value.filter((invite) => !activeInvites.value.includes(invite)));

async function load(): Promise<void> {
  loading.value = true;
  try {
    await app.loadGroups({ includeDisabled: true });
    allGroups.value = [...app.groups];
    if (!isSuperAdmin.value) return;
    const [accountData, inviteData, auditData] = await Promise.all([
      api<{ accounts: AdminAccount[] }>("/api/admin-accounts"),
      api<{ invites: AdminInvite[] }>("/api/admin-accounts/invites"),
      api<{ entries: AdminAuthAuditEntry[] }>("/api/admin-auth-audit?limit=80"),
    ]);
    accounts.value = accountData.accounts;
    invites.value = inviteData.invites;
    authAudit.value = auditData.entries;
    for (const account of accounts.value) {
      grantDrafts[account.id] = [...account.groupIds];
      qqDrafts[account.id] = account.qqUserId ?? "";
    }
  } catch (error) { app.showToast((error as Error).message, "error"); }
  finally { loading.value = false; }
}

async function reauthenticate(): Promise<void> {
  if (!securityForm.reauthPassword) return app.showToast("请输入当前密码", "error");
  busyAction.value = "reauth";
  try {
    await api("/api/auth/reauth", { method: "POST", body: JSON.stringify({ password: securityForm.reauthPassword }) });
    securityForm.reauthPassword = "";
    app.showToast("密码复验成功，10 分钟内可执行敏感操作");
  } catch (error) { app.showToast((error as Error).message, "error"); }
  finally { busyAction.value = ""; }
}

async function changePassword(): Promise<void> {
  if (!securityForm.currentPassword || !securityForm.nextPassword) return app.showToast("请填写当前密码和新密码", "error");
  if (securityForm.nextPassword !== securityForm.confirmPassword) return app.showToast("两次输入的新密码不一致", "error");
  busyAction.value = "password";
  try {
    await api("/api/auth/password/change", { method: "POST", body: JSON.stringify({ currentPassword: securityForm.currentPassword, nextPassword: securityForm.nextPassword }) });
    securityForm.currentPassword = securityForm.nextPassword = securityForm.confirmPassword = "";
    app.showToast("密码已更新，其他登录会话已失效");
  } catch (error) { app.showToast((error as Error).message, "error"); }
  finally { busyAction.value = ""; }
}

async function createInvite(): Promise<void> {
  if (inviteForm.role === "group_admin" && inviteForm.groupIds.length === 0) return app.showToast("群管理员至少需要一个授权群", "error");
  busyAction.value = "create-invite";
  try {
    const result = await api<{ inviteUrl: string }>("/api/admin-accounts/invites", { method: "POST", body: JSON.stringify({ role: inviteForm.role, groupIds: inviteForm.role === "group_admin" ? inviteForm.groupIds : [], expiresHours: inviteForm.expiresHours }) });
    inviteUrl.value = result.inviteUrl;
    inviteForm.groupIds = [];
    await load();
    app.showToast("邀请已创建");
  } catch (error) { app.showToast((error as Error).message, "error"); }
  finally { busyAction.value = ""; }
}

async function revokeInvite(invite: AdminInvite): Promise<void> {
  if (!window.confirm("撤销后该邀请链接不能再使用。确定继续吗？")) return;
  busyAction.value = `invite:${invite.id}`;
  try { await api(`/api/admin-accounts/invites/${encodeURIComponent(invite.id)}/revoke`, { method: "POST", body: "{}" }); await load(); app.showToast("邀请已撤销"); }
  catch (error) { app.showToast((error as Error).message, "error"); }
  finally { busyAction.value = ""; }
}

async function accountAction(account: AdminAccount, action: "disable" | "enable" | "revoke-sessions"): Promise<void> {
  const labels = { disable: "停用", enable: "启用", "revoke-sessions": "撤销全部会话" };
  if (!window.confirm(`确定要${labels[action]}账号「${account.username}」吗？`)) return;
  busyAction.value = `account:${account.id}:${action}`;
  try { await api(`/api/admin-accounts/${encodeURIComponent(account.id)}/${action}`, { method: "POST", body: "{}" }); await load(); app.showToast(`已${labels[action]}账号`); }
  catch (error) { app.showToast((error as Error).message, "error"); }
  finally { busyAction.value = ""; }
}

async function saveGrants(account: AdminAccount): Promise<void> {
  const groupIds = grantDrafts[account.id] || [];
  if (groupIds.length === 0) return app.showToast("群管理员至少需要保留一个授权群", "error");
  busyAction.value = `grants:${account.id}`;
  try { await api(`/api/admin-accounts/${encodeURIComponent(account.id)}/grants`, { method: "POST", body: JSON.stringify({ groupIds }) }); await load(); app.showToast("群授权已更新"); }
  catch (error) { app.showToast((error as Error).message, "error"); }
  finally { busyAction.value = ""; }
}

async function saveQqBinding(account: AdminAccount): Promise<void> {
  const qqUserId = (qqDrafts[account.id] ?? "").trim();
  if (!/^[1-9]\d{4,11}$/.test(qqUserId)) return app.showToast("请输入 5-12 位有效 QQ 号", "error");
  busyAction.value = `qq:${account.id}`;
  try { await api(`/api/admin-accounts/${encodeURIComponent(account.id)}/qq-binding`, { method: "POST", body: JSON.stringify({ qqUserId }) }); await load(); app.showToast("QQ 绑定已更新"); }
  catch (error) { app.showToast((error as Error).message, "error"); }
  finally { busyAction.value = ""; }
}

async function removeQqBinding(account: AdminAccount): Promise<void> {
  if (!account.qqUserId || !window.confirm(`确定解除 QQ ${account.qqUserId} 的绑定吗？`)) return;
  busyAction.value = `qq:${account.id}`;
  try { await api(`/api/admin-accounts/${encodeURIComponent(account.id)}/qq-binding`, { method: "DELETE" }); await load(); app.showToast("QQ 绑定已解除"); }
  catch (error) { app.showToast((error as Error).message, "error"); }
  finally { busyAction.value = ""; }
}

function auditLabel(action: string): string { return action.replace(/[_:]/g, " "); }
onMounted(() => void load());
useRefreshEvents({ refresh: () => void load() });
</script>

<template>
  <section class="page security-page">
    <section class="page-grid security-grid">
      <section class="panel">
        <div class="section-head"><div><h2>登录与密码</h2><p>密码至少 12 位。敏感操作前需完成密码复验，有效 10 分钟。</p></div></div>
        <form class="inline-form" @submit.prevent="reauthenticate">
          <label>当前密码<input v-model="securityForm.reauthPassword" class="input" type="password" autocomplete="current-password" required /></label>
          <button class="btn" type="submit" :disabled="busyAction === 'reauth'">{{ busyAction === "reauth" ? "验证中..." : "完成密码复验" }}</button>
        </form>
        <form class="stack-form" @submit.prevent="changePassword">
          <h3>修改密码</h3>
          <label>当前密码<input v-model="securityForm.currentPassword" class="input" type="password" autocomplete="current-password" required /></label>
          <label>新密码<input v-model="securityForm.nextPassword" class="input" type="password" autocomplete="new-password" minlength="12" required /></label>
          <label>确认新密码<input v-model="securityForm.confirmPassword" class="input" type="password" autocomplete="new-password" required /></label>
          <button class="ghost-btn align-start" type="submit" :disabled="busyAction === 'password'">更新密码</button>
        </form>
      </section>
      <aside class="panel security-side"><h2>账号边界</h2><p class="muted">群管理员仅访问获授群。QQ 群主/群管的自动权限只覆盖群内指令，不能登录后台。</p></aside>
    </section>

    <template v-if="isSuperAdmin">
      <section class="panel">
        <div class="section-head"><div><h2>创建管理员邀请</h2><p>邀请注册只需设置账号和密码。创建、授权和绑定操作需要近期密码复验。</p></div></div>
        <form class="invite-form" @submit.prevent="createInvite">
          <label>角色<select v-model="inviteForm.role" class="select"><option value="group_admin">群管理员</option><option value="super_admin">超级管理员</option></select></label>
          <label>有效期（小时）<input v-model.number="inviteForm.expiresHours" class="input" type="number" min="1" max="720" /></label>
          <fieldset v-if="inviteForm.role === 'group_admin'" class="grant-picker"><legend>授权群</legend><label v-for="group in allGroups" :key="group.groupId" class="check-row"><input v-model="inviteForm.groupIds" type="checkbox" :value="group.groupId" /><span>{{ group.groupName || group.groupId }}</span></label></fieldset>
          <button class="btn" type="submit" :disabled="busyAction === 'create-invite'">创建邀请</button>
        </form>
        <div v-if="inviteUrl" class="invite-result"><strong>一次性邀请链接</strong><code>{{ inviteUrl }}</code></div>
      </section>

      <section class="panel">
        <div class="section-head"><div><h2>后台账号</h2><p>QQ 绑定优先于平台群身份；停用、解绑或撤销群授权后立即失权。</p></div></div>
        <div v-if="loading" class="empty compact">加载中...</div>
        <div v-else class="account-list">
          <article v-for="account in accounts" :key="account.id" class="account-row">
            <div class="account-main"><div class="row-top"><strong>{{ account.username }}</strong><span class="tag" :class="{ danger: Boolean(account.disabledAt) }">{{ account.disabledAt ? "已停用" : "已启用" }}</span></div><p>{{ account.role === "super_admin" ? "超级管理员" : "群管理员" }}</p><small>最近登录：{{ account.lastLoginAt ? formatDateTime(account.lastLoginAt) : "从未" }}</small></div>
            <div class="account-settings">
              <form class="inline-form compact-form" @submit.prevent="saveQqBinding(account)"><input v-model="qqDrafts[account.id]" class="input" inputmode="numeric" maxlength="12" placeholder="绑定 QQ 号" :disabled="Boolean(account.disabledAt)" /><button class="link-btn" type="submit">{{ account.qqUserId ? "更新绑定" : "绑定 QQ" }}</button><button v-if="account.qqUserId" class="link-btn danger-link" type="button" @click="removeQqBinding(account)">解绑</button></form>
              <fieldset v-if="account.role === 'group_admin'" class="grant-picker"><legend>群授权</legend><label v-for="group in allGroups" :key="group.groupId" class="check-row"><input v-model="grantDrafts[account.id]" type="checkbox" :value="group.groupId" :disabled="Boolean(account.disabledAt)" /><span>{{ group.groupName || group.groupId }}</span></label><button class="link-btn" type="button" @click="saveGrants(account)">保存授权</button></fieldset>
            </div>
            <div class="account-actions"><button class="ghost-btn" type="button" @click="accountAction(account, 'revoke-sessions')">撤销会话</button><button v-if="account.disabledAt" class="ghost-btn" type="button" @click="accountAction(account, 'enable')">启用</button><button v-else class="ghost-btn danger-action" type="button" @click="accountAction(account, 'disable')">停用</button></div>
          </article>
        </div>
      </section>

      <section class="page-grid security-grid">
        <section class="panel"><div class="section-head"><div><h2>有效邀请 <span class="tag">{{ activeInvites.length }}</span></h2><p>邀请码不会从列表中重新显示。</p></div></div><div v-if="!activeInvites.length" class="empty compact">没有有效邀请。</div><article v-for="invite in activeInvites" v-else :key="invite.id" class="list-row"><div class="row-top"><strong>{{ invite.role === "super_admin" ? "超级管理员" : "群管理员" }}</strong><button class="link-btn danger-link" type="button" @click="revokeInvite(invite)">撤销</button></div><small>{{ formatDateTime(invite.expiresAt) }}</small></article><details v-if="inactiveInvites.length"><summary>已失效邀请 {{ inactiveInvites.length }} 条</summary></details></section>
        <section class="panel"><div class="section-head"><div><h2>账号安全审计</h2><p>认证、会话和授权事件。</p></div></div><div v-if="!authAudit.length" class="empty compact">暂无账号安全事件。</div><article v-for="entry in authAudit" v-else :key="entry.id" class="audit-row"><strong>{{ auditLabel(entry.action) }}</strong><span>{{ formatDateTime(entry.createdAt) }}</span></article></section>
      </section>
    </template>
  </section>
</template>

<style scoped>
.security-page { display: grid; gap: 18px; }.security-grid { grid-template-columns: minmax(0, 1.3fr) minmax(280px, .7fr); }.inline-form { display: flex; align-items: end; gap: 10px; margin-top: 12px; }.inline-form label, .stack-form label, .invite-form > label { display: grid; gap: 6px; color: var(--muted); font-size: 13px; font-weight: 700; }.stack-form { display: grid; gap: 10px; max-width: 480px; margin-top: 28px; }.stack-form h3 { margin: 0; }.align-start { justify-self: start; }.invite-form { display: grid; grid-template-columns: minmax(160px, .35fr) minmax(160px, .35fr) minmax(260px, 1fr) auto; align-items: end; gap: 14px; }.grant-picker { display: grid; gap: 7px; max-height: 160px; overflow: auto; margin: 0; border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 9px 11px; }.check-row { display: flex; gap: 8px; align-items: center; font-size: 13px; }.invite-result { display: grid; gap: 8px; margin-top: 14px; padding: 14px; border: 1px solid var(--line); }.invite-result code { overflow-wrap: anywhere; }.account-list { display: grid; gap: 12px; }.account-row { display: grid; grid-template-columns: minmax(170px, .6fr) minmax(300px, 1fr) auto; gap: 16px; align-items: start; border: 1px solid var(--line); padding: 14px; }.account-main p, .account-main small, .panel > p { color: var(--muted); }.account-settings { display: grid; gap: 10px; }.compact-form { margin: 0; }.account-actions { display: flex; flex-wrap: wrap; justify-content: end; gap: 8px; }.danger-action, .danger-link { color: var(--danger); }.list-row, .audit-row { display: flex; justify-content: space-between; gap: 12px; border-bottom: 1px solid var(--line); padding: 10px 0; }.audit-row span, .list-row small { color: var(--muted); font-size: 13px; }
@media (max-width: 1100px) { .security-grid, .invite-form, .account-row { grid-template-columns: 1fr; }.account-actions { justify-content: start; } } @media (max-width: 620px) { .inline-form { align-items: stretch; flex-direction: column; } }
</style>
