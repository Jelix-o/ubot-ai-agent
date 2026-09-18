#!/usr/bin/env node
import path from "node:path";
import process from "node:process";

import { openSharedDb } from "../dist/shared/sqlite.js";
import { AdminAuthService } from "../dist/services/admin-auth-service.js";

const options = parseArgs(process.argv.slice(2));
if (!options.username) {
  console.error("Usage: npm run admin:reset-password -- --username <account> [--data-dir <directory>]");
  process.exit(2);
}
if (!process.stdin.isTTY) {
  console.error("Password reset requires an interactive terminal.");
  process.exit(2);
}

const password = await readHidden("New password: ");
const confirmation = await readHidden("Confirm password: ");
if (password !== confirmation) {
  console.error("Passwords do not match.");
  process.exit(2);
}

const dataDir = path.resolve(options.dataDir ?? process.env.UBOT_DATA_DIR ?? path.join(process.cwd(), "data"));
const sharedDb = openSharedDb(dataDir);
try {
  const auth = new AdminAuthService(sharedDb, {});
  await auth.resetPasswordFromServer(options.username, password);
  console.log(`Password reset completed for ${options.username}; all account sessions were revoked.`);
} finally {
  sharedDb.close();
}

function parseArgs(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--username") result.username = args[++index];
    else if (value === "--data-dir") result.dataDir = args[++index];
    else throw new Error(`Unknown argument: ${value}`);
  }
  return result;
}

function readHidden(prompt) {
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = () => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
    };
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === "\r" || character === "\n") {
          finish();
          resolve(value);
          return;
        }
        if (character === "\u0003") {
          finish();
          reject(new Error("cancelled"));
          return;
        }
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else value += character;
      }
    };
    process.stdin.on("data", onData);
  });
}
