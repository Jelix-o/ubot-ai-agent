import assert from "node:assert/strict";
import test from "node:test";

import { TimeoutError, withTimeout } from "./with-timeout.js";

test("withTimeout settles a pending operation when the timeout is the only active handle", async () => {
  const pending = new Promise<never>(() => undefined);

  await assert.rejects(
    () => withTimeout(pending, 20),
    (error: unknown) => error instanceof TimeoutError,
  );
});
