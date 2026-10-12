function unifyTitle(title) {
  let t = String(title || '').toLowerCase();
  // strip common packaging noise but keep core title/episode tokens
  t = t.replace(/\[[^\]]*(?:bt下载|夸克|阿里云盘|网盘|字幕组|简中|繁中|中字|国语|双语|内封|内嵌|10bit|hevc|x26[45]|aac|flac|web-?dl|webrip|bdrip|hdr|dv)[^\]]*\]/gi, ' ');
  t = t.replace(/\((?:web-?dl|webrip|bdrip|hevc|x26[45]|aac|flac|10bit)[^)]*\)/gi, ' ');
  t = t.replace(/\.torrent|\.mkv|\.mp4|\.ts/gi, ' ');
  t = t.replace(/[_\.]+/g, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

function extractInfoHash(magnetOrUrl) {
  const text = String(magnetOrUrl || '');
  const match = text.match(/btih:([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})/i);
  return match ? match[1].toLowerCase() : '';
}

function parseDateValue(value) {
  if (!value) return 0;
  const normalized = value.replace(/\//g, '-').trim();
  const timestamp = Date.parse(normalized.replace(' ', 'T'));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function parseSizeInfo(...texts) {
  const merged = texts.filter(Boolean).join(' ');
  const match = merged.match(/(\d+(?:\.\d+)?)\s*(TiB|GiB|MiB|KiB|TB|GB|MB|KB)/i);
  if (!match) {
    return {
      bytes: Number.POSITIVE_INFINITY,
      label: '未知'
    };
  }

  const value = Number.parseFloat(match[1]);
  const unit = match[2].toUpperCase();
  const multiplier = {
    KIB: 1024,
    MIB: 1024 ** 2,
    GIB: 1024 ** 3,
    TIB: 1024 ** 4,
    KB: 1024,
    MB: 1024 ** 2,
    GB: 1024 ** 3,
    TB: 1024 ** 4
  }[unit] || 1;

  return {
    bytes: value * multiplier,
    label: `${match[1]} ${match[2]}`
  };
}

function detectResolution(...texts) {
  const merged = texts.filter(Boolean).join(' ').toLowerCase();
  if (/(?:^|[^a-z0-9])(?:4320p|8k)(?:$|[^a-z0-9])|7680x4320/i.test(merged)) return { rank: 4320, label: '8K' };
  if (/(?:^|[^a-z0-9])(?:2160p|4k|web-4k|uhd)(?:$|[^a-z0-9])|3840x2160/i.test(merged)) return { rank: 2160, label: '4K' };
  if (/(?:^|[^a-z0-9])1440p(?:$|[^a-z0-9])|2560x1440/i.test(merged)) return { rank: 1440, label: '1440P' };
  if (/(?:^|[^a-z0-9])1080i(?:$|[^a-z0-9])/i.test(merged)) return { rank: 1080, label: '1080I' };
  if (/(?:^|[^a-z0-9])(?:1080p|web-1080p|fhd)(?:$|[^a-z0-9])|1920x1080/i.test(merged)) return { rank: 1080, label: '1080P' };
  if (/(?:^|[^a-z0-9])(?:720p|web-720p)(?:$|[^a-z0-9])|1280x720/i.test(merged)) return { rank: 720, label: '720P' };
  return { rank: 0, label: '未知' };
}

function hasChineseSubtitle(...texts) {
  const merged = texts.filter(Boolean).join(' ');
  return /(中字|中文字幕|简中|繁中|简繁|中英字幕|双语字幕|内封|内嵌|国语中字|中字版|字幕版|\[(?:GB|BIG5|CHS|CHT|JPTC)\]|\b(?:GB2312|GBK|CHS|CHT|JPTC|BIG5)\b)/i.test(merged);
}

function parseEpisodeInfo(...texts) {
  const merged = texts.filter(Boolean).join(' ');
  const patterns = [
    /第\s*(\d{1,4})(?:\s*[-~至—]\s*(\d{1,4}))?\s*[集话]/i,
    /\bS\d{1,3}[. _-]*E(\d{1,4})(?:\s*[-~至—]\s*E?(\d{1,4}))?\b/i,
    /\bep?\.?\s*(\d{1,4})(?:\s*[-~]\s*(\d{1,4}))?\b/i,
    /\[(?!19\d{2}\]|20\d{2}\])(?!(?:360|480|540|576|720|1080|1440|2160|4320)\])([0-9]{1,4})(?:\s*[-~]\s*([0-9]{1,4}))?\](?!\s*(?:0?p|i|x26[45]|avc|hevc|aac|gb|big5))/i,
    /\s+-\s*(\d{1,4})(?:v\d+)?(?:\s*[\[\(]|\s*$)/i
  ];

  let match = null;
  for (const pattern of patterns) {
    match = merged.match(pattern);
    if (match) break;
  }

  if (!match) {
    const collectionHit = /(合集|全集|全\s*\d+\s*[集话]|season\s*\d+\s*complete)/i.test(merged);
    return {
      start: 0,
      end: 0,
      isBatch: collectionHit
    };
  }

  const start = Number.parseInt(match[1], 10) || 0;
  const end = Number.parseInt(match[2] || match[1], 10) || start;
  const explicitBatchHint = /(合集|全集|complete|batch)/i.test(merged);
  const seasonContextOnly = /(年番|Season|S\d{1,2}|第[一二三四五六七八九十]+季)/i.test(merged);
  const isBatch = end > start || explicitBatchHint || (seasonContextOnly && start === 0 && end === 0);
  return {
    start,
    end,
    isBatch
  };
}

function compareMediaResults(a, b) {
  const aEpisode = a.episodeEnd || 0;
  const bEpisode = b.episodeEnd || 0;
  if (bEpisode !== aEpisode) return bEpisode - aEpisode;

  const aSingle = a.episodeEnd > 0 && !a.episodeIsBatch;
  const bSingle = b.episodeEnd > 0 && !b.episodeIsBatch;
  if (aSingle !== bSingle) return bSingle ? 1 : -1;

  if ((b.hasChineseSubtitle ? 1 : 0) !== (a.hasChineseSubtitle ? 1 : 0)) {
    return (b.hasChineseSubtitle ? 1 : 0) - (a.hasChineseSubtitle ? 1 : 0);
  }

  if ((b.resolutionRank || 0) !== (a.resolutionRank || 0)) {
    return (b.resolutionRank || 0) - (a.resolutionRank || 0);
  }
  if ((b.seedersValue || 0) !== (a.seedersValue || 0)) {
    return (b.seedersValue || 0) - (a.seedersValue || 0);
  }
  if ((b.hits || 0) !== (a.hits || 0)) {
    return (b.hits || 0) - (a.hits || 0);
  }
  if ((b.timeValue || 0) !== (a.timeValue || 0)) {
    return (b.timeValue || 0) - (a.timeValue || 0);
  }

  const aSize = Number.isFinite(a.sizeBytes) ? a.sizeBytes : Number.POSITIVE_INFINITY;
  const bSize = Number.isFinite(b.sizeBytes) ? b.sizeBytes : Number.POSITIVE_INFINITY;
  if (aSize !== bSize) {
    return aSize - bSize;
  }
  return 0;
}

function sortMediaResults(items) {
  return [...items].sort(compareMediaResults);
}

function textBundleForItem(item) {
  return [item.title, item.torrentName, item.waterMark, item.subtitle].filter(Boolean).join(' ');
}

function preferFilteredSubset(items, predicate) {
  const subset = items.filter(predicate);
  return subset.length > 0 ? subset : items;
}

function filterByLatest(items) {
  const maxEpisode = Math.max(...items.map(item => item.episodeEnd || 0), 0);
  if (maxEpisode > 0) {
    return preferFilteredSubset(items, item => (item.episodeEnd || 0) === maxEpisode);
  }

  const maxTime = Math.max(...items.map(item => item.timeValue || 0), 0);
  return preferFilteredSubset(items, item => (item.timeValue || 0) === maxTime);
}

function filterByEpisodeRange(items, start, end) {
  return preferFilteredSubset(
    items,
    item => (item.episodeEnd || 0) >= start && (item.episodeStart || 0) <= end
  );
}

function sortBySmallest(items) {
  return [...items].sort((a, b) => {
    const sizeDiff = (a.sizeBytes || Number.POSITIVE_INFINITY) - (b.sizeBytes || Number.POSITIVE_INFINITY);
    if (sizeDiff !== 0) return sizeDiff;
    return compareMediaResults(a, b);
  });
}

function sortByHot(items) {
  return [...items].sort(
    (a, b) => ((b.seedersValue || 0) + (b.hits || 0)) - ((a.seedersValue || 0) + (a.hits || 0))
  );
}

function applySearchFilters(items, searchFilters = {}) {
  let filtered = [...(items || [])];
  if (filtered.length === 0) return filtered;

  if (searchFilters.chinese) {
    filtered = preferFilteredSubset(filtered, item => item.hasChineseSubtitle);
  }
  if (searchFilters.noSubtitle) {
    filtered = preferFilteredSubset(filtered, item => !item.hasChineseSubtitle);
  }

  if (searchFilters.prefer4k) {
    filtered = preferFilteredSubset(filtered, item => (item.resolutionRank || 0) >= 2160);
  } else if (searchFilters.prefer1080) {
    filtered = preferFilteredSubset(
      filtered,
      item => (item.resolutionRank || 0) >= 1080 && (item.resolutionRank || 0) < 2160
    );
  }

  if (searchFilters.hdr) {
    filtered = preferFilteredSubset(filtered, item => /HDR/i.test(textBundleForItem(item)));
  }
  if (searchFilters.dv) {
    filtered = preferFilteredSubset(filtered, item => /杜比视界|\bDV\b/i.test(textBundleForItem(item)));
  }
  if (searchFilters.highBitrate) {
    filtered = preferFilteredSubset(filtered, item => /高码|HQ/i.test(textBundleForItem(item)));
  }
  if (searchFilters.collection) {
    filtered = preferFilteredSubset(filtered, item => item.episodeIsBatch);
  }
  if (searchFilters.singleEpisode) {
    filtered = preferFilteredSubset(
      filtered,
      item => (item.episodeStart || 0) > 0
        && (item.episodeStart || 0) === (item.episodeEnd || 0)
        && !item.episodeIsBatch
    );
  }
  if (searchFilters.episodeEnd > 0) {
    filtered = filterByEpisodeRange(filtered, searchFilters.episodeStart, searchFilters.episodeEnd);
  }
  if (searchFilters.latest) {
    filtered = filterByLatest(filtered);
  }
  if (searchFilters.hot) {
    return sortByHot(filtered);
  }
  if (searchFilters.smallest) {
    return sortBySmallest(filtered);
  }
  return sortMediaResults(filtered);
}

function summarizeActiveFilters(searchFilters = {}) {
  const labels = [];
  if (searchFilters.latest) labels.push('最新');
  if (searchFilters.chinese) labels.push('中字');
  if (searchFilters.noSubtitle) labels.push('无字');
  if (searchFilters.prefer4k) labels.push('4K');
  if (searchFilters.prefer1080) labels.push('1080P');
  if (searchFilters.smallest) labels.push('小体积');
  if (searchFilters.hdr) labels.push('HDR');
  if (searchFilters.dv) labels.push('DV');
  if (searchFilters.highBitrate) labels.push('高码');
  if (searchFilters.collection) labels.push('合集');
  if (searchFilters.singleEpisode) labels.push('单集');
  if (searchFilters.hot) labels.push('热门');
  if (searchFilters.episodeEnd > 0) {
    labels.push(
      searchFilters.episodeStart === searchFilters.episodeEnd
        ? `第${searchFilters.episodeEnd}集`
        : `第${searchFilters.episodeStart}-${searchFilters.episodeEnd}集`
    );
  }
  return labels;
}

function scoreMergedItem(item) {
  let score = 0;
  // Episode freshness matters, but must never dominate quality due to bad parsing.
  score += Math.min(Math.max(item.episodeEnd || 0, 0), 250) * 2;
  if (item.hasChineseSubtitle) score += 80;
  score += Math.min(item.resolutionRank || 0, 2160) / 10;
  score += Math.min(item.seedersValue || 0, 500);
  score += Math.min(item.hits || 0, 200);
  if (item.magnet) score += 20;
  if (item.downloadUrl || item.torrentUrl) score += 10;
  // Prefer reasonable sizes over unknown/huge remux dumps when ranking ties.
  if (Number.isFinite(item.sizeBytes) && item.sizeBytes > 0 && item.sizeBytes < 20 * 1024 ** 3) {
    score += 5;
  }
  return score;
}

function buildDedupeKey(item) {
  const hash = extractInfoHash(item.magnet || item.downloadUrl || item.torrentUrl || item.pageUrl || '');
  if (hash) return `hash:${hash}`;

  const epStart = Number(item.episodeStart || item.episode || 0);
  const epEnd = Number(item.episodeEnd || item.episode || 0);
  const res = item.resolutionLabel || item.resolution || '未知';
  const batch = item.episodeIsBatch ? 'batch' : 'single';
  const rawTitle = String(item.title || item.torrentName || '');
  const year = (rawTitle.match(/(?:19|20)\d{2}/) || [])[0] || '';
  const subtitleVariant = /(?:\[|\b)(CHS|CHT|GB|BIG5|JPTC)(?:\]|\b)/i.exec(rawTitle)?.[1]?.toUpperCase()
    || (item.hasChineseSubtitle ? 'ZH' : '');
  const codec = /(?:\b|\[)(HEVC|H\.?265|X265)(?:\b|\])/i.test(rawTitle)
    ? 'HEVC'
    : (/(?:\b|\[)(AVC|H\.?264|X264)(?:\b|\])/i.test(rawTitle) ? 'AVC' : '');

  let identityTitle = rawTitle
    .replace(/^\s*(?:\[[^\]]+\]\s*)+/, ' ')
    .replace(/\bS\d{1,3}[. _-]*E\d{1,4}(?:\s*[-~至—]\s*E?\d{1,4})?\b/ig, ' ')
    .replace(/第\s*\d{1,4}(?:\s*[-~至—]\s*\d{1,4})?\s*[集话]/ig, ' ')
    .replace(/\s+-\s*\d{1,4}(?:v\d+)?(?=\s*[\[\(]|\s*$)/ig, ' ')
    .replace(/\[(?:\d{1,4}(?:\s*[-~]\s*\d{1,4})?|1080P?|720P?|1440P?|2160P?|4K|8K|CHS|CHT|GB|BIG5|JPTC|AVC|HEVC|H\.?26[45]|X26[45]|AAC|FLAC|WEB-?DL|WEBRIP|BDRIP|10BIT|HDR|DV|合集)\]/ig, ' ')
    .replace(/\b(?:1080[pi]?|720p|1440p|2160p|4k|8k|chs|cht|big5|jptc|avc|hevc|h\.?26[45]|x26[45]|aac|flac|web-?dl|webrip|bdrip|10bit|hdr|dv)\b/ig, ' ')
    .replace(/(?:19|20)\d{2}/g, ' ');
  identityTitle = unifyTitle(identityTitle).replace(/^[-|:]+|[-|:]+$/g, '').trim();
  if (!identityTitle) identityTitle = unifyTitle(rawTitle);

  return `title:${identityTitle}|year:${year}|ep:${epStart}-${epEnd}|res:${res}|sub:${subtitleVariant}|codec:${codec}|${batch}`;
}

function pickBetterItem(a, b) {
  const scoreDiff = scoreMergedItem(b) - scoreMergedItem(a);
  if (scoreDiff !== 0) return scoreDiff > 0 ? b : a;
  return compareMediaResults(a, b) <= 0 ? a : b;
}

function normalizeMergedItem(item, siteRun) {
  const title = item.title || item.torrentName || '';
  const sizeInfo = parseSizeInfo(item.sizeText, item.sizeLabel, item.size, title);
  const resolution = detectResolution(title, item.torrentName, item.sizeText, item.resolutionLabel);
  const episodeInfo = parseEpisodeInfo(title, item.torrentName, item.subtitle);
  const hasZh = item.hasChineseSubtitle === true
    || item.subtitle === '中字'
    || hasChineseSubtitle(title, item.torrentName, item.subtitle);

  return {
    ...item,
    title,
    siteId: siteRun.siteId || item.siteId || item.site || '',
    siteName: siteRun.siteName || item.siteName || item.sourceLabel || '',
    sourceLabel: item.sourceLabel || siteRun.siteName || '',
    magnet: item.magnet || '',
    downloadUrl: item.downloadUrl || item.torrentUrl || item.torrent || '',
    torrentUrl: item.torrentUrl || item.downloadUrl || item.torrent || '',
    pageUrl: item.pageUrl || item.threadUrl || item.page || item.source || '',
    sizeBytes: Number.isFinite(item.sizeBytes) ? item.sizeBytes : sizeInfo.bytes,
    sizeLabel: item.sizeLabel && item.sizeLabel !== '未知' ? item.sizeLabel : sizeInfo.label,
    sizeText: item.sizeText || item.sizeLabel || sizeInfo.label,
    resolutionRank: item.resolutionRank || resolution.rank,
    resolutionLabel: item.resolutionLabel || item.resolution || resolution.label,
    resolution: item.resolution || item.resolutionLabel || resolution.label,
    hasChineseSubtitle: hasZh,
    episodeStart: Number(item.episodeStart || episodeInfo.start || item.episode || 0),
    episodeEnd: Number(item.episodeEnd || episodeInfo.end || item.episode || 0),
    episode: Number(item.episode || item.episodeEnd || episodeInfo.end || item.episodeStart || 0),
    episodeIsBatch: Boolean(item.episodeIsBatch || episodeInfo.isBatch),
    seedersValue: Number(item.seedersValue || item.seeders || 0),
    hits: Number(item.hits || item.hot || 0),
    timeValue: Number(item.timeValue || 0),
    sources: item.sources || [siteRun.siteId || item.siteId || item.site || ''].filter(Boolean),
    score: 0
  };
}

function mergeCrossSourceResults(siteRuns = [], options = {}) {
  const limit = Number(options.limit || 20);
  const map = new Map();
  let rawCount = 0;

  for (const siteRun of siteRuns) {
    for (const raw of siteRun.results || []) {
      rawCount += 1;
      const item = normalizeMergedItem(raw, siteRun);
      item.score = scoreMergedItem(item);
      const key = buildDedupeKey(item);
      const prev = map.get(key);
      if (!prev) {
        map.set(key, item);
        continue;
      }
      const better = pickBetterItem(prev, item);
      const sources = Array.from(new Set([...(prev.sources || []), ...(item.sources || [])]));
      better.sources = sources;
      better.sourceLabel = sources
        .map(id => {
          const hit = siteRuns.find(run => run.siteId === id);
          return hit ? hit.siteName : id;
        })
        .filter(Boolean)
        .join('+');
      better.score = scoreMergedItem(better);
      map.set(key, better);
    }
  }

  const merged = [...map.values()]
    .sort((a, b) => {
      const scoreDiff = (b.score || 0) - (a.score || 0);
      if (scoreDiff !== 0) return scoreDiff;
      return compareMediaResults(a, b);
    })
    .slice(0, Math.max(1, limit));

  return {
    rawCount,
    uniqueCount: map.size,
    items: merged
  };
}

module.exports = {
  unifyTitle,
  extractInfoHash,
  parseDateValue,
  parseSizeInfo,
  detectResolution,
  hasChineseSubtitle,
  parseEpisodeInfo,
  compareMediaResults,
  sortMediaResults,
  textBundleForItem,
  preferFilteredSubset,
  filterByLatest,
  filterByEpisodeRange,
  sortBySmallest,
  sortByHot,
  applySearchFilters,
  summarizeActiveFilters,
  scoreMergedItem,
  buildDedupeKey,
  mergeCrossSourceResults
};
