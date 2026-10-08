import { watch } from "vue";
import { useRoute, useRouter } from "vue-router";
// Two-way query state. Unknown URL keys (workspace/group/bookmarks) are retained.
export function useUrlState<T extends Record<string, any>>(state: T, keys: (keyof T)[] = Object.keys(state), prefix = ""): void {
  const route = useRoute(), router = useRouter();
  const defaults = { ...state }; let syncing = false;
  function restore() {
    syncing = true;
    for (const key of keys) { const value = route.query[prefix + String(key)]; const raw = Array.isArray(value) ? value[0] : value;
      state[key] = (raw == null ? defaults[key] : typeof defaults[key] === "number" ? Math.max(1, Number(raw) || defaults[key]) : typeof defaults[key] === "boolean" ? raw === "true" : raw) as T[keyof T]; }
    syncing = false;
  }
  restore();
  watch(() => route.query, restore, { flush: "sync" });
  watch(() => keys.map(key => state[key]), () => {
    if (syncing) return;
    const query = { ...route.query };
    for (const key of keys) { const value = state[key]; const queryKey = prefix + String(key); if (value === "" || value == null || value === defaults[key]) delete query[queryKey]; else query[queryKey] = String(value); }
    if (JSON.stringify(query) !== JSON.stringify(route.query)) void router.replace({ query });
  }, { flush: "post" });
}
