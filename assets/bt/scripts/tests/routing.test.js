#!/usr/bin/env node
const assert = require('assert');
const { getSitesForType } = require('../lib/site-registry');
const { resolveTrackerMirrors } = require('../lib/tracker-site');
const onelou = require('../sources/onelou');
const sukebei = require('../sources/sukebei');
const { createRuntime } = require('../lib/runtime');
const path = require('path');
const fs = require('fs');
const os = require('os');

assert.deepStrictEqual(
  getSitesForType('movie').map(site => site.id),
  ['btbtla', 'kpkuang', 'onelou', 'nyaa']
);
assert.deepStrictEqual(resolveTrackerMirrors('nyaa', 'https://nyaa.net/'), [
  'https://nyaa.net/',
  'https://nyaa.si/'
]);
assert.deepStrictEqual(resolveTrackerMirrors('sukebei', 'https://sukebei.nyaa.net/'), [
  'https://sukebei.nyaa.net/',
  'https://sukebei.nyaa.si/'
]);
assert.deepStrictEqual(resolveTrackerMirrors('sukebei', 'https://sukebei.nyaa.net/', true), [
  'https://sukebei.nyaa.net/'
]);
assert.ok(onelou.defaultConfig.fastTimeoutMs <= 5000);
assert.ok(sukebei.defaultConfig.requestOptions.timeoutMs <= 8000);
assert.deepStrictEqual(sukebei.defaultConfig.requestOptions.transportOrder, ['curl_cffi']);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-no-cache-test-'));
const runtime = createRuntime({ workspaceRoot: tempRoot, scriptDir: path.resolve(__dirname, '..') });
const testUrl = 'https://example.invalid/search/test';
(async () => {
  const cacheDir = runtime.cacheDir;
  const crypto = require('crypto');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, `search-${crypto.createHash('sha1').update(testUrl).digest('hex')}.json`), JSON.stringify({
    url: testUrl,
    createdAt: Date.now(),
    html: '<html>stale-cache</html>'
  }));
  const result = await runtime.fetchCachedHtml(testUrl, { noCache: true, allowNetwork: false });
  assert.strictEqual(result.html, '');
  assert.strictEqual(result.reason, 'cache_miss');
  await runtime.close();
  console.log('routing tests passed');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
