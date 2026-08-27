<script setup lang="ts">
import { computed, reactive, shallowRef } from "vue";

type LoginStep = "password" | "totp" | "enroll" | "recovery";

const form = reactive({ username: "", password: "", code: "", recoveryCode: "" });
const message = shallowRef("");
const loading = shallowRef(false);
const step = shallowRef<LoginStep>("password");
const challengeToken = shallowRef("");
const enrollmentSecret = shallowRef("");
const enrollmentUri = shallowRef("");
const recoveryCodes = shallowRef<string[]>([]);
const inviteToken = new URLSearchParams(window.location.search).get("invite") || "";
const actionLabel = computed(() => {
  if (step.value === "password") return inviteToken ? "创建受邀账号" : "继续";
  if (step.value === "recovery") return "使用恢复码登录";
  return "验证并登录";
});

async function request(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok) throw new Error(loginError(String(data.error || "login_failed")));
  return data;
}

async function login(): Promise<void> {
  loading.value = true;
  message.value = "";
  try {
    if (step.value === "recovery") {
      const data = await request("/api/auth/recovery", {
        username: form.username.trim(),
        password: form.password,
        recoveryCode: form.recoveryCode,
      });
      if (data.ok === true) {
        window.location.href = "/";
        return;
      }
    } else if (step.value === "totp") {
      const data = await request("/api/auth/totp", { loginToken: challengeToken.value, code: form.code });
      if (data.ok === true) {
        window.location.href = "/";
        return;
      }
    } else if (step.value === "enroll") {
      const data = await request("/api/auth/totp/enroll", { enrollmentToken: challengeToken.value, code: form.code });
      if (data.ok === true) {
        recoveryCodes.value = Array.isArray(data.recoveryCodes) ? data.recoveryCodes.map(String) : [];
        if (!recoveryCodes.value.length) {
          window.location.href = "/";
        }
        return;
      }
    } else {
      const data = inviteToken
        ? await request("/api/auth/invites/accept", {
            inviteToken,
            username: form.username.trim(),
            password: form.password,
          })
        : await request("/api/auth/password", {
            username: form.username.trim(),
            password: form.password,
          });
      const status = String(data.status || "");
      if (status === "totp_required") {
        challengeToken.value = String(data.loginToken || "");
        step.value = "totp";
        form.code = "";
        return;
      }
      if (status === "totp_enrollment_required") {
        challengeToken.value = String(data.enrollmentToken || "");
        enrollmentSecret.value = String(data.totpSecret || "");
        enrollmentUri.value = String(data.totpUri || "");
        step.value = "enroll";
        form.code = "";
        return;
      }
    }
    message.value = "登录流程未完成，请重试。";
  } catch (error) {
    message.value = error instanceof Error ? error.message : "登录失败";
  } finally {
    loading.value = false;
  }
}

function finishRecoveryCodes(): void {
  recoveryCodes.value = [];
  window.location.href = "/";
}

function useRecovery(): void {
  step.value = "recovery";
  message.value = "";
}

function backToPassword(): void {
  step.value = "password";
  challengeToken.value = "";
  form.code = "";
  message.value = "";
}

function loginError(code: string): string {
  return ({
    invalid_credentials: "账号或密码错误。",
    invalid_totp: "验证码错误或已使用。",
    invalid_recovery_code: "恢复码无效或已使用。",
    invalid_challenge: "登录验证已过期，请重新输入账号和密码。",
    too_many_login_attempts: "尝试次数过多，请稍后再试。",
    username_taken: "该账号名已经被使用。",
    invalid_invite: "邀请无效、已过期或已被使用。",
  } as Record<string, string>)[code] || "登录失败，请稍后重试。";
}
</script>

<template>
  <main class="login-page">
    <section class="login-copy">
      <div class="brand">
        <span>UB</span>
        <div>
          <strong>UBot</strong>
          <small>群聊成员控制台</small>
        </div>
      </div>
      <div>
        <h1>自然参与，可靠管理</h1>
        <p>让机器人以有边界、有记忆的方式融入群聊。</p>
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
      <p v-if="step === 'password'">请输入账号和密码继续安全验证。</p>
      <p v-else-if="step === 'totp'">输入验证器应用中的 6 位验证码。</p>
      <p v-else-if="step === 'enroll'">先将密钥添加到验证器应用，再输入当前验证码。</p>
      <p v-else>输入账号密码和一条未使用的恢复码。</p>
      <section v-if="recoveryCodes.length" class="recovery-codes">
        <h3>保存恢复码</h3>
        <p>这些恢复码只显示一次。每条只能使用一次。</p>
        <code v-for="code in recoveryCodes" :key="code">{{ code }}</code>
        <button class="btn" type="button" @click="finishRecoveryCodes">我已保存恢复码</button>
      </section>
      <form @submit.prevent="login">
        <label v-if="step === 'password' || step === 'recovery'">
          账号
          <input v-model="form.username" class="input" autocomplete="username" placeholder="请输入账号" required />
        </label>
        <label v-if="step === 'password' || step === 'recovery'">
          密码
          <input v-model="form.password" class="input" type="password" autocomplete="current-password" placeholder="请输入密码" required />
        </label>
        <label v-if="step === 'totp' || step === 'enroll'">
          验证码
          <input v-model="form.code" class="input" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="6 位验证码" required />
        </label>
        <label v-if="step === 'recovery'">
          恢复码
          <input v-model="form.recoveryCode" class="input" autocomplete="one-time-code" placeholder="例如 ABCD-EF01-2345-6789" required />
        </label>
        <section v-if="step === 'enroll'" class="totp-secret">
          <strong>验证器密钥</strong>
          <code>{{ enrollmentSecret }}</code>
          <small>{{ enrollmentUri }}</small>
        </section>
        <div v-if="!recoveryCodes.length" class="login-row">
          <button v-if="step !== 'password'" class="link-btn" type="button" @click="backToPassword">返回</button>
          <button v-else-if="!inviteToken" class="link-btn" type="button" @click="useRecovery">使用恢复码</button>
          <span>双因素认证</span>
        </div>
        <button v-if="!recoveryCodes.length" class="btn" type="submit" :disabled="loading">{{ loading ? "验证中..." : actionLabel }}</button>
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

.link-btn {
  min-height: 28px;
  background: transparent;
  color: var(--accent-strong);
  padding: 0;
}

.totp-secret,
.recovery-codes {
  display: grid;
  gap: 9px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface-soft);
  padding: 13px;
}

.totp-secret code,
.totp-secret small,
.recovery-codes code {
  overflow-wrap: anywhere;
}

.recovery-codes code {
  display: block;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--surface);
  padding: 7px 9px;
}

@media (max-width: 860px) {
  .login-page {
    grid-template-columns: 1fr;
    padding: 24px 0;
  }
}
</style>
