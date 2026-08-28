import assert from "node:assert/strict";
import test from "node:test";

import { validateV3CapabilityPolicy } from "./capability-policy-service.js";

test("capability policy accepts html preview while older persisted policies remain valid", () => {
  assert.doesNotThrow(() => validateV3CapabilityPolicy({
    version: 1,
    enabledCapabilities: ["conversation"],
    updatedAt: "2026-08-28T00:00:00.000Z",
  }));

  assert.doesNotThrow(() => validateV3CapabilityPolicy({
    version: 1,
    enabledCapabilities: ["conversation", "html_preview"],
    updatedAt: "2026-08-28T00:00:00.000Z",
  }));
});

test("capability policy still rejects unknown capability names", () => {
  assert.throws(() => validateV3CapabilityPolicy({
    version: 1,
    enabledCapabilities: ["html_preview_typo"],
    updatedAt: "2026-08-28T00:00:00.000Z",
  }), /v3_capability_policy_unknown_capability:html_preview_typo/);
});
