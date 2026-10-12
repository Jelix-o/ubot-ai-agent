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
const { renderOnelouSection } = require('../lib/renderers');
const { resolveDeepBudget } = require('../lib/site-common');

const DEFAULT_CONFIG = {
  id: 'onelou',
  name: '1LOU',
  siteName: 'BT之家1LOU',
  baseUrl: 'https://www.1lou.me/',
  searchPathPrefix: 'search-',
  searchPathSuffix: '.htm',
  referer: 'https://www.1lou.me/',
  cooldownKey: 'lastOnelouSearch',
  cooldownSeconds: 20,
  pageLimit: 20,
  expandLimit: 12,
  detailLimit: 6,
  fastExpandLimit: 6,
  fastDetailLimit: 3,
  fastAnimeExpandLimit: 4,
  fastAnimeDetailLimit: 2,
  fastAnimeResultLimit: 12,
  timeoutMs: 25000,
  fastTimeoutMs: 4500,
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
      ...(overrides.abortSignal ? { abortSignal: overrides.abortSignal } : {}),
      timeoutMs: config.fastMode ? config.fastTimeoutMs : config.timeoutMs,
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
  return `${config.baseUrl}search/api/search.php?q=${encodeURIComponent(query)}&page=1&sort=relevance&scope=%E5%85%A8%E9%83%A8&type=%E5%85%A8%E9%83%A8&year=%E5%85%A8%E9%83%A8&quality=%E5%85%A8%E9%83%A8&source=%E5%85%A8%E9%83%A8&track=1`;
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

function looksLikeCloudOnly(title) {
  const text = String(title || '');
  if (/\[?BT下载\]?|\[BT\]|\.torrent|磁力|magnet/i.test(text)) return false;
  return /夸克|阿里云盘|百度网盘|网盘|迅雷云盘|UC网盘|天翼云盘/i.test(text);
}

function parseSearchItems(html, searchUrl, config) {
  try {
    const data = JSON.parse(html);
    if (!data || !data.ok || !data.data || !data.data.hits) return [];
    return data.data.hits.slice(0, config.pageLimit).map(hit => {
      const title = stripHtml(hit.subject || '').replace(/&#039;/g, "'").replace(/&amp;/g, "&");
      const threadUrl = absolutizeUrl(searchUrl, hit.thread_url);
      const date = new Date(hit.create_date * 1000);
      const timeStr = date.toISOString().replace('T', ' ').substring(0, 19);
      const isAnime = hit.fid === 4;
      const isMovie = hit.fid === 2;
      return {
        title,
        threadUrl,
        author: hit.username || '',
        time: timeStr,
        comments: String(hit.posts || '0'),
        forum: isAnime ? '动漫' : String(hit.fid),
        tags: [],
        summary: '',
        year: '',
        category: isAnime ? '动漫' : (isMovie ? '电影' : ''),
        sourceLabel: config.siteName,
        cloudOnly: looksLikeCloudOnly(title)
      };
    }).filter(item => item.title && item.threadUrl);
  } catch (e) {
    // If it is not JSON (maybe cache fallback or HTML error), fallback to old regex parse just in case
    const blocks = html.match(/<li class=\"media thread[\s\S]*?<\/li>/gi) || [];
    return blocks.slice(0, config.pageLimit).map(block => {
      const hrefMatch = block.match(/<a href=\"(thread-\d+\.htm)\"/i)
        || block.match(/data-href=\"(thread-\d+\.htm)\"/i)
        || block.match(/href=\"(thread-\d+\.htm)\"/i);
      const titleMatch = block.match(/<a href=\"thread-\d+\.htm\"[^>]*>([\s\S]*?)<\/a>/i)
        || block.match(/href=\"thread-\d+\.htm\"[^>]*>([\s\S]*?)<\/a>/i);
      const authorMatch = block.match(/class=\"username[^\"]*\"[^>]*>([\s\S]*?)<\/span>/i);
      const timeMatch = block.match(/class=\"date[^\"]*\"[^>]*>([\s\S]*?)<\/span>/i);
      const tags = [...block.matchAll(/class=\"badge[^\"]*\"[^>]*>([\s\S]*?)<\/a>/gi)]
        .map(match => stripHtml(match[1]))
        .filter(Boolean);
      const title = stripHtml(titleMatch ? titleMatch[1] : '');
      return {
        title,
        threadUrl: absolutizeUrl(searchUrl, hrefMatch ? hrefMatch[1] : ''),
        author: stripHtml(authorMatch ? authorMatch[1] : ''),
        time: stripHtml(timeMatch ? timeMatch[1] : ''),
        comments: '0',
        forum: tags[2] || tags[1] || '',
        tags: unique(tags),
        summary: '',
        year: tags.find(tag => /^\d{4}$/.test(tag)) || '',
        category: tags.find(tag => /动漫|电影|剧集|综艺|纪录/i.test(tag)) || '',
        sourceLabel: config.siteName,
        cloudOnly: looksLikeCloudOnly(title)
      };
    }).filter(item => item.title && item.threadUrl);
  }
}

function parseThreadAttachments(html, threadUrl) {
  const magnets = unique(
    [...html.matchAll(/href="(magnet:\?[^"]+)"/gi)].map(match => match[1].replace(/&amp;/g, '&'))
  );
  const attachments = [...html.matchAll(/href="(attach-download-\d+\.htm)"[^>]*>[\s\S]*?<i class="icon filetype torrent"><\/i>\s*([\s\S]*?)<\/a>/gi)]
    .map(match => ({
      downloadUrl: absolutizeUrl(threadUrl, match[1]),
      torrentName: stripHtml(match[2])
    }));

  // fallback: any attach-download near .torrent text
  if (attachments.length === 0) {
    const loose = [...html.matchAll(/href="(attach-download-\d+\.htm)"[^>]*>([\s\S]*?)<\/a>/gi)]
      .map(match => ({
        downloadUrl: absolutizeUrl(threadUrl, match[1]),
        torrentName: stripHtml(match[2])
      }))
      .filter(item => /\.torrent/i.test(item.torrentName) || /torrent/i.test(item.torrentName));
    attachments.push(...loose);
  }

  return {
    magnets,
    attachments: attachments.filter(item => item.downloadUrl)
  };
}

function normalizeAttachmentResult(searchItem, attachment, config) {
  const composedTitle = stripHtml(attachment.torrentName || searchItem.title);
  const sizeInfo = parseSizeInfo(composedTitle, attachment.torrentName, searchItem.title);
  const resolution = detectResolution(composedTitle, attachment.torrentName, searchItem.title, searchItem.category);
  const episodeInfo = parseEpisodeInfo(composedTitle, attachment.torrentName, searchItem.title);
  const sizeText = sizeInfo.label && sizeInfo.label !== '未知' ? sizeInfo.label : '';

  return {
    title: composedTitle || searchItem.title,
    threadUrl: searchItem.threadUrl,
    detailUrl: searchItem.threadUrl,
    forum: searchItem.category || searchItem.forum || config.siteName,
    author: searchItem.author || '',
    time: searchItem.time || '',
    comments: searchItem.comments || '0',
    tags: unique([...(searchItem.tags || []), searchItem.year].filter(Boolean)),
    downloadUrl: attachment.downloadUrl || '',
    torrentName: attachment.torrentName || composedTitle,
    magnet: attachment.magnet || '',
    sizeBytes: sizeInfo.bytes,
    sizeLabel: sizeText || sizeInfo.label,
    sizeText: sizeText || sizeInfo.label,
    resolution: resolution.label,
    resolutionRank: resolution.rank,
    resolutionLabel: resolution.label,
    timeValue: parseDateValue(searchItem.time),
    hasChineseSubtitle: hasChineseSubtitle(composedTitle, attachment.torrentName, searchItem.title),
    episode: episodeInfo.end || episodeInfo.start,
    episodeStart: episodeInfo.start,
    episodeEnd: episodeInfo.end,
    episodeIsBatch: episodeInfo.isBatch,
    summary: searchItem.summary || '',
    subtitle: '',
    source: config.siteName,
    sourceLabel: config.siteName,
    hash: '',
    waterMark: '',
    pageTitle: searchItem.title,
    hits: 0
  };
}

function scoreResultMatch(item, query, queryYearTokens) {
  const loweredQuery = query.toLowerCase();
  const baseQuery = stripYearTokens(query).toLowerCase();
  const haystack = [item.title, item.pageTitle, item.torrentName, item.summary, ...(item.tags || [])]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  let score = 0;

  if (query && haystack.includes(loweredQuery)) score += 120;
  if (baseQuery && haystack.includes(baseQuery)) score += 60;
  if (item.title && item.title.toLowerCase() === loweredQuery) score += 90;
  if (item.title && baseQuery && item.title.toLowerCase().includes(baseQuery)) score += 40;
  if (/\[?bt下载\]?|\.torrent/i.test(item.title || '') || item.downloadUrl) score += 30;
  if (looksLikeCloudOnly(item.title) && !item.downloadUrl && !item.magnet) score -= 100;

  const itemYears = unique([
    ...extractYearTokens(item.title),
    ...extractYearTokens(item.pageTitle),
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
    detectChallenge(html) {
      const normalized = stripHtml(html).toLowerCase();
      const challenge = normalized.includes('just a moment')
        || normalized.includes('verify you are human')
        || /challenge-platform|cf-browser-verification|turnstile/i.test(html || '');
      const usable = /class=\"media thread|attach-download-\d+\.htm|thread-\d+\.htm/i.test(html || '')
        || (html && html.trim().startsWith('{'));
      return challenge && !usable;
    }
  });
}

function humanizeFetchFailure(page) {
  switch (page.reason) {
    case 'cache_miss':
      return '1LOU 当前处于冷却期，且本地暂无可用缓存';
    case 'stale_cache':
      return '1LOU 直连失败，已回退到过期缓存结果';
    case 'challenge':
      return '1LOU 触发 Cloudflare / 验证页，当前抓取失败';
    case 'timeout':
      return '1LOU 页面抓取超时';
    default:
      return '1LOU 页面获取失败';
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

function isStrongHit(items, context) {
  const requestedEpisode = Number(context?.queryContext?.requestedEpisode || 0);
  return (items || []).some(item => {
    if (!item) return false;
    if (requestedEpisode && (item.episodeEnd || 0) >= requestedEpisode && (item.episodeStart || 0) <= requestedEpisode) {
      return true;
    }
    return scoreResultMatch(item, context.query, context.queryContext.yearTokens) >= 140;
  });
}

async function fetchResults(url, context, runtime, config, allowNetwork) {
  if (shouldStopWork(config)) {
    return {
      via: '中止',
      results: [],
      warnings: ['1LOU 搜索已中止']
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

  const searchItems = parseSearchItems(page.html, url, config);
  const preferredItems = searchItems
    .map(item => ({
      ...item,
      preferScore: (item.cloudOnly ? -50 : 40) + scoreResultMatch(item, context.query, context.queryContext.yearTokens)
    }))
    .sort((a, b) => b.preferScore - a.preferScore);
  const budget = resolveDeepBudget(config, config, context);
  if (budget.noDeep || budget.expandLimit <= 0) {
    const shallow = preferredItems.slice(0, budget.resultLimit || preferredItems.length).map(item =>
      normalizeAttachmentResult(item, {
        downloadUrl: '',
        torrentName: item.title,
        magnet: ''
      }, config)
    );
    return {
      via: page.via,
      results: shallow,
      warnings: ['--no-deep: 仅返回 1LOU 搜索页结果，未展开帖内附件']
    };
  }

  const nestedAllowNetwork = config.fastMode && page.reason === 'stale_cache' ? false : allowNetwork;
  const isFastAnime = config.fastMode && context.searchType === 'anime';
  const expandLimit = budget.expandLimit;
  const detailLimit = budget.detailLimit;

  const expandedSearchItems = preferredItems.slice(0, Math.max(1, expandLimit || preferredItems.length));
  const warnings = [];

  const torrentCandidateGroups = await mapLimitUntil(
    expandedSearchItems,
    config.fastMode ? 2 : 3,
    async searchItem => {
      if (shouldStopWork(config)) return [];
      const detailResponse = await fetchHtml(searchItem.threadUrl, runtime, config, nestedAllowNetwork);
      if (!detailResponse.html) return [];

      const parsed = parseThreadAttachments(detailResponse.html, searchItem.threadUrl);
      const attachmentRows = parsed.attachments.slice(0, Math.max(1, detailLimit || parsed.attachments.length));
      const results = [];

      for (const attachment of attachmentRows) {
        results.push(normalizeAttachmentResult(searchItem, attachment, config));
      }

      // magnet-only fallback when no torrent attachment
      if (results.length === 0) {
        for (const magnet of parsed.magnets.slice(0, Math.max(1, detailLimit || parsed.magnets.length))) {
          results.push(normalizeAttachmentResult(searchItem, {
            downloadUrl: '',
            torrentName: searchItem.title,
            magnet
          }, config));
        }
      }

      return results.filter(item => item.downloadUrl || item.magnet);
    },
    partialGroups => config.fastMode && isStrongHit(partialGroups.flat(), context)
  );

  const torrentCandidates = torrentCandidateGroups.flat();
  const torrentResults = torrentCandidates
    .map(item => ({
      ...item,
      relevanceScore: scoreResultMatch(item, context.query, context.queryContext.yearTokens)
    }))
    .sort((a, b) => {
      if (b.relevanceScore !== a.relevanceScore) return b.relevanceScore - a.relevanceScore;
      return compareMediaResults(a, b);
    })
    .slice(0, isFastAnime ? (config.fastAnimeResultLimit || 12) : torrentCandidates.length);

  if (searchItems.length === 0) {
    warnings.push('1LOU 未找到搜索结果');
  } else if (torrentResults.length === 0) {
    warnings.push('1LOU 有帖子但未解析到可下载种子/磁力（可能多为网盘帖）');
  }

  const excludedCloud = searchItems.filter(item => item.cloudOnly).length;
  if (excludedCloud > 0 && torrentResults.length > 0) {
    warnings.push(`搜索列表含 ${excludedCloud} 条疑似网盘帖，已优先展开 BT 帖`);
  }
  if (searchItems.length > expandedSearchItems.length) {
    warnings.push(`快速/默认模式仅展开前 ${expandedSearchItems.length} 条 1LOU 搜索结果`);
  }
  if (config.fastMode && page.reason === 'stale_cache') {
    warnings.push('1LOU 搜索页已回退到过期缓存，详情层仅使用缓存以缩短等待');
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
  renderOnelouSection(run, context);
}

function collectJsonItems(run, startIndex = 1) {
  let index = startIndex;
  const items = [];
  const includeRaw = process.env.OPENCLAW_BT_INCLUDE_RAW === '1';

  for (const item of run.results || []) {
    const jsonItem = {
      index,
      site: 'onelou',
      siteMode: run.siteMode,
      siteName: run.siteName,
      title: item.title || '',
      page: item.threadUrl || '',
      source: item.detailUrl || item.threadUrl || '',
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
  __test: { parseSearchItems, parseThreadAttachments, normalizeAttachmentResult }
};
