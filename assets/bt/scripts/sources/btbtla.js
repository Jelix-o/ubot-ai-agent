const { stripHtml, absolutizeUrl } = require('../lib/html-utils');
const { unique, extractYearTokens, stripYearTokens } = require('../lib/query-utils');
const {
  parseDateValue,
  parseSizeInfo,
  detectResolution,
  hasChineseSubtitle,
  parseEpisodeInfo,
  compareMediaResults
} = require('../lib/media-utils');
const { renderBtbtlaSection } = require('../lib/renderers');
const { resolveDeepBudget } = require('../lib/site-common');

const DEFAULT_CONFIG = {
  id: 'btbtla',
  name: 'BTBTLA',
  siteName: 'BT影视',
  baseUrl: 'https://www.btbtlb.com/',
  searchPath: 'search',
  // www SNI is blocked on some paths; use apex SNI + Host:www.
  resolveHost: 'www.btbtlb.com',
  sniHost: 'btbtlb.com',
  // Prefer live DoH IPs; stale hardcoded IP still works as fallback via runtime.
  resolveIp: '',
  referer: 'https://www.btbtlb.com/',
  cooldownKey: 'lastBtbtlaSearch',
  cooldownSeconds: 30,
  pageLimit: 20,
  expandLimit: 20,
  detailLimit: 20,
  fastExpandLimit: 4,
  fastDetailLimit: 4,
  fastAnimeExpandLimit: 2,
  fastAnimeDetailLimit: 2,
  fastAnimeResultLimit: 12,
  timeoutMs: 30000,
  maxBuffer: 20 * 1024 * 1024,
  capabilities: {
    searchTypes: ['anime', 'movie'],
    hasMagnet: true,
    hasTorrent: true,
    hasScreenshots: false,
    hasCooldown: true,
    usesCache: true,
    queryBuilder: 'yearRelaxedQueryVariants'
  }
};

function getConfig(overrides = {}) {
  const config = {
    ...DEFAULT_CONFIG,
    ...overrides,
    capabilities: {
      ...DEFAULT_CONFIG.capabilities,
      ...(overrides.capabilities || {})
    }
  };

  return {
    ...config,
    requestOptions: {
      referer: config.referer,
      resolveHost: config.resolveHost,
      resolveIp: config.resolveIp,
      sniHost: config.sniHost,
      transportOrder: config.transportOrder || ['curl_cffi', 'https', 'curl'],
      ...(overrides.abortSignal ? { abortSignal: overrides.abortSignal } : {}),
      timeoutMs: config.timeoutMs,
      maxBuffer: config.maxBuffer
    }
  };
}

function describe() {
  const config = getConfig();
  return {
    id: config.id,
    name: config.name,
    capabilities: config.capabilities,
    defaultConfig: {
      baseUrl: config.baseUrl,
      searchPath: config.searchPath,
      cooldownSeconds: config.cooldownSeconds,
      pageLimit: config.pageLimit,
      expandLimit: config.expandLimit,
      detailLimit: config.detailLimit
    }
  };
}

function supportsType(type) {
  return getConfig().capabilities.searchTypes.includes(type);
}

function buildSearchUrl(query, config) {
  return `${config.baseUrl}${config.searchPath}/${encodeURIComponent(query)}`;
}

function buildQueryPlan(context, overrides = {}) {
  const config = getConfig(overrides);
  return {
    candidates: context.queryContext.yearRelaxedQueryVariants.map(queryVariant => ({
      query: queryVariant,
      url: buildSearchUrl(queryVariant, config)
    }))
  };
}

function parseSearchItems(html, searchUrl, config) {
  const normalizedText = stripHtml(html);
  if (/找到\s*0\s*部影视作品/i.test(normalizedText)) return [];

  const sections = html.split(/<div class="module-item">/i).slice(1, config.pageLimit + 1);
  return sections.map(section => {
    const hrefMatch = section.match(/<a href="(\/detail\/\d+\.html)" class="module-item-title" title="([^"]+)"/i)
      || section.match(/<a href="(\/detail\/\d+\.html)" title="([^"]+)"/i);
    const title = stripHtml(hrefMatch ? hrefMatch[2] : '');
    const threadUrl = absolutizeUrl(searchUrl, hrefMatch ? hrefMatch[1] : '');
    const captionMatch = section.match(/<div class="module-item-caption">([\s\S]*?)<\/div>/i);
    const summaryMatch = section.match(/<div class="module-item-style video-text">([\s\S]*?)<\/div>/i);
    const spans = captionMatch ? [...captionMatch[1].matchAll(/<span(?: class="([^"]+)")?>([\s\S]*?)<\/span>/gi)] : [];
    const tags = spans.map(match => stripHtml(match[2])).filter(Boolean);
    const year = tags[0] || '';
    const category = tags[1] || '';
    const area = tags[2] || '';
    return {
      title,
      threadUrl,
      author: '',
      time: year,
      comments: '0',
      forum: category,
      tags: unique([category, area].filter(Boolean)),
      summary: stripHtml(summaryMatch ? summaryMatch[1] : ''),
      area,
      year,
      category,
      sourceLabel: config.siteName
    };
  }).filter(item => item.title && item.threadUrl);
}

function extractInfoField(html, label, pattern = '([\\s\\S]*?)') {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(
    `<div class="video-info-items">[\\s\\S]*?<span class="video-info-itemtitle">${escapedLabel}:<\\/span>[\\s\\S]*?<div class="video-info-item">(?:<span class="slash">\\/<\\/span>)?\\s*${pattern}\\s*<\\/div>`,
    'i'
  );
  const match = html.match(regex);
  return match ? stripHtml(match[1]) : '';
}

function extractRelatedItems(html, threadUrl) {
  return [...html.matchAll(/<div class="tlist"><a href="(\/tdown\/[^"]+)">([\s\S]*?)<span>\[?([0-9.]+\s*(?:GB|MB|TB))\]?<\/span><\/a><\/div>/gi)]
    .map(item => ({
      threadUrl: absolutizeUrl(threadUrl, item[1]),
      title: stripHtml(item[2]),
      sizeLabel: stripHtml(item[3])
    }));
}

function extractDownloadMeta(html, threadUrl) {
  const magnetMatch = html.match(/href="(magnet:\?xt=urn:btih:[^"]+)"[^>]*>[\s\S]*?磁力链接/i);
  const downloadMatch = html.match(/href="(\/dlt\/[^"]+)"[^>]*>[\s\S]*?种子文件/i);
  return {
    downloadUrl: absolutizeUrl(threadUrl, downloadMatch ? downloadMatch[1] : ''),
    magnet: magnetMatch ? magnetMatch[1].replace(/&amp;/g, '&') : ''
  };
}

function parseDownloadDetail(html, threadUrl, config) {
  const pageTitleMatch = html.match(/<h1 class="page-title">([\s\S]*?)<\/h1>/i);
  const subTitleMatch = html.match(/<h2 class="video-subtitle"[^>]*>([\s\S]*?)<\/h2>/i);
  const contentTitleMatch = html.match(/<h2 class="page-title">([\s\S]*?)\.torrent<\/h2>/i);
  const downloadMeta = extractDownloadMeta(html, threadUrl);

  return {
    title: stripHtml(contentTitleMatch ? contentTitleMatch[1] : (pageTitleMatch ? pageTitleMatch[1] : '')),
    forum: config.siteName,
    downloadUrl: downloadMeta.downloadUrl,
    torrentName: stripHtml(contentTitleMatch ? `${contentTitleMatch[1]}.torrent` : ''),
    magnet: downloadMeta.magnet,
    sizeLabel: extractInfoField(html, '影片大小'),
    time: extractInfoField(html, '种子时间'),
    hash: extractInfoField(html, 'Hash', '([a-f0-9]{20,40})').toLowerCase(),
    waterMark: extractInfoField(html, '水印'),
    subtitle: stripHtml(subTitleMatch ? subTitleMatch[1] : ''),
    related: extractRelatedItems(html, threadUrl)
  };
}

function parseDownloadRows(detailHtml, threadUrl, limit) {
  return [...detailHtml.matchAll(/<div class="module-row-info">([\s\S]*?)<\/div>\s*<\/div>/gi)]
    .slice(0, limit)
    .map(match => {
      const rowHtml = match[1];
      const tdownHrefMatch = rowHtml.match(/href="(\/tdown\/[^"]+)"/i);
      const rowTitleMatch = rowHtml.match(/<h4>([\s\S]*?)<\/h4>/i);
      const countMatch = rowHtml.match(
        /<a class="btn-pc btn-down"[^>]*><i class="icon-download-bold"><\/i><span>(\d+)<\/span><\/a>/i
      );

      return {
        detailUrl: absolutizeUrl(threadUrl, tdownHrefMatch ? tdownHrefMatch[1] : ''),
        rowTitle: stripHtml(rowTitleMatch ? rowTitleMatch[1] : ''),
        hits: countMatch ? Number.parseInt(countMatch[1], 10) : 0
      };
    })
    .filter(item => item.detailUrl);
}

function parseDetailPage(detailHtml, threadUrl, config) {
  const detailPageTitleMatch = detailHtml.match(/<h1 class="page-title">([\s\S]*?)<\/h1>/i);
  const detailSubTitleMatch = detailHtml.match(/<h2 class="video-subtitle"[^>]*>([\s\S]*?)<\/h2>/i);

  return {
    pageTitle: stripHtml(detailPageTitleMatch ? detailPageTitleMatch[1] : ''),
    subtitle: stripHtml(detailSubTitleMatch ? detailSubTitleMatch[1] : ''),
    downloadRows: parseDownloadRows(detailHtml, threadUrl, config.detailLimit)
  };
}

function normalizeTorrentResult(searchItem, detailPage, downloadRow, downloadDetail, config) {
  const sizeInfo = parseSizeInfo(downloadDetail.sizeLabel, downloadDetail.torrentName, downloadDetail.title);
  const resolution = detectResolution(
    downloadDetail.title,
    downloadDetail.torrentName,
    downloadDetail.sizeLabel,
    searchItem.category,
    searchItem.summary,
    downloadDetail.subtitle,
    downloadDetail.waterMark
  );
  const composedTitle = stripHtml(downloadDetail.title || downloadRow.rowTitle || searchItem.title);
  const episodeInfo = parseEpisodeInfo(
    downloadDetail.title,
    downloadDetail.torrentName,
    downloadRow.rowTitle,
    searchItem.summary
  );
  const sizeText = downloadDetail.sizeLabel || sizeInfo.label;

  return {
    title: composedTitle || searchItem.title,
    threadUrl: searchItem.threadUrl,
    detailUrl: downloadRow.detailUrl,
    forum: searchItem.category || downloadDetail.forum || config.siteName,
    author: '',
    time: downloadDetail.time || searchItem.time,
    comments: String(downloadRow.hits),
    tags: unique([...(searchItem.tags || []), searchItem.year, searchItem.area, downloadDetail.waterMark].filter(Boolean)),
    downloadUrl: downloadDetail.downloadUrl,
    torrentName: downloadDetail.torrentName || composedTitle,
    magnet: downloadDetail.magnet,
    sizeBytes: sizeInfo.bytes,
    sizeLabel: sizeText,
    sizeText,
    resolution: resolution.label,
    resolutionRank: resolution.rank,
    resolutionLabel: resolution.label,
    timeValue: parseDateValue(downloadDetail.time || searchItem.time),
    hasChineseSubtitle: hasChineseSubtitle(
      composedTitle,
      downloadDetail.torrentName,
      downloadDetail.subtitle,
      downloadDetail.waterMark
    ),
    episode: episodeInfo.end || episodeInfo.start,
    episodeStart: episodeInfo.start,
    episodeEnd: episodeInfo.end,
    episodeIsBatch: episodeInfo.isBatch,
    summary: searchItem.summary || '',
    subtitle: downloadDetail.subtitle || detailPage.subtitle,
    source: config.siteName,
    hash: downloadDetail.hash || '',
    waterMark: downloadDetail.waterMark || '',
    pageTitle: detailPage.pageTitle || searchItem.title,
    hits: downloadRow.hits
  };
}

function scoreResultMatch(item, query, queryYearTokens) {
  const loweredQuery = query.toLowerCase();
  const baseQuery = stripYearTokens(query).toLowerCase();
  const haystack = [item.title, item.pageTitle, item.subtitle, item.summary, item.torrentName, ...(item.tags || [])]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  let score = 0;

  if (query && haystack.includes(loweredQuery)) score += 120;
  if (baseQuery && haystack.includes(baseQuery)) score += 60;
  if (item.title && item.title.toLowerCase() === loweredQuery) score += 90;
  if (item.pageTitle && item.pageTitle.toLowerCase() === loweredQuery) score += 90;
  if (item.title && baseQuery && item.title.toLowerCase().includes(baseQuery)) score += 40;
  if (item.pageTitle && baseQuery && item.pageTitle.toLowerCase().includes(baseQuery)) score += 40;

  const itemYears = unique([
    ...extractYearTokens(item.title),
    ...extractYearTokens(item.pageTitle),
    ...extractYearTokens(item.subtitle),
    ...extractYearTokens(item.time),
    ...(item.tags || []).flatMap(extractYearTokens)
  ]);
  if (queryYearTokens.length > 0) {
    if (queryYearTokens.some(year => itemYears.includes(year))) score += 100;
    else if (itemYears.length > 0) score -= 80;
  }

  return score;
}

async function fetchHtml(url, runtime, config, allowNetwork) {
  return runtime.fetchCachedHtml(url, {
    allowNetwork,
    requestOptions: config.requestOptions,
    detectChallenge: runtime.isLikelyBtbtlaChallenge
  });
}

function humanizeFetchFailure(page) {
  switch (page.reason) {
    case 'cache_miss':
      return 'BTBTLA 当前处于冷却期，且本地暂无可用缓存';
    case 'stale_cache':
      return 'BTBTLA 直连失败，已回退到过期缓存结果';
    case 'challenge':
      return 'BTBTLA 触发 Cloudflare / 验证页，当前抓取失败';
    case 'timeout':
      return 'BTBTLA 页面抓取超时';
    default:
      return 'BTBTLA 页面获取失败';
  }
}

function isAborted(overrides = {}) {
  return Boolean(overrides.abortSignal && overrides.abortSignal.aborted);
}

function isPastDeadline(overrides = {}) {
  return Number.isFinite(overrides.deadlineAt) && Date.now() >= overrides.deadlineAt;
}

function shouldStopWork(overrides = {}) {
  return isAborted(overrides) || isPastDeadline(overrides);
}

async function mapLimitUntil(items, limit, mapper, shouldStop) {
  const results = [];
  const chunkSize = Math.max(1, limit);
  for (let index = 0; index < items.length; index += chunkSize) {
    const chunk = items.slice(index, index + chunkSize);
    const mapped = await Promise.all(chunk.map(mapper));
    results.push(...mapped);
    if (typeof shouldStop === 'function' && shouldStop(results)) break;
  }
  return results;
}

function normalizedRelevanceText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\s._·:：|｜\-—–]+/g, '')
    .replace(/[【】\[\]()（）]/g, '');
}

function isRelevantSearchItem(item, context) {
  const queryContext = context?.queryContext || {};
  const variants = unique([
    context?.query,
    ...(queryContext.queryVariants || []),
    ...(queryContext.yearRelaxedQueryVariants || [])
  ])
    .map(stripYearTokens)
    .map(normalizedRelevanceText)
    .filter(value => value.length >= 2);
  if (variants.length === 0) return true;

  const title = normalizedRelevanceText(item?.title || '');
  return variants.some(variant => title === variant || title.startsWith(variant) || title.includes(variant));
}

function scoreBtbtlaResult(item, context) {
  return scoreResultMatch(item, context.query, context.queryContext.yearTokens);
}

function isStrongBtbtlaHit(items, context) {
  const requestedEpisode = Number(context?.queryContext?.requestedEpisode || 0);
  return (items || []).some(item => {
    if (!item) return false;
    if (requestedEpisode && (item.episodeEnd || 0) >= requestedEpisode && (item.episodeStart || 0) <= requestedEpisode) return true;
    return scoreBtbtlaResult(item, context) >= 140;
  });
}

async function fetchResults(url, context, runtime, config, allowNetwork) {
  if (shouldStopWork(config)) {
    return {
      via: '中止',
      results: [],
      warnings: ['BTBTLA 搜索已中止']
    };
  }
  const page = await fetchHtml(url, runtime, config, allowNetwork);
  if (!page.html) {
    return {
      via: page.via,
      results: [],
      warnings: [humanizeFetchFailure(page)]
    };
  }

  const parsedSearchItems = parseSearchItems(page.html, url, config);
  const searchItems = parsedSearchItems.filter(item => isRelevantSearchItem(item, context));
  const budget = resolveDeepBudget(config, config, context);
  if (budget.noDeep || budget.expandLimit <= 0) {
    const shallow = searchItems.slice(0, budget.resultLimit || searchItems.length).map(item => ({
      title: item.title,
      threadUrl: item.threadUrl,
      detailUrl: item.threadUrl,
      forum: item.category || item.forum || config.siteName,
      author: item.author || '',
      time: item.time || '',
      comments: item.comments || '0',
      tags: item.tags || [],
      downloadUrl: '',
      torrentName: item.title,
      magnet: '',
      sizeBytes: Number.POSITIVE_INFINITY,
      sizeLabel: '未知',
      sizeText: '未知',
      resolution: detectResolution(item.title).label,
      resolutionRank: detectResolution(item.title).rank,
      resolutionLabel: detectResolution(item.title).label,
      timeValue: parseDateValue(item.time),
      hasChineseSubtitle: hasChineseSubtitle(item.title),
      episode: parseEpisodeInfo(item.title).end || parseEpisodeInfo(item.title).start,
      episodeStart: parseEpisodeInfo(item.title).start,
      episodeEnd: parseEpisodeInfo(item.title).end,
      episodeIsBatch: parseEpisodeInfo(item.title).isBatch,
      summary: item.summary || '',
      source: config.siteName,
      pageTitle: item.title,
      hits: 0
    }));
    return {
      via: page.via,
      results: shallow,
      warnings: ['--no-deep: 仅返回 BTBTLA 搜索页结果，未展开详情/种子层']
    };
  }
  const nestedAllowNetwork = config.fastMode && page.reason === 'stale_cache' ? false : allowNetwork;
  const isFastAnime = config.fastMode && context.searchType === 'anime';
  const expandLimit = budget.expandLimit;
  const detailLimit = budget.detailLimit;
  const expandedSearchItems = searchItems.slice(0, Math.max(1, expandLimit || searchItems.length));
  const warnings = [];
  const irrelevantCount = parsedSearchItems.length - searchItems.length;
  if (irrelevantCount > 0) {
    warnings.push(`已过滤 ${irrelevantCount} 条标题不相关的 BT影视候选`);
  }
  const torrentCandidateGroups = await mapLimitUntil(
    expandedSearchItems,
    config.fastMode ? 2 : 3,
    async searchItem => {
      if (shouldStopWork(config)) return [];
      const detailResponse = await fetchHtml(searchItem.threadUrl, runtime, config, nestedAllowNetwork);
      if (!detailResponse.html) return [];
      const detailPage = parseDetailPage(detailResponse.html, searchItem.threadUrl, config);
      const downloadRows = detailPage.downloadRows.slice(0, Math.max(1, detailLimit || detailPage.downloadRows.length));

      const downloadDetails = await Promise.all(
        downloadRows.map(async downloadRow => {
          if (shouldStopWork(config)) return null;
          const downloadPage = await fetchHtml(downloadRow.detailUrl, runtime, config, nestedAllowNetwork);
          if (!downloadPage.html) return null;

          const downloadDetail = parseDownloadDetail(downloadPage.html, downloadRow.detailUrl, config);
          return normalizeTorrentResult(searchItem, detailPage, downloadRow, downloadDetail, config);
        })
      );

      return downloadDetails.filter(Boolean);
    },
    partialGroups => config.fastMode && isStrongBtbtlaHit(partialGroups.flat(), context)
  );
  const torrentCandidates = torrentCandidateGroups.flat();

  if (searchItems.length === 0 && /找到\s*0\s*部影视作品/.test(stripHtml(page.html))) {
    warnings.push('BTBTLA 未找到结果');
  }

  const torrentResults = torrentCandidates
    .filter(item => item.downloadUrl || item.magnet)
    .map(item => ({
      ...item,
      relevanceScore: scoreBtbtlaResult(item, context)
    }))
    .sort((a, b) => {
      if (b.relevanceScore !== a.relevanceScore) return b.relevanceScore - a.relevanceScore;
      return compareMediaResults(a, b);
    })
    .slice(0, isFastAnime ? (config.fastAnimeResultLimit || 12) : torrentCandidates.length);

  const excludedCount = torrentCandidates.length - torrentResults.length;
  if (excludedCount > 0) {
    warnings.push(`已排除 ${excludedCount} 条无可下载资源结果`);
  }
  if (searchItems.length > expandedSearchItems.length) {
    warnings.push(`快速模式仅展开前 ${expandedSearchItems.length} 条 BTBTLA 搜索结果`);
  }
  if (isFastAnime && torrentResults.length > 0) {
    warnings.push(`anime --fast 已截断为前 ${torrentResults.length} 条 BTBTLA 候选`);
  }
  if (config.fastMode && page.reason === 'stale_cache') {
    warnings.push('BTBTLA 搜索页已回退到过期缓存，详情层仅使用缓存以缩短等待');
  }

  return {
    via: page.via,
    results: torrentResults,
    warnings
  };
}

async function search(context, runtime, overrides = {}) {
  const config = getConfig(overrides);
  const plan = buildQueryPlan(context, config);
  const cooldownRemaining = runtime.getCooldownRemaining(config.cooldownKey, config.cooldownSeconds);
  const allowNetwork = cooldownRemaining === 0;

  if (allowNetwork && plan.candidates.length > 0) {
    runtime.markCooldown(config.cooldownKey);
  }

  let lastAttempt = null;
  for (const candidate of plan.candidates) {
    if (shouldStopWork(config)) break;
    const result = await fetchResults(candidate.url, context, runtime, config, allowNetwork);
    lastAttempt = {
      siteName: config.name,
      usedUrl: candidate.url,
      usedQuery: candidate.query,
      via: result.via,
      cooldownRemaining,
      results: result.results,
      warnings: result.warnings
    };
    if (result.results.length > 0) {
      return lastAttempt;
    }
  }

  return lastAttempt || {
    siteName: config.name,
    usedUrl: plan.candidates[0] ? plan.candidates[0].url : '',
    usedQuery: plan.candidates[0] ? plan.candidates[0].query : context.query,
    via: allowNetwork ? '失败' : '缓存未命中',
    cooldownRemaining,
    results: [],
    warnings: [allowNetwork ? humanizeFetchFailure({ reason: 'network_failed' }) : humanizeFetchFailure({ reason: 'cache_miss' })]
  };
}

function renderSection(run, context) {
  renderBtbtlaSection(run, context);
}

function collectJsonItems(run, startIndex = 1) {
  let index = startIndex;
  const items = [];
  const includeRaw = process.env.OPENCLAW_BT_INCLUDE_RAW === '1';

  for (const item of run.results || []) {
    const jsonItem = {
      index,
      site: 'btbtla',
      siteMode: run.siteMode,
      siteName: run.siteName,
      title: item.title || '',
      page: item.threadUrl || '',
      source: item.detailUrl || '',
      torrent: item.downloadUrl || '',
      magnet: item.magnet || '',
      episode: Number(item.episode || item.episodeEnd || item.episodeStart || 0),
      episodeStart: Number(item.episodeStart || item.episode || item.episodeEnd || 0),
      episodeEnd: Number(item.episodeEnd || item.episode || item.episodeStart || 0),
      isBatch: Boolean(item.episodeIsBatch),
      size: item.sizeText || item.sizeLabel || item.size || '',
      resolution: item.resolution || item.resolutionLabel || '',
      subtitle: item.hasChineseSubtitle ? '中字' : '未标注',
      hot: item.hits || 0
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

module.exports = {
  id: DEFAULT_CONFIG.id,
  defaultConfig: DEFAULT_CONFIG,
  describe,
  supportsType,
  buildQueryPlan,
  search,
  renderSection,
  collectJsonItems,
  __test: { parseSearchItems, isRelevantSearchItem, parseDetailPage, parseDownloadDetail, normalizeTorrentResult }
};
