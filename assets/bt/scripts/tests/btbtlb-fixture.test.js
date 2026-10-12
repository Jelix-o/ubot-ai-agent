#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const site = require('../sources/btbtla');
const fx = n => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8');
const config = site.defaultConfig;
const searchUrl = 'https://www.btbtlb.com/search/三体';
const searchItems = site.__test.parseSearchItems(fx('btbtlb-search.html'), searchUrl, config);
assert.strictEqual(searchItems.length, 1);
assert.strictEqual(searchItems[0].year, '2023');
assert.strictEqual(searchItems[0].category, '电视剧');

const relevanceContext = {
  query: '三体',
  queryContext: { queryVariants: ['三体'], yearRelaxedQueryVariants: ['三体'], yearTokens: [] }
};
assert.strictEqual(site.__test.isRelevantSearchItem(searchItems[0], relevanceContext), true);
assert.strictEqual(site.__test.isRelevantSearchItem({ ...searchItems[0], title: '我是女生，也是男生' }, relevanceContext), false);

const detail = site.__test.parseDetailPage(fx('btbtlb-detail.html'), searchItems[0].threadUrl, config);
assert.strictEqual(detail.downloadRows.length, 1);
assert.strictEqual(detail.downloadRows[0].hits, 99);

const download = site.__test.parseDownloadDetail(fx('btbtlb-download.html'), detail.downloadRows[0].detailUrl, config);
assert.strictEqual(download.hash, '3333333333333333333333333333333333333333');
assert.strictEqual(download.sizeLabel, '1.20GB');
assert.ok(download.magnet.includes('3333333333333333333333333333333333333333'));
assert.ok(download.downloadUrl.endsWith('/dlt/token333'));

const normalized = site.__test.normalizeTorrentResult(searchItems[0], detail, detail.downloadRows[0], download, config);
assert.strictEqual(normalized.episodeEnd, 1);
assert.strictEqual(normalized.resolutionLabel, '4K');
assert.strictEqual(normalized.hasChineseSubtitle, true);
console.log('BT影视 fixture test passed');
