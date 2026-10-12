#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const mikan = require('../sources/mikan');

const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'mikan-search.html'), 'utf8');
const raw = mikan.__test.parseSearchResults(html, 'https://mikanani.me/', 20);
assert.strictEqual(raw.length, 2);

const first = mikan.__test.normalizeSearchResult(raw[0], 'https://mikanani.me/');
assert.strictEqual(first.episodeEnd, 12);
assert.strictEqual(first.resolutionLabel, '4K');
assert.strictEqual(first.hasChineseSubtitle, true);
assert.strictEqual(first.sizeLabel, '1.15 GB');
assert.ok(first.torrentUrl.endsWith('.torrent'));
assert.strictEqual(first.infoHash, 'a9091799ffb7c2cb0d3bfdc66697f1e308a9689e');

const second = mikan.__test.normalizeSearchResult(raw[1], 'https://mikanani.me/');
assert.strictEqual(second.episodeEnd, 188);
assert.strictEqual(second.resolutionLabel, '1080P');
assert.strictEqual(second.hasChineseSubtitle, false);

console.log('Mikan fixture test passed');
