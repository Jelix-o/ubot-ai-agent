const { extractImageUrls } = require('../lib/html-utils');
const {
  createTrackerSite,
  parseStandardTrackerRows,
  normalizeStandardTrackerResult
} = require('../lib/tracker-site');

const DEFAULT_CONFIG = {
  id: 'sukebei',
  name: 'Sukebei',
  baseUrl: 'https://sukebei.nyaa.net/',
  maxResults: 20,
  screenshotLimit: 5,
  requestOptions: {
    timeoutMs: 7000,
    transportOrder: ['curl_cffi']
  },
  categoriesByType: {
    adult: ['2_2', '0_0']
  },
  capabilities: {
    searchTypes: ['adult'],
    hasMagnet: true,
    hasTorrent: true,
    hasScreenshots: true,
    queryBuilder: 'queryVariants'
  }
};

async function fetchScreenshots(viewUrl, runtime, config) {
  const response = await runtime.fetchUrl(viewUrl);
  if (!response.ok || !response.text) return [];
  return extractImageUrls(response.text, config.screenshotLimit, viewUrl);
}

function parseSearchResults(html, baseUrl, config) {
  return parseStandardTrackerRows(html, config.maxResults);
}

function normalizeSearchResult(rawResult, baseUrl) {
  return normalizeStandardTrackerResult(rawResult, baseUrl);
}

async function enrichSearchRun(run, { runtime, config }) {
  if (run.results[0] && run.results[0].pageUrl) {
    run.results[0].screenshots = await fetchScreenshots(run.results[0].pageUrl, runtime, config);
  }
  return run;
}

const defaultSite = createTrackerSite({
  defaultConfig: DEFAULT_CONFIG,
  parseSearchResults,
  normalizeSearchResult,
  enrichSearchRun
});
defaultSite.__test = { parseSearchResults, normalizeSearchResult };
module.exports = defaultSite;
