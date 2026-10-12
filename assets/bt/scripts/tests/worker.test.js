#!/usr/bin/env node
const assert = require('assert');
const path = require('path');
const { createRuntime } = require('../lib/runtime');

async function main() {
  const runtime = createRuntime({
    workspaceRoot: '/root/.hermes',
    scriptDir: path.resolve(__dirname, '..')
  });

  const first = await runtime.fetchUrl('https://httpbin.org/cookies/set/bt_worker/yes', {
    transportOrder: ['curl_cffi_worker'], timeoutMs: 6000, noCache: true
  });
  assert.strictEqual(first.ok, true);

  const second = await runtime.fetchUrl('https://httpbin.org/cookies', {
    transportOrder: ['curl_cffi_worker'], timeoutMs: 6000, noCache: true
  });
  assert.strictEqual(second.ok, true);
  assert.ok(second.text.includes('bt_worker'), 'persistent worker must reuse the host session cookie');

  if (typeof runtime.close === 'function') await runtime.close();
  console.log('persistent worker session test passed');
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
