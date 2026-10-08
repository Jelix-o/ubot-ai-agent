import { spawn } from "node:child_process";

const target = process.argv[2];
if (!target) throw new Error("Usage: start-admin-preview.mjs <local-api-url>");
const origin = process.argv[3] ?? "http://127.0.0.1";

const child = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--config", "admin/vite.config.ts", "--host", "127.0.0.1"], {
  stdio: "inherit",
  env: { ...process.env, ADMIN_API_TARGET: target, ADMIN_API_ORIGIN: origin },
});
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => child.kill(signal));
child.once("exit", (code) => process.exit(code ?? 1));
