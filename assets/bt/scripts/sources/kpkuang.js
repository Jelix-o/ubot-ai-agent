const vm = require('vm');
const { absolutizeUrl, stripHtml } = require('../lib/html-utils');
const { unique, normalizeQuery, stripYearTokens } = require('../lib/query-utils');
const {
  parseSizeInfo,
  detectResolution,
  hasChineseSubtitle,
  parseEpisodeInfo,
  compareMediaResults
} = require('../lib/media-utils');
const { renderTrackerSection } = require('../lib/renderers');
const { resolveDeepBudget } = require('../lib/site-common');

const DEFAULT_CONFIG = {
  id: 'kpkuang',
  name: 'KPkuang',
  baseUrl: 'https://www.kpkuang.org',
  referer: 'https://www.kpkuang.org/',
  warmupUrl: 'https://www.kpkuang.org/',
  customJsPath: '/template/vfed/asset/js/custom.js?v=3.1.47',
  timeoutMs: 30000,
  fastTimeoutMs: 6000,
  searchResultLimit: 12,
  detailCandidateLimit: 2,
  fastDetailCandidateLimit: 5,
  downloadPageLimit: 200,
  fastDownloadPageLimit: 4,
  capabilities: {
    searchTypes: ['anime', 'movie'],
    hasMagnet: true,
    hasTorrent: false,
    hasScreenshots: false,
    usesCache: true,
    needsDecryption: true,
    queryBuilder: 'yearRelaxedQueryVariants'
  }
};

let cachedDecryptor = null;
const cachedDecryptorSource = {
  code: '',
  loadedAt: 0
};

function humanizeFetchFailure(page) {
  switch (page.reason) {
    case 'stale_cache':
      return 'KPkuang 直连失败，已回退到过期缓存结果';
    case 'challenge':
      return 'KPkuang 触发验证页，当前抓取失败';
    case 'timeout':
      return 'KPkuang 页面抓取超时';
    default:
      return 'KPkuang 页面获取失败';
  }
}

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
    customJsUrl: absolutizeUrl(config.baseUrl, config.customJsPath),
    requestOptions: {
      referer: config.referer,
      timeoutMs: config.timeoutMs,
      // CF soft challenge: warmup homepage in same curl_cffi session first.
      warmupUrl: config.warmupUrl || config.referer || `${config.baseUrl}/`,
      cookieJar: config.cookieJar || process.env.OPENCLAW_BT_KPKUANG_COOKIE_JAR || process.env.OPENCLAW_BT_COOKIE_JAR || '',
      ...(overrides.abortSignal ? { abortSignal: overrides.abortSignal } : {}),
      transportOrder: ['curl_cffi', 'https', 'curl']
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
      timeoutMs: config.timeoutMs,
      detailCandidateLimit: config.detailCandidateLimit,
      downloadPageLimit: config.downloadPageLimit
    }
  };
}

function supportsType(type) {
  return getConfig().capabilities.searchTypes.includes(type);
}

function buildSearchUrl(query, config) {
  return `${config.baseUrl}/vodsearch/${encodeURIComponent(query)}-------------.html`;
}

function buildQueryPlan(context, overrides = {}) {
  const config = getConfig(overrides);
  const variants = context.queryContext.yearRelaxedQueryVariants || context.queryContext.queryVariants || [context.query];
  return {
    candidates: unique(variants).map(query => ({
      query,
      url: buildSearchUrl(query, config)
    }))
  };
}

function isLikelyChallenge(html) {
  return /Just a moment|Performing security verification/i.test(html || '');
}

async function fetchHtml(url, runtime, config, options = {}) {
  return runtime.fetchCachedHtml(url, {
    allowNetwork: options.allowNetwork !== false,
    noCache: Boolean(options.noCache),
    requestOptions: {
      ...config.requestOptions,
      timeoutMs: options.fastMode ? config.fastTimeoutMs : config.timeoutMs
    },
    detectChallenge: isLikelyChallenge
  });
}

async function getDecryptor(runtime, config, options = {}) {
  if (cachedDecryptor) {
    return cachedDecryptor;
  }

  const response = await runtime.fetchCachedHtml(config.customJsUrl, {
    allowNetwork: true,
    requestOptions: {
      ...config.requestOptions,
      timeoutMs: options.fastMode ? config.fastTimeoutMs : config.timeoutMs
    }
  });
  if (!response.html) {
    return null;
  }

  const context = {
    console,
    window: {},
    document: {},
    navigator: { userAgent: 'Mozilla/5.0' },
    location: { protocol: 'https:' },
    setTimeout: () => 0,
    clearTimeout: () => {},
    atob: value => Buffer.from(value, 'base64').toString('binary'),
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
    UIkit: { notification: () => {} },
    ClipboardJS: function ClipboardJS() {},
    red_url: '',
    click_dlpage: true,
    CryptoJS: {
      enc: {
        Base64: { parse: value => value },
        Utf8: { stringify: value => Buffer.from(value, 'base64').toString('utf8') }
      }
    },
    $: function dollar() {
      return new Proxy(function proxy() {}, {
        get() {
          return () => context.$();
        },
        apply() {
          return context.$();
        }
      });
    }
  };

  context.window = context;
  vm.createContext(context);

  try {
    vm.runInContext(response.html, context, { timeout: 5000 });
    cachedDecryptor = typeof context.decryptMystring === 'function' ? context.decryptMystring : null;
    cachedDecryptorSource.code = response.html || '';
    cachedDecryptorSource.loadedAt = Date.now();
  } catch {
    cachedDecryptor = null;
    cachedDecryptorSource.code = '';
    cachedDecryptorSource.loadedAt = 0;
  }

  return cachedDecryptor;
}

function scoreCandidate(text, queryText) {
  const value = String(text || '');
  const hay = value.toLowerCase();
  const query = String(queryText || '').toLowerCase();
  let score = 0;

  if (value === queryText) score += 120;
  if (value.startsWith(queryText)) score += 80;
  if (query && hay.includes(query)) score += 40;
  if (/Season|第一季|第二季|第三季|第\d+集|最近更新|动漫/.test(value)) score += 10;
  if (/动态漫画|番外篇|短剧/.test(value)) score -= 20;
  return score;
}

async function mapLimit(items, limit, mapper) {
  const results = [];
  for (let index = 0; index < items.length; index += Math.max(1, limit)) {
    const chunk = items.slice(index, index + Math.max(1, limit));
    const mapped = await Promise.all(chunk.map(mapper));
    results.push(...mapped);
  }
  return results;
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

async function mapLimitUntilTruthy(items, limit, mapper) {
  const results = [];
  const chunkSize = Math.max(1, limit);
  for (let index = 0; index < items.length; index += chunkSize) {
    const chunk = items.slice(index, index + chunkSize);
    const mapped = await Promise.all(chunk.map(mapper));
    results.push(...mapped.filter(Boolean));
    if (results.length > 0) break;
  }
  return results;
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

function hasStrongAvailabilityHit(detailRuns, requestedEpisode) {
  const runs = (detailRuns || []).filter(Boolean);
  if (runs.length === 0) return false;
  if (requestedEpisode) {
    return runs.some(run => run.linksWithEpisode.some(link => link.ep === requestedEpisode));
  }
  return runs.some(run => run.linksWithEpisode.length >= 2 && run.availabilityScore >= 80);
}

function parseRecentEpisode(text) {
  const match = String(text || '').match(/第\s*(\d{1,4})\s*[集话]/);
  return match ? Number.parseInt(match[1], 10) : 0;
}

function isRelevantSearchCandidate(text, queryText) {
  const candidate = normalizeQuery(String(text || '')).toLowerCase();
  const normalizedQuery = normalizeQuery(String(queryText || '')).toLowerCase();
  const strippedQuery = stripYearTokens(queryText || '').toLowerCase();
  const hasCjk = /[\u3400-\u9fff]/.test(normalizedQuery);
  if (!candidate || !normalizedQuery) return false;
  if (hasCjk) {
    return candidate.includes(normalizedQuery) || (strippedQuery && candidate.includes(strippedQuery));
  }
  return candidate.includes(normalizedQuery) || (strippedQuery && candidate.includes(strippedQuery));
}

function parseSearchCandidates(html, queryText, config, options = {}) {
  const detailCandidateLimit = options.fastMode ? config.fastDetailCandidateLimit : config.detailCandidateLimit;
  const rawCandidates = [];

  // 1) classic anchors with inner text
  for (const match of html.matchAll(/href="(\/voddetail\/\d+\/)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = match[1];
    const text = stripHtml(match[2]);
    const titleAttr = (match[0].match(/\btitle="([^"]+)"/i) || [])[1] || '';
    rawCandidates.push({
      href,
      text: text || stripHtml(titleAttr),
      extra: stripHtml(titleAttr)
    });
  }

  // 2) cards that put title only in attributes (fed-list-pics etc.)
  for (const match of html.matchAll(/<a[^>]+href="(\/voddetail\/\d+\/)"[^>]*>/gi)) {
    const tag = match[0];
    const href = match[1];
    const titleAttr = (tag.match(/\btitle="([^"]+)"/i) || [])[1] || '';
    if (!titleAttr) continue;
    rawCandidates.push({
      href,
      text: stripHtml(titleAttr),
      extra: ''
    });
  }

  // 3) nearby "最近更新: 第N集" for scoring
  for (const match of html.matchAll(/href="(\/voddetail\/\d+\/)"[\s\S]{0,500}?最近更新:\s*第\s*(\d{1,4})\s*集/gi)) {
    rawCandidates.push({
      href: match[1],
      text: '',
      extra: `最近更新: 第${match[2]}集`
    });
  }

  const merged = new Map();
  for (const item of rawCandidates) {
    if (!item.href) continue;
    const prev = merged.get(item.href) || { href: item.href, text: '', extra: '' };
    const text = item.text || prev.text || '';
    const extra = [prev.extra, item.extra, item.text].filter(Boolean).join(' ');
    merged.set(item.href, {
      href: item.href,
      text: text || stripHtml(extra),
      extra
    });
  }

  return [...merged.values()]
    .map(item => ({
      href: item.href,
      text: stripHtml(`${item.text} ${item.extra}`.trim())
    }))
    .filter(item => item.text)
    .filter(item => isRelevantSearchCandidate(item.text, queryText))
    .map(item => {
      let score = scoreCandidate(item.text, queryText);
      if (/年番|Season|S\d+/i.test(item.text)) score += 15;
      score += parseRecentEpisode(item.text);
      return {
        ...item,
        score
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(config.searchResultLimit, detailCandidateLimit))
    .slice(0, detailCandidateLimit);
}

function cleanMagnetDisplayName(magnet, fallbackTitle) {
  if (!magnet || !magnet.includes('magnet:?')) {
    return magnet;
  }

  try {
    const url = new URL(magnet);
    const dn = url.searchParams.get('dn');
    if (!dn) {
      return magnet;
    }

    let cleaned = dn.replace(/【[^】]*(?:www\.|DDHDTV|BPHDTV|高清剧集网发布)[^】]*】/gi, '').trim();
    if (!cleaned || cleaned.length < 5) {
      cleaned = fallbackTitle;
    }
    url.searchParams.set('dn', cleaned);
    return url.toString().replace(/%3A/g, ':');
  } catch {
    return magnet;
  }
}

function cleanTitle(title) {
  return String(title || '')
    .replace(/【[^】]*(?:www\.|DDHDTV|BPHDTV|高清剧集网发布)[^】]*】/gi, '')
    .replace(/\s+-《[^》]+》\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseEpisodeNumber(title) {
  const value = String(title || '');
  const patterns = [
    /第\s*(\d{1,4})\s*[-~～到至]\s*(\d{1,4})\s*[集话]/i, // 第01-22集 -> use end
    /第\s*(\d{1,4})\s*[集话]/,
    /\bS\d{1,3}[. _-]*E(\d{1,4})\b/i,
    /(?:EP|E|第)?\s*(\d{1,4})\s*(?:集|话)\b/i,
    /年番\s*(\d{1,4})\b/i,
    /年番(\d{1,4})(?:\D|$)/i,
    /(?:^|[^\d])(\d{1,3})\.mp4\b/i,
    /(?:^|[^\d])(\d{1,3})(?=\s*\.mp4\b)/i
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (!match) continue;
    if (match[2]) return Number.parseInt(match[2], 10);
    return Number.parseInt(match[1], 10);
  }
  return 0;
}

function parseDetailDownloadLinks(detailHtml, detailId, config) {
  const pattern = new RegExp(`href="(/download/${detailId}[^"]+)"[^>]*title="([^"]*)"`, 'gi');
  return [...detailHtml.matchAll(pattern)]
    .map(match => ({
      url: absolutizeUrl(config.baseUrl, match[1]),
      rawTitle: match[2]
    }))
    .filter(item => item.rawTitle)
    .map(item => {
      const ep = parseEpisodeNumber(item.rawTitle);
      const resolution = detectResolution(item.rawTitle);
      const chinese = hasChineseSubtitle(item.rawTitle) || /国语|中文|国配/i.test(item.rawTitle);
      let qualityScore = 0;
      if (resolution.rank >= 2160) qualityScore += 3;
      else if (resolution.rank >= 1080) qualityScore += 2;
      else qualityScore += 1;
      if (chinese) qualityScore += 2;
      if (/高码|HQ/i.test(item.rawTitle)) qualityScore += 1;
      if (/\.torrent|magnet|WEB-DL|WEBRip|BDRip|H\.?26[45]|HEVC|AAC/i.test(item.rawTitle)) qualityScore += 2;
      if (/\.mp4$/i.test(item.rawTitle) && !/WEB-DL|合集|第\d+/i.test(item.rawTitle)) qualityScore -= 1;
      return {
        ...item,
        ep,
        qualityScore
      };
    });
}

function scoreCandidateByAvailability(candidate, links) {
  const episodeCount = links.filter(link => link.ep > 0).length;
  const chineseCount = links.filter(link => /国语|中文|国配|中字|中文字幕/i.test(link.rawTitle || '')).length;
  const highResCount = links.filter(link => detectResolution(link.rawTitle).rank >= 1080).length;
  return (candidate.score || 0) + (episodeCount * 12) + (chineseCount * 4) + (highResCount * 2);
}

function groupByEpisode(links) {
  const groups = new Map();

  for (const link of links) {
    const key = link.ep || 0;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(link);
  }

  return [...groups.entries()]
    .map(([ep, items]) => ({
      ep,
      items: [...items].sort((a, b) => b.qualityScore - a.qualityScore)
    }))
    .map(group => group.items[0])
    .sort((a, b) => (b.ep || 0) - (a.ep || 0));
}

function selectProbeLinks(links, limit) {
  return groupByEpisode(links).slice(0, limit);
}

function parseDownloadToken(html) {
  return (html.match(/data-clipboard-text="([^"]+)"/i) || [])[1] || '';
}

function normalizeResult(decodedMagnet, link, bestCandidate) {
  const title = cleanTitle(link.rawTitle);
  const sizeInfo = parseSizeInfo(title);
  const resolution = detectResolution(title);
  const episodeInfo = parseEpisodeInfo(title);

  return {
    title,
    category: 'KPkuang',
    pageUrl: bestCandidate.detailUrl,
    torrentUrl: link.url,
    magnet: cleanMagnetDisplayName(decodedMagnet, title),
    time: '',
    seeders: '0',
    seedersValue: 0,
    leechers: '0',
    leechersValue: 0,
    completed: '0',
    sizeBytes: sizeInfo.bytes,
    sizeLabel: sizeInfo.label,
    sizeText: sizeInfo.label,
    resolutionRank: resolution.rank,
    resolutionLabel: resolution.label,
    hasChineseSubtitle: hasChineseSubtitle(title) || /国语|中文|国配/i.test(title),
    timeValue: 0,
    episode: episodeInfo.end || episodeInfo.start,
    episodeStart: episodeInfo.start,
    episodeEnd: episodeInfo.end,
    episodeIsBatch: episodeInfo.isBatch,
    sourceLabel: 'KPkuang',
    kpkuangEp: link.ep
  };
}

async function search(context, runtime, overrides = {}) {
  const config = getConfig(overrides);
  const plan = buildQueryPlan(context, config);
  let lastRun = null;

  for (const candidate of plan.candidates) {
    if (shouldStopWork(overrides)) break;
    const searchPage = await fetchHtml(candidate.url, runtime, config, overrides);
    if (!searchPage.html) {
      lastRun = {
        siteName: config.name,
        usedUrl: candidate.url,
        usedQuery: candidate.query,
        via: searchPage.via,
        results: [],
        warnings: [humanizeFetchFailure(searchPage)]
      };
      continue;
    }

    const searchCandidates = parseSearchCandidates(searchPage.html, candidate.query, config, overrides);
    if (searchCandidates.length === 0) {
      lastRun = {
        siteName: config.name,
        usedUrl: candidate.url,
        usedQuery: candidate.query,
        via: searchPage.via,
        results: [],
        warnings: ['KPkuang 无有效候选']
      };
      continue;
    }

    const budget = resolveDeepBudget(config, overrides, context);
    if (budget.noDeep || Number(overrides.detailCandidateLimit) === 0 || Number(overrides.fastDetailCandidateLimit) === 0) {
      const shallow = searchCandidates.slice(0, budget.resultLimit || searchCandidates.length).map(item => ({
        title: item.text,
        pageUrl: absolutizeUrl(config.baseUrl, item.href),
        magnet: '',
        torrentUrl: '',
        sizeText: '未知',
        sizeLabel: '未知',
        sizeBytes: Number.POSITIVE_INFINITY,
        resolutionLabel: detectResolution(item.text).label,
        resolutionRank: detectResolution(item.text).rank,
        hasChineseSubtitle: hasChineseSubtitle(item.text),
        episode: parseEpisodeInfo(item.text).end || parseEpisodeInfo(item.text).start,
        episodeStart: parseEpisodeInfo(item.text).start,
        episodeEnd: parseEpisodeInfo(item.text).end,
        episodeIsBatch: parseEpisodeInfo(item.text).isBatch,
        sourceLabel: 'KPkuang'
      }));
      lastRun = {
        siteName: config.name,
        usedUrl: candidate.url,
        usedQuery: candidate.query,
        via: searchPage.via,
        results: shallow,
        warnings: ['--no-deep: 仅返回 KPkuang 搜索候选，未解密磁力']
      };
      if (shallow.length > 0) return lastRun;
      continue;
    }

    const decrypt = await getDecryptor(runtime, config, overrides);
    if (!decrypt) {
      lastRun = {
        siteName: config.name,
        usedUrl: candidate.url,
        usedQuery: candidate.query,
        via: searchPage.via,
        results: [],
        warnings: ['KPkuang 解密器初始化失败']
      };
      continue;
    }

    let bestCandidate = null;
    let bestLinks = [];
    let bestScore = -Infinity;

    const detailCandidateRuns = await mapLimitUntil(
      searchCandidates,
      overrides.fastMode ? 2 : 3,
      async detailCandidate => {
        if (shouldStopWork(overrides)) return null;
        const detailId = (detailCandidate.href.match(/\/voddetail\/(\d+)\//) || [])[1];
        if (!detailId) return null;

        const detailUrl = absolutizeUrl(config.baseUrl, detailCandidate.href);
        const detailPage = await fetchHtml(detailUrl, runtime, config, overrides);
        if (!detailPage.html) return null;

        const links = parseDetailDownloadLinks(detailPage.html, detailId, config);
        const linksWithEpisode = links.filter(link => link.ep > 0);
        const usableLinks = linksWithEpisode.length > 0 ? linksWithEpisode : links;
        const availabilityScore = scoreCandidateByAvailability(detailCandidate, usableLinks);

        return {
          detailCandidate,
          detailId,
          detailUrl,
          linksWithEpisode: usableLinks,
          availabilityScore
        };
      },
      partialRuns => (overrides.fastMode && hasStrongAvailabilityHit(partialRuns, context.queryContext.requestedEpisode)) || shouldStopWork(overrides)
    );

    for (const detailRun of detailCandidateRuns.filter(Boolean)) {
      if (shouldStopWork(overrides)) break;
      if (detailRun.linksWithEpisode.length > 0 && detailRun.availabilityScore > bestScore) {
        bestCandidate = {
          ...detailRun.detailCandidate,
          detailId: detailRun.detailId,
          detailUrl: detailRun.detailUrl
        };
        bestLinks = detailRun.linksWithEpisode;
        bestScore = detailRun.availabilityScore;
      }
    }

    if (!bestCandidate) {
      const detailTried = detailCandidateRuns.filter(Boolean).length;
      lastRun = {
        siteName: config.name,
        usedUrl: candidate.url,
        usedQuery: candidate.query,
        via: searchPage.via,
        results: [],
        warnings: [
          detailTried > 0
            ? 'KPkuang 详情页未解析到可下载分集'
            : 'KPkuang 无有效候选'
        ]
      };
      continue;
    }

    const downloadLimit = overrides.fastMode ? config.fastDownloadPageLimit : config.downloadPageLimit;
    const linksToProbe = overrides.fastMode
      ? selectProbeLinks(bestLinks, downloadLimit)
      : groupByEpisode(bestLinks).slice(0, downloadLimit);
    const probeMapper = async link => {
      if (shouldStopWork(overrides)) return null;
      const downloadPage = await fetchHtml(link.url, runtime, config, overrides);
      if (!downloadPage.html) return null;

      const token = parseDownloadToken(downloadPage.html);
      if (!token) return null;

      let decoded = '';
      try {
        decoded = decrypt(token) || '';
      } catch {
        decoded = '';
      }

      if (!decoded.startsWith('magnet:?')) return null;
      return normalizeResult(decoded, link, bestCandidate);
    };
    const results = (overrides.fastMode
      ? await mapLimitUntilTruthy(linksToProbe, 1, probeMapper)
      : await mapLimit(linksToProbe, 3, probeMapper))
      .filter(Boolean);

    const deduped = results
      .filter((item, index, all) => all.findIndex(other => other.magnet === item.magnet) === index)
      .sort(compareMediaResults);

    lastRun = {
      siteName: config.name,
      usedUrl: candidate.url,
      usedQuery: candidate.query,
      via: searchPage.via,
      results: deduped,
      warnings: deduped.length > 0 ? [] : ['KPkuang 无可解密磁力结果']
    };

    if (deduped.length > 0) {
      return lastRun;
    }
  }

  return lastRun || {
    siteName: config.name,
    usedUrl: plan.candidates[0] ? plan.candidates[0].url : '',
    usedQuery: plan.candidates[0] ? plan.candidates[0].query : context.query,
    via: '失败',
    results: [],
    warnings: [humanizeFetchFailure({ reason: 'network_failed' })]
  };
}

function renderSection(run, context) {
  renderTrackerSection(run, context);
}

function collectJsonItems(run, startIndex = 1) {
  let index = startIndex;
  const items = [];
  const includeRaw = process.env.OPENCLAW_BT_INCLUDE_RAW === '1';

  for (const item of run.results || []) {
    const jsonItem = {
      index,
      site: 'kpkuang',
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
      size: item.sizeText || item.sizeLabel || '',
      resolution: item.resolutionLabel || '',
      subtitle: item.hasChineseSubtitle ? '中字' : '未标注'
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
  __test: { buildSearchUrl, parseSearchCandidates, parseDetailDownloadLinks, parseDownloadToken, normalizeResult }
};
