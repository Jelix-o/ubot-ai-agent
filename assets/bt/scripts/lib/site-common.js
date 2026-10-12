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

async function mapLimit(items, limit, mapper) {
  return mapLimitUntil(items, limit, mapper, null);
}

function isLikelyChallenge(html) {
  const text = String(html || '');
  const normalized = text.toLowerCase();
  return (
    normalized.includes('just a moment')
    || normalized.includes('verify you are human')
    || normalized.includes('performing security verification')
    || /challenge-platform|cf-browser-verification|turnstile/i.test(text)
  );
}

function humanizeNetworkFailure(siteName, page = {}) {
  switch (page.reason) {
    case 'cache_miss':
      return `${siteName} 当前处于冷却期，且本地暂无可用缓存`;
    case 'stale_cache':
      return `${siteName} 直连失败，已回退到过期缓存结果`;
    case 'challenge':
      return `${siteName} 触发 Cloudflare / 验证页，当前抓取失败`;
    case 'timeout':
      return `${siteName} 页面抓取超时`;
    case 'aborted':
      return `${siteName} 搜索已中止`;
    default:
      return `${siteName} 页面获取失败`;
  }
}

function resolveDeepBudget(config, overrides = {}, context = {}) {
  const noDeep = Boolean(overrides.noDeep || config.noDeep);
  const fastMode = Boolean(overrides.fastMode || config.fastMode);
  const isFastAnime = fastMode && context.searchType === 'anime';
  if (noDeep) {
    return {
      noDeep: true,
      fastMode,
      expandLimit: 0,
      detailLimit: 0,
      resultLimit: config.pageLimit || config.searchResultLimit || 20
    };
  }
  const expandLimit = isFastAnime
    ? (config.fastAnimeExpandLimit || config.fastExpandLimit || config.expandLimit)
    : (fastMode ? (config.fastExpandLimit || config.expandLimit) : config.expandLimit);
  const detailLimit = isFastAnime
    ? (config.fastAnimeDetailLimit || config.fastDetailLimit || config.detailLimit)
    : (fastMode ? (config.fastDetailLimit || config.detailLimit) : config.detailLimit);
  return {
    noDeep: false,
    fastMode,
    expandLimit: expandLimit || 0,
    detailLimit: detailLimit || 0,
    resultLimit: isFastAnime
      ? (config.fastAnimeResultLimit || config.pageLimit || 12)
      : (config.pageLimit || config.searchResultLimit || 20)
  };
}

module.exports = {
  isAborted,
  isPastDeadline,
  shouldStopWork,
  mapLimit,
  mapLimitUntil,
  isLikelyChallenge,
  humanizeNetworkFailure,
  resolveDeepBudget
};
