#!/usr/bin/env node
const assert = require('assert');
const path = require('path');
const { createRuntime } = require('../lib/runtime');

const fakeFetch = path.resolve(__dirname, 'helpers', 'fake-curl-cffi-fetch.js');

async function main() {
  const runtime = createRuntime({
    workspaceRoot: '/root/.hermes',
    scriptDir: path.resolve(__dirname, '..'),
    curlCffiFetchCommand: process.execPath,
    curlCffiFetchScript: fakeFetch
  });

  const failed = await runtime.fetchUrl('https://example.com/definitely-not-found-bt-test', {
    transportOrder: ['curl_cffi'],
    timeoutMs: 10000,
    noCache: true
  });
  assert.strictEqual(failed.ok, false, 'curl_cffi must not report HTTP 404 as success');
  assert.strictEqual(failed.statusCode, 404, 'curl_cffi must preserve the real HTTP status');

  const successful = await runtime.fetchUrl('https://example.com/', {
    transportOrder: ['curl_cffi'],
    timeoutMs: 10000,
    noCache: true
  });
  assert.strictEqual(successful.ok, true);
  assert.strictEqual(successful.statusCode, 200);
  assert.ok(successful.text.includes('Example Domain'));

  console.log('2 transport tests passed');
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
