import type { ForwardMessageNode } from "../forward-message.js";
import type { BtSearchItem, BtSearchRequest, BtSearchResult } from "./bt-search-service.js";

export const BT_ADULT_CONTENT_WARNING = "【成人内容提示】含成人向资源，仅限成年人查看；请注意隐私并遵守当地法律。";

/** Used only for ordinary string messages; forward text segments stay literal. */
export function escapeBtText(text: string): string {
  return text.replace(/&/gu, "&amp;").replace(/\[/gu, "&#91;").replace(/\]/gu, "&#93;");
}

export function btHelp(primary = "#bt", full = false): string {
  const brief = [
    `${primary} <关键词> [anime|movie|adult]`,
    "默认展示前 5 条，点击合并转发卡片查看完整下载链接。",
    `例如：${primary} 葬送的芙莉莲 anime --fast`,
    `完整参数：${primary} --help`,
  ];
  return (full ? [...brief,
    "完整搜索最多约 3 分钟；--fast 快速搜索。",
    "--full / --detail 更多结果与分站详情 · --limit 1～20",
    "--source mikan,nyaa,btbtla,onelou,kpkuang,sukebei",
    "--timeout 8s 单站超时 · --no-cache 重抓 · --no-deep 浅抓",
    "--json 结构化结果 · --debug 站点诊断",
  ] : brief).join("\n");
}

export function btEmptyResultMessage(result: BtSearchResult): string {
  const warnings = [...result.warnings, ...result.sites.flatMap(site => site.warnings)].join(" ");
  return /依赖|curl_cffi.*(?:不可用|missing|installed)/iu.test(warnings) ? "抓取依赖缺失，部分来源暂不可用。" :
    /验证页|challenge|Cloudflare/iu.test(warnings) ? "来源返回了验证页，暂未取得可用结果。" :
    result.budgetExceeded || /超时|timeout/iu.test(warnings) ? "搜索超时，暂未取得可用结果。" :
    "未找到匹配资源，请换个关键词或指定类型。";
}

function renderItem(item: BtSearchItem, index: number): string {
  const episode = item.episodeStart > 0 ? (item.episodeEnd > item.episodeStart ? `第${item.episodeStart}～${item.episodeEnd}集` : `第${item.episodeStart}集`) : "";
  return [`${index}. ${item.title}`,
    [episode, item.isBatch ? "合集" : "", item.resolution || "清晰度未标注", item.size || "体积未标注", item.subtitle || "字幕未标注", item.sources.join(" / ") || "来源未标注"].filter(Boolean).join(" · "),
    ...(item.magnet ? ["磁力（完整链接）：", item.magnet] : []),
    ...(item.torrent ? ["种子：", item.torrent] : []),
    ...(item.page ? ["页面：", item.page] : []),
  ].join("\n");
}

/** All result entries travel in one card; links are never decoded or cut. */
export function renderBtForwardNodes(result: BtSearchResult, request: BtSearchRequest, senderId: string): ForwardMessageNode[] {
  const type = { anime: "动漫", movie: "影视", adult: "成人" }[result.resolvedType];
  // Diagnostic cards for an empty adult query are not adult resource cards.
  // They must not carry the warning or become candidates for silent recall.
  const isAdultResourceCard = result.resolvedType === "adult" && result.items.length > 0;
  const blocks = [`${isAdultResourceCard ? `${BT_ADULT_CONTENT_WARNING}\n` : ""}【BT 搜索】${result.query}（${type}）\n共 ${result.uniqueResultCount} 条资源 · 展示 ${result.items.length} 条 · ${Math.round(result.durationMs / 1000)} 秒${result.fromCache ? " · 缓存命中" : ""}\n点击查看完整下载链接。`];
  if (request.json) {
    blocks.push(JSON.stringify({ ...result, items: [], sites: [] }, null, 2),
      ...result.sites.map(({ items: _items, ...site }) => JSON.stringify({ query: result.query, site }, null, 2)),
      ...result.items.map((item, index) => JSON.stringify({ query: result.query, index: index + 1, item }, null, 2)));
  } else {
    if (!result.items.length) blocks.push(btEmptyResultMessage(result));
    blocks.push(...result.items.map((item, index) => renderItem(item, index + 1)));
    const diagnostics = [...new Set([
      ...(result.budgetExceeded ? ["已到搜索时限，以上为已取得的结果。"] : []),
      ...result.warnings,
      ...result.sites.flatMap(site => site.warnings.map(warning => `${site.siteName}：${warning}`)),
    ])];
    if (request.full || request.debug) {
      diagnostics.push(`原始 ${result.rawResultCount} 条 → 去重 ${result.uniqueResultCount} 条`,
        ...result.sites.map(site => `${site.siteName}：${site.resultCount} 条 · ${site.via || "正常"} · ${Math.round(site.durationMs / 1000)} 秒`));
    }
    if (diagnostics.length) blocks.push(diagnostics.join("\n"));
  }
  return blocks.map(text => ({ senderId, senderName: "会仙", text }));
}
