#!/usr/bin/env node
const assert = require('assert');
const {
  detectResolution,
  hasChineseSubtitle,
  parseEpisodeInfo,
  mergeCrossSourceResults,
  applySearchFilters
} = require('../lib/media-utils');
const { inferSearchType, resolveQueryContext } = require('../lib/query-utils');

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

test('Mikan 坐标分辨率识别', () => {
  assert.deepStrictEqual(detectResolution('1920x1080 HEVC AAC'), { rank: 1080, label: '1080P' });
  assert.deepStrictEqual(detectResolution('3840x2160 HEVC'), { rank: 2160, label: '4K' });
});

test('Mikan 字幕标签识别', () => {
  assert.strictEqual(hasChineseSubtitle('[GM-Team][GB][1080P]'), true);
  assert.strictEqual(hasChineseSubtitle('[ANi][CHT][1080P]'), true);
  assert.strictEqual(hasChineseSubtitle('[Raw][JPN][1080P]'), false);
  assert.strictEqual(hasChineseSubtitle('Movie 1.5 GB'), false);
});

test('常见动漫集数识别', () => {
  assert.deepStrictEqual(parseEpisodeInfo('凡人修仙传 - 188 [1080P]'), { start: 188, end: 188, isBatch: false });
  assert.deepStrictEqual(parseEpisodeInfo('[2026][12][AVC][GB][1080P]'), { start: 12, end: 12, isBatch: false });
  assert.deepStrictEqual(parseEpisodeInfo('第29-38话 合集'), { start: 29, end: 38, isBatch: true });
  assert.deepStrictEqual(parseEpisodeInfo('[ANi] Title [1080] [HEVC]'), { start: 0, end: 0, isBatch: false });
  assert.deepStrictEqual(parseEpisodeInfo('Title S01E02 1080p'), { start: 2, end: 2, isBatch: false });
  assert.deepStrictEqual(parseEpisodeInfo('Title 2024 10'), { start: 0, end: 0, isBatch: false });
});

test('分辨率边界识别', () => {
  assert.deepStrictEqual(detectResolution('4Kids Show'), { rank: 0, label: '未知' });
  assert.deepStrictEqual(detectResolution('Show 1080i'), { rank: 1080, label: '1080I' });
  assert.deepStrictEqual(detectResolution('Show 1440p'), { rank: 1440, label: '1440P' });
  assert.deepStrictEqual(detectResolution('Show 8K'), { rank: 4320, label: '8K' });
});

test('搜索类型推断', () => {
  assert.strictEqual(inferSearchType('葬送的芙莉莲 新番'), 'anime');
  assert.strictEqual(inferSearchType('三体 电视剧'), 'movie');
  assert.strictEqual(inferSearchType('中文字幕 动画'), 'anime');
  assert.strictEqual(inferSearchType('AV1 编码 动画'), 'anime');
  assert.notStrictEqual(inferSearchType('Java 教程'), 'adult');
  assert.notStrictEqual(inferSearchType('Avatar 2009'), 'adult');
  assert.strictEqual(inferSearchType('权力的游戏 S01'), 'movie');
  assert.strictEqual(inferSearchType('波多野结衣'), 'adult');
});

test('单集筛选排除未知集数', () => {
  const filtered = applySearchFilters([
    { title: 'Unknown movie', episodeStart: 0, episodeEnd: 0, episodeIsBatch: false },
    { title: 'Show E02', episodeStart: 2, episodeEnd: 2, episodeIsBatch: false }
  ], { singleEpisode: true });
  assert.deepStrictEqual(filtered.map(item => item.title), ['Show E02']);
});

test('异常集数不能压倒高质量正常集数', () => {
  const merged = mergeCrossSourceResults([
    { siteId: 'bad', siteName: 'Bad', results: [{ title: 'Show E1000 720p', magnet: 'magnet:?xt=urn:btih:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }] },
    { siteId: 'good', siteName: 'Good', results: [{ title: 'Show E12 2160p 中字', magnet: 'magnet:?xt=urn:btih:cccccccccccccccccccccccccccccccccccccccc', seeders: 500 }] }
  ]);
  assert.strictEqual(merged.items[0].siteId, 'good');
});

test('查询变体去空格', () => {
  const ctx = resolveQueryContext('光阴 之外');
  assert.ok(ctx.queryVariants.includes('光阴之外'));
});

test('跨源按 InfoHash 去重并合并来源', () => {
  const magnet = 'magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const merged = mergeCrossSourceResults([
    { siteId: 'mikan', siteName: '蜜柑计划', results: [{ title: 'Test - 01 [1080P]', magnet }] },
    { siteId: 'nyaa', siteName: 'Nyaa', results: [{ title: 'Test - 01 [1080P]', magnet }] }
  ]);
  assert.strictEqual(merged.uniqueCount, 1);
  assert.deepStrictEqual(merged.items[0].sources.sort(), ['mikan', 'nyaa']);
});

test('无 InfoHash 时跨发布组保守去重', () => {
  const merged = mergeCrossSourceResults([
    { siteId: 'mikan', siteName: '蜜柑计划', results: [{ title: '[ANi] 葬送的芙莉莲 - 28 [1080P][CHT]', pageUrl: 'https://a/1' }] },
    { siteId: 'nyaa', siteName: 'Nyaa', results: [{ title: '[LoliHouse] 葬送的芙莉莲 S01E28 1080p CHT', pageUrl: 'https://b/2' }] }
  ]);
  assert.strictEqual(merged.uniqueCount, 1);
  assert.deepStrictEqual(merged.items[0].sources.sort(), ['mikan', 'nyaa']);
});

test('无 InfoHash 时不同版本不得误合并', () => {
  const merged = mergeCrossSourceResults([
    { siteId: 'a', siteName: 'A', results: [{ title: '[A] Show - 01 [1080P][CHS][AVC]', pageUrl: 'https://a/1' }] },
    { siteId: 'b', siteName: 'B', results: [{ title: '[B] Show - 01 [1080P][CHT][HEVC]', pageUrl: 'https://b/2' }] },
    { siteId: 'c', siteName: 'C', results: [{ title: '[C] Show 2024 - 01 [1080P][CHS][AVC]', pageUrl: 'https://c/3' }] },
    { siteId: 'd', siteName: 'D', results: [{ title: '[D] Show - 01-12 [1080P][CHS][AVC][合集]', pageUrl: 'https://d/4' }] }
  ]);
  assert.strictEqual(merged.uniqueCount, 4);
});

let failed = 0;
for (const item of cases) {
  try {
    item.fn();
    console.log(`✓ ${item.name}`);
  } catch (error) {
    failed += 1;
    console.error(`✗ ${item.name}`);
    console.error(error.stack || error.message);
  }
}

if (failed > 0) {
  process.exitCode = 1;
} else {
  console.log(`\n${cases.length} tests passed`);
}
