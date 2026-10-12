function unique(items) {
  return [...new Set((items || []).filter(Boolean))];
}

function normalizeQuery(input) {
  return (input || '').replace(/\s+/g, ' ').trim();
}

function buildQueryVariants(input) {
  const normalized = normalizeQuery(input);
  const variants = [normalized];
  if (/[\u3400-\u9fff]/.test(normalized) && /\s/.test(normalized)) {
    variants.push(normalized.replace(/\s+/g, ''));
  }
  return unique(variants);
}

function extractYearTokens(input) {
  return unique((input || '').match(/(?:19|20)\d{2}/g) || []);
}

function stripYearTokens(input) {
  return normalizeQuery((input || '').replace(/(?:19|20)\d{2}/g, ' '));
}

function buildYearRelaxedQueryVariants(input) {
  const normalized = normalizeQuery(input);
  const variants = [...buildQueryVariants(normalized)];
  const stripped = stripYearTokens(normalized);
  if (stripped && stripped !== normalized) {
    variants.push(...buildQueryVariants(stripped));
  }
  return unique(variants);
}

function resolveQueryContext(input) {
  const normalizedQuery = normalizeQuery(input);
  return {
    normalizedQuery,
    queryVariants: buildQueryVariants(normalizedQuery),
    yearRelaxedQueryVariants: buildYearRelaxedQueryVariants(normalizedQuery),
    yearTokens: extractYearTokens(normalizedQuery)
  };
}

function parseSearchFilters(input) {
  const raw = input || '';
  const episodeMatch = raw.match(/第\s*(\d{1,4})(?:\s*[-~至—]\s*(\d{1,4}))?\s*[集话]/i);
  const filters = {
    latest: /(最新|newest|latest)/i.test(raw),
    chinese: /(中字|中文字幕|简中|繁中|双语|国语|国配|国语配音)/i.test(raw),
    noSubtitle: /(无字|无字幕|生肉|raw)/i.test(raw),
    prefer4k: /(?:^|\s)(4k|2160p)(?:$|\s)/i.test(raw),
    prefer1080: /(?:^|\s)(1080|1080p)(?:$|\s)/i.test(raw),
    smallest: /(小体积|体积最小|最省空间|小一点|省空间)/i.test(raw),
    hdr: /(?:^|\s)hdr(?:$|\s)/i.test(raw),
    dv: /(?:^|\s)dv(?:$|\s)|杜比视界/i.test(raw),
    highBitrate: /(高码|高码版|hq)/i.test(raw),
    collection: /(合集|全集|打包)/i.test(raw),
    singleEpisode: /(单集|单话)/i.test(raw),
    hot: /(热门|高热度)/i.test(raw),
    episodeStart: episodeMatch ? Number.parseInt(episodeMatch[1], 10) : 0,
    episodeEnd: episodeMatch ? Number.parseInt(episodeMatch[2] || episodeMatch[1], 10) : 0
  };

  let cleaned = raw
    .replace(/(?:最新|newest|latest)/ig, ' ')
    .replace(/(?:中字|中文字幕|简中|繁中|双语|国语|国配|国语配音)/ig, ' ')
    .replace(/(?:无字|无字幕|生肉|raw)/ig, ' ')
    .replace(/(?:^|\s)(?:4k|2160p)(?:$|\s)/ig, ' ')
    .replace(/(?:^|\s)(?:1080|1080p)(?:$|\s)/ig, ' ')
    .replace(/(?:小体积|体积最小|最省空间|小一点|省空间)/ig, ' ')
    .replace(/(?:^|\s)hdr(?:$|\s)/ig, ' ')
    .replace(/(?:^|\s)dv(?:$|\s)|杜比视界/ig, ' ')
    .replace(/(?:高码|高码版|hq)/ig, ' ')
    .replace(/(?:合集|全集|打包|单集|单话|热门|高热度)/ig, ' ')
    .replace(/第\s*\d{1,4}(?:\s*[-~至—]\s*\d{1,4})?\s*[集话]/ig, ' ');

  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  return {
    filters,
    cleanedQuery: cleaned || raw.trim()
  };
}

function inferSearchType(input) {
  const normalized = normalizeQuery(input);
  const lowered = normalized.toLowerCase();
  const adultKeywordPattern =
    /(?:^|\W)(?:jav|fc2)(?:$|\W)|无码|有码|中字无码|中文淫语|uncensored|censored|番号|车牌|人妻|痴女|无码破解|麻豆|swag/i;
  const adultCodePattern = /\b[a-z]{2,6}-\d{2,5}\b/i;
  const adultNames = [
    '波多野结衣',
    '三上悠亚',
    '桥本有菜',
    '河北彩花',
    '明里紬',
    '天使萌',
    '葵司',
    '深田咏美',
    '伊藤舞雪',
    '相泽南',
    '桃乃木香奈',
    '小野夕子',
    '本庄铃'
  ];
  const animeHintPattern =
    /(新番|番剧|动画|动漫|国漫|日漫|字幕组|生肉|熟肉|内封|内嵌|简繁|双语|ova|剧场版|第\s*\d+\s*话)/i;
  const movieHintPattern =
    /(电影|电视剧|剧集|美剧|韩剧|日剧|纪录片|综艺|真人版|网剧|院线|蓝光|remux|season|\bs\d{1,3}\b|第\s*\d+\s*集)/i;

  if (adultKeywordPattern.test(normalized)) return 'adult';
  if (adultCodePattern.test(lowered)) return 'adult';
  if (adultNames.some(name => normalized.includes(name))) return 'adult';
  if (animeHintPattern.test(normalized)) return 'anime';
  if (movieHintPattern.test(normalized)) return 'movie';
  return 'anime';
}

module.exports = {
  unique,
  normalizeQuery,
  buildQueryVariants,
  extractYearTokens,
  stripYearTokens,
  buildYearRelaxedQueryVariants,
  resolveQueryContext,
  parseSearchFilters,
  inferSearchType
};
