#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const onelou = require('../sources/onelou');
const fx = name => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const config = onelou.defaultConfig;
const searchUrl = 'https://www.1lou.me/search/api/search.php?q=x';

const jsonItems = onelou.__test.parseSearchItems(fx('onelou-search.json'), searchUrl, config);
assert.strictEqual(jsonItems.length, 2);
assert.strictEqual(jsonItems[0].category, '电影');
assert.strictEqual(jsonItems[1].cloudOnly, true);

const htmlItems = onelou.__test.parseSearchItems(fx('onelou-search.html'), searchUrl, config);
assert.strictEqual(htmlItems.length, 1);
assert.ok(htmlItems[0].threadUrl.endsWith('thread-77.htm'));

const parsed = onelou.__test.parseThreadAttachments(fx('onelou-thread.html'), 'https://www.1lou.me/thread-10231.htm');
assert.strictEqual(parsed.attachments.length, 1);
assert.strictEqual(parsed.magnets.length, 1);
const normalized = onelou.__test.normalizeAttachmentResult(jsonItems[0], {
  ...parsed.attachments[0], magnet: parsed.magnets[0]
}, config);
assert.strictEqual(normalized.resolutionLabel, '4K');
assert.strictEqual(normalized.hasChineseSubtitle, true);
assert.ok(normalized.downloadUrl.endsWith('attach-download-13093.htm'));
console.log('1LOU JSON/HTML fixture test passed');
