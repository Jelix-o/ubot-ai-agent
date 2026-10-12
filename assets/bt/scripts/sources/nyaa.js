const {
  createTrackerSite,
  parseStandardTrackerRows,
  normalizeStandardTrackerResult
} = require('../lib/tracker-site');
const { normalizeQuery, stripYearTokens } = require('../lib/query-utils');

const DEFAULT_CONFIG = {
  id: 'nyaa',
  name: 'Nyaa',
  baseUrl: 'https://nyaa.net/',
  maxResults: 20,
  categoriesByType: {
    anime: ['1_0', '0_0'],
    movie: ['4_0', '0_0']
  },
  capabilities: {
    searchTypes: ['anime', 'movie'],
    hasMagnet: true,
    hasTorrent: true,
    hasScreenshots: false,
    queryBuilder: 'queryVariants'
  }
};

function parseSearchResults(html, baseUrl, config) {
  return parseStandardTrackerRows(html, config.maxResults);
}

function normalizeSearchResult(rawResult, baseUrl) {
  return normalizeStandardTrackerResult(rawResult, baseUrl);
}

function normalizeText(value) {
  return normalizeQuery(String(value || '')).toLowerCase();
}

function normalizeLeadingTitle(value) {
  return normalizeText(value)
    .replace(/^(?:\[[^\]]+\]|【[^】]+】|\([^)]*\)|（[^）]*）)\s*/g, '')
    .replace(/^(?:[-|:]+\s*)+/g, '')
    .trim();
}

function hasCjk(value) {
  return /[\u3400-\u9fff]/.test(String(value || ''));
}

function isRelevantMovieResult(item, context) {
  const query = String(context?.query || '');
  const queryContext = context?.queryContext || {};
  const normalizedTitle = normalizeText(item?.title || '');
  const normalizedLeadingTitle = normalizeLeadingTitle(item?.title || '');
  const directVariants = (queryContext.queryVariants || [query]).map(normalizeText).filter(Boolean);
  const relaxedVariants = (queryContext.yearRelaxedQueryVariants || [stripYearTokens(query)]).map(normalizeText).filter(Boolean);
  const cjkVariants = directVariants.filter(hasCjk);

  if (cjkVariants.length > 0) {
    if (cjkVariants.some(variant => normalizedLeadingTitle.startsWith(variant))) return true;
    return false;
  }

  if (directVariants.some(variant => !hasCjk(variant) && normalizedTitle.includes(variant))) return true;
  if (relaxedVariants.some(variant => variant && normalizedTitle.includes(variant))) return true;
  return false;
}

async function enrichSearchRun(run, { context }) {
  if (context.searchType !== 'movie' || !hasCjk(context.query)) {
    return run;
  }

  const filteredResults = (run.results || []).filter(item => isRelevantMovieResult(item, context));
  if (filteredResults.length > 0) {
    return {
      ...run,
      results: filteredResults
    };
  }

  return {
    ...run,
    results: [],
    warnings: [...(run.warnings || []), 'Nyaa 已过滤与中文影视关键词无关的结果']
  };
}

const defaultSite = createTrackerSite({
  defaultConfig: DEFAULT_CONFIG,
  parseSearchResults,
  normalizeSearchResult,
  enrichSearchRun
});
defaultSite.__test = { parseSearchResults, normalizeSearchResult, isRelevantMovieResult };
module.exports = defaultSite;
