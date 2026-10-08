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
      "/api": {
        target: process.env.ADMIN_API_TARGET ?? "http://127.0.0.1:6200",
        configure(proxy) {
          const origin = process.env.ADMIN_API_ORIGIN;
          if (origin) proxy.on("proxyReq", (proxyRequest) => proxyRequest.setHeader("origin", origin));
        },
      },
    },
  },
});
