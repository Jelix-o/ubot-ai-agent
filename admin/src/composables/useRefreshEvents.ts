import { onMounted, onUnmounted } from "vue";

export const refreshCurrentEvent = "ubot-refresh-current";
export const groupChangedEvent = "ubot-group-changed";

interface RefreshEventHandlers {
  refresh?: () => void;
  groupChanged?: () => void;
}

export function dispatchRefreshCurrent(): void {
  window.dispatchEvent(new CustomEvent(refreshCurrentEvent));
}

export function dispatchGroupChanged(): void {
  window.dispatchEvent(new CustomEvent(groupChangedEvent));
}

export function useRefreshEvents(handlers: RefreshEventHandlers): void {
  onMounted(() => {
    if (handlers.refresh) window.addEventListener(refreshCurrentEvent, handlers.refresh);
    if (handlers.groupChanged) window.addEventListener(groupChangedEvent, handlers.groupChanged);
  });

  onUnmounted(() => {
    if (handlers.refresh) window.removeEventListener(refreshCurrentEvent, handlers.refresh);
    if (handlers.groupChanged) window.removeEventListener(groupChangedEvent, handlers.groupChanged);
  });
}
