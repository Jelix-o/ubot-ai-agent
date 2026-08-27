import { logError, logInfo } from "./logger.js";

/**
 * Process launcher. `npm start` / `node dist/index.js` now dispatches on the
 * BOT_ROLE environment variable:
 *
 *   BOT_ROLE=ingress  → dist/index-ingress.js   (NapCat WS, dedupe, emitter)
 *   BOT_ROLE=worker   → dist/index-worker.js    (topic routing, LLM, replies)
 *   BOT_ROLE=admin    → dist/index-admin.js     (admin HTTP backend)
 *   BOT_ROLE=legacy   → legacy single-process mode (explicit disaster recovery)
 *
 * The old monolithic `main()` is preserved as the legacy entry so the
 * rollback path (plan section 7) stays a one-line env change.
 */

const role = (process.env.BOT_ROLE ?? "").trim().toLowerCase();
const production = process.env.NODE_ENV === "production";

async function main(): Promise<void> {
  if (role === "ingress") {
    const { main: ingressMain } = await import("./index-ingress.js");
    await ingressMain();
    return;
  }
  if (role === "worker") {
    const { main: workerMain } = await import("./index-worker.js");
    await workerMain();
    return;
  }
  if (role === "admin") {
    const { main: adminMain } = await import("./index-admin.js");
    await adminMain();
    return;
  }
  if (role === "legacy") {
    const { main: legacyMain } = await import("./index-legacy.js");
    await legacyMain();
    return;
  }

  // Keep a convenient local-development default, but production must never
  // silently fall back to the monolith because a systemd environment value was
  // omitted or misspelled. Disaster recovery is always explicit (`legacy`).
  if (production) {
    throw new Error("BOT_ROLE must be ingress, worker, admin, or explicit legacy in production.");
  }
  if (role) {
    throw new Error("BOT_ROLE must be ingress, worker, admin, or legacy.");
  }
  const { main: legacyMain } = await import("./index-legacy.js");
  await legacyMain();
}

const isDirectRun = process.argv[1] && (
  process.argv[1].endsWith("index.js") ||
  process.argv[1].endsWith("index") ||
  process.argv[1].endsWith("dist\\index.js")
);

if (isDirectRun) {
  void main().catch((error) => {
    logError("Application startup failed.", {
      error: error instanceof Error ? error.message : String(error),
      role,
    });
    process.exitCode = 1;
  });
}
