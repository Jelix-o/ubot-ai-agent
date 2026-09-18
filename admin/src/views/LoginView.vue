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
    <section class="login-panel">
      <div class="brand">
        <span class="brand-mark">UB</span>
        <div class="brand-text">
          <strong>UBot</strong>
          <small>群聊成员控制台</small>
        </div>
      </div>
      <header class="login-head">
        <h1>{{ inviteToken ? "接受后台邀请" : "后台登录" }}</h1>
        <p>{{ inviteToken ? "设置账号和密码后即可登录。" : "请输入管理员账号和密码。" }}</p>
      </header>
      <form @submit.prevent="login">
        <label>账号<input v-model="form.username" class="input" autocomplete="username" placeholder="请输入账号" required /></label>
        <label>密码<input v-model="form.password" class="input" type="password" :minlength="inviteToken ? 12 : undefined" :autocomplete="inviteToken ? 'new-password' : 'current-password'" :placeholder="inviteToken ? '至少 12 位' : '请输入密码'" required /></label>
        <p v-if="inviteToken" class="policy">邀请创建的账号密码至少 12 位。</p>
        <button class="btn login-btn" type="submit" :disabled="loading">{{ loading ? "登录中..." : actionLabel }}</button>
        <p class="message" role="alert">{{ message }}</p>
      </form>
    </section>
  </main>
</template>

<style scoped>
.login-page {
  display: grid;
  place-items: center;
  min-height: 100vh;
  width: min(100%, 440px);
  margin: 0 auto;
  padding: 24px 16px;
}

.login-panel {
  width: 100%;
  display: grid;
  gap: 24px;
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  background: var(--surface);
  padding: 28px 28px 24px;
  box-shadow: none;
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
}

.brand-mark {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: var(--radius-md);
  background: var(--accent-soft);
  color: var(--accent-strong);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.02em;
  border: 1px solid color-mix(in oklch, var(--accent) 22%, var(--line));
}

.brand-text {
  display: grid;
  gap: 1px;
}

.brand-text strong {
  font-size: 14px;
  font-weight: 700;
  color: var(--text-strong);
  line-height: 1.2;
}

.brand-text small {
  font-size: 12px;
  color: var(--muted);
}

.login-head {
  display: grid;
  gap: 6px;
}

.login-head h1 {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--text-strong);
  line-height: 1.3;
}

.login-head p {
  margin: 0;
  font-size: 12.5px;
  color: var(--muted);
  line-height: 1.5;
}

form {
  display: grid;
  gap: 14px;
}

label {
  display: grid;
  gap: 6px;
  color: var(--muted);
  font-size: 12.5px;
  font-weight: 600;
}

.login-btn {
  width: 100%;
  min-height: 38px;
  margin-top: 2px;
}

.message {
  min-height: 18px;
  margin: 0;
  color: var(--danger);
  font-size: 12.5px;
  line-height: 1.4;
}

.policy {
  margin: 0;
  color: var(--muted);
  font-size: 12.5px;
}

@media (max-width: 480px) {
  .login-page {
    width: 100%;
    padding: 16px 12px;
  }

  .login-panel {
    padding: 22px 18px 18px;
  }
}
</style>
