import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SharedDb } from "../shared/sqlite.js";
import { V3StateRepository } from "./v3-state-repository.js";
import {
  REQUIRED_V3_RUNTIME_CAPABILITIES,
  resolveV3RuntimeState,
} from "./v3-runtime-state.js";

const TEST_STATE_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

test("V3 runtime resolver requires encryption, cutover, and persisted capabilities", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ubot-v3-runtime-"));
  const db = new SharedDb(path.join(dir, "bot-shared.db"));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  assert.throws(
    () => resolveV3RuntimeState(db, undefined, { production: true }),
    /UBOT_STATE_ENCRYPTION_KEY is required for production startup/,
  );
  assert.throws(
    () => resolveV3RuntimeState(db, TEST_STATE_KEY, { production: true }),
    /v3_state_cutover_required/,
  );

  const repository = new V3StateRepository(db, { stateEncryptionKey: TEST_STATE_KEY });
  repository.markCutover();
  assert.throws(
    () => resolveV3RuntimeState(db, TEST_STATE_KEY, { production: true }),
    /v3_capability_policy_missing/,
  );

  repository.saveCapabilityPolicy({
    version: 1,
    enabledCapabilities: [...REQUIRED_V3_RUNTIME_CAPABILITIES],
    updatedAt: "2026-08-27T00:00:00.000Z",
  });
  assert.equal(resolveV3RuntimeState(db, TEST_STATE_KEY, { production: true })?.isCutover(), true);
});

test("V3 runtime resolver rejects a persisted policy missing retained capability", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ubot-v3-runtime-policy-"));
  const db = new SharedDb(path.join(dir, "bot-shared.db"));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const repository = new V3StateRepository(db, { stateEncryptionKey: TEST_STATE_KEY });
  repository.markCutover();
  repository.saveCapabilityPolicy({
    version: 1,
    enabledCapabilities: REQUIRED_V3_RUNTIME_CAPABILITIES.filter((capability) => capability !== "knowledge"),
    updatedAt: "2026-08-27T00:00:00.000Z",
  });

  assert.throws(
    () => resolveV3RuntimeState(db, TEST_STATE_KEY, { production: true }),
    /v3_capability_policy_missing_required:knowledge/,
  );
});
