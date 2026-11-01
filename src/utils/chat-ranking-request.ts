/** Only explicit group speech rankings own this lane; stock/company/game
 * rankings and requests to draw a poster remain on their existing paths. */
export function isNaturalChatRankingRequest(text: string): boolean {
  const clean = text.trim().replace(/[？?。！!吧呢呀]+$/u, "");
  if (/画|绘制|制作|生成|海报|企业|公司|股票|股市|游戏|段位/u.test(clean)) return false;
  if (/昨天|昨日|前天|本周|这周|上周|本月|最近/u.test(clean)) return false;
  return /^(?:(?:请|帮我|给我|麻烦)?(?:看(?:看|一下)?|查(?:看|一下)?|发(?:个|一下|一份)?|来(?:个|一份)?)?\s*)?(?:今天|今日|现在|当前)?(?:的)?(?:本群|群聊|群里|聊天|发言|水群)(?:的|今日|今天|实时|聊天|发言)*(?:排行榜|排行|排名|榜单|榜)$/u.test(clean) ||
    /^(?:(?:请|帮我)?(?:看看|查看|统计一下))?(?:今天|今日)?(?:本群|群里)?谁(?:今天|今日)?(?:聊得最多|说话最多|发言最多|最能聊|最活跃)$/u.test(clean);
}
