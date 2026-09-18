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
    <section class="login-copy">
      <div class="brand"><span>UB</span><div><strong>UBot</strong><small>群聊成员控制台</small></div></div>
      <div><h1>自然参与，可靠管理</h1><p>让机器人以有边界、有记忆的方式融入群聊。</p></div>
      <div class="login-visual" aria-hidden="true"><i /><i /><i /></div>
    </section>
    <section class="login-panel">
      <span class="tag">UBot</span>
      <h2>{{ inviteToken ? "接受后台邀请" : "后台登录" }}</h2>
      <p>{{ inviteToken ? "设置账号和密码后即可登录。" : "请输入管理员账号和密码。" }}</p>
      <form @submit.prevent="login">
        <label>账号<input v-model="form.username" class="input" autocomplete="username" placeholder="请输入账号" required /></label>
        <label>密码<input v-model="form.password" class="input" type="password" :minlength="inviteToken ? 12 : undefined" :autocomplete="inviteToken ? 'new-password' : 'current-password'" :placeholder="inviteToken ? '至少 12 位' : '请输入密码'" required /></label>
        <p v-if="inviteToken" class="policy">邀请创建的账号密码至少 12 位。</p>
        <button class="btn" type="submit" :disabled="loading">{{ loading ? "登录中..." : actionLabel }}</button>
        <p class="message" role="alert">{{ message }}</p>
      </form>
    </section>
  </main>
</template>

<style scoped>
.login-page { display: grid; grid-template-columns: minmax(360px, 1.1fr) minmax(360px, .9fr); gap: 48px; align-items: center; min-height: 100vh; width: min(1120px, calc(100% - 48px)); margin: 0 auto; }
.login-copy, .login-panel { border: 1px solid var(--line); border-radius: var(--radius-xl); background: var(--surface); box-shadow: var(--shadow-lg); padding: 42px; }
.login-copy { display: grid; min-height: 480px; align-content: space-between; }
.brand { display: flex; align-items: center; gap: 14px; }
.brand > span { display: grid; place-items: center; width: 48px; height: 48px; border-radius: 8px; background: var(--accent); color: white; font-weight: 900; }
.brand div { display: grid; gap: 2px; }.brand strong { font-size: 20px; }.brand small, .login-panel > p, .login-copy p { color: var(--muted); }
h1 { max-width: 620px; margin: 0 0 14px; font-size: 46px; line-height: 1.08; letter-spacing: 0; } h2 { margin: 18px 0 8px; font-size: 28px; }
form { display: grid; gap: 16px; margin-top: 28px; } label { display: grid; gap: 7px; color: var(--muted); font-size: 13px; font-weight: 700; }
.btn { min-height: 44px; }.message { min-height: 22px; margin: 0; color: var(--danger); font-size: 13px; }.policy { margin: 0; color: var(--muted); font-size: 13px; }
.login-visual { display: flex; gap: 10px; align-items: end; height: 90px; }.login-visual i { display: block; width: 32px; background: var(--accent); }.login-visual i:nth-child(1) { height: 42px; }.login-visual i:nth-child(2) { height: 72px; }.login-visual i:nth-child(3) { height: 56px; }
@media (max-width: 780px) { .login-page { grid-template-columns: 1fr; width: min(100% - 28px, 520px); padding: 20px 0; }.login-copy { display: none; }.login-panel { padding: 28px; } }
</style>
