#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const nyaa = require('../sources/nyaa');
const sukebei = require('../sources/sukebei');

const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'nyaa-search.html'), 'utf8');
for (const [site, base] of [[nyaa, 'https://nyaa.net/'], [sukebei, 'https://sukebei.nyaa.net/']]) {
  const raw = site.__test.parseSearchResults(html, base, site.defaultConfig);
  assert.strictEqual(raw.length, 1);
  const item = site.__test.normalizeSearchResult(raw[0], base);
  assert.strictEqual(item.episodeEnd, 28);
  assert.strictEqual(item.resolutionLabel, '1080P');
  assert.strictEqual(item.hasChineseSubtitle, true);
  assert.strictEqual(item.seedersValue, 88);
  assert.strictEqual(item.leechersValue, 3);
  assert.strictEqual(item.completed, '120');
  assert.ok(item.torrentUrl.endsWith('/download/12345.torrent'));
  assert.ok(item.magnet.includes('1111111111111111111111111111111111111111'));
}
console.log('Nyaa/Sukebei fixture test passed');
