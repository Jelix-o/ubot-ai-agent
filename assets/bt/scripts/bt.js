#!/usr/bin/env node
/**
 * OpenClaw BT skill entrypoint.
 * Main responsibility: parse args, resolve search type, dispatch site modules.
 */

const path = require('path');
const { spawnSync } = require('child_process');
const { createRuntime } = require('./lib/runtime');
const { parseSearchFilters, inferSearchType, resolveQueryContext, normalizeQuery, unique } = require('./lib/query-utils');
const { applySearchFilters, summarizeActiveFilters, mergeCrossSourceResults } = require('./lib/media-utils');
const { getSitesForType } = require('./lib/site-registry');
const { stripHtml } = require('./lib/html-utils');
const { renderGlobalRecommendations, renderSiteSummaryLine, shortTitle, chipList, formatEpisodeChip } = require('./lib/renderers');

const DEFAULT_MAX_RESULTS = 5;
const VALID_TYPES = ['anime', 'movie', 'adult'];
const VALID_SITE_IDS = ['mikan', 'nyaa', 'btbtla', 'onelou', 'kpkuang', 'sukebei'];
const FAST_SOURCE_TIMEOUT_MS = 8000;
const FAST_TOTAL_BUDGET_MS = 15000;
const SITE_CIRCUIT_THRESHOLD = 3;
const SITE_CIRCUIT_OPEN_MS = 5 * 60 * 1000;
const WORKSPACE_ROOT = path.resolve(__dirname, '../../..');
const args = process.argv.slice(2);
const commandStartedAt = Date.now();

function nowMs() {
  return Date.now();
}

function timingStart() {
  return nowMs();
}

function timingEnd(label, startedAt) {
  if (ENABLE_TIMING_LOG) {
    console.error(`[timing] ${label}: ${nowMs() - startedAt}ms`);
  }
}

function debugLog(label, value) {
  if (DEBUG_MODE) {
    const rendered = typeof value === 'string' ? value : JSON.stringify(value);
    console.error(`[debug] ${label}: ${rendered}`);
  }
}

async function withTimeout(promise, ms, label = 'task') {
  if (!ms || ms <= 0) {
    return promise;
  }

  let timer = null;
  return new Promise(resolve => {
    timer = setTimeout(() => {
      debugLog('timeout', { label, ms });
      resolve({ __timedOut: true });
    }, ms);

    Promise.resolve(promise).then(
      value => {
        if (timer) clearTimeout(timer);
        resolve(value);
      },
      error => {
        if (timer) clearTimeout(timer);
        resolve({ __failed: true, error });
      }
    );
  });
}

function createAbortSignal() {
  return {
    aborted: false,
    reason: '',
    abort(reason = 'aborted') {
      this.aborted = true;
      this.reason = reason;
    }
  };
}

function printHelp() {
  console.log('用法: bt <关键词> [类型] [选项]');
  console.log('类型: anime (动漫), movie (影视), adult (成人)');
  console.log('选项:');
  console.log('  --fast                 首屏优先（限深抓 + 总预算）');
  console.log('  --full / --detail      展开完整结果');
  console.log('  --json                 JSON 输出');
  console.log('  --no-cache             跳过结构化结果缓存');
  console.log('  --no-deep              只抓搜索页，不进详情/附件层');
  console.log('  --source a,b,c         仅启用指定站点: mikan,nyaa,btbtla,onelou,kpkuang,sukebei');
  console.log('  --timeout <ms|s>       单站超时，如 8000 / 8s');
  console.log('  --limit <n>            融合推荐条数（默认 5）');
  console.log('  --debug                调试日志');
  console.log('示例: bt "葬送的芙莉莲" anime --fast');
  console.log('示例: bt "三体" movie --source nyaa,btbtla --limit 8');
  console.log('示例: bt 波多野结衣 --no-deep');
}

function getSearchTypeBanner(type) {
  switch (type) {
    case 'anime':
      return '🎬 动漫搜索';
    case 'movie':
      return '🎥 影视搜索';
    case 'adult':
      return '🔞 成人搜索';
    default:
      return '🔎 搜索';
  }
}

if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
  printHelp();
  process.exit(args.length === 0 ? 1 : 0);
}

function parseDurationMs(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  const text = String(raw).trim().toLowerCase();
  if (!text) return fallback;
  if (/^\d+$/.test(text)) return Number(text);
  const match = text.match(/^(\d+(?:\.\d+)?)(ms|s|m)?$/);
  if (!match) return fallback;
  const value = Number(match[1]);
  const unit = match[2] || 'ms';
  if (unit === 's') return Math.round(value * 1000);
  if (unit === 'm') return Math.round(value * 60 * 1000);
  return Math.round(value);
}

function consumeOptionValue(argv, index) {
  const token = argv[index];
  if (token.includes('=')) {
    return { value: token.split('=').slice(1).join('='), next: index + 1 };
  }
  return { value: argv[index + 1], next: index + 2 };
}

const flagArgs = new Set();
const positionalArgs = [];
let sourceFilter = [];
let customTimeoutMs = 0;
let resultLimit = DEFAULT_MAX_RESULTS;
let noDeep = false;

for (let i = 0; i < args.length; i += 1) {
  const token = args[i];
  if (!token.startsWith('--')) {
    positionalArgs.push(token);
    continue;
  }
  const flagName = token.split('=')[0];
  flagArgs.add(flagName);
  if (flagName === '--source') {
    const got = consumeOptionValue(args, i);
    sourceFilter = String(got.value || '')
      .split(',')
      .map(item => item.trim().toLowerCase())
      .filter(Boolean);
    i = got.next - 1;
    continue;
  }
  if (flagName === '--timeout') {
    const got = consumeOptionValue(args, i);
    customTimeoutMs = parseDurationMs(got.value, 0);
    i = got.next - 1;
    continue;
  }
  if (flagName === '--limit') {
    const got = consumeOptionValue(args, i);
    const n = Number(got.value);
    if (Number.isFinite(n) && n > 0) resultLimit = Math.floor(n);
    i = got.next - 1;
    continue;
  }
  if (flagName === '--no-deep') {
    noDeep = true;
  }
}

const outputJson = flagArgs.has('--json');
const fastMode = flagArgs.has('--fast');
const noCache = flagArgs.has('--no-cache');
const explicitFull = flagArgs.has('--full') || flagArgs.has('--detail') || flagArgs.has('--all');
const showFullResults = explicitFull;
const totalBudgetMs = Math.min(180000, Math.max(1, Number(process.env.UBOT_BT_TOTAL_BUDGET_MS) || (fastMode ? FAST_TOTAL_BUDGET_MS : 180000)));
const commandDeadlineAt = commandStartedAt + totalBudgetMs;
const remainingBudgetMs = () => Math.max(0, commandDeadlineAt - Date.now());
const RESULT_CACHE_TTL_MS = Number(process.env.OPENCLAW_BT_RESULT_TTL_MS || (15 * 60 * 1000));
const DEBUG_MODE = flagArgs.has('--debug');
const ENABLE_TIMING_LOG = process.env.OPENCLAW_BT_TIMING === '1' || DEBUG_MODE;
const MAX_RESULTS = resultLimit;
const typeArg = positionalArgs[positionalArgs.length - 1];

let typeExplicitlyProvided = false;
let query;
let searchType;

if (VALID_TYPES.includes(typeArg)) {
  query = positionalArgs.slice(0, -1).join(' ');
  searchType = typeArg;
  typeExplicitlyProvided = true;
} else {
  query = positionalArgs.join(' ');
  searchType = 'anime';
}

const parsedQuery = parseSearchFilters(query);
const searchFilters = parsedQuery.filters;
const queryContext = resolveQueryContext(parsedQuery.cleanedQuery);
query = queryContext.normalizedQuery;

if (!query) {
  printHelp();
  process.exit(1);
}

if (!typeExplicitlyProvided) {
  searchType = inferSearchType(query);
}

if (sourceFilter.length > 0) {
  const invalid = sourceFilter.filter(id => !VALID_SITE_IDS.includes(id));
  if (invalid.length > 0) {
    console.error(`未知站点: ${invalid.join(', ')}`);
    console.error(`可选站点: ${VALID_SITE_IDS.join(', ')}`);
    process.exit(1);
  }
}

const runtime = createRuntime({
  noCache,
  workspaceRoot: WORKSPACE_ROOT,
  scriptDir: __dirname
});
const pythonProbe = spawnSync(process.env.OPENCLAW_BT_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), ['-c', 'import curl_cffi'], {
  timeout: 2000, windowsHide: true, stdio: 'ignore'
});
const dependencyWarnings = pythonProbe.status === 0 ? [] : ['抓取依赖 curl_cffi 不可用，部分来源受限'];
const attemptedSiteRuns = [];
let budgetExceeded = false;

function getSiteSearchOverrides(site) {
  const baseTimeout = customTimeoutMs > 0
    ? customTimeoutMs
    : (fastMode ? FAST_SOURCE_TIMEOUT_MS : 30000);
  const overrides = {};
  if (baseTimeout > 0) {
    overrides.siteTimeoutMs = baseTimeout;
    overrides.timeoutMs = baseTimeout;
  }
  if (noDeep) {
    overrides.noDeep = true;
    overrides.expandLimit = 0;
    overrides.detailLimit = 0;
    overrides.fastExpandLimit = 0;
    overrides.fastDetailLimit = 0;
    overrides.fastAnimeExpandLimit = 0;
    overrides.fastAnimeDetailLimit = 0;
    overrides.detailCandidateLimit = 0;
    overrides.fastDetailCandidateLimit = 0;
    overrides.downloadPageLimit = 0;
    overrides.fastDownloadPageLimit = 0;
  }
  if (showFullResults && !fastMode && !noDeep && customTimeoutMs <= 0) {
    return overrides;
  }
  if (!fastMode && !noDeep) {
    return overrides;
  }

  if (site.id === 'btbtla') {
    return {
      ...overrides,
      siteTimeoutMs: overrides.siteTimeoutMs || FAST_SOURCE_TIMEOUT_MS,
      fastMode: true,
      timeoutMs: overrides.timeoutMs || Math.max(2500, Math.floor(FAST_SOURCE_TIMEOUT_MS * 0.75)),
      pageLimit: noDeep ? 12 : 6,
      expandLimit: noDeep ? 0 : 1,
      detailLimit: noDeep ? 0 : 1,
      fastExpandLimit: noDeep ? 0 : 3,
      fastDetailLimit: noDeep ? 0 : 2
    };
  }

  if (site.id === 'onelou') {
    return {
      ...overrides,
      siteTimeoutMs: overrides.siteTimeoutMs || FAST_SOURCE_TIMEOUT_MS,
      fastMode: true,
      timeoutMs: overrides.timeoutMs || Math.max(2500, Math.floor(FAST_SOURCE_TIMEOUT_MS * 0.75)),
      pageLimit: noDeep ? 20 : 12,
      expandLimit: noDeep ? 0 : 4,
      detailLimit: noDeep ? 0 : 2,
      fastExpandLimit: noDeep ? 0 : 4,
      fastDetailLimit: noDeep ? 0 : 2
    };
  }

  if (site.id === 'kpkuang') {
    return {
      ...overrides,
      siteTimeoutMs: overrides.siteTimeoutMs || Math.max(2500, Math.floor(FAST_SOURCE_TIMEOUT_MS * 0.75)),
      fastMode: true,
      timeoutMs: overrides.timeoutMs || Math.max(2500, Math.floor(FAST_SOURCE_TIMEOUT_MS * 0.75)),
      fastDetailCandidateLimit: noDeep ? 0 : 1,
      fastDownloadPageLimit: noDeep ? 0 : 1,
      detailCandidateLimit: noDeep ? 0 : 1,
      downloadPageLimit: noDeep ? 0 : 1
    };
  }

  return {
    ...overrides,
    siteTimeoutMs: overrides.siteTimeoutMs || FAST_SOURCE_TIMEOUT_MS
  };
}

function extractAliasCandidatesFromText(input) {
  const raw = String(input || '');
  const candidates = [];
  const parenthetical = [...raw.matchAll(/\(([^()]{2,80})\)/g)].map(match => match[1].trim());
  const pipeParts = raw.split('|').map(item => item.trim()).filter(Boolean);
  const slashParts = raw.split('/').map(item => item.trim()).filter(Boolean);

  for (const value of [...parenthetical, ...pipeParts, ...slashParts]) {
    const cleaned = normalizeQuery(stripHtml(value));
    if (!cleaned || cleaned.length < 2) continue;
    if (/^(1080p|2160p|4k|chs|cht|gb_cn|aac|hevc|x264|x265|webrip|web-dl)$/i.test(cleaned)) continue;
    candidates.push(cleaned);
  }

  return unique(candidates).slice(0, 6);
}

function collectCrossSourceAliases(siteRuns) {
  const titles = [];

  for (const siteRun of siteRuns || []) {
    if (siteRun.siteId === 'kpkuang') continue;
    titles.push(...(siteRun.results || []).slice(0, 3).map(item => item.title));
  }

  return unique(titles.flatMap(extractAliasCandidatesFromText)).slice(0, 6);
}

function filterAliasProbeCandidates(aliases, baseQuery) {
  const normalizedBase = normalizeQuery(baseQuery || '').toLowerCase();
  return unique((aliases || []).filter(alias => {
    const normalizedAlias = normalizeQuery(alias || '').toLowerCase();
    if (!normalizedAlias || normalizedAlias.length < 2) return false;
    if (normalizedAlias === normalizedBase) return false;
    if (/^[0-9\W]+$/.test(normalizedAlias)) return false;
    if (/^(1080p|2160p|4k|chs|cht|aac|hevc|x264|x265|webrip|web-dl)$/i.test(normalizedAlias)) return false;
    return true;
  }));
}

function isKpkuangResultDirty(run, expectedTerms) {
  if (!run || !run.results || run.results.length === 0) return true;
  const top = run.results[0];
  const title = String(top.title || '').trim();
  if (!title || title.length < 6) return true;
  if (/^(第\d+集|豆瓣|TMDB)/i.test(title)) return true;

  const haystack = title.toLowerCase();
  const terms = unique((expectedTerms || []).map(item => normalizeQuery(item)).filter(Boolean));
  if (terms.length === 0) return false;

  return !terms.some(term => {
    const lowered = term.toLowerCase();
    return lowered && (haystack.includes(lowered) || lowered.includes(haystack));
  });
}

function summarizeSiteRuns(siteRuns) {
  return (siteRuns || []).map(siteRun => ({
    siteId: siteRun.siteId,
    siteName: siteRun.siteName,
    usedQuery: siteRun.usedQuery || '',
    usedUrl: siteRun.usedUrl || '',
    via: siteRun.via || '',
    durationMs: Number(siteRun.durationMs || 0),
    resultCount: Array.isArray(siteRun.results) ? siteRun.results.length : 0,
    warnings: Array.isArray(siteRun.warnings) ? siteRun.warnings : []
  }));
}


function buildSearchCacheKey(type) {
  const filterKey = JSON.stringify(searchFilters || {});
  const modeKey = [
    fastMode ? 'fast' : 'full',
    explicitFull ? 'detail' : 'compact',
    noDeep ? 'nodeep' : 'deep',
    sourceFilter.length ? `src=${sourceFilter.slice().sort().join(',')}` : 'src=all',
    `limit=${MAX_RESULTS}`,
    customTimeoutMs > 0 ? `timeout=${customTimeoutMs}` : 'timeout=auto'
  ].join(':');
  return ['bt-result', type, query, modeKey, filterKey].join('|');
}

function sanitizeSiteRunForCache(siteRun) {
  return {
    siteId: siteRun.siteId,
    siteName: siteRun.siteName,
    siteMode: siteRun.siteMode,
    usedQuery: siteRun.usedQuery || '',
    usedUrl: siteRun.usedUrl || '',
    via: siteRun.via || '',
    durationMs: Number(siteRun.durationMs || 0),
    warnings: Array.isArray(siteRun.warnings) ? siteRun.warnings : [],
    results: Array.isArray(siteRun.results) ? siteRun.results : []
  };
}

function rehydrateCachedExecution(cached, type) {
  const siteById = new Map(getSitesForType(type).map(site => [site.id, site]));
  const siteRuns = (cached.siteRuns || []).map(siteRun => {
    const site = siteById.get(siteRun.siteId) || {
      id: siteRun.siteId,
      describe: () => ({ name: siteRun.siteName || siteRun.siteId }),
      renderSection: () => {},
      collectJsonItems: (run, startIndex = 1) => {
        let index = startIndex;
        const items = (run.results || []).map(item => {
          const jsonItem = {
            index,
            site: siteRun.siteId,
            siteMode: type,
            siteName: siteRun.siteName,
            title: item.title || '',
            page: item.pageUrl || item.threadUrl || item.page || '',
            source: item.source || item.detailUrl || '',
            torrent: item.downloadUrl || item.torrentUrl || item.torrent || '',
            magnet: item.magnet || '',
            episode: Number(item.episode || item.episodeEnd || item.episodeStart || 0),
            episodeStart: Number(item.episodeStart || item.episode || 0),
            episodeEnd: Number(item.episodeEnd || item.episode || 0),
            isBatch: Boolean(item.episodeIsBatch),
            size: item.sizeText || item.sizeLabel || item.size || '',
            resolution: item.resolutionLabel || item.resolution || '',
            subtitle: item.hasChineseSubtitle ? '中字' : '未标注'
          };
          index += 1;
          return jsonItem;
        });
        return { items, nextIndex: index };
      }
    };
    return {
      ...siteRun,
      site,
      siteId: siteRun.siteId,
      siteMode: type,
      results: siteRun.results || [],
      warnings: [...(siteRun.warnings || []), '命中结构化结果缓存']
    };
  });

  return {
    searchType: type,
    siteRuns,
    crossSourceAliases: cached.crossSourceAliases || [],
    mergedItems: cached.mergedItems || [],
    rawResultCount: cached.rawResultCount || 0,
    uniqueResultCount: cached.uniqueResultCount || (cached.mergedItems || []).length,
    totalResults: cached.totalResults || (cached.mergedItems || []).length,
    durationMs: 0,
    fromCache: true,
    cacheAgeMs: cached.ageMs || 0
  };
}


function classifySiteRunOutcome(run) {
  const via = String(run && run.via || '');
  const warnings = (run && run.warnings) || [];
  const count = Array.isArray(run && run.results) ? run.results.length : 0;
  if (via === '超时' || /超时/.test(warnings.join(' '))) return { ok: false, reason: 'timeout' };
  if (via === '失败' || /执行失败|页面获取失败|验证页|challenge/i.test(warnings.join(' '))) {
    return { ok: false, reason: warnings[0] || via || 'failed' };
  }
  if (count > 0) return { ok: true, reason: 'results' };
  // empty but clean response is not a hard failure for circuit
  return { ok: true, reason: 'empty' };
}

function filterSitesBySource(sites) {
  if (!sourceFilter.length) return sites;
  const allow = new Set(sourceFilter);
  return sites.filter(site => allow.has(site.id));
}

function shouldSkipComplementarySite(site, siteRuns, type) {
  // 1LOU is complementary to BTBTLA: if BTBTLA already produced usable hits, skip 1LOU.
  if (site.id !== 'onelou') return false;
  if (!fastMode || sourceFilter.length > 0) return false;
  // Only explicit full/detail mode keeps both sources; --json alone should still allow skip.
  if (flagArgs.has('--full') || flagArgs.has('--detail') || flagArgs.has('--all')) return false;
  const bt = siteRuns.find(run => run.siteId === 'btbtla');
  if (!bt) return false;
  const results = bt.results || [];
  const count = results.length;
  if (count <= 0) return false;
  const hasDownloadable = results.some(item => item.magnet || item.downloadUrl || item.torrentUrl || item.torrent);
  // fast: any downloadable BTBTLA hit is enough; normal: >=3 downloadable or >=5 total
  if (fastMode) return hasDownloadable || count >= 1;
  return (hasDownloadable && count >= 3) || count >= 5;
}

async function executeSearch(type) {
  const searchStartedAt = timingStart();
  const cacheKey = buildSearchCacheKey(type);
  if (!noCache) {
    const cached = runtime.readSearchResultCache(cacheKey, { ttlMs: RESULT_CACHE_TTL_MS });
    if (cached && Array.isArray(cached.siteRuns) && cached.siteRuns.length > 0) {
      debugLog('resultCache.hit', { cacheKey, ageMs: cached.ageMs, total: cached.totalResults });
      const hydrated = rehydrateCachedExecution(cached, type);
      hydrated.durationMs = nowMs() - searchStartedAt;
      timingEnd(`search:${type}:cache`, searchStartedAt);
      return hydrated;
    }
  }

  let sites = getSitesForType(type);
  if (type === 'anime') {
    const preferred = ['mikan', 'nyaa', 'onelou', 'kpkuang', 'btbtla'];
    sites = preferred
      .map(id => sites.find(site => site.id === id))
      .filter(Boolean)
      .concat(sites.filter(site => !preferred.includes(site.id)));
  } else if (type === 'movie') {
    const preferred = ['btbtla', 'kpkuang', 'onelou', 'nyaa'];
    sites = preferred
      .map(id => sites.find(site => site.id === id))
      .filter(Boolean)
      .concat(sites.filter(site => !preferred.includes(site.id)));
  }
  sites = filterSitesBySource(sites);

  const siteRuns = [];
  publishProgress(siteRuns, type);

  for (const site of sites) {
    if (remainingBudgetMs() <= 0) {
        budgetExceeded = true;
        debugLog('budget.earlyReturn', { site: site.id, totalBudgetMs });
        break;
    }
    if (shouldSkipComplementarySite(site, siteRuns, type)) {
      const description = site.describe();
      siteRuns.push({
        siteName: description.name,
        usedUrl: '',
        usedQuery: query,
        via: '互补跳过',
        results: [],
        warnings: ['BTBTLA 结果已足够，1LOU 作为互补源已跳过'],
        site,
        siteId: site.id,
        siteMode: type,
        durationMs: 0
      });
      debugLog('complement.skip', { site: site.id, reason: 'btbtla-enough' });
      continue;
    }

    if (runtime.isSiteCircuitOpen(site.id)) {
      const health = runtime.getSiteHealth(site.id);
      const remainSec = Math.max(1, Math.ceil((health.openUntil - Date.now()) / 1000));
      const description = site.describe();
      siteRuns.push({
        siteName: description.name,
        usedUrl: '',
        usedQuery: query,
        via: '熔断',
        results: [],
        warnings: [`${description.name} 熔断中（约 ${remainSec}s），已跳过`],
        site,
        siteId: site.id,
        siteMode: type,
        durationMs: 0
      });
      debugLog('circuit.open', { site: site.id, remainSec, lastError: health.lastError });
      continue;
    }

    const siteStartedAt = timingStart();
    const abortSignal = createAbortSignal();
    const siteOverrides = {
        ...getSiteSearchOverrides(site),
        abortSignal,
        noCache
    };
    siteOverrides.siteTimeoutMs = Math.min(siteOverrides.siteTimeoutMs || 30000, remainingBudgetMs());
    siteOverrides.timeoutMs = Math.min(siteOverrides.timeoutMs || 30000, siteOverrides.siteTimeoutMs);
    if (siteOverrides.siteTimeoutMs > 0) {
        siteOverrides.deadlineAt = nowMs() + siteOverrides.siteTimeoutMs;
    }
    let run;
    try {
        const searchResult = await withTimeout(
        site.search(
            { query, queryContext, searchType: type, searchFilters },
            runtime,
            siteOverrides
        ),
        siteOverrides.siteTimeoutMs || 0,
        `site:${site.id}:${type}`
        );
        if (searchResult && searchResult.__timedOut) {
            abortSignal.abort(`site:${site.id}:${type}:timeout`);
            const description = site.describe();
            run = {
                siteName: description.name,
                usedUrl: '',
                usedQuery: query,
                via: '超时',
                results: [],
                warnings: [`${description.name} 搜索超时，已跳过`]
            };
        } else if (searchResult && searchResult.__failed) {
            throw searchResult.error;
        } else {
            run = searchResult;
        }
    } catch (error) {
        const description = site.describe();
        run = {
            siteName: description.name,
            usedUrl: '',
            usedQuery: query,
            via: '失败',
            results: [],
            warnings: [`${description.name} 执行失败: ${error.message}`]
        };
    }
    timingEnd(`site:${site.id}:${type}`, siteStartedAt);
    const durationMs = nowMs() - siteStartedAt;
    debugLog(`site:${site.id}`, {
        type,
        usedQuery: run.usedQuery || query,
        resultCount: (run.results || []).length,
        warnings: run.warnings || [],
        via: run.via || '',
        durationMs
    });

    const normalizedRun = {
        ...run,
        site,
        siteId: site.id,
        siteMode: type,
        durationMs,
        results: applySearchFilters(run.results || [], searchFilters).map(item => ({
            ...item,
            sourceLabel: item.sourceLabel || run.siteName
        }))
    };
    const outcome = classifySiteRunOutcome(normalizedRun);
    if (outcome.ok) {
      runtime.recordSiteSuccess(site.id);
    } else {
      const health = runtime.recordSiteFailure(site.id, outcome.reason, {
        threshold: SITE_CIRCUIT_THRESHOLD,
        openMs: SITE_CIRCUIT_OPEN_MS
      });
      if (health.openUntil > Date.now()) {
        normalizedRun.warnings = [
          ...(normalizedRun.warnings || []),
          `${normalizedRun.siteName || site.id} 连续失败，已熔断 5 分钟`
        ];
      }
      debugLog('circuit.failure', { site: site.id, failures: health.failures, reason: outcome.reason });
    }
    siteRuns.push(normalizedRun);
    publishProgress(siteRuns, type);

    if (fastMode && sourceFilter.length === 0) {
      const accumulated = siteRuns.flatMap(item => item.results || []);
      const strongDownloads = accumulated.filter(item =>
        (item.magnet || item.downloadUrl || item.torrentUrl)
        && ((item.resolutionRank || 0) >= 1080 || item.hasChineseSubtitle)
      );

      // Fast mode is first-screen oriented: after the two primary anime indexes,
      // or one strong domestic movie hit, avoid spending the remaining budget on deep sources.
      if (type === 'anime' && site.id === 'nyaa' && accumulated.length >= 10) {
        debugLog('fast.earlyStop', { type, site: site.id, resultCount: accumulated.length });
        break;
      }
      if (type === 'movie' && strongDownloads.length >= 1) {
        debugLog('fast.earlyStop', { type, site: site.id, strongDownloads: strongDownloads.length });
        break;
      }
    }
  }

  const crossSourceAliases = collectCrossSourceAliases(siteRuns);
  const aliasProbeCandidates = filterAliasProbeCandidates(crossSourceAliases, query);
  const expectedTerms = unique([query, ...aliasProbeCandidates]);
  debugLog('crossSource.aliasPool', aliasProbeCandidates);
  if (!showFullResults) {
    const primaryResultCount = siteRuns
      .filter(siteRun => siteRun.siteId !== 'kpkuang')
      .reduce((sum, siteRun) => sum + ((siteRun.results || []).length), 0);
    const shouldProbeKpkuangAlias = primaryResultCount <= 3 && aliasProbeCandidates.length > 0;
    const kpIndex = shouldProbeKpkuangAlias
      ? siteRuns.findIndex(siteRun => siteRun.siteId === 'kpkuang' && isKpkuangResultDirty(siteRun, expectedTerms))
      : -1;
    if (kpIndex >= 0) {
      const kpSite = siteRuns[kpIndex].site;
      for (const alias of aliasProbeCandidates.slice(0, 2)) {
        if (remainingBudgetMs() <= 0) { budgetExceeded = true; break; }
        const aliasAbortSignal = createAbortSignal();
        const aliasStartedAt = timingStart();
        let aliasRun;
          try {
            const aliasResult = await withTimeout(
            kpSite.search(
              {
                query: alias,
                queryContext: resolveQueryContext(alias),
                searchType: type,
                searchFilters
              },
              runtime,
              {
                ...getSiteSearchOverrides(kpSite),
                siteTimeoutMs: Math.min(FAST_SOURCE_TIMEOUT_MS, remainingBudgetMs()),
                deadlineAt: Math.min(commandDeadlineAt, nowMs() + FAST_SOURCE_TIMEOUT_MS),
                abortSignal: aliasAbortSignal
              }
            ),
            Math.min(FAST_SOURCE_TIMEOUT_MS, remainingBudgetMs()),
            `site:kpkuang:alias:${alias}`
          );
          if (aliasResult && aliasResult.__timedOut) {
            aliasAbortSignal.abort(`site:kpkuang:alias:${alias}:timeout`);
            aliasRun = {
              siteName: siteRuns[kpIndex].siteName,
              usedUrl: '',
              usedQuery: alias,
              via: '超时',
              results: [],
              warnings: [`KPkuang 别名补试超时: ${alias}`]
            };
          } else if (aliasResult && aliasResult.__failed) {
            throw aliasResult.error;
          } else {
            aliasRun = aliasResult;
          }
        } catch (error) {
          aliasRun = {
            siteName: siteRuns[kpIndex].siteName,
            usedUrl: '',
            usedQuery: alias,
            via: '失败',
            results: [],
            warnings: [`KPkuang 别名补试失败: ${error.message}`]
          };
        }
        timingEnd(`site:kpkuang:alias:${alias}`, aliasStartedAt);

        const normalizedAliasRun = {
          ...aliasRun,
          site: kpSite,
          siteId: kpSite.id,
          siteMode: type,
          durationMs: nowMs() - aliasStartedAt,
          results: applySearchFilters(aliasRun.results || [], searchFilters).map(item => ({
            ...item,
            sourceLabel: item.sourceLabel || aliasRun.siteName
          })),
          warnings: [...(aliasRun.warnings || []), `已通过跨源别名补试: ${alias}`]
        };

        if (!isKpkuangResultDirty(normalizedAliasRun, expectedTerms)) {
          siteRuns[kpIndex] = normalizedAliasRun;
          debugLog('crossSource.aliasHit', {
            site: 'kpkuang',
            alias,
            resultCount: normalizedAliasRun.results.length
          });
          break;
        }
      }
    }
  }

  const merged = mergeCrossSourceResults(siteRuns, {
    limit: explicitFull ? Math.max(MAX_RESULTS * 4, 50) : Math.max(MAX_RESULTS * 3, Math.max(MAX_RESULTS, 15))
  });
  const execution = {
    searchType: type,
    siteRuns,
    crossSourceAliases,
    mergedItems: merged.items,
    rawResultCount: merged.rawCount,
    uniqueResultCount: merged.uniqueCount,
    totalResults: merged.uniqueCount > 0
      ? merged.uniqueCount
      : siteRuns.reduce((sum, siteRun) => sum + (siteRun.results || []).length, 0),
    durationMs: nowMs() - searchStartedAt,
    fromCache: false
  };

  if (!noCache && execution.totalResults > 0) {
    try {
      runtime.writeSearchResultCache(cacheKey, {
        query,
        searchType: type,
        filters: searchFilters,
        fastMode,
        showFullResults,
        crossSourceAliases: execution.crossSourceAliases,
        mergedItems: execution.mergedItems,
        rawResultCount: execution.rawResultCount,
        uniqueResultCount: execution.uniqueResultCount,
        totalResults: execution.totalResults,
        siteRuns: siteRuns.map(sanitizeSiteRunForCache)
      });
      debugLog('resultCache.write', { cacheKey, total: execution.totalResults });
    } catch (error) {
      debugLog('resultCache.writeFailed', String(error && error.message || error));
    }
  }

  timingEnd(`search:${type}`, searchStartedAt);
  debugLog(`search:${type}:summary`, {
    totalResults: execution.totalResults,
    aliases: execution.crossSourceAliases,
    fromCache: false,
    sites: execution.siteRuns.map(siteRun => ({
      siteId: siteRun.siteId,
      resultCount: (siteRun.results || []).length,
      via: siteRun.via || ''
    }))
  });
  return execution;
}

function serializeExecution(execution, type) {
  const runs = [...new Set([...attemptedSiteRuns, ...(execution ? execution.siteRuns : [])])];
  return {
    query, requestedType: searchType, resolvedType: type, filters: searchFilters,
    totalResults: execution ? execution.totalResults : 0,
    rawResultCount: execution ? execution.rawResultCount || 0 : 0,
    uniqueResultCount: execution ? execution.uniqueResultCount || 0 : 0,
    fromCache: Boolean(execution && execution.fromCache),
    cacheAgeMs: execution ? execution.cacheAgeMs || 0 : 0,
    durationMs: nowMs() - commandStartedAt,
    budgetExceeded: budgetExceeded || remainingBudgetMs() <= 0,
    warnings: dependencyWarnings,
    options: { fastMode, noCache, noDeep, sourceFilter, timeoutMs: customTimeoutMs || 30000, limit: MAX_RESULTS },
    crossSourceAliases: execution ? execution.crossSourceAliases || [] : [],
    sites: summarizeSiteRuns(runs).map((summary, index) => ({
      ...summary,
      ...(explicitFull ? { items: runs[index].site.collectJsonItems(runs[index], 1).items.slice(0, 5) } : {})
    })),
    items: execution ? collectJsonItems(execution).slice(0, MAX_RESULTS) : []
  };
}

function publishProgress(siteRuns, type) {
  if (typeof process.send !== 'function' || !process.connected) return;
  const merged = mergeCrossSourceResults(siteRuns, { limit: MAX_RESULTS });
  const execution = { searchType: type, siteRuns, mergedItems: merged.items, rawResultCount: merged.rawCount,
    uniqueResultCount: merged.uniqueCount, totalResults: merged.uniqueCount };
  process.send({ kind: 'bt-progress', result: serializeExecution(execution, type) }, () => {});
}

function renderMergedItems(items, context = {}) {
  const list = items || [];
  if (list.length === 0) {
    console.log('🔗 暂无融合结果\n');
    return;
  }

  const limit = context.showFullResults ? Math.min(list.length, 20) : Math.min(list.length, MAX_RESULTS);
  console.log(`🔗 融合 Top ${limit}/${list.length}`);
  list.slice(0, limit).forEach((item, index) => {
    const chips = chipList([
      formatEpisodeChip(item),
      item.resolutionLabel && item.resolutionLabel !== '未知' ? item.resolutionLabel : '',
      item.sizeText && item.sizeText !== '未知' ? item.sizeText : '',
      item.hasChineseSubtitle ? '中字' : '',
      item.sourceLabel || '',
      Number.isFinite(item.score) ? `分${Math.round(item.score)}` : ''
    ]);
    console.log(`${index + 1}. ${shortTitle(item.title, 88)}`);
    if (chips) console.log(`   ${chips}`);
    if (item.magnet) console.log(`   磁力 ${item.magnet}`);
    else if (item.downloadUrl || item.torrentUrl) console.log(`   种子 ${item.downloadUrl || item.torrentUrl}`);
    else if (item.pageUrl) console.log(`   页面 ${item.pageUrl}`);
    console.log();
  });
  if (!context.showFullResults && list.length > limit) {
    console.log(`… 还有 ${list.length - limit} 条，发 --full 展开\n`);
  }
}

function renderExecution(execution) {
  const activeFilters = summarizeActiveFilters(searchFilters);
  const headerBits = [];
  if (activeFilters.length > 0) headerBits.push(`筛选 ${activeFilters.join('/')}`);
  if (execution.fromCache) {
    const ageSec = Math.max(0, Math.round((execution.cacheAgeMs || 0) / 1000));
    headerBits.push(`缓存 ${ageSec}s`);
  }
  if (execution.rawResultCount || execution.uniqueResultCount) {
    headerBits.push(`${execution.rawResultCount || 0}→${execution.uniqueResultCount || 0}`);
  }
  if (headerBits.length > 0) {
    console.log(`📌 ${headerBits.join(' · ')}\n`);
  }

  renderMergedItems(execution.mergedItems || [], {
    showFullResults: explicitFull
  });

  const siteSummary = renderSiteSummaryLine(execution.siteRuns || []);
  if (siteSummary) {
    console.log(`📡 ${siteSummary}`);
  }
  if (!explicitFull) {
    console.log('💡 默认只显示融合结果；需要分站明细请加 --full\n');
  } else {
    console.log();
    renderGlobalRecommendations(execution.siteRuns, { showFullResults: true });
    for (const siteRun of execution.siteRuns) {
      siteRun.site.renderSection(siteRun, {
        query,
        showFullResults: true,
        maxResults: MAX_RESULTS
      });
    }
  }
}

function collectJsonItems(execution) {
  const mergedItems = execution.mergedItems || [];
  if (mergedItems.length > 0) {
    const limited = explicitFull ? mergedItems : mergedItems.slice(0, MAX_RESULTS);
    return limited.map((item, idx) => ({
      index: idx + 1,
      site: 'merged',
      siteMode: execution.searchType,
      siteName: item.sourceLabel || '跨源融合',
      title: item.title || '',
      page: item.pageUrl || '',
      source: (item.sources || []).join(','),
      torrent: item.downloadUrl || item.torrentUrl || '',
      magnet: item.magnet || '',
      episode: Number(item.episode || item.episodeEnd || item.episodeStart || 0),
      episodeStart: Number(item.episodeStart || item.episode || 0),
      episodeEnd: Number(item.episodeEnd || item.episode || 0),
      isBatch: Boolean(item.episodeIsBatch),
      size: item.sizeText || item.sizeLabel || '',
      resolution: item.resolutionLabel || item.resolution || '',
      subtitle: item.hasChineseSubtitle ? '中字' : '未标注',
      score: Math.round(item.score || 0),
      sources: item.sources || []
    }));
  }

  const items = [];
  let index = 1;
  for (const siteRun of execution.siteRuns) {
    const collected = siteRun.site.collectJsonItems(siteRun, index);
    items.push(...collected.items);
    index = collected.nextIndex;
  }
  return items;
}

const searchOrder = typeExplicitlyProvided
  ? [searchType]
  : [searchType, ...VALID_TYPES.filter(type => type !== searchType)];

const rolloutStartedAt = timingStart();

(async () => {
  let finalExecution = null;
  let finalType = searchType;

  for (const [index, currentType] of searchOrder.entries()) {
    if (remainingBudgetMs() <= 0) { budgetExceeded = true; break; }
    if (!outputJson) {
      if (index > 0) {
        console.log(`🔁 自动重试类型: ${currentType}`);
      }
      if (index === 0) {
        console.log(`\n🔎 ${query}`);
        if (!typeExplicitlyProvided) {
          console.log(`类型自动: ${searchType}`);
        }
        console.log();
      }
      console.log(`${getSearchTypeBanner(currentType)}\n`);
    }

    const execution = await executeSearch(currentType);
    if (outputJson) {
      finalExecution = execution;
      finalType = currentType;
    } else {
      renderExecution(execution);
    }

    if (execution.totalResults > 0 || typeExplicitlyProvided) {
      finalExecution = execution;
      finalType = currentType;
      break;
    }
    if (index < searchOrder.length - 1) attemptedSiteRuns.push(...execution.siteRuns);

    if (!outputJson) {
      console.log('未命中结果，继续尝试其他类型...\n');
    }
  }

  if (outputJson) {
    const payload = serializeExecution(finalExecution, finalType);
    console.log(JSON.stringify(payload, null, 2));
    if (typeof process.send === 'function' && process.connected) {
      await new Promise(resolve => process.send({ kind: 'bt-complete', result: payload }, resolve));
    }
    timingEnd('bt:total', rolloutStartedAt);
    return;
  }

  // tip omitted in compact TG mode
  timingEnd('bt:total', rolloutStartedAt);
})().catch(error => {
  timingEnd('bt:total', typeof rolloutStartedAt === 'number' ? rolloutStartedAt : nowMs());
  console.error(`BT 搜索失败: ${error.message}`);
  process.exitCode = 1;
}).finally(async () => {
  if (!process.connected && runtime && typeof runtime.close === 'function') {
    await runtime.close();
  }
  // Timed-out HTTP probes must not keep this isolated command alive.
  process.stdout.write('', () => {
    if (process.connected) setTimeout(() => process.exit(process.exitCode || 0), 5000);
    else process.exit(process.exitCode || 0);
  });
});
