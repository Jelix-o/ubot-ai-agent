import { shallowRef } from "vue";
export interface ConfirmOptions { title: string; message: string; confirmText?: string; danger?: boolean }
export const confirmation = shallowRef<(ConfirmOptions & { resolve: (answer: boolean) => void }) | null>(null);
export function confirmAction(options: ConfirmOptions): Promise<boolean> {
  return new Promise(resolve => { confirmation.value?.resolve(false); confirmation.value = { ...options, resolve }; });
}
export function resolveConfirmation(answer: boolean): void { const item = confirmation.value; confirmation.value = null; item?.resolve(answer); }
