<script setup lang="ts">
import { computed, reactive, shallowRef } from "vue";

const form = reactive({ username: "", password: "" });
const message = shallowRef("");
const loading = shallowRef(false);
const inviteToken = new URLSearchParams(window.location.search).get("invite") || "";
const actionLabel = computed(() => inviteToken ? "创建受邀账号并登录" : "登录控制台");

async function login(): Promise<void> {
  loading.value = true;
  message.value = "";
  try {
    const path = inviteToken ? "/api/auth/invites/accept" : "/api/auth/password";
    const body = inviteToken
      ? { inviteToken, username: form.username.trim(), password: form.password }
      : { username: form.username.trim(), password: form.password };
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new Error(loginError(String(data.error || "login_failed")));
    if (data.ok !== true && data.status !== "authenticated") throw new Error("登录流程未完成，请重试。");
    window.location.href = "/";
  } catch (error) {
    message.value = error instanceof Error ? error.message : "登录失败";
  } finally {
    loading.value = false;
  }
}

function loginError(code: string): string {
  return ({
    invalid_credentials: "账号或密码错误。",
    too_many_login_attempts: "尝试次数过多，请稍后再试。",
    username_taken: "该账号名已经被使用。",
    invalid_invite: "邀请无效、已过期或已被使用。",
    invalid_password: "密码至少 12 位。",
  } as Record<string, string>)[code] || "登录失败，请稍后重试。";
}
</script>

<template>
  <main class="login-page">
    <section class="login-shell m-surface" aria-labelledby="login-title">
      <aside class="login-brief">
        <div class="login-brand">
          <span class="login-mark">UB</span>
          <span><strong>UBot</strong><small>群聊运营控制台</small></span>
        </div>
        <div class="brief-copy">
          <p class="brief-eyebrow">ADMIN CONSOLE</p>
          <h1>保持群聊运营的
            <span>清晰与可控</span>
          </h1>
          <p>从一个安静、聚焦的工作台管理群配置、记忆与运行状态。</p>
        </div>
        <div class="brief-status"><span></span>服务状态由登录后控制台展示</div>
      </aside>
      <section class="login-entry">
        <header class="login-head">
          <p class="entry-eyebrow">{{ inviteToken ? "受邀访问" : "安全访问" }}</p>
          <h2 id="login-title">{{ inviteToken ? "接受后台邀请" : "后台登录" }}</h2>
          <p>{{ inviteToken ? "设置账号和密码后即可进入控制台。" : "请输入管理员账号和密码。" }}</p>
        </header>
        <form @submit.prevent="login">
          <label>账号<input v-model="form.username" class="input" autocomplete="username" placeholder="请输入账号" required /></label>
          <label>密码<input v-model="form.password" class="input" type="password" :minlength="inviteToken ? 12 : undefined" :autocomplete="inviteToken ? 'new-password' : 'current-password'" :placeholder="inviteToken ? '至少 12 位' : '请输入密码'" required /></label>
          <p v-if="inviteToken" class="policy">邀请创建的账号密码至少 12 位。</p>
          <button class="btn login-btn" type="submit" :disabled="loading">{{ loading ? "登录中..." : actionLabel }}</button>
          <p class="message" role="alert">{{ message }}</p>
        </form>
      </section>
    </section>
  </main>
</template>

<style scoped>
.login-page {
  display: grid;
  min-height: 100dvh;
  place-items: center;
  padding: 28px;
  background-color: var(--stage);
  background-image:
    linear-gradient(rgb(var(--shade) / 0.028) 1px, transparent 1px),
    linear-gradient(90deg, rgb(var(--shade) / 0.028) 1px, transparent 1px);
  background-size: 24px 24px;
}

.login-shell {
  display: grid;
  grid-template-columns: minmax(330px, 0.92fr) minmax(380px, 1.08fr);
  width: min(100%, 1040px);
  min-height: 588px;
  overflow: hidden;
  border-radius: var(--r-xl);
  background: var(--surface-gradient);
  box-shadow: var(--e3), var(--edge-strong);
}

.login-brief {
  position: relative;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 34px;
  background: #253134;
  box-shadow: inset -1px 0 0 rgb(255 255 255 / 0.07);
  color: #edf4f1;
}

.login-brief::before {
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(rgb(255 255 255 / 0.042) 1px, transparent 1px),
    linear-gradient(90deg, rgb(255 255 255 / 0.042) 1px, transparent 1px);
  background-size: 26px 26px;
  content: "";
  opacity: 0.65;
  pointer-events: none;
}

.login-brief > * {
  position: relative;
  z-index: 1;
}

.login-brand {
  display: flex;
  align-items: center;
  gap: 10px;
}

.login-mark {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border: 1px solid rgb(255 255 255 / 0.14);
  border-radius: 11px;
  background: #182326;
  color: #f8fbfa;
  box-shadow: 0 5px 13px rgb(0 0 0 / 0.16), inset 0 1px 0 rgb(255 255 255 / 0.12);
  font-size: 11px;
  font-weight: 800;
}

.login-brand > span:last-child {
  display: grid;
  gap: 2px;
}

.login-brand strong {
  font-size: 14px;
  font-weight: 750;
}

.login-brand small {
  color: #b8c6c0;
  font-size: 11px;
}

.brief-copy {
  display: grid;
  gap: 14px;
  max-width: 300px;
  margin: auto 0;
}

.brief-eyebrow,
.entry-eyebrow {
  margin: 0;
  font-size: 10px;
  font-weight: 750;
}

.brief-eyebrow {
  color: var(--lime);
}

.brief-copy h1 {
  margin: 0;
  color: #ffffff;
  font-size: 29px;
  font-weight: 720;
  line-height: 1.3;
}

.brief-copy h1 span {
  color: #c8f19b;
}

.brief-copy > p:last-child {
  margin: 0;
  color: #c2cdc7;
  font-size: 13px;
  line-height: 1.8;
}

.brief-status {
  display: flex;
  align-items: center;
  gap: 7px;
  color: #b9c8c0;
  font-size: 11px;
}

.brief-status span {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--lime);
  box-shadow: 0 0 0 3px rgb(130 221 45 / 0.16);
}

.login-entry {
  display: grid;
  align-content: center;
  gap: 28px;
  padding: 58px;
  background: color-mix(in oklch, var(--surface-raised) 86%, transparent);
}

.login-head {
  display: grid;
  gap: 7px;
}

.entry-eyebrow {
  color: var(--accent);
}

.login-head h2 {
  margin: 0;
  color: var(--text-strong);
  font-size: 24px;
  font-weight: 730;
  line-height: 1.25;
}

.login-head > p:last-child {
  margin: 0;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.6;
}

form {
  display: grid;
  gap: 16px;
}

label {
  display: grid;
  gap: 7px;
  color: var(--text);
  font-size: 12px;
  font-weight: 680;
}

.input {
  min-height: 40px;
}

.login-btn {
  width: 100%;
  min-height: 40px;
  margin-top: 4px;
}

.message,
.policy {
  min-height: 18px;
  margin: -2px 0 0;
  font-size: 12px;
  line-height: 1.45;
}

.message {
  color: var(--danger);
}

.policy {
  min-height: 0;
  color: var(--muted);
}

:global(:root[data-theme="dark"]) .login-brief {
  background: #1b2527;
}

:global(:root[data-theme="dark"]) .login-shell {
  border-color: var(--line-strong);
}

@media (max-width: 760px) {
  .login-page {
    place-items: stretch;
    padding: 16px;
  }

  .login-shell {
    grid-template-columns: 1fr;
    min-height: 0;
    margin: auto 0;
  }

  .login-brief {
    min-height: 210px;
    padding: 26px;
  }

  .brief-copy {
    margin: 34px 0 0;
  }

  .brief-copy h1 {
    font-size: 24px;
  }

  .brief-status {
    display: none;
  }

  .login-entry {
    padding: 34px 28px 30px;
  }
}

@media (max-width: 430px) {
  .login-page {
    padding: 0;
  }

  .login-shell {
    min-height: 100dvh;
    border: 0;
    border-radius: 0;
  }

  .login-brief {
    min-height: 184px;
    padding: 22px;
  }

  .brief-copy {
    margin-top: 26px;
  }

  .brief-copy > p:last-child {
    display: none;
  }

  .login-entry {
    padding: 28px 22px;
  }
}
</style>
