const { stripHtml, absolutizeUrl } = require('../lib/html-utils');
const {
  parseDateValue,
  parseSizeInfo,
  detectResolution,
  hasChineseSubtitle,
  parseEpisodeInfo,
  extractInfoHash
} = require('../lib/media-utils');
const { renderTrackerSection } = require('../lib/renderers');

const DEFAULT_CONFIG = {
  id: 'mikan',
  name: 'Mikan',
  siteName: '蜜柑计划',
  baseUrl: 'https://mikanani.me/',
  mirrors: ['https://mikanani.me/', 'https://mikanime.tv/'],
  maxResults: 20,
  requestOptions: {
    timeoutMs: 8000,
    referer: 'https://mikanani.me/'
  },
  capabilities: {
    searchTypes: ['anime'],
    hasMagnet: true,
    hasTorrent: true,
    hasScreenshots: false,
    queryBuilder: 'queryVariants'
  }
};

function parseSearchResults(html, baseUrl, maxResults = 20) {
  const rows = html.match(/<tr[^>]*class="[^"]*js-search-results-row[^"]*"[\s\S]*?<\/tr>/gi)
    || html.match(/<tr[\s\S]*?<\/tr>/gi)
    || [];

  const rawResults = [];
  for (const row of rows) {
    const titleMatch = row.match(/<a[^>]+class="[^"]*magnet-link-wrap[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
      || row.match(/<a[^>]+href="(\/Home\/Episode\/[a-fA-F0-9]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!titleMatch) continue;

    const pagePath = titleMatch[1];
    const rawTitle = stripHtml(titleMatch[2]).trim();

    const magnetMatch = row.match(/data-clipboard-text="(magnet:\?[^"]+)"/i)
      || row.match(/data-magnet="(magnet:\?[^"]+)"/i)
      || row.match(/href="(magnet:\?[^"]+)"/i);

    const torrentMatch = row.match(/href="(\/Download\/[^"]+\.torrent)"/i);
    const sizeMatch = row.match(/<td>\s*([0-9.]+\s*[GMK]i?B)\s*<\/td>/i);
    const dateMatch = row.match(/<td>\s*(\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2})\s*<\/td>/i);

    const magnet = magnetMatch ? magnetMatch[1].replace(/&amp;/g, '&') : '';
    const size = sizeMatch ? sizeMatch[1] : '未知';
    const date = dateMatch ? dateMatch[1] : '';

    rawResults.push({
      title: rawTitle,
      pagePath,
      torrentPath: torrentMatch ? torrentMatch[1] : '',
      magnet,
      size,
      time: date,
      timeValue: parseDateValue(date)
    });

    if (rawResults.length >= maxResults) break;
  }

  return rawResults;
}

function normalizeSearchResult(rawResult, baseUrl) {
  const sizeInfo = parseSizeInfo(rawResult.size, rawResult.title);
  const resolution = detectResolution(rawResult.title, rawResult.size);
  const episodeInfo = parseEpisodeInfo(rawResult.title);
  const hasSub = hasChineseSubtitle(rawResult.title);

  const subgroupMatch = rawResult.title.match(/^\[([^\]]+)\]/);
  const subgroup = subgroupMatch ? subgroupMatch[1].trim() : '';

  return {
    source: 'mikan',
    siteId: 'mikan',
    siteName: 'Mikan',
    title: rawResult.title,
    subgroup,
    pageUrl: absolutizeUrl(baseUrl, rawResult.pagePath),
    torrentUrl: absolutizeUrl(baseUrl, rawResult.torrentPath),
    magnet: rawResult.magnet,
    infoHash: extractInfoHash(rawResult.magnet || rawResult.pagePath),
    sizeText: sizeInfo.label,
    sizeLabel: sizeInfo.label,
    sizeBytes: sizeInfo.bytes,
    resolution: resolution.label,
    resolutionLabel: resolution.label,
    resolutionRank: resolution.rank,
    episode: episodeInfo.end || episodeInfo.start || 0,
    episodeStart: episodeInfo.start || 0,
    episodeEnd: episodeInfo.end || 0,
    episodeIsBatch: episodeInfo.isBatch,
    hasChineseSubtitle: hasSub,
    time: rawResult.time,
    timeValue: rawResult.timeValue,
    seeders: 0,
    leechers: 0,
    completed: 0,
    rawTitle: rawResult.title
  };
}

function collectMikanJsonItems(run, siteId = 'mikan', startIndex = 1) {
  let index = startIndex;
  const items = [];
  const includeRaw = process.env.OPENCLAW_BT_INCLUDE_RAW === '1';

  for (const item of run.results || []) {
    const jsonItem = {
      index,
      site: siteId,
      siteMode: run.siteMode || 'anime',
      siteName: run.siteName || 'Mikan',
      title: item.title || '',
      page: item.pageUrl || '',
      source: item.pageUrl || '',
      torrent: item.torrentUrl || '',
      magnet: item.magnet || '',
      episode: Number(item.episode || item.episodeEnd || item.episodeStart || 0),
      episodeStart: Number(item.episodeStart || item.episode || item.episodeEnd || 0),
      episodeEnd: Number(item.episodeEnd || item.episode || item.episodeStart || 0),
      isBatch: Boolean(item.episodeIsBatch),
      size: item.sizeText || item.sizeLabel || item.size || '',
      resolution: item.resolution || item.resolutionLabel || '',
      subtitle: item.hasChineseSubtitle ? '中字' : '未标注',
      seeds: item.seeders || 0,
      leechers: item.leechers || 0,
      completed: item.completed || 0
    };
    if (includeRaw) {
      jsonItem.raw = item;
    }
    items.push(jsonItem);
    index += 1;
  }

  return {
    items,
    nextIndex: index
  };
}

function createMikanSite(customConfig = {}) {
  const config = {
    ...DEFAULT_CONFIG,
    ...customConfig
  };

  function describe() {
    return {
      id: config.id,
      name: config.name,
      capabilities: config.capabilities,
      defaultConfig: {
        baseUrl: config.baseUrl,
        maxResults: config.maxResults
      }
    };
  }

  function supportsType(type) {
    return config.capabilities.searchTypes.includes(type);
  }

  async function search(context, runtime, overrides = {}) {
    const activeConfig = {
      ...config,
      ...overrides,
      requestOptions: {
        ...config.requestOptions,
        ...(overrides.requestOptions || {}),
        ...(overrides.abortSignal ? { abortSignal: overrides.abortSignal } : {})
      }
    };

    const maxResults = activeConfig.maxResults || 20;
    const mirrors = [...new Set(activeConfig.mirrors || [activeConfig.baseUrl])];
    const variants = context.queryContext?.queryVariants || [context.query];

    let lastAttempt = null;

    for (const mirror of mirrors) {
      let mirrorSuccess = false;
      for (const queryVariant of variants) {
        const searchUrl = `${mirror.replace(/\/$/, '')}/Home/Search?searchstr=${encodeURIComponent(queryVariant)}`;
        const response = await runtime.fetchUrl(searchUrl, activeConfig.requestOptions);

        if (response.ok && response.text) {
          mirrorSuccess = true;
          const parsed = parseSearchResults(response.text, mirror, maxResults);
          const normalized = parsed
            .map(item => normalizeSearchResult(item, mirror))
            .filter(item => item && item.title && (item.magnet || item.torrentUrl));

          const run = {
            siteName: config.siteName,
            usedUrl: searchUrl,
            usedQuery: queryVariant,
            results: normalized,
            warnings: []
          };

          lastAttempt = run;
          if (normalized.length > 0) {
            return run;
          }
        }
      }

      if (mirrorSuccess) {
        break;
      }
    }

    return lastAttempt || {
      siteName: config.siteName,
      usedUrl: '',
      usedQuery: context.query,
      results: [],
      warnings: []
    };
  }

  function renderSection(run, context) {
    renderTrackerSection(run, context);
  }

  function collectJsonItems(run, startIndex = 1) {
    return collectMikanJsonItems(run, config.id, startIndex);
  }

  return {
    id: config.id,
    defaultConfig: config,
    describe,
    supportsType,
    search,
    renderSection,
    collectJsonItems
  };
}

const defaultSite = createMikanSite();
defaultSite.__test = {
  parseSearchResults,
  normalizeSearchResult
};

module.exports = defaultSite;
