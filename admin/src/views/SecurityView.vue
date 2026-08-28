<script setup lang="ts">
import { computed, onMounted, reactive, shallowRef } from "vue";

import { useRefreshEvents } from "../composables/useRefreshEvents";
import {
  api,
  type AdminAccount,
  type AdminAuthAuditEntry,
  type AdminInvite,
  type GroupConfig,
} from "../services/api";
import { useAppStore } from "../stores/app";
import { formatDateTime } from "../utils/format";

const app = useAppStore();
const loading = shallowRef(false);
const busyAction = shallowRef("");
const accounts = shallowRef<AdminAccount[]>([]);
const invites = shallowRef<AdminInvite[]>([]);
const authAudit = shallowRef<AdminAuthAuditEntry[]>([]);
const allGroups = shallowRef<GroupConfig[]>([]);
const recoveryCodes = shallowRef<string[]>([]);
const inviteUrl = shallowRef("");
const grantDrafts = reactive<Record<string, string[]>>({});
const enrollment = shallowRef<{ token: string; secret: string; uri: string }>();

const securityForm = reactive({
  reauthCode: "",
  currentPassword: "",
  nextPassword: "",
  confirmPassword: "",
  enrollmentCode: "",
});
const inviteForm = reactive({
  role: "group_admin" as "super_admin" | "group_admin",
  groupIds: [] as string[],
  expiresHours: 24,
});

const isSuperAdmin = computed(() => app.role === "super_admin");
const activeInvites = computed(() => invites.value.filter((invite) => !invite.revokedAt && !invite.usedAt && new Date(invite.expiresAt).getTime() > Date.now()));
const inactiveInvites = computed(() => invites.value.filter((invite) => !activeInvites.value.includes(invite)));

function setBusy(action: string): void {
  busyAction.value = action;
}

function clearSensitiveDisplays(): void {
  recoveryCodes.value = [];
  inviteUrl.value = "";
}

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
    }
  } catch (error) {
    app.showToast((error as Error).message, "error");
  } finally {
    loading.value = false;
  }
}

async function reauthenticate(): Promise<void> {
  const code = securityForm.reauthCode.trim();
  if (!/^\d{6}$/.test(code)) {
    app.showToast("请输入验证器中的 6 位验证码", "error");
    return;
  }
  setBusy("reauth");
  try {
    await api("/api/auth/reauth", { method: "POST", body: JSON.stringify({ code }) });
    securityForm.reauthCode = "";
    app.showToast("已完成近期 MFA 验证，可执行敏感操作");
  } catch (error) {
    app.showToast((error as Error).message, "error");
  } finally {
    setBusy("");
  }
}

async function changePassword(): Promise<void> {
  if (!securityForm.currentPassword || !securityForm.nextPassword) {
    app.showToast("请填写当前密码和新密码", "error");
    return;
  }
  if (securityForm.nextPassword !== securityForm.confirmPassword) {
    app.showToast("两次输入的新密码不一致", "error");
    return;
  }
  setBusy("password");
  try {
    await api("/api/auth/password/change", {
      method: "POST",
      body: JSON.stringify({
        currentPassword: securityForm.currentPassword,
        nextPassword: securityForm.nextPassword,
      }),
    });
    securityForm.currentPassword = "";
    securityForm.nextPassword = "";
    securityForm.confirmPassword = "";
    app.showToast("密码已更新，其他登录会话已失效");
  } catch (error) {
    app.showToast((error as Error).message, "error");
  } finally {
    setBusy("");
  }
}

async function regenerateRecoveryCodes(): Promise<void> {
  setBusy("recovery-codes");
  try {
    const result = await api<{ recoveryCodes: string[] }>("/api/auth/recovery-codes", { method: "POST", body: "{}" });
    recoveryCodes.value = result.recoveryCodes;
    app.showToast("已生成新的恢复码，旧恢复码已经失效");
  } catch (error) {
    app.showToast((error as Error).message, "error");
  } finally {
    setBusy("");
  }
}

async function beginTotpReset(): Promise<void> {
  setBusy("totp-reset");
  try {
    const result = await api<{ enrollmentToken: string; totpSecret: string; totpUri: string }>("/api/auth/totp/reset", {
      method: "POST",
      body: "{}",
    });
    enrollment.value = { token: result.enrollmentToken, secret: result.totpSecret, uri: result.totpUri };
    securityForm.enrollmentCode = "";
    recoveryCodes.value = [];
    app.showToast("请将新密钥添加到验证器后完成确认");
  } catch (error) {
    app.showToast((error as Error).message, "error");
  } finally {
    setBusy("");
  }
}

async function finishTotpReset(): Promise<void> {
  const activeEnrollment = enrollment.value;
  const code = securityForm.enrollmentCode.trim();
  if (!activeEnrollment || !/^\d{6}$/.test(code)) {
    app.showToast("请输入新验证器中的 6 位验证码", "error");
    return;
  }
  setBusy("totp-enroll");
  try {
    const result = await api<{ ok: boolean; recoveryCodes?: string[] }>("/api/auth/totp/enroll", {
      method: "POST",
      body: JSON.stringify({ enrollmentToken: activeEnrollment.token, code }),
    });
    enrollment.value = undefined;
    securityForm.enrollmentCode = "";
    recoveryCodes.value = result.recoveryCodes || [];
    await app.refreshSession();
    app.showToast("验证器已更新，请保存新的恢复码");
  } catch (error) {
    app.showToast((error as Error).message, "error");
  } finally {
    setBusy("");
  }
}

async function createInvite(): Promise<void> {
  if (inviteForm.role === "group_admin" && inviteForm.groupIds.length === 0) {
    app.showToast("群管理员至少需要一个授权群", "error");
    return;
  }
  setBusy("create-invite");
  try {
    const result = await api<{ inviteUrl: string }>("/api/admin-accounts/invites", {
      method: "POST",
      body: JSON.stringify({
        role: inviteForm.role,
        groupIds: inviteForm.role === "group_admin" ? inviteForm.groupIds : [],
        expiresHours: inviteForm.expiresHours,
      }),
    });
    inviteUrl.value = result.inviteUrl;
    inviteForm.groupIds = [];
    await load();
    app.showToast("邀请已创建。链接只在当前页面保留，请安全发送给受邀人");
  } catch (error) {
    app.showToast((error as Error).message, "error");
  } finally {
    setBusy("");
  }
}

async function revokeInvite(invite: AdminInvite): Promise<void> {
  if (!window.confirm("撤销后该邀请链接不能再使用。确定继续吗？")) return;
  setBusy(`invite:${invite.id}`);
  try {
    await api(`/api/admin-accounts/invites/${encodeURIComponent(invite.id)}/revoke`, { method: "POST", body: "{}" });
    await load();
    app.showToast("邀请已撤销");
  } catch (error) {
    app.showToast((error as Error).message, "error");
  } finally {
    setBusy("");
  }
}

async function accountAction(account: AdminAccount, action: "disable" | "enable" | "revoke-sessions"): Promise<void> {
  const labels = { disable: "停用", enable: "启用", "revoke-sessions": "撤销全部会话" };
  if (!window.confirm(`确定要${labels[action]}账号「${account.username}」吗？`)) return;
  setBusy(`account:${account.id}:${action}`);
  try {
    await api(`/api/admin-accounts/${encodeURIComponent(account.id)}/${action}`, { method: "POST", body: "{}" });
    await load();
    app.showToast(`已${labels[action]}账号「${account.username}」`);
  } catch (error) {
    app.showToast((error as Error).message, "error");
  } finally {
    setBusy("");
  }
}

async function saveGrants(account: AdminAccount): Promise<void> {
  if (account.role !== "group_admin") return;
  const groupIds = grantDrafts[account.id] || [];
  if (groupIds.length === 0) {
    app.showToast("群管理员至少需要保留一个授权群", "error");
    return;
  }
  setBusy(`grants:${account.id}`);
  try {
    await api(`/api/admin-accounts/${encodeURIComponent(account.id)}/grants`, {
      method: "POST",
      body: JSON.stringify({ groupIds }),
    });
    await load();
    app.showToast(`已更新「${account.username}」的群授权`);
  } catch (error) {
    app.showToast((error as Error).message, "error");
  } finally {
    setBusy("");
  }
}

function accountStatus(account: AdminAccount): string {
  if (account.disabledAt) return "已停用";
  if (!account.totpEnabled) return "待绑定 TOTP";
  return "已启用";
}

function auditLabel(action: string): string {
  return action.replace(/[_:]/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

onMounted(() => void load());
useRefreshEvents({ refresh: () => void load() });
</script>

<template>
  <section class="page security-page">
    <section class="page-grid security-grid">
      <section class="panel">
        <div class="section-head">
          <div>
            <h2>登录保护</h2>
            <p>敏感操作需要近期 TOTP 验证。完成验证后可改密码、重置验证器或生成恢复码。</p>
          </div>
          <button class="ghost-btn" type="button" :disabled="loading" @click="load">{{ loading ? "刷新中..." : "刷新" }}</button>
        </div>

        <div class="security-section">
          <h3>近期 MFA 验证</h3>
          <form class="inline-form" @submit.prevent="reauthenticate">
            <input v-model="securityForm.reauthCode" class="input code-input" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="6 位验证码" />
            <button class="btn" type="submit" :disabled="busyAction === 'reauth'">{{ busyAction === "reauth" ? "验证中..." : "验证" }}</button>
          </form>
        </div>

        <div class="security-section">
          <h3>更改密码</h3>
          <form class="stack-form" @submit.prevent="changePassword">
            <label>当前密码<input v-model="securityForm.currentPassword" class="input" type="password" autocomplete="current-password" /></label>
            <label>新密码<input v-model="securityForm.nextPassword" class="input" type="password" autocomplete="new-password" /></label>
            <label>确认新密码<input v-model="securityForm.confirmPassword" class="input" type="password" autocomplete="new-password" /></label>
            <button class="ghost-btn align-start" type="submit" :disabled="busyAction === 'password'">{{ busyAction === "password" ? "保存中..." : "更新密码" }}</button>
          </form>
        </div>

        <div class="security-section action-row">
          <div>
            <h3>恢复码</h3>
            <p>新恢复码会立即废弃旧恢复码。每条只能使用一次。</p>
          </div>
          <button class="ghost-btn" type="button" :disabled="busyAction === 'recovery-codes'" @click="regenerateRecoveryCodes">{{ busyAction === "recovery-codes" ? "生成中..." : "生成新恢复码" }}</button>
        </div>

        <div class="security-section action-row">
          <div>
            <h3>重置验证器</h3>
            <p>先完成近期 MFA 验证，然后替换当前 TOTP 密钥。</p>
          </div>
          <button class="ghost-btn danger-action" type="button" :disabled="busyAction === 'totp-reset'" @click="beginTotpReset">{{ busyAction === "totp-reset" ? "处理中..." : "开始重置" }}</button>
        </div>
      </section>

      <aside class="panel security-side">
        <section v-if="enrollment" class="secret-box">
          <h3>绑定新的验证器</h3>
          <p>将下方密钥添加到验证器应用，再输入当前验证码完成替换。</p>
          <code>{{ enrollment.secret }}</code>
          <small>{{ enrollment.uri }}</small>
          <form class="inline-form" @submit.prevent="finishTotpReset">
            <input v-model="securityForm.enrollmentCode" class="input code-input" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="新验证码" />
            <button class="btn" type="submit" :disabled="busyAction === 'totp-enroll'">{{ busyAction === "totp-enroll" ? "确认中..." : "确认" }}</button>
          </form>
        </section>
        <section v-if="recoveryCodes.length" class="secret-box recovery-box">
          <h3>保存恢复码</h3>
          <p>这些代码仅在当前页面显示一次。请在离线安全位置保存。</p>
          <code v-for="code in recoveryCodes" :key="code">{{ code }}</code>
          <button class="ghost-btn" type="button" @click="clearSensitiveDisplays">我已保存</button>
        </section>
        <section v-if="!enrollment && !recoveryCodes.length" class="security-note">
          <h3>账号 {{ app.username }}</h3>
          <p>{{ isSuperAdmin ? "超级管理员可管理后台账号与群授权。" : "群管理员只能管理自己账号的登录保护。" }}</p>
          <p>验证器、密码和恢复码都不会写入普通运营日志。</p>
        </section>
      </aside>
    </section>

    <template v-if="isSuperAdmin">
      <section class="panel">
        <div class="section-head">
          <div>
            <h2>邀请管理员</h2>
            <p>受邀账号首次登录必须设置密码并绑定 TOTP。群管理员只能管理被授予的群。</p>
          </div>
        </div>
        <form class="invite-form" @submit.prevent="createInvite">
          <label>角色
            <select v-model="inviteForm.role" class="select">
              <option value="group_admin">群管理员</option>
              <option value="super_admin">超级管理员</option>
            </select>
          </label>
          <label>有效期
            <select v-model.number="inviteForm.expiresHours" class="select">
              <option :value="1">1 小时</option>
              <option :value="24">24 小时</option>
              <option :value="72">3 天</option>
              <option :value="168">7 天</option>
            </select>
          </label>
          <fieldset v-if="inviteForm.role === 'group_admin'" class="grant-picker">
            <legend>授权群</legend>
            <label v-for="group in allGroups" :key="group.groupId" class="check-row">
              <input v-model="inviteForm.groupIds" type="checkbox" :value="group.groupId" />
              <span>{{ group.groupName || group.groupId }} <small>{{ group.groupId }}</small></span>
            </label>
          </fieldset>
          <button class="btn" type="submit" :disabled="busyAction === 'create-invite'">{{ busyAction === "create-invite" ? "创建中..." : "创建邀请" }}</button>
        </form>
        <section v-if="inviteUrl" class="invite-result">
          <strong>本次邀请链接</strong>
          <code>{{ inviteUrl }}</code>
          <button class="ghost-btn" type="button" @click="clearSensitiveDisplays">隐藏链接</button>
        </section>
      </section>

      <section class="panel">
        <div class="section-head">
          <div>
            <h2>后台账号 <span class="tag">{{ accounts.length }}</span></h2>
            <p>停用账号会撤销其会话；系统保护最后一个超级管理员不被停用。</p>
          </div>
        </div>
        <div v-if="loading" class="empty compact">正在加载账号...</div>
        <div v-else class="account-list">
          <article v-for="account in accounts" :key="account.id" class="account-row">
            <div class="account-main">
              <div class="row-top"><strong>{{ account.username }}</strong><span class="tag" :class="{ warn: !account.totpEnabled, danger: Boolean(account.disabledAt) }">{{ accountStatus(account) }}</span></div>
              <p>{{ account.role === "super_admin" ? "超级管理员 / 全部群" : `群管理员 / ${account.groupIds.length} 个群` }}</p>
              <small>创建于 {{ formatDateTime(account.createdAt) }} · 最近登录 {{ account.lastLoginAt ? formatDateTime(account.lastLoginAt) : "从未" }}</small>
            </div>
            <fieldset v-if="account.role === 'group_admin'" class="grant-picker compact-picker">
              <legend>群授权</legend>
              <label v-for="group in allGroups" :key="group.groupId" class="check-row">
                <input v-model="grantDrafts[account.id]" type="checkbox" :value="group.groupId" :disabled="Boolean(account.disabledAt)" />
                <span>{{ group.groupName || group.groupId }} <small>{{ group.groupId }}</small></span>
              </label>
              <button class="link-btn" type="button" :disabled="Boolean(account.disabledAt) || busyAction === `grants:${account.id}`" @click="saveGrants(account)">保存授权</button>
            </fieldset>
            <div class="account-actions">
              <button class="ghost-btn" type="button" :disabled="busyAction === `account:${account.id}:revoke-sessions`" @click="accountAction(account, 'revoke-sessions')">撤销会话</button>
              <button v-if="account.disabledAt" class="ghost-btn" type="button" :disabled="busyAction === `account:${account.id}:enable`" @click="accountAction(account, 'enable')">启用</button>
              <button v-else class="ghost-btn danger-action" type="button" :disabled="busyAction === `account:${account.id}:disable`" @click="accountAction(account, 'disable')">停用</button>
            </div>
          </article>
        </div>
      </section>

      <section class="page-grid security-grid">
        <section class="panel">
          <div class="section-head"><div><h2>有效邀请 <span class="tag">{{ activeInvites.length }}</span></h2><p>邀请码不会从列表中重新显示。</p></div></div>
          <div v-if="!activeInvites.length" class="empty compact">没有有效邀请。</div>
          <div v-else class="list">
            <article v-for="invite in activeInvites" :key="invite.id" class="list-row">
              <div class="row-top"><strong>{{ invite.role === "super_admin" ? "超级管理员" : "群管理员" }}</strong><button class="link-btn danger-link" type="button" :disabled="busyAction === `invite:${invite.id}`" @click="revokeInvite(invite)">撤销</button></div>
              <p class="row-content">{{ invite.role === "group_admin" ? `授权群：${invite.groupIds.join("、")}` : "全局访问" }}</p>
              <small class="muted">到期：{{ formatDateTime(invite.expiresAt) }}</small>
            </article>
          </div>
          <details v-if="inactiveInvites.length" class="history-details"><summary>已失效邀请 {{ inactiveInvites.length }} 条</summary><p v-for="invite in inactiveInvites" :key="invite.id" class="muted">{{ invite.role }} · {{ invite.revokedAt ? "已撤销" : invite.usedAt ? "已使用" : "已过期" }} · {{ formatDateTime(invite.createdAt) }}</p></details>
        </section>
        <section class="panel">
          <div class="section-head"><div><h2>账号安全审计</h2><p>仅显示认证、会话和授权相关事件。</p></div></div>
          <div v-if="!authAudit.length" class="empty compact">暂无账号安全事件。</div>
          <div v-else class="auth-audit-list">
            <article v-for="entry in authAudit" :key="entry.id" class="auth-audit-row">
              <strong>{{ auditLabel(entry.action) }}</strong>
              <span>{{ formatDateTime(entry.createdAt) }}</span>
              <small>{{ entry.accountId || "系统" }}<template v-if="entry.targetAccountId"> → {{ entry.targetAccountId }}</template></small>
            </article>
          </div>
        </section>
      </section>
    </template>
  </section>
</template>

<style scoped>
.security-grid { grid-template-columns: minmax(0, 1.25fr) minmax(300px, 0.75fr); }
.security-side { align-self: start; }
.security-section { border-top: 1px solid var(--line); padding: 16px 0; }
.security-section:first-of-type { border-top: 0; padding-top: 0; }
.security-section h3, .secret-box h3, .security-note h3 { margin: 0 0 8px; font-size: 16px; }
.security-section p, .secret-box p, .security-note p { margin: 0; color: var(--muted); line-height: 1.6; }
.inline-form { display: flex; align-items: end; gap: 10px; margin-top: 12px; }
.code-input { max-width: 180px; letter-spacing: 0; }
.stack-form { display: grid; gap: 10px; max-width: 480px; margin-top: 12px; }
.stack-form label, .invite-form > label { display: grid; gap: 6px; color: var(--muted); font-size: 13px; font-weight: 700; }
.align-start { justify-self: start; }
.action-row { display: flex; align-items: center; justify-content: space-between; gap: 20px; }
.secret-box, .security-note { display: grid; gap: 12px; border: 1px solid var(--line); border-radius: var(--radius-md); background: var(--surface-raised); padding: 16px; }
.secret-box code, .invite-result code { display: block; overflow-wrap: anywhere; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); padding: 10px; color: var(--text); }
.secret-box small { overflow-wrap: anywhere; color: var(--muted); }
.recovery-box code { font-size: 13px; }
.invite-form { display: grid; grid-template-columns: minmax(180px, 0.4fr) minmax(180px, 0.4fr) minmax(260px, 1fr) auto; align-items: end; gap: 14px; }
.grant-picker { display: grid; gap: 7px; min-width: 0; margin: 0; border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 9px 11px; }
.grant-picker legend { padding: 0 4px; color: var(--muted); font-size: 12px; font-weight: 800; }
.check-row { display: flex; align-items: center; gap: 8px; min-width: 0; color: var(--text); font-size: 13px; }
.check-row span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.check-row small { color: var(--muted); }
.invite-result { display: grid; gap: 10px; margin-top: 16px; border: 1px solid color-mix(in oklch, var(--warning) 40%, var(--line)); border-radius: var(--radius-md); background: color-mix(in oklch, var(--warning) 10%, var(--surface)); padding: 14px; }
.account-list { display: grid; gap: 12px; }
.account-row { display: grid; grid-template-columns: minmax(180px, 0.8fr) minmax(220px, 1fr) auto; align-items: start; gap: 16px; border: 1px solid var(--line); border-radius: var(--radius-md); background: var(--surface-raised); padding: 14px; }
.account-main { min-width: 0; }
.account-main p, .account-main small { display: block; margin: 7px 0 0; color: var(--muted); font-size: 13px; }
.compact-picker { max-height: 140px; overflow: auto; }
.account-actions { display: flex; flex-wrap: wrap; justify-content: end; gap: 8px; }
.danger-action { border-color: color-mix(in oklch, var(--danger) 48%, var(--line)); color: var(--danger); }
.danger-link { color: var(--danger); }
.history-details { margin-top: 12px; color: var(--muted); }
.history-details summary { cursor: pointer; font-weight: 700; }
.auth-audit-list { display: grid; gap: 8px; max-height: 420px; overflow: auto; }
.auth-audit-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 5px 12px; border-bottom: 1px solid var(--line); padding: 9px 0; font-size: 13px; }
.auth-audit-row span, .auth-audit-row small { color: var(--muted); }
.auth-audit-row small { grid-column: 1 / -1; }
@media (max-width: 1100px) { .security-grid, .invite-form, .account-row { grid-template-columns: 1fr; } .account-actions { justify-content: start; } }
@media (max-width: 620px) { .inline-form, .action-row { align-items: stretch; flex-direction: column; } .code-input { max-width: none; } }
</style>
