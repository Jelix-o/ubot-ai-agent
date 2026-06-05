<script setup lang="ts">
import { reactive, shallowRef } from "vue";

const form = reactive({ username: "", password: "" });
const message = shallowRef("");
const loading = shallowRef(false);

async function login(): Promise<void> {
  loading.value = true;
  message.value = "";
  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    if (res.ok) window.location.href = "/";
    else message.value = "账号或密码错误";
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <main class="login-page">
    <section class="login-copy">
      <div class="brand">
        <span>UB</span>
        <div>
          <strong>UBot</strong>
          <small>群聊运营控制台</small>
        </div>
      </div>
      <div>
        <h1>高效运营，智能管理</h1>
        <p>让群聊运营更简单、更稳定、更安全。</p>
      </div>
      <div class="login-visual" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
    </section>
    <section class="login-panel">
      <span class="tag">UBot</span>
      <h2>后台登录</h2>
      <p>欢迎回来，请输入账号密码登录系统</p>
      <form @submit.prevent="login">
        <label>
          账号
          <input v-model="form.username" class="input" autocomplete="username" placeholder="请输入账号" required />
        </label>
        <label>
          密码
          <input v-model="form.password" class="input" type="password" autocomplete="current-password" placeholder="请输入密码" required />
        </label>
        <div class="login-row">
          <label><input type="checkbox" disabled /> 记住登录</label>
          <span>安全登录，保护账号信息</span>
        </div>
        <button class="btn" type="submit" :disabled="loading">{{ loading ? "登录中..." : "登录" }}</button>
        <p class="message">{{ message }}</p>
      </form>
    </section>
  </main>
</template>

<style scoped>
.login-page {
  display: grid;
  grid-template-columns: minmax(380px, 0.95fr) minmax(360px, 0.75fr);
  gap: 52px;
  align-items: center;
  min-height: 100vh;
  width: min(1180px, calc(100% - 48px));
  margin: 0 auto;
}

.login-copy,
.login-panel {
  border: 1px solid var(--line);
  border-radius: 24px;
  background: color-mix(in oklch, var(--surface) 86%, transparent);
  box-shadow: var(--shadow-md);
  padding: 44px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 14px;
}

.brand span {
  display: grid;
  place-items: center;
  width: 46px;
  height: 46px;
  border-radius: 15px;
  background: var(--accent-strong);
  color: oklch(0.99 0.004 160);
  font-weight: 900;
}

.brand strong {
  display: block;
  font-size: 30px;
}

.brand small,
.login-copy p,
.login-panel p,
.login-row {
  color: var(--muted);
}

.login-copy h1 {
  margin: 72px 0 12px;
  font-size: 44px;
}

.login-visual {
  display: grid;
  gap: 16px;
  margin-top: 72px;
}

.login-visual i {
  display: block;
  height: 68px;
  border-radius: 18px;
  background: linear-gradient(90deg, var(--accent-soft), var(--surface));
}

.login-panel h2 {
  margin: 18px 0 8px;
  font-size: 34px;
}

form {
  display: grid;
  gap: 18px;
  margin-top: 28px;
}

label {
  display: grid;
  gap: 8px;
  font-weight: 700;
}

.login-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 13px;
}

.login-row label {
  display: inline-flex;
  align-items: center;
}

.message {
  min-height: 20px;
  color: var(--danger);
}

@media (max-width: 860px) {
  .login-page {
    grid-template-columns: 1fr;
    padding: 24px 0;
  }
}
</style>
