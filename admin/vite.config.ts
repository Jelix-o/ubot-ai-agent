import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

export default defineConfig({
  root: __dirname,
  plugins: [vue()],
  build: {
    outDir: "../dist/admin",
    emptyOutDir: true,
    target: "es2022",
  },
  server: {
    port: 5178,
    proxy: {
      "/api": "http://127.0.0.1:6200",
    },
  },
});
