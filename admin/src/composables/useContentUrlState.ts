import { nextTick, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

/** Keep content filters and pagination shareable without replacing unrelated query values. */
export function useContentUrlState(read: () => Record<string, string | number>, apply: (query: Record<string, string>) => void, reload: () => void) {
  const route = useRoute();
  const router = useRouter();
  const keys = Object.keys(read());
  let restoring = false;
  const extract = () => Object.fromEntries(keys.map((key) => [key, typeof route.query[key] === "string" ? route.query[key] as string : ""]));
  apply(extract());
  const encoded = () => Object.fromEntries(Object.entries(read()).map(([key, value]) => [key, value === "" || value === 1 && key.endsWith("page") ? undefined : String(value)]));
  watch(read, () => {
    if (restoring) return;
    const state = encoded();
    if (keys.every((key) => (route.query[key] ?? undefined) === state[key])) return;
    void router.replace({ query: { ...route.query, ...state } });
  }, { deep: true });
  watch(() => keys.map((key) => route.query[key]), async () => {
    const state = encoded();
    if (keys.every((key) => (route.query[key] ?? undefined) === state[key])) return;
    restoring = true;
    apply(extract());
    await nextTick();
    restoring = false;
    reload();
  });
}

export function contentPage(value: string, fallback = 1): number { return /^\d+$/.test(value) ? Math.max(1, Number(value)) : fallback; }
export function contentPageSize(value: string, fallback = 20): number { const size = Number(value); return [10, 20, 50, 100].includes(size) ? size : fallback; }
