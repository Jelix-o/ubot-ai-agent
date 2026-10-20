<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref } from "vue";
import AdminDialog from "./AdminDialog.vue";
import { api, ApiError, registerReauthHandler } from "../services/api";

const visible = ref(false), busy = ref(false), password = ref(""), error = ref("");
const passwordInput = ref<HTMLInputElement>();
let finish: ((error?: Error) => void) | undefined;
let request: AbortController | undefined;
let dispose: (() => void) | undefined;

function cancel() { finish?.(new ApiError("operation_cancelled", 0)); }

onMounted(() => {
  dispose = registerReauthHandler(signal => new Promise<void>((resolve, reject) => {
    const abort = () => cancel();
    finish = failure => {
      signal.removeEventListener("abort", abort);
      request?.abort();
      request = undefined;
      finish = undefined;
      visible.value = false;
      password.value = "";
      busy.value = false;
      error.value = "";
      if (failure) reject(failure); else resolve();
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) return cancel();
    visible.value = true;
    void nextTick().then(() => passwordInput.value?.focus());
  }));
});
onUnmounted(() => { cancel(); dispose?.(); });

async function verify() {
  if (busy.value || !password.value) return;
  busy.value = true;
  error.value = "";
  const attempt = new AbortController();
  request = attempt;
  const body = JSON.stringify({ password: password.value });
  password.value = "";
  try {
    await api("/api/auth/reauth", { method: "POST", body, signal: attempt.signal });
    if (!attempt.signal.aborted) finish?.();
  } catch (failure) {
    if (!attempt.signal.aborted) error.value = (failure as Error).message;
  } finally {
    if (request === attempt) { request = undefined; busy.value = false; }
  }
}
</script>
<template>
  <AdminDialog v-if="visible" title="验证当前密码" description="为保护敏感配置，请验证后继续刚才的操作。当前页面的填写内容会保留。" @close="cancel">
    <form id="admin-reauth" @submit.prevent="verify">
      <label>当前密码<input ref="passwordInput" v-model="password" class="input" type="password" autocomplete="current-password" :disabled="busy" required /></label>
      <p v-if="error" role="alert">{{ error }}</p>
    </form>
    <template #footer>
      <button class="btn" type="button" @click="cancel">取消操作</button>
      <button class="btn primary" type="submit" form="admin-reauth" :disabled="busy || !password">{{ busy ? "验证中…" : "验证并继续" }}</button>
    </template>
  </AdminDialog>
</template>
