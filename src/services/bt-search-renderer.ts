import type { BtSearchItem, BtSearchRequest, BtSearchResult } from "./bt-search-service.js";

/** Escape literal CQ delimiters while preserving the decoded text and URLs. */
export function escapeBtText(text: string): string {
  return text.replace(/&/gu, "&amp;").replace(/\[/gu, "&#91;").replace(/\]/gu, "&#93;");
}
export function btHelp(primary = "#bt"): string {
  return [
    "BT 资源搜索（动漫 / 影视 / 成人）",
    `${primary} <关键词> [anime|movie|adult]`,
    "默认尽量搜全，展示前 5 条；完整搜索最多约 3 分钟。",
    "--fast 快速搜索 · --full / --detail 更多结果及分站详情",
    "--source mikan,nyaa,btbtla,onelou,kpkuang,sukebei",
    "--timeout 8s 单站超时 · --limit 1～20 结果条数",
    "--no-cache 重抓 · --no-deep 浅抓 · --json 结构化结果 · --debug 站点诊断",
    `例如：${primary} 葬送的芙莉莲 anime --fast`,
  ].join("\n");
}

function renderItem(item: BtSearchItem, index: number): string {
  const episode = item.episodeStart > 0 ? (item.episodeEnd > item.episodeStart ? `第${item.episodeStart}～${item.episodeEnd}集` : `第${item.episodeStart}集`) : "";
  return [`${index}. ${item.title}`, [episode, item.isBatch ? "合集" : "", item.resolution || "清晰度未标注", item.size || "体积未标注", item.subtitle || "字幕未标注", item.sources.join(" / ") || "来源未标注"].filter(Boolean).join(" · "),
    ...(item.magnet ? [item.magnet] : []), ...(item.torrent ? [`种子：${item.torrent}`] : []),
    ...(item.page ? [`页面：${item.page}`] : []),
  ].filter(Boolean).join("\n");
}

/** Pack complete result blocks; never cut a magnet or torrent URL. */
export function renderBtSearchMessages(result: BtSearchResult, request: BtSearchRequest): string[] {
  if (request.json) {
    // Each JSON message is independently valid, with whole result entries.
    return [JSON.stringify({ ...result, items: [], sites: [] }, null, 2),
      ...result.sites.map(({ items: _items, ...site }) => JSON.stringify({ query: result.query, site }, null, 2)),
      ...result.items.map((item, index) => JSON.stringify({ query: result.query, index: index + 1, item }, null, 2)),
    ].map(escapeBtText);
  }
  const type = { anime: "动漫", movie: "影视", adult: "成人" }[result.resolvedType];
  const blocks = [`BT 搜索：${result.query}（${type}）\n${result.rawResultCount} 条原始结果 → ${result.uniqueResultCount} 条去重结果 · ${Math.round(result.durationMs / 1000)} 秒${result.fromCache ? " · 缓存命中" : ""}`];
  if (!result.items.length) {
    const warnings = [...result.warnings, ...result.sites.flatMap((site) => site.warnings)].join(" ");
    blocks.push(/依赖|curl_cffi.*(?:不可用|missing|installed)/iu.test(warnings) ? "抓取依赖缺失，部分来源暂不可用。" :
      /验证页|challenge|Cloudflare/iu.test(warnings) ? "来源返回了验证页，暂未取得可用结果。" :
      result.budgetExceeded || /超时|timeout/iu.test(warnings) ? "搜索超时，暂未取得可用结果。" : "未找到匹配资源，请换个关键词或指定类型。" );
  }
  blocks.push(...result.items.map((item, index) => renderItem(item, index + 1)));
  if (result.budgetExceeded) blocks.push("已到搜索时限，以上为已取得的结果。");
  blocks.push(...result.warnings);
  blocks.push(`来源：${result.sites.map((site) => `${site.siteName}:${site.resultCount || site.via || "无结果"}`).join(" · ")}`);
  if (request.full || request.debug) {
    for (const site of result.sites) {
      blocks.push(`${site.siteName}：${site.resultCount} 条 · ${site.via} · ${Math.round(site.durationMs / 1000)} 秒\n${site.warnings.join("\n")}`);
      if (request.full) blocks.push(...(site.items ?? []).map((item, index) => `${site.siteName} ${renderItem(item, index + 1)}`));
    }
  }
  const messages: string[] = [];
  for (const block of blocks.filter(Boolean).map(escapeBtText)) {
    const previous = messages.at(-1);
    if (previous && previous.length + block.length + 2 <= 1800) messages[messages.length - 1] = `${previous}\n\n${block}`;
    else messages.push(block);
  }
  return messages;
}
