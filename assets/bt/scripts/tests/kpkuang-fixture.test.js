#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const site = require('../sources/kpkuang');
const fx = n => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8');
const config = site.defaultConfig;
assert.strictEqual(
  site.__test.buildSearchUrl('三体', config),
  'https://www.kpkuang.org/vodsearch/%E4%B8%89%E4%BD%93-------------.html'
);

const candidates = site.__test.parseSearchCandidates(fx('kpkuang-search.html'), '三体 2023', config, { fastMode: false });
assert.ok(candidates.length >= 1);
assert.ok(candidates[0].text.includes('2023'));
assert.ok(!candidates[0].text.includes('动态漫画'));
const bestCandidate = { ...candidates[0], detailUrl: 'https://www.kpkuang.org/voddetail/100/' };

const links = site.__test.parseDetailDownloadLinks(fx('kpkuang-detail.html'), '100', config);
assert.strictEqual(links.length, 2);
assert.strictEqual(links[0].ep, 30);
assert.strictEqual(links[0].qualityScore > links[1].qualityScore, true);
assert.strictEqual(site.__test.parseDownloadToken(fx('kpkuang-download.html')), 'encrypted-token-30');

const magnet = 'magnet:?xt=urn:btih:4444444444444444444444444444444444444444&dn=threebody';
const normalized = site.__test.normalizeResult(magnet, links[0], bestCandidate);
assert.strictEqual(normalized.episodeEnd, 30);
assert.strictEqual(normalized.resolutionLabel, '4K');
assert.strictEqual(normalized.hasChineseSubtitle, true);
assert.ok(normalized.magnet.includes('4444444444444444444444444444444444444444'));
console.log('KPkuang fixture test passed');
