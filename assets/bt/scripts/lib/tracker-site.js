const { stripHtml, absolutizeUrl } = require('./html-utils');
const { parseSizeInfo, detectResolution, hasChineseSubtitle, parseEpisodeInfo } = require('./media-utils');
const { renderTrackerSection } = require('./renderers');

function mergeTrackerConfig(defaultConfig, overrides = {}) {
  return {
    ...defaultConfig,
    ...overrides,
    requestOptions: {
      ...(defaultConfig.requestOptions || {}),
      ...(overrides.requestOptions || {})
    },
    categoriesByType: {
      ...defaultConfig.categoriesByType,
      ...(overrides.categoriesByType || {})
    },
    capabilities: {
      ...defaultConfig.capabilities,
      ...(overrides.capabilities || {})
    }
  };
}

function describeTrackerDefaultConfig(config) {
  const defaultConfig = {
    baseUrl: config.baseUrl,
    categoriesByType: config.categoriesByType,
    maxResults: config.maxResults
  };

  if (Number.isFinite(config.screenshotLimit)) {
    defaultConfig.screenshotLimit = config.screenshotLimit;
  }

  return defaultConfig;
}

function resolveTrackerMirrors(siteId, baseUrl, fastMode = false) {
  if (siteId === 'nyaa') {
    return fastMode ? ['https://nyaa.net/'] : ['https://nyaa.net/', 'https://nyaa.si/'];
  }
  if (siteId === 'sukebei') {
    return fastMode ? ['https://sukebei.nyaa.net/'] : ['https://sukebei.nyaa.net/', 'https://sukebei.nyaa.si/'];
  }
  return [baseUrl];
}

function buildCategoryQueryPlan(context, config) {
  const categories = config.categoriesByType[context.searchType] || [];
  const candidates = [];

  const uniqueMirrors = [...new Set(resolveTrackerMirrors(config.id, config.baseUrl, Boolean(config.fastMode)))];

  for (const baseUrl of uniqueMirrors) {
    for (const queryVariant of context.queryContext.queryVariants) {
      for (const category of categories) {
        candidates.push({
          query: queryVariant,
          category,
          url: `${baseUrl}?f=0&c=${category}&q=${encodeURIComponent(queryVariant)}`
        });
      }
    }
  }

  return { candidates };
}

function parseStandardTrackerRows(html, maxResults) {
  // Support both old class name constraints and general classes (for nyaa.net custom layouts)
  const rows = html.match(/<tr class="[^"]*">[\s\S]*?<\/tr>/gi) || [];

  return rows.slice(0, maxResults).map(row => {
    const rowClassMatch = row.match(/<tr class="([^"]*)"/i);
    const categoryMatch = row.match(/class="(?:category-icon|cat-icon)"[^>]*alt="([^"]+)"/i);
    const commentMatch = row.match(/<a[^>]*href="[^"]*#comments"[^>]*title="(\d+)\s+comment/i)
      || row.match(/class="[^"]*num-c"[^>]*>(\d+)</i);
    const titleMatch = row.match(/<a[^>]*href="(\/view\/\d+)"[^>]*title="([^"]+)"/i)
      || row.match(/href="(\/view\/\d+)"[^>]*title="([^"]+)"/i);
    const torrentMatch = row.match(/href="([^"]*?\/download\/\d+\.torrent)"/i);
    const magnetMatch = row.match(/href="(magnet:\?[^"]+)"/i);
    const sizeMatch = row.match(/class="(?:text-center|col-size)"[^>]*>([0-9.]+\s*[GMK]i?B)</i)
      || row.match(/([0-9.]+\s*[GMK]i?B)/i);
    const timeMatch = row.match(/data-timestamp="(\d+)">([^<]+)</i)
      || row.match(/class="col-date"[^>]*title="([^"]+)">([^<]+)</i);

    let seeders = '0';
    let leechers = '0';
    let completed = '0';

    const seedersMatch = row.match(/class="[^"]*num-s"[^>]*>(\d+)</i);
    const leechersMatch = row.match(/class="[^"]*num-l"[^>]*>(\d+)</i);
    const completedMatch = row.match(/class="[^"]*num-c"[^>]*>(\d+)</i);

    if (seedersMatch) {
      seeders = seedersMatch[1];
      leechers = leechersMatch ? leechersMatch[1] : '0';
      completed = completedMatch ? completedMatch[1] : '0';
    } else {
      const numericCells = [...row.matchAll(/<td class="text-center">(\d+)<\/td>/g)].map(item => item[1]);
      seeders = numericCells[0] || '0';
      leechers = numericCells[1] || '0';
      completed = numericCells[2] || '0';
    }

    let timeValue = 0;
    let timeText = '';
    if (timeMatch) {
      if (timeMatch[1] && /^\d+$/.test(timeMatch[1])) {
        timeValue = Number.parseInt(timeMatch[1], 10) * 1000;
        timeText = stripHtml(timeMatch[2]);
      } else {
        const cleanTime = timeMatch[1].replace('+00:00', 'Z');
        timeValue = Date.parse(cleanTime) || 0;
        timeText = stripHtml(timeMatch[2]);
      }
    }

    return {
      rowClass: rowClassMatch ? rowClassMatch[1] : 'default',
      category: stripHtml(categoryMatch ? categoryMatch[1] : ''),
      comments: commentMatch ? commentMatch[1] : '0',
      title: stripHtml(titleMatch ? titleMatch[2] : ''),
      pagePath: titleMatch ? titleMatch[1] : '',
      torrentPath: torrentMatch ? torrentMatch[1] : '',
      magnet: magnetMatch ? magnetMatch[1].replace(/&amp;/g, '&') : '',
      size: sizeMatch ? sizeMatch[1] : '未知',
      time: timeText || (timeMatch ? stripHtml(timeMatch[2]) : ''),
      timeValue: timeValue,
      seeders: seeders,
      leechers: leechers,
      completed: completed
    };
  });
}

function normalizeStandardTrackerResult(rawResult, baseUrl) {
  const sizeInfo = parseSizeInfo(rawResult.size, rawResult.title);
  const resolution = detectResolution(rawResult.title, rawResult.size, rawResult.category);
  const episodeInfo = parseEpisodeInfo(rawResult.title);

  return {
    title: rawResult.title,
    category: rawResult.category,
    pageUrl: absolutizeUrl(baseUrl, rawResult.pagePath),
    torrentUrl: absolutizeUrl(baseUrl, rawResult.torrentPath),
    magnet: rawResult.magnet || '',
    size: rawResult.size,
    sizeBytes: sizeInfo.bytes,
    sizeLabel: sizeInfo.label,
    sizeText: rawResult.size,
    time: rawResult.time,
    timeValue: rawResult.timeValue,
    seeders: rawResult.seeders,
    seedersValue: Number.parseInt(rawResult.seeders || '0', 10),
    leechers: rawResult.leechers,
    leechersValue: Number.parseInt(rawResult.leechers || '0', 10),
    completed: rawResult.completed,
    comments: rawResult.comments,
    rowClass: rawResult.rowClass,
    resolution: resolution.label,
    resolutionRank: resolution.rank,
    resolutionLabel: resolution.label,
    hasChineseSubtitle: hasChineseSubtitle(rawResult.title, rawResult.category),
    episode: episodeInfo.end || episodeInfo.start,
    episodeStart: episodeInfo.start,
    episodeEnd: episodeInfo.end,
    episodeIsBatch: episodeInfo.isBatch
  };
}

function collectTrackerJsonItems(run, siteId, startIndex = 1) {
  let index = startIndex;
  const items = [];
  const includeRaw = process.env.OPENCLAW_BT_INCLUDE_RAW === '1';

  for (const item of run.results || []) {
    const jsonItem = {
      index,
      site: siteId,
      siteMode: run.siteMode,
      siteName: run.siteName,
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

function createTrackerSite(options) {
  const {
    defaultConfig,
    parseSearchResults,
    normalizeSearchResult,
    enrichSearchRun,
    describeDefaultConfig = describeTrackerDefaultConfig
  } = options;

  function getConfig(overrides = {}) {
    const config = mergeTrackerConfig(defaultConfig, overrides);
    const timeoutMs = overrides.siteTimeoutMs || overrides.timeoutMs || config.siteTimeoutMs || config.timeoutMs || config.requestOptions.timeoutMs;
    return {
      ...config,
      requestOptions: {
        ...config.requestOptions,
        ...(overrides.abortSignal ? { abortSignal: overrides.abortSignal } : {}),
        ...(timeoutMs ? { timeoutMs } : {})
      }
    };
  }

  function describe() {
    const config = getConfig();
    return {
      id: config.id,
      name: config.name,
      capabilities: config.capabilities,
      defaultConfig: describeDefaultConfig(config)
    };
  }

  function supportsType(type) {
    return getConfig().capabilities.searchTypes.includes(type);
  }

  function buildQueryPlan(context, overrides = {}) {
    return buildCategoryQueryPlan(context, getConfig(overrides));
  }

  function parseResults(html, baseUrl, config) {
    const parsedResults = parseSearchResults(html, baseUrl, config) || [];
    return parsedResults
      .map(parsedResult => normalizeSearchResult(parsedResult, baseUrl, config))
      .filter(item => item && item.title && item.pageUrl && item.magnet);
  }

  async function fetchResults(url, runtime, config) {
    const response = await runtime.fetchUrl(url, config.requestOptions || {});
    if (!response.ok || !response.text) return { ok: false, status: response.statusCode || 0, results: [] };
    return { ok: true, status: response.statusCode || 200, results: parseResults(response.text, url, config) };
  }

  async function search(context, runtime, overrides = {}) {
    const config = getConfig(overrides);
    const categories = config.categoriesByType[context.searchType] || [];

    const uniqueMirrors = [...new Set(resolveTrackerMirrors(config.id, config.baseUrl, Boolean(config.fastMode)))];

    let lastAttempt = null;

    for (const baseUrl of uniqueMirrors) {
      let mirrorAlive = false;
      let mirrorFailed = false;
      for (const queryVariant of context.queryContext.queryVariants) {
        for (const category of categories) {
          const url = `${baseUrl}?f=0&c=${category}&q=${encodeURIComponent(queryVariant)}`;
          const fetchRes = await fetchResults(url, runtime, config);
          if (fetchRes.ok) {
            mirrorAlive = true;
          } else {
            mirrorFailed = true;
          }

          let run = {
            siteName: config.name,
            usedUrl: url,
            usedQuery: queryVariant,
            results: fetchRes.results,
            warnings: []
          };

          if (typeof enrichSearchRun === 'function') {
            run = await enrichSearchRun(run, {
              context,
              runtime,
              config,
              candidate: { url, query: queryVariant, category }
            });
          }

          lastAttempt = run;
          if (run.results.length > 0) {
            return run;
          }

          if (mirrorFailed) {
            break;
          }
        }
        if (mirrorFailed) {
          break;
        }
      }

      // If this mirror responded successfully (HTTP 200) for all queries and simply had 0 results,
      // no need to hit mirror clones of the same database.
      if (mirrorAlive) {
        break;
      }
    }

    return lastAttempt || {
      siteName: config.name,
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
    return collectTrackerJsonItems(run, defaultConfig.id, startIndex);
  }

  return {
    id: defaultConfig.id,
    defaultConfig,
    describe,
    supportsType,
    buildQueryPlan,
    search,
    renderSection,
    collectJsonItems
  };
}

module.exports = {
  createTrackerSite,
  resolveTrackerMirrors,
  parseStandardTrackerRows,
  normalizeStandardTrackerResult
};
