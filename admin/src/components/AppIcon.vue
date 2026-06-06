<script setup lang="ts">
defineProps<{
  name: string;
  size?: number;
}>();
</script>

<template>
  <svg class="app-icon" :width="size || 18" :height="size || 18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path v-if="name === 'overview'" d="M4 11.5 12 5l8 6.5V20a1 1 0 0 1-1 1h-5v-6h-4v6H5a1 1 0 0 1-1-1v-8.5Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" />
    <path v-else-if="name === 'settings'" d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Zm8.5 3.5a7.9 7.9 0 0 0-.12-1.35l2.02-1.55-2-3.46-2.43.98a8.3 8.3 0 0 0-2.34-1.35L15.25 2h-6.5l-.38 3.27a8.3 8.3 0 0 0-2.34 1.35L3.6 5.64l-2 3.46 2.02 1.55a7.8 7.8 0 0 0 0 2.7L1.6 14.9l2 3.46 2.43-.98a8.3 8.3 0 0 0 2.34 1.35L8.75 22h6.5l.38-3.27a8.3 8.3 0 0 0 2.34-1.35l2.43.98 2-3.46-2.02-1.55c.08-.44.12-.89.12-1.35Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
    <path v-else-if="name === 'users'" d="M16 11a4 4 0 1 0-8 0 4 4 0 0 0 8 0ZM4 21a8 8 0 0 1 16 0M18 7a3 3 0 0 1 2.3 4.92M20.5 21a5.7 5.7 0 0 0-2.2-4.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
    <path v-else-if="name === 'candidate'" d="M7 4h10l4 4v12H3V4h4Zm10 0v4h4M8 13h8M8 17h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
    <path v-else-if="name === 'memory'" d="M6 4h12a2 2 0 0 1 2 2v13a1 1 0 0 1-1.45.9L12 17l-6.55 2.9A1 1 0 0 1 4 19V6a2 2 0 0 1 2-2Zm2 5h8M8 13h6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
    <path v-else-if="name === 'knowledge'" d="M5 4h10a4 4 0 0 1 4 4v12H9a4 4 0 0 1-4-4V4Zm4 0v12a4 4 0 0 0 4 4M9 8h5M9 12h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
    <path v-else-if="name === 'iteration'" d="M19 5v5h-5M5 19v-5h5M18.2 10A6.8 6.8 0 0 0 6.7 6.7L5 8.4M5.8 14a6.8 6.8 0 0 0 11.5 3.3l1.7-1.7M10 12h4M12 10v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
    <path v-else-if="name === 'health'" d="M20 7.5c0 6-8 12-8 12s-8-6-8-12A4.5 4.5 0 0 1 12 4a4.5 4.5 0 0 1 8 3.5ZM9 11h2l1-2 2 5 1-3h2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
    <path v-else-if="name === 'search'" d="m21 21-4.2-4.2M10.8 18a7.2 7.2 0 1 1 0-14.4 7.2 7.2 0 0 1 0 14.4Z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
    <path v-else-if="name === 'refresh'" d="M20 12a8 8 0 1 1-2.35-5.66M20 4v5h-5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
    <path v-else-if="name === 'bell'" d="M18 9a6 6 0 1 0-12 0c0 7-3 7-3 7h18s-3 0-3-7ZM10 20h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
    <path v-else-if="name === 'list'" d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
    <path v-else-if="name === 'tasks'" d="M7 5h12M7 12h12M7 19h12M3.5 5l.8.8L5.8 4.3M3.5 12l.8.8 1.5-1.5M3.5 19l.8.8 1.5-1.5" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" />
    <path v-else-if="name === 'audit'" d="M6 3.8h9l3 3V20a1.2 1.2 0 0 1-1.2 1.2H6A1.2 1.2 0 0 1 4.8 20V5A1.2 1.2 0 0 1 6 3.8Zm9 0v3h3M8 10h6M8 14h7M8 18h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
    <path v-else-if="name === 'theme'" d="M12 3v2.5M12 18.5V21M4.22 4.22l1.77 1.77M18.01 18.01l1.77 1.77M3 12h2.5M18.5 12H21M4.22 19.78l1.77-1.77M18.01 5.99l1.77-1.77M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
    <path v-else-if="name === 'check'" d="m5 12 4 4L19 6" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" />
    <path v-else d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
  </svg>
</template>

<style scoped>
.app-icon {
  display: block;
  flex: none;
}
</style>
