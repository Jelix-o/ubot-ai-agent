const { compareMediaResults, sortMediaResults } = require('./media-utils');

const COMPACT_RENDER_HINT = '🪶 默认极简显示；加 --full 可展开三种排序和完整明细';

function formatDigestLine(label, item) {
  if (!item) return '';
  const bits = [];
  if (item.episodeEnd) {
    bits.push(`第${item.episodeStart === item.episodeEnd ? item.episodeEnd : `${item.episodeStart}-${item.episodeEnd}`}集`);
  }
  if (item.resolutionLabel && item.resolutionLabel !== '未知') bits.push(item.resolutionLabel);
  if (item.sizeLabel && item.sizeLabel !== '未知') bits.push(item.sizeLabel);
  if (item.hasChineseSubtitle) bits.push('中字');
  return `- ${label}: ${item.title}${bits.length ? `（${bits.join(' / ')}）` : ''}`;
}

function buildQuickDigest(items, sourceKind) {
  if (!items || items.length === 0) return [];

  const sorted = sortMediaResults(items);
  const latest = sorted[0] || null;
  const subtitlePool = sorted.filter(item => item.hasChineseSubtitle);
  const recommendPool = subtitlePool.length > 0 ? subtitlePool : sorted;
  const recommended = recommendPool[0] || null;
  const smallest =
    [...recommendPool]
      .filter(item => Number.isFinite(item.sizeBytes))
      .sort((a, b) => (a.sizeBytes || Number.POSITIVE_INFINITY) - (b.sizeBytes || Number.POSITIVE_INFINITY))[0]
    || null;
  const hdPref =
    [...recommendPool]
      .filter(item => (item.resolutionRank || 0) >= 1080)
      .sort(compareMediaResults)[0]
    || null;
  const lines = [];

  if (latest) lines.push(formatDigestLine('最新', latest));
  if (recommended && recommended !== latest) lines.push(formatDigestLine('推荐', recommended));
  if (hdPref && hdPref !== latest && hdPref !== recommended) {
    lines.push(formatDigestLine(sourceKind === 'btbtla' ? '高清优先' : '高质量', hdPref));
  }
  if (smallest && ![latest, recommended, hdPref].includes(smallest)) {
    lines.push(formatDigestLine('最省空间', smallest));
  }
  return lines;
}

function buildVariantLabel(item) {
  const bits = [];
  if (item.resolutionLabel && item.resolutionLabel !== '未知') bits.push(item.resolutionLabel);
  const merged = [item.title, item.torrentName, item.waterMark].filter(Boolean).join(' ');
  if (/HDR/i.test(merged)) bits.push('HDR');
  if (/杜比视界|\bDV\b/i.test(merged)) bits.push('DV');
  if (/高码|HQ/i.test(merged)) bits.push('高码');
  if (item.hasChineseSubtitle) bits.push('中字');
  if (item.sizeLabel && item.sizeLabel !== '未知') bits.push(item.sizeLabel);
  return bits.join(' / ');
}

function buildGroupedVariantDigest(items) {
  if (!items || items.length === 0) return [];

  const groups = new Map();
  for (const item of sortMediaResults(items)) {
    if (!item.episodeEnd) continue;
    const baseTitle = (item.pageTitle || item.title || '').trim();
    const episodeLabel =
      item.episodeStart === item.episodeEnd
        ? `第${item.episodeEnd}集`
        : `第${item.episodeStart}-${item.episodeEnd}集`;
    const key = `${baseTitle}##${episodeLabel}`;
    if (!groups.has(key)) {
      groups.set(key, {
        title: baseTitle,
        episodeLabel,
        items: []
      });
    }
    groups.get(key).items.push(item);
  }

  return [...groups.values()]
    .sort((a, b) => (b.items[0]?.episodeEnd || 0) - (a.items[0]?.episodeEnd || 0))
    .slice(0, 3)
    .map(group => ({
      label: `${group.title} ${group.episodeLabel}`.trim(),
      variants: group.items.slice(0, 3).map(item => ({
        label: buildVariantLabel(item),
        magnet: item.magnet || '',
        torrent: item.downloadUrl || ''
      }))
    }));
}

function choosePreferred(items, predicate, comparator) {
  return items.filter(predicate).sort(comparator)[0] || null;
}

function withSubtitlePreference(items, requireDownload = false) {
  const base = requireDownload ? items.filter(item => item.downloadUrl || item.torrentUrl) : [...items];
  const subtitleItems = base.filter(item => item.hasChineseSubtitle);
  return subtitleItems.length > 0 ? subtitleItems : base;
}

function compareNewestThenBigger(a, b) {
  const timeDiff = (b.timeValue || 0) - (a.timeValue || 0);
  if (timeDiff !== 0) return timeDiff;
  return (b.sizeBytes || 0) - (a.sizeBytes || 0);
}

function compareSmallestThenNewest(a, b) {
  const sizeDiff = (a.sizeBytes || Number.POSITIVE_INFINITY) - (b.sizeBytes || Number.POSITIVE_INFINITY);
  if (sizeDiff !== 0) return sizeDiff;
  return (b.timeValue || 0) - (a.timeValue || 0);
}

function compareSeedersThenNewest(a, b) {
  const seedDiff = (b.seedersValue || 0) - (a.seedersValue || 0);
  if (seedDiff !== 0) return seedDiff;
  return (b.timeValue || 0) - (a.timeValue || 0);
}

function buildRecommendationEntries(pool, specs) {
  return specs
    .map(spec => ({
      key: spec.key,
      item: choosePreferred(pool, spec.predicate, spec.comparator)
    }))
    .filter(entry => entry.item);
}

function buildTrackerRecommendations(items) {
  const pool = withSubtitlePreference(items, false);
  return buildRecommendationEntries(pool, [
    { key: '高做种', predicate: () => true, comparator: compareSeedersThenNewest },
    {
      key: '最新',
      predicate: item => item.timeValue > 0,
      comparator: (a, b) => compareNewestThenBigger(a, b) || ((b.seedersValue || 0) - (a.seedersValue || 0))
    },
    {
      key: '体积最小',
      predicate: item => Number.isFinite(item.sizeBytes),
      comparator: (a, b) => compareSmallestThenNewest(a, b) || ((b.seedersValue || 0) - (a.seedersValue || 0))
    }
  ]);
}

function buildBtbtlaRecommendations(items) {
  const pool = withSubtitlePreference(items, true);
  return buildRecommendationEntries(pool, [
    { key: '4K优先', predicate: item => item.resolutionRank >= 2160, comparator: compareNewestThenBigger },
    { key: '1080P优先', predicate: item => item.resolutionRank === 1080, comparator: compareNewestThenBigger },
    { key: '体积最小', predicate: item => Number.isFinite(item.sizeBytes), comparator: compareSmallestThenNewest }
  ]);
}

function getDisplayLimit(showFullResults, maxResults) {
  return showFullResults ? Math.max(1, maxResults) : 0;
}

function shortTitle(title, maxLen = 72) {
  const text = String(title || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 1)}…`;
}

function chipList(parts) {
  return (parts || []).filter(Boolean).join(' · ');
}

function formatEpisodeChip(item) {
  const start = Number(item.episodeStart || item.episode || 0);
  const end = Number(item.episodeEnd || item.episode || 0);
  if (!end && !start) return '';
  if (start && end && start !== end) return `EP${start}-${end}`;
  return `EP${end || start}`;
}

function renderSiteSummaryLine(siteRuns) {
  const parts = (siteRuns || []).map(run => {
    const count = Array.isArray(run.results) ? run.results.length : 0;
    const via = run.via || '';
    if (via === '互补跳过') return `${run.siteName || run.siteId}:跳过`;
    if (via === '熔断') return `${run.siteName || run.siteId}:熔断`;
    if (via === '超时') return `${run.siteName || run.siteId}:超时`;
    if (via === '失败') return `${run.siteName || run.siteId}:失败`;
    return `${run.siteName || run.siteId}:${count}`;
  });
  return parts.join(' · ');
}

function renderCompactHintIfNeeded(showFullResults) {
  if (!showFullResults) {
    console.log(`${COMPACT_RENDER_HINT}\n`);
  }
}

function buildGlobalRecommendations(siteRuns) {
  const allResults = (siteRuns || []).flatMap(run => run.results || []);
  if (allResults.length === 0) return [];

  const pool = withSubtitlePreference(allResults, false);
  return buildRecommendationEntries(pool, [
    { key: '🌟 全局首选', predicate: () => true, comparator: compareMediaResults },
    { key: '📺 4K/2160P', predicate: item => item.resolutionRank >= 2160, comparator: compareMediaResults },
    { key: '🎬 1080P/高清', predicate: item => item.resolutionRank === 1080, comparator: compareMediaResults },
    { key: '💾 最省空间', predicate: item => Number.isFinite(item.sizeBytes), comparator: compareSmallestThenNewest }
  ]);
}

function renderGlobalRecommendations(siteRuns, options = {}) {
  if (!options.showFullResults) return;
  const recommendations = buildGlobalRecommendations(siteRuns);
  if (recommendations.length === 0) return;

  console.log('🏆 全局推荐');
  recommendations.forEach(entry => {
    const item = entry.item;
    const chips = chipList([
      formatEpisodeChip(item),
      item.resolutionLabel && item.resolutionLabel !== '未知' ? item.resolutionLabel : '',
      item.sizeLabel && item.sizeLabel !== '未知' ? item.sizeLabel : '',
      item.hasChineseSubtitle ? '中字' : '',
      item.sourceLabel || item.source || ''
    ]);
    console.log(`• ${entry.key}`);
    console.log(`  ${shortTitle(item.title, 80)}`);
    if (chips) console.log(`  ${chips}`);
    const link = item.magnet || item.downloadUrl || item.torrentUrl || item.pageUrl || '';
    if (link) console.log(`  ${link}`);
  });
  console.log();
}

function renderTrackerItem(item, index) {
  console.log(`${index + 1}. ${shortTitle(item.title, 90)}`);
  const chips = chipList([
    formatEpisodeChip(item),
    item.resolutionLabel && item.resolutionLabel !== '未知' ? item.resolutionLabel : '',
    item.sizeLabel && item.sizeLabel !== '未知' ? item.sizeLabel : '',
    item.hasChineseSubtitle ? '中字' : '',
    item.seeders ? `↑${item.seeders}` : '',
    item.time || ''
  ]);
  if (chips) console.log(`   ${chips}`);
  if (item.magnet) console.log(`   磁力 ${item.magnet}`);
  else if (item.torrentUrl) console.log(`   种子 ${item.torrentUrl}`);
  else if (item.pageUrl) console.log(`   页面 ${item.pageUrl}`);
  console.log();
}

function renderTrackerSection(run, context) {
  const results = run.results || [];
  if (!context.showFullResults) return;

  console.log(`📦 ${run.siteName} · ${results.length} 条${run.via ? ` · ${run.via}` : ''}`);
  if (run.usedQuery && run.usedQuery !== context.query) {
    console.log(`匹配: ${run.usedQuery}`);
  }

  if (results.length === 0) {
    console.log('未找到结果');
    (run.warnings || []).forEach(message => console.log(`- ${message}`));
    console.log();
    return;
  }

  const quickDigest = buildQuickDigest(results, 'tracker');
  if (quickDigest.length > 0) {
    console.log('速览');
    quickDigest.forEach(line => console.log(line));
    console.log();
  }

  const recommendations = buildTrackerRecommendations(results);
  if (recommendations.length > 0) {
    console.log('排序');
    recommendations.forEach(entry => {
      console.log(`- ${entry.key}: ${shortTitle(entry.item.title, 70)}`);
    });
    console.log();
  }

  const displayResults = results.slice(0, getDisplayLimit(true, context.maxResults));
  displayResults.forEach(renderTrackerItem);

  (run.warnings || []).forEach(message => console.log(`- ${message}`));
  if ((run.warnings || []).length > 0) console.log();
}

function renderBtbtlaItem(item, index) {
  console.log(`${index + 1}. ${shortTitle(item.title, 90)}`);
  const chips = chipList([
    formatEpisodeChip(item),
    item.resolutionLabel && item.resolutionLabel !== '未知' ? item.resolutionLabel : '',
    item.sizeLabel && item.sizeLabel !== '未知' ? item.sizeLabel : '',
    item.hasChineseSubtitle ? '中字' : '',
    item.time || '',
    item.forum || ''
  ]);
  if (chips) console.log(`   ${chips}`);
  if (item.magnet) console.log(`   磁力 ${item.magnet}`);
  else if (item.downloadUrl) console.log(`   种子 ${item.downloadUrl}`);
  else if (item.threadUrl) console.log(`   详情 ${item.threadUrl}`);
  console.log();
}

function renderForumTorrentSection(run, context, options = {}) {
  const title = options.title || '🎞️ BTBTLA';
  const digestKey = options.digestKey || 'btbtla';
  const results = run.results || [];
  if (!context.showFullResults) return;

  console.log(`${title} · ${results.length} 条${run.via ? ` · ${run.via}` : ''}`);
  if (run.usedQuery && run.usedQuery !== context.query) {
    console.log(`匹配: ${run.usedQuery}`);
  }

  if (results.length === 0) {
    console.log('未找到可解析结果');
    (run.warnings || []).forEach(message => console.log(`- ${message}`));
    console.log();
    return;
  }

  const quickDigest = buildQuickDigest(results, digestKey);
  if (quickDigest.length > 0) {
    console.log('速览');
    quickDigest.forEach(line => console.log(line));
    console.log();
  }

  const recommendations = buildBtbtlaRecommendations(results);
  if (recommendations.length > 0) {
    console.log('排序');
    recommendations.forEach(entry => {
      console.log(`- ${entry.key}: ${shortTitle(entry.item.title, 70)}`);
    });
    console.log();
  }

  const displayResults = results.slice(0, getDisplayLimit(true, context.maxResults));
  displayResults.forEach(renderBtbtlaItem);

  (run.warnings || []).forEach(message => console.log(`- ${message}`));
  if ((run.warnings || []).length > 0) console.log();
}

function renderBtbtlaSection(run, context) {
  renderForumTorrentSection(run, context, {
    title: '🎞️ BTBTLA',
    digestKey: 'btbtla'
  });
}

function renderOnelouSection(run, context) {
  renderForumTorrentSection(run, context, {
    title: '📦 1LOU',
    digestKey: 'onelou'
  });
}

module.exports = {
  buildGlobalRecommendations,
  renderGlobalRecommendations,
  renderTrackerSection,
  renderBtbtlaSection,
  renderOnelouSection,
  renderSiteSummaryLine,
  shortTitle,
  chipList,
  formatEpisodeChip
};
