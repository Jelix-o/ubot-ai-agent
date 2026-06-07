<script setup lang="ts">
import { reactive, shallowRef } from "vue";

type LoginMode = "admin" | "viewer";

const form = reactive({ username: "", password: "" });
const mode = shallowRef<LoginMode>("admin");
const message = shallowRef("");
const loading = shallowRef(false);

async function login(): Promise<void> {
  if (mode.value === "viewer" && !/^\d+$/.test(form.username.trim())) {
    message.value = "请输入正确的 QQ 账号";
    return;
  }
  loading.value = true;
  message.value = "";
  try {
    const body = mode.value === "viewer"
      ? { mode: "viewer", username: form.username.trim() }
      : { mode: "admin", username: form.username.trim(), password: form.password };
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      window.location.href = "/";
      return;
    }
    message.value = mode.value === "viewer" ? "未找到这个 QQ 可查看的群聊" : "账号或密码错误";
  } finally {
    loading.value = false;
  }
}

function switchMode(nextMode: LoginMode): void {
  mode.value = nextMode;
  message.value = "";
  if (nextMode === "viewer") {
    form.password = "";
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
      <p>{{ mode === "viewer" ? "输入 QQ 账号进入只读后台。" : "请输入账号密码登录系统。" }}</p>
      <div class="mode-tabs" role="tablist" aria-label="登录方式">
        <button type="button" role="tab" :aria-selected="mode === 'admin'" :class="{ active: mode === 'admin' }" @click="switchMode('admin')">
          管理员
        </button>
        <button type="button" role="tab" :aria-selected="mode === 'viewer'" :class="{ active: mode === 'viewer' }" @click="switchMode('viewer')">
          普通用户
        </button>
      </div>
      <form @submit.prevent="login">
        <label>
          {{ mode === "viewer" ? "QQ 账号" : "账号" }}
          <input v-model="form.username" class="input" autocomplete="username" :placeholder="mode === 'viewer' ? '请输入 QQ 号' : '请输入账号'" required />
        </label>
        <label v-if="mode === 'admin'">
          密码
          <input v-model="form.password" class="input" type="password" autocomplete="current-password" placeholder="请输入密码" required />
        </label>
        <div class="login-row">
          <label><input type="checkbox" disabled /> 记住登录</label>
          <span>{{ mode === "viewer" ? "只读访问" : "安全登录" }}</span>
        </div>
        <button class="btn" type="submit" :disabled="loading">{{ loading ? "登录中..." : mode === "viewer" ? "只读进入" : "登录" }}</button>
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

.mode-tabs {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin-top: 22px;
  padding: 4px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface-soft);
}

.mode-tabs button {
  min-height: 36px;
  border-radius: 8px;
  background: transparent;
  color: var(--muted);
  font-weight: 800;
}

.mode-tabs button.active {
  background: var(--surface);
  color: var(--accent-strong);
  box-shadow: 0 0 0 1px var(--line);
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
