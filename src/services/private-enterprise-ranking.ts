import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";

export interface RankedEnterprise {
  rank: number;
  name: string;
  province: string;
  revenueWan: number;
  /**
   * A derived projection of the independently reviewed headquarters sidecar.
   * It is never accepted from the primary ranking asset.
   */
  headquarters?: VerifiedHeadquarters;
}

export interface VerifiedHeadquarters {
  province: string;
  city: string;
  administrativeLevel: "municipality" | "prefecture";
  evidenceId: string;
  sourceUrl: string;
  sourcePublisher: string;
  retrievedOn: string;
  asOf: string;
}

export interface HeadquartersEvidence {
  evidenceId: string;
  authority: "enterprise" | "government";
  publisher: string;
  sourceUrl: string;
  sourcePublishedOn: string;
  claimAsOf: string;
  retrievedOn: string;
  /** SHA-256 of the immutable local captured-content record. */
  capturedContentSha256: string;
  /** Entity name explicitly present in the cited source. */
  sourceSubject: string;
  claimText: string;
  /**
   * Verbatim source text that establishes the relationship to the ranked
   * enterprise when `sourceSubject` uses a different legal or group name.
   * It is deliberately source evidence, not a reviewer-authored mapping.
   */
  entityRelationText?: string;
}

export interface HeadquartersEvidenceArchiveEntry {
  evidenceId: string;
  capturedContentSha256: string;
  /** A dated, minimal source capture containing the headquarters claim. */
  capturedContent: string;
}

export interface HeadquartersEvidenceArchive {
  schemaVersion: 1;
  edition: 2026;
  entriesSha256: string;
  entries: HeadquartersEvidenceArchiveEntry[];
}

export interface HeadquartersResearchApproval {
  reviewProtocol: 1;
  reviewerId: string;
  reviewedAt: string;
  scope: "2026_private_enterprise_top_500_headquarters";
  ledgerSha256: string;
  evidenceArchiveSha256: string;
  publicKeyId: string;
  /** Ed25519 signature over the canonical completion payload. */
  signature: string;
}

export interface HeadquartersResearchVerificationOptions {
  /** Base64 SPKI DER Ed25519 public key. Production reads the pinned env key. */
  approvalPublicKey?: string;
  /** Must match the key identifier in a completed research approval. */
  approvalPublicKeyId?: string;
}

export interface HeadquartersResearchEntry {
  rank: number;
  enterpriseName: string;
  /** SHA-256 of the immutable primary ranking row. */
  rankingRowSha256: string;
  /** Documents an exact-entity or source-cited name-continuity match. */
  entityMatch: string;
  headquarters: {
    province: string;
    city: string;
    administrativeLevel: "municipality" | "prefecture";
    asOf: string;
    evidence: HeadquartersEvidence[];
  };
}

/**
 * Versioned evidence ledger for headquarters-city research.  This stays
 * separate from the published ranking because the ranking itself only gives
 * a provincial field.
 */
export interface HeadquartersResearchData {
  schemaVersion: 1;
  edition: 2026;
  rankingRowsSha256: string;
  frozenAt: string;
  status: "in_progress" | "complete";
  researchRowsSha256: string;
  sourceManifestSha256: string;
  evidenceArchiveSha256: string;
  completionApproval?: HeadquartersResearchApproval;
  entries: HeadquartersResearchEntry[];
}

export interface PrivateEnterpriseRankingData {
  edition: 2026;
  revenueYear: 2025;
  publishedOn: string;
  rankingSource: string;
  transcriptionRowsSha256: string;
  screenshotSha256: string;
  rowsSha256: string;
  screenshotCheckedRanks: number[];
  screenshotSpotCheckedRanks: number[];
  screenshotCorrections: number[];
  headquartersBasis: string;
  entries: RankedEnterprise[];
}

export interface RankingPageArgs {
  query?: string;
  rank?: number;
  province?: string;
  city?: string;
  page: number;
  pageSize: number;
}

export interface RankingAnswer {
  messages: string[];
}

/**
 * The only operations exposed to an LLM.  Each operation is executed against
 * the checksum-verified in-process ranking rather than against model context.
 */
export type PrivateEnterpriseToolOperation =
  | "company_lookup"
  | "rank_lookup"
  | "rank_range"
  | "province_count"
  | "province_list"
  | "province_compare"
  | "province_max"
  | "province_min"
  | "province_leaderboard"
  | "national_count"
  | "city_count"
  | "city_list";

export interface PrivateEnterpriseToolQuery {
  operation: PrivateEnterpriseToolOperation;
  /** Omitted means the only stored edition, 2026. */
  edition?: number;
  company?: string;
  rank?: number;
  startRank?: number;
  endRank?: number;
  province?: string;
  provinces?: string[];
  city?: string;
  limit?: number;
}

const CITY_PENDING = "2026中国民营企业500强榜单只公布省份。500家企业的总部城市尚未全部核验，暂不能给出地级市的准确家数或名单。";
const EDITION = "2026中国民营企业500强";
const LIST_BATCH_SIZE = 20;
// A headquarters answer is frozen for the ranking publication date. A source
// used as that frozen-date claim may be no more than one calendar year old.
// Historical corroboration may remain in the ledger, but cannot be selected
// as the record projected to city answers.
const HEADQUARTERS_SUPPORT_MAX_AGE_DAYS = 365;
const MUNICIPALITIES = new Set(["北京市", "天津市", "上海市", "重庆市"]);
// These are fixed, unambiguous official-to-common autonomous-prefecture forms.
// Do not derive an alias by chopping off ethnic descriptors: doing so would
// silently turn an arbitrary city string into a looser geographic claim.
const AUTONOMOUS_PREFECTURE_SHORT_ALIASES = new Map<string, string>([
  ["延边朝鲜族自治州", "延边州"],
  ["恩施土家族苗族自治州", "恩施州"],
  ["湘西土家族苗族自治州", "湘西州"],
  ["黔东南苗族侗族自治州", "黔东南州"],
  ["黔南布依族苗族自治州", "黔南州"],
  ["黔西南布依族苗族自治州", "黔西南州"],
  ["阿坝藏族羌族自治州", "阿坝州"],
  ["甘孜藏族自治州", "甘孜州"],
  ["凉山彝族自治州", "凉山州"],
  ["楚雄彝族自治州", "楚雄州"],
  ["红河哈尼族彝族自治州", "红河州"],
  ["文山壮族苗族自治州", "文山州"],
  ["西双版纳傣族自治州", "西双版纳州"],
  ["大理白族自治州", "大理州"],
  ["德宏傣族景颇族自治州", "德宏州"],
  ["怒江傈僳族自治州", "怒江州"],
  ["迪庆藏族自治州", "迪庆州"],
  ["临夏回族自治州", "临夏州"],
  ["甘南藏族自治州", "甘南州"],
  ["海北藏族自治州", "海北州"],
  ["黄南藏族自治州", "黄南州"],
  ["海南藏族自治州", "海南州"],
  ["果洛藏族自治州", "果洛州"],
  ["玉树藏族自治州", "玉树州"],
  ["海西蒙古族藏族自治州", "海西州"],
  ["昌吉回族自治州", "昌吉州"],
  ["伊犁哈萨克自治州", "伊犁州"],
]);
const REGIONS_WITHOUT_ENTRIES = ["黑龙江省", "甘肃省", "青海省", "西藏自治区"];
// "民营500强" is the common abbreviated form in group chat.  It still names
// this specific ranking, unlike a bare "民营", so it belongs on the
// deterministic path as well.
const EXPLICIT_RANKING_SCOPE = /(?:20\d{2}年?)?(?:中国)?(?:民营企业|民企|民营)(?:500|五百)强(?:榜单)?/u;
// The product defaults an unqualified Top-N request to this 2026 dataset.
// Keep this deliberately narrow so ordinary chat about an unnamed company or
// media list does not get captured.
const BARE_TOP_N_REQUEST = /^(?:(?:请|帮我|给我|麻烦)?(?:列出|列一下|列举|展示|看一下|发我|告诉我)?\s*)?(?:20\d{2}年?)?(?:前|top)\s*(?:\d{1,3}|[〇零一二两三四五六七八九十百]+)\s*(?:名|位|家|强)?(?:有哪些|是什么|名单|企业|公司|都有谁|分别是哪些|分别是谁)?[？?。！!]*$/iu;
const BARE_RANK_RANGE_REQUEST = /^(?:(?:请|帮我|给我|麻烦)?(?:列出|列一下|列举|展示|看一下|发我|告诉我)?\s*)?(?:20\d{2}年?)?第?(?:\d{1,3}|[〇零一二两三四五六七八九十百]+)(?:名|位)?(?:到|至|-|—|~|～)第?(?:\d{1,3}|[〇零一二两三四五六七八九十百]+)(?:名|位)?(?:有哪些|是什么|名单|企业|公司|都有谁|分别是哪些|分别是谁)?[？?。！!]*$/iu;
const BARE_RANK_LOOKUP_REQUEST = /^(?:(?:请|帮我|给我|麻烦)?\s*)?(?:20\d{2}年?)?(?:(?:第|排名|名次|位列)\s*(?:\d{1,3}|[〇零一二两三四五六七八九十百]+)\s*(?:名|位)?(?:是谁|是哪(?:家|个)?|是什么(?:公司|企业)?|有谁)?|(?:谁|哪家|什么(?:公司|企业)?).{0,6}?(?:排名|名次|位列)(?:第)?(?:\d{1,3}|[〇零一二两三四五六七八九十百]+)\s*(?:名|位)?)[？?。！!]*$/iu;
// Province ordering is a sufficiently specific dataset operation to default
// to the 2026 edition even when it follows no prior turn. This prevents the
// model from inferring a province leaderboard or ordinal from a single row.
const BARE_PROVINCE_LEADERBOARD_REQUEST = /^(?:(?:请|帮我|给我|麻烦)?\s*)?(?:20\d{2}年?)?(?:(?:按(?:榜单)?(?:省份|省级地区)|(?:省份|省级地区|各省|各地区))(?:上榜(?:家数|数量)?|(?:排名|排行|排序)|上榜情况|分别有多少家|有多少家|有几家)|(?:排名|排行|排序)第?(?:\d{1,3}|[〇零一二两三四五六七八九十百]+)(?:名|位)?的?(?:省份|省|地区)|第?(?:\d{1,3}|[〇零一二两三四五六七八九十百]+)(?:名|位)?的?(?:省份|省|地区))(?:呢|吗)?[？?。！!]*$/iu;
const BARE_PROVINCE_EXTREME_REQUEST = /^(?=.*(?:上榜|家数|榜单|(?:500|五百)强))(?:(?:(?:哪个|哪(?:一)?个|什么)(?:省份?|地区)(?:上榜)?(?:最多|最少))|(?:(?:上榜|榜单)?(?:最多|最少)(?:的?是)?(?:哪个|哪(?:一)?个|什么)(?:省份?|地区))|(?:(?:各省|省份|地区)(?:上榜)?(?:最多|最少)))(?:呢|吗)?[？?。！!]*$/iu;
const BARE_PROVINCE_COMPARISON_REQUEST = /^(?=.*(?:省|自治区|北京市|天津市|上海市|重庆市))(?=.*(?:和|与|跟|、|,|，))(?=.*(?:上榜|家数|榜单|(?:500|五百)强)).*(?:哪个|谁)(?:多|少)(?:几家)?(?:[？?。！!])?$/u;
const NON_TARGET_RANKING_SCOPE = /(?:世界|财富|福布斯|胡润|中国企业)500强|电影榜单|(?:大学|高校|院校|学校|本科|招生|专业|医院|医疗|医生|患者|考试|赛季|联赛|游戏|歌曲|电视剧)/u;
const NON_TARGET_FACT_REQUEST = /(?:多少(?:家|个|所)?|几(?:家|个|所)|前\s*(?:\d{1,3}|[〇零一二两三四五六七八九十百]+)|分别|有哪些|哪几|名单|列(?:一下|出))/u;
// Only complete, compact follow-ups may inherit an immediately preceding
// ranking answer. In particular, do not treat ordinary words such as
// "公司" or "哪些" as a ranking signal: that would steal normal chat from
// the model after any Top 500 reply.
const CONTEXTUAL_LIST_FOLLOWUP = /^(?:分别是哪些|具体有哪些|其中有哪些|有哪些(?:公司|企业)?|都有哪些|哪几家|都有谁|有谁|那些(?:呢)?|哪些(?:呢)?|名单|把名单发我|列(?:一下|出)?)(?:[？?。！!])?$/u;
const CONTEXTUAL_COUNT_FOLLOWUP = /^(?:有多少家|有几家|多少家|几家)(?:[？?。！!])?$/u;
const CONTEXTUAL_PROVINCE_EXTREME_FOLLOWUP = /^(?:(?:哪个|哪(?:一)?个|那个|什么)(?:省份?|地区)(?:上榜)?(?:最多|最少)|(?:最多|最少)(?:的?是)?(?:哪个|哪(?:一)?个|什么)(?:省份?|地区)|(?:各省|省份|地区)(?:上榜)?(?:最多|最少))(?:[？?。！!])?$/u;
const CONTEXTUAL_PROVINCE_COMPARISON_FOLLOWUP = /^(?=.*(?:省|自治区|北京市|天津市|上海市|重庆市))(?=.*(?:和|与|跟|、|,|，))(?=.*(?:上榜|家数|榜单|(?:500|五百)强)).*(?:哪个|谁)(?:多|少)(?:几家)?(?:[？?。！!])?$/u;

export type PrivateEnterpriseRankingRequestScope = "none" | "explicit" | "contextual";

/**
 * Separates unmistakable Top 500 fact requests from ordinary conversation.
 * An explicit named ranking is always handled locally, while a short
 * follow-up is local only immediately after an authoritative ranking reply.
 */
export function classifyPrivateEnterpriseRankingRequest(
  text: string,
  history: ReadonlyArray<{ role: string; content: string }> = [],
): PrivateEnterpriseRankingRequestScope {
  const normalized = compactRankingText(text);
  if (isNonTargetRankingScope(normalized)) return "none";
  if (EXPLICIT_RANKING_SCOPE.test(normalized) ||
      BARE_TOP_N_REQUEST.test(normalized) || BARE_RANK_RANGE_REQUEST.test(normalized) ||
      BARE_RANK_LOOKUP_REQUEST.test(normalized) || BARE_PROVINCE_LEADERBOARD_REQUEST.test(normalized) ||
      BARE_PROVINCE_EXTREME_REQUEST.test(normalized) || BARE_PROVINCE_COMPARISON_REQUEST.test(normalized)) return "explicit";
  const previous = history.at(-1);
  return previous?.role === "assistant" && previous.content.includes(EDITION) &&
    isContextualRankingFollowup(normalized)
    ? "contextual"
    : "none";
}

function isContextualRankingFollowup(normalizedText: string): boolean {
  return CONTEXTUAL_LIST_FOLLOWUP.test(normalizedText) ||
    CONTEXTUAL_COUNT_FOLLOWUP.test(normalizedText) ||
    CONTEXTUAL_PROVINCE_EXTREME_FOLLOWUP.test(normalizedText) ||
    CONTEXTUAL_PROVINCE_COMPARISON_FOLLOWUP.test(normalizedText);
}

export function loadPrivateEnterpriseRanking(
  verificationOptions: HeadquartersResearchVerificationOptions = {
    approvalPublicKey: process.env.UBOT_PRIVATE_ENTERPRISE_HEADQUARTERS_REVIEW_PUBLIC_KEY?.trim() || undefined,
    approvalPublicKeyId: process.env.UBOT_PRIVATE_ENTERPRISE_HEADQUARTERS_REVIEW_PUBLIC_KEY_ID?.trim() || undefined,
  },
): PrivateEnterpriseRanking {
  const rankingAssetUrl = new URL("../../assets/private-enterprises-2026.json", import.meta.url);
  const headquartersAssetUrl = new URL("../../assets/private-enterprises-2026-headquarters.json", import.meta.url);
  const evidenceArchiveUrl = new URL("../../assets/private-enterprises-2026-headquarters-evidence.json", import.meta.url);
  return new PrivateEnterpriseRanking(
    JSON.parse(readFileSync(rankingAssetUrl, "utf8")) as PrivateEnterpriseRankingData,
    JSON.parse(readFileSync(headquartersAssetUrl, "utf8")) as HeadquartersResearchData,
    JSON.parse(readFileSync(evidenceArchiveUrl, "utf8")) as HeadquartersEvidenceArchive,
    verificationOptions,
  );
}

export class PrivateEnterpriseRanking {
  readonly data: PrivateEnterpriseRankingData;
  readonly cityCoverage: number;
  readonly cityReady: boolean;
  readonly headquartersResearchStatus: HeadquartersResearchData["status"];
  readonly headquartersFrozenAt: string;
  readonly headquartersResearchRowsSha256: string;
  readonly headquartersSourceManifestSha256: string;
  readonly headquartersEvidenceArchiveSha256: string;
  private readonly provinces: string[];
  private readonly regions: string[];

  constructor(
    data: PrivateEnterpriseRankingData,
    research = emptyHeadquartersResearch(data),
    evidenceArchive = emptyHeadquartersEvidenceArchive(),
    verificationOptions: HeadquartersResearchVerificationOptions = {},
  ) {
    validateRanking(data);
    const validatedResearch = validateHeadquartersResearch(data, research, evidenceArchive, verificationOptions);
    this.cityCoverage = validatedResearch.coverage;
    this.cityReady = research.status === "complete" && this.cityCoverage === 500;
    this.headquartersResearchStatus = research.status;
    this.headquartersFrozenAt = research.frozenAt;
    this.headquartersResearchRowsSha256 = research.researchRowsSha256;
    this.headquartersSourceManifestSha256 = research.sourceManifestSha256;
    this.headquartersEvidenceArchiveSha256 = research.evidenceArchiveSha256;
    this.data = {
      ...data,
      // Do not project partial research into the public ranking object. This
      // protects both bot answers and the read-only admin list from exposing
      // unreviewed headquarters records.
      entries: data.entries.map((entry) => {
        const headquarters = this.cityReady ? validatedResearch.headquartersByRank.get(entry.rank) : undefined;
        return headquarters ? { ...entry, headquarters } : { ...entry };
      }),
    };
    this.provinces = [...new Set(this.data.entries.map((entry) => entry.province))];
    this.regions = [...this.provinces, ...REGIONS_WITHOUT_ENTRIES];
  }

  listPage(args: RankingPageArgs) {
    const queryRank = parseRankingRankFilter(args.query ?? "");
    const rank = normalizeRankingRank(args.rank) ?? queryRank;
    const query = queryRank === undefined ? normalize(args.query ?? "") : "";
    const province = this.provinces.find((item) => normalize(item) === normalize(args.province ?? ""));
    const city = normalize(args.city ?? "");
    const matched = this.data.entries.filter((entry) =>
      (rank === undefined || entry.rank === rank) &&
      (!query || normalize(`${entry.name} ${entry.province}`).includes(query)) &&
      (!args.province || entry.province === province) &&
      (!city || (this.cityReady && normalize(entry.headquarters?.city ?? "") === city))
    );
    const pageSize = Math.min(100, Math.max(1, Math.trunc(args.pageSize) || 20));
    const totalPages = Math.max(1, Math.ceil(matched.length / pageSize));
    const page = Math.min(totalPages, Math.max(1, Math.trunc(args.page) || 1));
    return {
      items: matched.slice((page - 1) * pageSize, page * pageSize).map((entry) =>
        this.cityReady ? entry : withoutHeadquarters(entry),
      ),
      pagination: { page, pageSize, total: matched.length, totalPages },
      metadata: {
        edition: this.data.edition,
        revenueYear: this.data.revenueYear,
        publishedOn: this.data.publishedOn,
        rankingSource: this.data.rankingSource,
        transcriptionRowsSha256: this.data.transcriptionRowsSha256,
        screenshotSha256: this.data.screenshotSha256,
        rowsSha256: this.data.rowsSha256,
        screenshotCheckedRanks: this.data.screenshotCheckedRanks,
        screenshotCorrections: this.data.screenshotCorrections,
        cityCoverage: this.cityCoverage,
        cityReady: this.cityReady,
        headquartersResearchStatus: this.headquartersResearchStatus,
        headquartersFrozenAt: this.headquartersFrozenAt,
        headquartersResearchRowsSha256: this.headquartersResearchRowsSha256,
        headquartersSourceManifestSha256: this.headquartersSourceManifestSha256,
        headquartersEvidenceArchiveSha256: this.headquartersEvidenceArchiveSha256,
        provinces: this.provinces,
      },
    };
  }

  /** Executes a bounded, typed read-only query for the model tool runtime. */
  query(input: PrivateEnterpriseToolQuery): RankingAnswer {
    if (input.edition !== undefined && input.edition !== this.data.edition) {
      return { messages: ["目前知识库仅收录2026中国民营企业500强，不能用这份榜单回答其他年份的名次或地区统计。"] };
    }
    switch (input.operation) {
      case "company_lookup":
        return this.answerCompany(input.company ?? "");
      case "rank_lookup":
        return this.answerRank(input.rank);
      case "rank_range":
        return this.answerRankRange(input.startRank, input.endRank);
      case "province_count":
        return this.answerProvince(input.province, false);
      case "province_list":
        return this.answerProvince(input.province, true);
      case "province_compare":
        return this.answerProvinceComparison(input.provinces ?? []);
      case "province_max":
        return this.answerProvinceExtreme("max");
      case "province_min":
        return this.answerProvinceExtreme("min");
      case "province_leaderboard":
        return this.answerProvinceLeaderboard(input.limit);
      case "national_count":
        return { messages: [`${EDITION}共500家，按2025年营收排序。`] };
      case "city_count":
        return this.answerCity(input.city, false);
      case "city_list":
        return this.answerCity(input.city, true);
      default:
        return { messages: ["榜单查询参数无效，请明确企业、名次、省级地区或总部城市。"] };
    }
  }

  answer(text: string, history: Array<{ role: string; content: string }> = []): RankingAnswer | undefined {
    const requestScope = classifyPrivateEnterpriseRankingRequest(text, history);
    const previousAssistantContent = history.at(-1)?.role === "assistant"
      ? history.at(-1)?.content ?? ""
      : "";
    const rankingContextActive = previousAssistantContent.includes(EDITION);
    if (isNonTargetRankingScope(compactRankingText(text))) return undefined;

    const rankRangeTokens = findRankRangeTokens(text);
    const rankRange = parseRankRange(text);
    const topRankToken = findTopRankToken(text);
    const topRankLimit = parseTopRankLimit(text);
    const rankIntent = /排名|名次|排行|排在|排(?:第)?几(?:名|位)?|第几(?:名|位)?|多少名|排多少|位列|位居|名列|位于第|榜首/.test(text);
    const listIntent = /哪些|哪几家|分别是|名单|有谁|都有哪些|列(?:一下|出)?/.test(text);
    const countIntent = /多少家|几家|上榜|入围/.test(text);
    const rankingReferenceIntent = /民营|民企|500强|榜单|排名|名次|上榜|入围/.test(text);
    // A generic "这家公司怎么样" remains ordinary conversation, even when
    // the prior assistant turn happened to be a ranking answer. Only an
    // explicit ranking reference may turn a company-status wording into a
    // deterministic Top 500 lookup.
    const companyStatusIntent = /怎样|怎么样|情况|表现/.test(text) && /榜单|排名|名次/.test(text);
    const companyExistenceIntent = /上榜|入围|进榜|进入(?:榜单|500强)?|有上榜|有无|有没有|是否/.test(text);
    const potentialCompanyInquiry = rankIntent || companyStatusIntent || companyExistenceIntent || rankingReferenceIntent;
    const companyMatches = potentialCompanyInquiry ? this.matchEnterprises(text) : [];
    const companyRankRequestShape = rankIntent && looksLikeCompanyRankRequest(text);
    const companyExistenceRequestShape = companyExistenceIntent && looksLikeCompanyExistenceRequest(text);
    const extremeIntent = /(?:哪个|哪(?:一)?个|那个|什么)(?:省|地区)(?:[^？?。]{0,12})?(?:最多|最少)|(?:最多|最少)(?:的?是)?(?:哪个|哪(?:一)?个|什么)(?:省|地区)|(?:各省|省份|地区).*(?:最多|最少)|(?:哪个|哪(?:一)?个)(?:省|地区).*(?:排第?[一二两三四五六七八九十\d]+|第一)/.test(text);
    const provinceRankingIntent = /(?:按(?:榜单)?(?:省份|省级地区)|(?:省份|省级地区|各省|各地区).{0,8}(?:排名|排行|排序|上榜(?:数量|家数)?|上榜情况)|(?:排名|排行|排序).{0,8}(?:省份|省级地区|各省|各地区)|(?:排名|排行|排序)第?(?:\d{1,3}|[〇零一二两三四五六七八九十百]+)(?:名|位)?的?(?:省份|省|地区)|第?(?:\d{1,3}|[〇零一二两三四五六七八九十百]+)(?:名|位)?的?(?:省份|省|地区)|(?:各省|各省份|每(?:个)?省|各地区).*(?:多少家|几家|上榜(?:数量|家数)?|数量|家数|分别))/.test(text);
    const revenueBasisIntent = /(?:2025年?)?(?:营业)?收入|营收.*(?:年份|年度|2025)|(?:按|以|用)2025年?(?:营收|营业收入|收入)/.test(text);
    const namedEdition = extractNamedRankingEdition(text);
    const fallbackEdition = namedEdition === undefined && (requestScope !== "none" || companyMatches.length > 0 || companyRankRequestShape || companyExistenceRequestShape)
      ? extractFallbackRankingEdition(text)
      : undefined;
    const requestedEdition = namedEdition ?? fallbackEdition;
    if (requestedEdition !== undefined && requestedEdition !== 2026) {
      return { messages: ["目前知识库仅收录2026中国民营企业500强，不能用这份榜单回答其他年份的名次或地区统计。"] };
    }

    const hasNamedScope = requestScope !== "none";
    const prior = requestScope === "contextual" && rankingContextActive
      ? [...history].reverse().find((turn) => turn.role === "user")?.content
      : undefined;
    const compactText = compactRankingText(text);
    const listFollowup = Boolean(requestScope === "contextual" && CONTEXTUAL_LIST_FOLLOWUP.test(compactText));
    const countFollowup = Boolean(requestScope === "contextual" && CONTEXTUAL_COUNT_FOLLOWUP.test(compactText));
    const contextualFollowup = listFollowup || countFollowup ||
      Boolean(requestScope === "contextual" && extremeIntent);
    const question = contextualFollowup && prior ? prior : text;
    let provinceMatches = this.matchProvinces(question);
    // A follow-up such as "分别是哪些" after "哪个省最多" has no province
    // in the user's preceding text. The immediately preceding deterministic
    // answer is the authoritative context for recovering that province.
    if (contextualFollowup && provinceMatches.length === 0 && rankingContextActive) {
      provinceMatches = this.matchProvinces(previousAssistantContent);
    }
    const exactRank = parseExactRank(text);
    const exactRankToken = findExactRankToken(text);
    const invalidRankExpression = Boolean(
      (rankRangeTokens && !rankRange) ||
      (topRankToken && topRankLimit === undefined) ||
      (exactRankToken && exactRank === undefined),
    );
    const rankLookupIntent = exactRank !== undefined && /谁|哪家|什么(?:公司|企业)?|是哪(?:家|个)?/.test(text);
    const provinceRank = parseProvinceRank(text);
    const compareIntent = provinceMatches.length > 1 && /(?:哪个|哪(?:个)?|谁|比较|多(?:一些|一点|几家)?|少(?:一些|一点|几家)?)/.test(text);
    // A bare province or national count defaults only when the whole turn is
    // the compact dataset shorthand (for example "浙江有几家"). A province
    // plus unrelated subject words such as "医院" or "上市公司" belongs to
    // ordinary model chat.
    const provinceFactRequest = provinceMatches.length === 1 && (countIntent || listIntent) &&
      (hasNamedScope || isBareProvinceFactRequest(text, provinceMatches[0]!));
    const nationalCountRequest = provinceMatches.length === 0 && /全国|总共|总计/.test(text) && countIntent &&
      (hasNamedScope || isBareNationalCountRequest(text));
    const companyLookupRequest = (rankIntent || companyStatusIntent || companyExistenceIntent) &&
      (companyMatches.length > 0 || companyExistenceRequestShape ||
        (hasNamedScope && companyRankRequestShape));
    const hasRoutingSignal = hasNamedScope || companyLookupRequest || provinceFactRequest || nationalCountRequest;
    if (!hasRoutingSignal) return undefined;

    if (invalidRankExpression) {
      return { messages: ["榜单名次范围应在1至500之间。"] };
    }

    if (revenueBasisIntent && hasNamedScope) {
      return { messages: [`${EDITION}按2025年营收排序。`] };
    }
    if (rankRange) return this.answerRankRange(rankRange.startRank, rankRange.endRank);
    if (topRankLimit !== undefined) return this.answerRankRange(1, topRankLimit);
    if (provinceRankingIntent) {
      return provinceRank === undefined
        ? this.answerProvinceLeaderboard(undefined, true)
        : this.answerProvinceRank(provinceRank);
    }
    if (extremeIntent) {
      return this.answerProvinceExtreme(/最少/.test(text) ? "min" : "max");
    }

    if (rankIntent || exactRank !== undefined || companyStatusIntent || companyExistenceIntent ||
        (countIntent && /有无|有没有|是否|哪家|公司|企业/.test(text) && !/多少家|几家/.test(text))) {
      if (exactRank && rankLookupIntent) {
        return this.answerRank(exactRank);
      }
      if (companyMatches.length > 1) {
        return { messages: [`找到多个可能的企业：${companyMatches.slice(0, 5).map((item) => item.name).join("、")}。请使用榜单中的完整名称。`] };
      }
      if (companyMatches.length === 1) {
        const entry = companyMatches[0]!;
        return { messages: [`${entry.name}在${EDITION}中排名第${entry.rank}，榜单省份为${entry.province}（按2025年营收排序）。`] };
      }
      if (provinceMatches.length === 0 && !/多少家|几家/.test(text)) {
        return { messages: [`没有在${EDITION}中找到该企业；请提供榜单企业的完整名称。`] };
      }
    }

    if (provinceMatches.length > 1) {
      if (compareIntent) return this.answerProvinceComparison(provinceMatches);
      return { messages: ["请一次指定一个省级地区，以便给出准确的家数和名单。"] };
    }
    const province = provinceMatches[0];
    if (!province && nationalCountRequest) {
      return { messages: [`${EDITION}共500家，按2025年营收排序。`] };
    }
    const cityRequested = this.isCityRequest(text, province);
    if (cityRequested && !this.cityReady) return { messages: [CITY_PENDING] };

    if (this.cityReady && cityRequested) {
      const cities = [...new Set(this.data.entries.map((entry) => entry.headquarters!.city))]
        .filter((city) => normalize(text).includes(normalize(city)) || normalize(text).includes(normalize(city).replace(/市$/, "")));
      if (cities.length !== 1) return { messages: ["请明确指定一个地级市的完整名称。"] };
      return this.formatRegion(cities[0]!, this.data.entries.filter((entry) => entry.headquarters?.city === cities[0]), listIntent || listFollowup, "city");
    }
    if (province) {
      return this.formatRegion(province, this.data.entries.filter((entry) => entry.province === province), listIntent || listFollowup);
    }
    if (countIntent || listIntent || contextualFollowup) {
      return { messages: [this.cityReady ? "请指定一个省份或地级市。" : `请指定榜单中的省级地区。${CITY_PENDING}`] };
    }
    return { messages: ["这份知识库可查询企业名次、指定名次、省级地区家数或名单。请明确企业名称、名次或省级地区。"] };
  }

  private matchProvinces(text: string): string[] {
    const normalized = normalize(text);
    const full = this.regions.filter((province) => normalized.includes(normalize(province)));
    if (full.length) return full;
    return this.regions.filter((province) => {
      const short = province.replace(/壮族自治区|回族自治区|维吾尔自治区|自治区|特别行政区|省|市$/, "");
      return normalized.includes(normalize(province)) || normalized.includes(normalize(short));
    });
  }

  private answerCompany(company: string): RankingAnswer {
    const candidates = this.matchEnterprises(company);
    if (candidates.length > 1) {
      return { messages: [`找到多个可能的企业：${candidates.slice(0, 5).map((item) => item.name).join("、")}。请使用榜单中的完整名称。`] };
    }
    if (candidates.length === 1) {
      const entry = candidates[0]!;
      return { messages: [`${entry.name}在${EDITION}中排名第${entry.rank}，榜单省份为${entry.province}（按2025年营收排序）。`] };
    }
    return { messages: [`没有在${EDITION}中找到该企业；请提供榜单企业的完整名称。`] };
  }

  private answerRank(rank: number | undefined): RankingAnswer {
    if (!Number.isInteger(rank) || rank! < 1 || rank! > 500) {
      return { messages: ["榜单名次应在1至500之间。"] };
    }
    const entry = this.data.entries[rank! - 1]!;
    return { messages: [`${EDITION}第${entry.rank}名是${entry.name}（榜单省份：${entry.province}）。`] };
  }

  private answerRankRange(startRank: number | undefined, endRank: number | undefined): RankingAnswer {
    if (!Number.isInteger(startRank) || !Number.isInteger(endRank) ||
        startRank! < 1 || endRank! > 500 || startRank! > endRank!) {
      return { messages: ["榜单名次范围应在1至500之间，且起始名次不能大于结束名次。"] };
    }
    const entries = this.data.entries.slice(startRank! - 1, endRank!);
    const prefix = `${EDITION}第${startRank}至${endRank}名（按2025年营收排序）`;
    const count = Math.ceil(entries.length / LIST_BATCH_SIZE);
    return {
      messages: Array.from({ length: count }, (_, index) => {
        const lines = entries.slice(index * LIST_BATCH_SIZE, (index + 1) * LIST_BATCH_SIZE)
          .map((entry) => `第${entry.rank}名 ${entry.name}`);
        return `${prefix}（${index + 1}/${count}）：\n${lines.join("\n")}`;
      }),
    };
  }

  private answerProvince(value: string | undefined, includeNames: boolean): RankingAnswer {
    const matches = this.matchProvinces(value ?? "");
    if (matches.length === 0) {
      return { messages: ["请指定一个榜单省级地区。"] };
    }
    if (matches.length > 1) {
      return { messages: ["请一次指定一个省级地区，以便给出准确的家数和名单。"] };
    }
    const province = matches[0]!;
    return this.formatRegion(province, this.data.entries.filter((entry) => entry.province === province), includeNames);
  }

  private answerProvinceComparison(values: string[]): RankingAnswer {
    const resolved = values.slice(0, 8).map((value) => this.matchProvinces(value));
    if (resolved.some((matches) => matches.length === 0)) {
      return { messages: ["请使用榜单中的完整省级地区名称，以便比较上榜企业家数。"] };
    }
    const provinces = [...new Set(resolved.flat())];
    if (provinces.length < 2) {
      return { messages: ["请至少指定两个省级地区，以便比较上榜企业家数。"] };
    }
    const rows = provinces.map((province) => {
      const count = this.data.entries.filter((entry) => entry.province === province).length;
      return { province, count };
    });
    const highest = Math.max(...rows.map((row) => row.count));
    const leaders = rows.filter((row) => row.count === highest).map((row) => row.province);
    const next = Math.max(...rows.filter((row) => row.count < highest).map((row) => row.count), Number.NEGATIVE_INFINITY);
    const conclusion = leaders.length > 1
      ? `${leaders.join("、")}并列最多`
      : Number.isFinite(next)
        ? `${leaders[0]}多${highest - next}家`
        : `${leaders[0]}最多`;
    return { messages: [`${EDITION}省级地区对比（按榜单省份；2025年营收）：${rows.map((row) => `${row.province}${row.count}家`).join("；")}。${conclusion}。`] };
  }

  private answerProvinceExtreme(kind: "max" | "min"): RankingAnswer {
    const rows = this.provinceCounts();
    const count = kind === "max" ? rows[0]!.count : rows.at(-1)!.count;
    const provinces = rows.filter((row) => row.count === count).map((row) => row.province);
    const label = kind === "max" ? "最多" : "最少";
    return { messages: [`${EDITION}上榜企业${label}的省级地区是${provinces.join("、")}，共${count}家（按榜单省份；2025年营收）。`] };
  }

  private answerProvinceLeaderboard(limit: number | undefined, all = false): RankingAnswer {
    const rows = all
      ? this.provinceCounts()
      : this.provinceCounts().slice(0, Math.min(20, Math.max(1, Math.trunc(limit ?? 10))));
    return { messages: [`${EDITION}省级地区上榜家数：${rows.map((row, index) => `${index + 1}. ${row.province}${row.count}家`).join("；")}（按榜单省份；2025年营收）。`] };
  }

  private answerProvinceRank(rank: number): RankingAnswer {
    const rows = this.provinceCounts();
    const counts = [...new Set(rows.map((row) => row.count))];
    const count = counts[rank - 1];
    if (count === undefined) return { messages: ["省级地区排名应在现有榜单名次范围内。"] };
    const provinces = rows.filter((row) => row.count === count).map((row) => row.province);
    const countPhrase = provinces.length === 1 ? `共${count}家` : `各${count}家`;
    return {
      messages: [`${EDITION}按上榜家数计，省级地区排名第${rank}的是${provinces.join("、")}，${countPhrase}（按榜单省份；2025年营收）。`],
    };
  }

  private answerCity(value: string | undefined, includeNames: boolean): RankingAnswer {
    if (!this.cityReady) return { messages: [CITY_PENDING] };
    const normalized = normalize(value ?? "");
    const cities = [...new Set(this.data.entries.map((entry) => entry.headquarters!.city))]
      .filter((city) => normalized === normalize(city) || normalized === normalize(city).replace(/市$/, ""));
    if (cities.length !== 1) return { messages: ["请明确指定一个地级市的完整名称。"] };
    const city = cities[0]!;
    return this.formatRegion(city, this.data.entries.filter((entry) => entry.headquarters?.city === city), includeNames, "city");
  }

  private provinceCounts(): Array<{ province: string; count: number }> {
    return this.regions
      .map((province) => ({ province, count: this.data.entries.filter((entry) => entry.province === province).length }))
      .sort((left, right) => right.count - left.count || left.province.localeCompare(right.province, "zh-CN"));
  }

  private matchEnterprises(text: string): RankedEnterprise[] {
    const normalized = normalize(text);
    const exact = this.data.entries.filter((entry) => normalized.includes(normalize(entry.name)));
    if (exact.length) return exact;
    // Remove a complete "在 2026 榜单里" phrase before generic fillers.
    // Never remove a bare "里": it is part of aliases such as "阿里".
    const inquiry = text.replace(/(?:在)?(?:20\d{2}年?)?(?:(?:中国)?(?:民营企业|民企|民营)(?:500|五百)强)(?:榜单)?(?:里|中)?/giu, "");
    const candidate = normalize(inquiry.replace(/20\d{2}年?|中国|全国|民营企业|民企|民营|(?:500|五百)强|榜单(?:里|中)?|排名|名次|排行|排在|排(?:第)?几(?:名|位)?|排第几|第几名|第几位|多少名|排多少|位列|位居|名列|位于|在|的|是否|有无|有没有|有上榜|上榜|入围|进榜|进入(?:榜单|500强)?|是|多少|几|第|名|前|top|怎样|怎么样|情况|表现|请问|帮我|查一下|告诉我|了吗|吗|呢|公司|企业|[？?！!。，、\s]/gi, ""));
    if (candidate.length < 2) return [];
    return this.data.entries.filter((entry) => {
      const name = normalize(entry.name);
      const position = name.indexOf(candidate);
      if (position < 0) return false;
      const regionPrefix = normalize(entry.province.replace(/壮族自治区|回族自治区|维吾尔自治区|自治区|省|市$/, ""));
      return !(name.startsWith(regionPrefix) && position < regionPrefix.length &&
        position + candidate.length > regionPrefix.length);
    });
  }

  private isCityRequest(text: string, province?: string): boolean {
    if (/总部城市|总部所在|总部位于|按总部/.test(text)) return true;
    // A municipality is both a provincial-level unit in the published table
    // and a city in ordinary Chinese.  The public question form defaults to
    // the headquarters-city meaning; only an explicit source-field qualifier
    // may request the ranking's separate province column before city records
    // are complete.
    if (MUNICIPALITIES.has(province ?? "")) {
      return !/(?:按|以)?(?:榜单)?省份|省级地区|省份字段/.test(text);
    }
    if (/市(?:有|共|的|多少|几家|哪些|民营|500强)|地级市|总部城市/.test(text)) return true;
    if (province) {
      const short = province.replace(/壮族自治区|回族自治区|维吾尔自治区|自治区|省|市$/, "");
      const fullPosition = text.indexOf(province);
      const shortPosition = text.indexOf(short);
      if (fullPosition < 0 && shortPosition < 0) return false;
      const suffix = text.slice(fullPosition >= 0 ? fullPosition + province.length : shortPosition + short.length);
      if (/^(?!一共|所有|全部|企业|民营|分别|排名|上榜|入围)[\u4e00-\u9fa5]{2,4}(?:市)?(?:有|共|的|多少|几家|哪些)/.test(suffix)) return true;
      return /省.{2,8}市/.test(text);
    }
    if (/哪个|哪些地区|各省|请指定/.test(text)) return false;
    // Only read a city from the start of the utterance (or immediately after
    // an explicit ranking prefix). Searching the entire sentence can mistake
    // a non-city noun such as "院校" for the subject in "院校有多少个".
    const citySubjectText = compactRankingText(text)
      .replace(/^(?:(?:请问|麻烦|请|帮我(?:查一下|查下)?|问下|问一下))/u, "")
      .replace(/^(?:(?:20\d{2}年?)?(?:中国)?(?:民营企业|民企|民营)(?:500|五百)强(?:榜单)?(?:里|中|的)?)/u, "")
      .replace(/^[？?，,。！!、:：]+/u, "");
    const citySubject = citySubjectText.match(/^([\u4e00-\u9fa5]{2,4})(?:市)?(?:有多少|有几家|有哪些|有哪几家|共(?:有)?|多少家|几家|哪些)/u)?.[1];
    return Boolean(citySubject && !/(?:民营|民企|企业|公司|榜单|全国|各省|地区|哪家|哪些|强)/.test(citySubject));
  }

  private formatRegion(region: string, entries: RankedEnterprise[], includeNames: boolean, basis: "province" | "city" = "province"): RankingAnswer {
    const prefix = `${EDITION}：${region}共${entries.length}家`;
    const qualifier = basis === "city" ? "按榜单发布时核验的总部城市" : "按榜单省份";
    if (!includeNames) return { messages: [`${prefix}（${qualifier}；2025年营收）。`] };
    if (!entries.length) return { messages: [`${prefix}（${qualifier}）。`] };
    const batches = [];
    const count = Math.ceil(entries.length / LIST_BATCH_SIZE);
    for (let index = 0; index < count; index += 1) {
      const lines = entries.slice(index * LIST_BATCH_SIZE, (index + 1) * LIST_BATCH_SIZE)
        .map((entry) => `第${entry.rank}名 ${entry.name}`);
      batches.push(`${prefix}（${qualifier}，${index + 1}/${count}）：\n${lines.join("\n")}`);
    }
    return { messages: batches };
  }
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
}

function compactRankingText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, "").trim();
}

function isBareProvinceFactRequest(text: string, province: string): boolean {
  const normalized = compactRankingText(text);
  const provinceForms = [province, province.replace(/壮族自治区|回族自治区|维吾尔自治区|自治区|特别行政区|省|市$/u, "")]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  return provinceForms.some((form) => {
    const escaped = escapeRegex(form);
    return new RegExp(
      `^${escaped}(?:(?:有)?上榜(?:企业)?(?:有)?(?:多少家|几家)|(?:有)?(?:多少家|几家)|(?:上榜|榜单)(?:家数|数量)|(?:有哪些|名单))[？?。！!]*$`,
      "u",
    ).test(normalized);
  });
}

function isBareNationalCountRequest(text: string): boolean {
  return /^(?:全国|总共|总计)(?:有)?(?:多少家|几家)[？?。！!]*$/u.test(compactRankingText(text));
}

function isNonTargetRankingScope(normalizedText: string): boolean {
  if (!NON_TARGET_RANKING_SCOPE.test(normalizedText)) return false;
  return !EXPLICIT_RANKING_SCOPE.test(normalizedText) || NON_TARGET_FACT_REQUEST.test(normalizedText);
}

/** Reads only the year attached to the named private-enterprise ranking. */
function extractNamedRankingEdition(text: string): number | undefined {
  const match = compactRankingText(text).match(/(20\d{2})年?(?:中国)?(?:民营企业|民企|民营)(?:500|五百)强/u);
  return match ? Number(match[1]) : undefined;
}

/**
 * A short company or contextual follow-up can put the requested edition next
 * to the fact, without repeating the full ranking name. Revenue-year wording
 * is deliberately excluded: 2025 is the revenue basis for this 2026 edition.
 */
function extractFallbackRankingEdition(text: string): number | undefined {
  if (/(?:营收|营业收入|收入|财年)/u.test(text)) return undefined;
  const match = compactRankingText(text).match(/20\d{2}/u);
  return match ? Number(match[0]) : undefined;
}

function normalizeRankingRank(value: number | undefined): number | undefined {
  return Number.isInteger(value) && value! >= 1 && value! <= 500 ? value : undefined;
}

/** A list-page query of `2` or `第2名` is an exact rank filter, not text search. */
function parseRankingRankFilter(value: string): number | undefined {
  const match = compactRankingText(value).match(/^(?:第)?(\d{1,3})(?:名|位)?$/u);
  return match ? normalizeRankingRank(Number(match[1])) : undefined;
}

function findRankRangeTokens(text: string): { start: string; end: string } | undefined {
  const normalized = compactRankingText(text);
  const match = normalized.match(/第?(\d{1,3}|[〇零一二两三四五六七八九十百]+)(?:名|位)?(?:到|至|-|—|~|～)第?(\d{1,3}|[〇零一二两三四五六七八九十百]+)(?:名|位)?/u);
  return match ? { start: match[1]!, end: match[2]! } : undefined;
}

function parseRankRange(text: string): { startRank: number; endRank: number } | undefined {
  const tokens = findRankRangeTokens(text);
  if (!tokens) return undefined;
  const startRank = parseRankToken(tokens.start);
  const endRank = parseRankToken(tokens.end);
  return startRank !== undefined && endRank !== undefined ? { startRank, endRank } : undefined;
}

/** Parses a direct ordinal such as "第2名" or "排名第一" without treating
 * an enterprise name as a fuzzy search term. */
function parseExactRank(text: string): number | undefined {
  const token = findExactRankToken(text);
  return token ? parseRankToken(token) : undefined;
}

function findExactRankToken(text: string): string | undefined {
  const normalized = compactRankingText(text);
  if (/榜首/u.test(normalized)) return "一";
  const match = normalized.match(/(?:第|排名|名次|位列)\s*(\d{1,3}|[〇零一二两三四五六七八九十百]+)\s*(?:名|位)?/u);
  return match?.[1];
}

function parseProvinceRank(text: string): number | undefined {
  const normalized = compactRankingText(text);
  const match = normalized.match(/(?:省份|省级地区|各省|各地区).{0,8}?(?:排名|排行|排序)(?:第)?(\d{1,3}|[〇零一二两三四五六七八九十百]+)|(?:排名|排行|排序)(?:第)?(\d{1,3}|[〇零一二两三四五六七八九十百]+)(?:名|位)?的?(?:省份|省|地区)|第?(\d{1,3}|[〇零一二两三四五六七八九十百]+)(?:名|位)?的?(?:省份|省|地区)/u);
  return match ? parseRankToken(match[1] ?? match[2] ?? match[3] ?? "") : undefined;
}

function parseRankToken(value: string): number | undefined {
  return /^\d{1,3}$/u.test(value)
    ? normalizeRankingRank(Number(value))
    : normalizeRankingRank(parseChineseNumber(value));
}

function parseChineseNumber(value: string): number | undefined {
  const digits: Record<string, number> = {
    零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
    六: 6, 七: 7, 八: 8, 九: 9,
  };
  const units: Record<string, number> = { 十: 10, 百: 100 };
  let total = 0;
  let current: number | undefined;
  let previousUnit = Number.POSITIVE_INFINITY;
  let pendingZero = false;
  for (const character of value) {
    const digit = digits[character];
    if (digit !== undefined) {
      if (digit === 0) {
        if (current !== undefined || total === 0 || pendingZero) return undefined;
        pendingZero = true;
        continue;
      }
      if (current !== undefined) return undefined;
      current = digit;
      pendingZero = false;
      continue;
    }
    const unit = units[character];
    if (!unit || pendingZero || unit >= previousUnit) return undefined;
    total += (current ?? 1) * unit;
    current = undefined;
    previousUnit = unit;
  }
  if (pendingZero) return undefined;
  const parsed = total + (current ?? 0);
  return parsed > 0 ? parsed : undefined;
}

function parseTopRankLimit(text: string): number | undefined {
  const token = findTopRankToken(text);
  return token ? parseRankToken(token) : undefined;
}

function findTopRankToken(text: string): string | undefined {
  const normalized = compactRankingText(text).toLowerCase();
  const match = normalized.match(/(?:前|top)(\d{1,3}|[〇零一二两三四五六七八九十百]+)(?:名|位|家|强|企业|公司)?/u);
  return match?.[1];
}

/**
 * Avoid passing an unrecognized company-ranking request to a general model.
 * The stripped candidate excludes ordinary pronouns and needs at least two
 * characters, so plain questions such as "你排第几" remain ordinary chat.
 */
function looksLikeCompanyRankRequest(text: string): boolean {
  if (/电影|电视剧|歌曲|游戏|比赛|球队|演员/u.test(text)) return false;
  if (!/排名|名次|排行|排在|排(?:第)?几(?:名|位)?|第几(?:名|位)?|多少名|排多少|位列|位居|名列|位于第/u.test(text)) return false;
  const candidate = compactRankingText(text.replace(
    /20\d{2}年?|中国|全国|民营企业|民企|民营|(?:500|五百)强|榜单|排名|名次|排行|排在|排(?:第)?几(?:名|位)?|排第几|第几名|第几位|多少名|排多少|位列|位居|名列|位于第|在|的|是否|有无|有没有|有上榜|上榜|入围|进榜|进入(?:榜单|500强)?|是|多少|几|第|名|前|top|请问|帮我|查一下|告诉我|了吗|吗|呢|公司|企业|你|我|他|她|它|[？?！!。，、\s]/giu,
    "",
  ));
  return candidate.length >= 2 && candidate.length <= 80;
}

/** Keeps a clear company "is it listed" question on the verified dataset,
 * including the deterministic no-result case, without capturing media or
 * other non-enterprise rankings. */
function looksLikeCompanyExistenceRequest(text: string): boolean {
  if (!/上榜|入围|进榜|进入(?:榜单|500强)?|有上榜|有无|有没有|是否/u.test(text) ||
      /电影|电视剧|歌曲|游戏|比赛|球队|演员/u.test(text)) return false;
  const candidate = compactRankingText(text.replace(
    /20\d{2}年?|中国|全国|民营企业|民企|民营|(?:500|五百)强|榜单(?:里|中)?|上榜了吗|上榜|入围|进榜|进入(?:榜单|500强)?|有上榜|是否|有无|有没有|在|的|是|请问|帮我|查一下|告诉我|了吗|吗|呢|公司|企业|你|我|他|她|它|[？?！!。，、\s]/giu,
    "",
  ));
  return candidate.length >= 2 && candidate.length <= 80;
}

function validateRanking(data: PrivateEnterpriseRankingData): void {
  if (data.edition !== 2026 || data.revenueYear !== 2025 || data.entries?.length !== 500 ||
      !/^https:\/\//.test(data.rankingSource) || !/^[a-f0-9]{64}$/.test(data.screenshotSha256) ||
      !/^[a-f0-9]{64}$/.test(data.transcriptionRowsSha256) ||
      !/^[a-f0-9]{64}$/.test(data.rowsSha256) || !isIsoDate(data.publishedOn) ||
      data.screenshotCheckedRanks?.length !== 500 ||
      data.screenshotCheckedRanks.some((rank, index) => rank !== index + 1)) {
    throw new Error("invalid_private_enterprise_ranking_metadata");
  }
  const names = new Set<string>();
  for (const [index, entry] of data.entries.entries()) {
    if (entry.rank !== index + 1 || !entry.name?.trim() || !entry.province?.trim() ||
        !Number.isSafeInteger(entry.revenueWan) || entry.revenueWan <= 0 || names.has(entry.name)) {
      throw new Error(`invalid_private_enterprise_ranking_row:${index + 1}`);
    }
    names.add(entry.name);
    // Headquarters are intentionally not accepted inline: they are evidence
    // records with a separate lifecycle and must be checksum-bound below.
    if (entry.headquarters !== undefined) throw new Error(`invalid_private_enterprise_headquarters_inline_data:${index + 1}`);
  }
  const canonical = data.entries.map(({ rank, name, province, revenueWan }) => ({ rank, name, province, revenueWan }));
  const hash = checksum(canonical);
  if (hash !== data.rowsSha256) throw new Error("private_enterprise_ranking_checksum_mismatch");
}

interface ValidatedHeadquartersResearch {
  coverage: number;
  headquartersByRank: Map<number, VerifiedHeadquarters>;
}

function emptyHeadquartersResearch(data: PrivateEnterpriseRankingData): HeadquartersResearchData {
  const emptyChecksum = checksum([]);
  return {
    schemaVersion: 1,
    edition: 2026,
    rankingRowsSha256: data.rowsSha256,
    frozenAt: data.publishedOn,
    status: "in_progress",
    researchRowsSha256: emptyChecksum,
    sourceManifestSha256: emptyChecksum,
    evidenceArchiveSha256: emptyChecksum,
    entries: [],
  };
}

function emptyHeadquartersEvidenceArchive(): HeadquartersEvidenceArchive {
  return {
    schemaVersion: 1,
    edition: 2026,
    entriesSha256: checksum([]),
    entries: [],
  };
}

/**
 * Validates a research ledger before it can affect any city response. The
 * completion path needs both locally captured evidence and a signature from a
 * deployment-pinned reviewer key. This avoids treating self-consistent JSON
 * as independently verified source material.
 */
function validateHeadquartersResearch(
  data: PrivateEnterpriseRankingData,
  research: HeadquartersResearchData,
  evidenceArchive: HeadquartersEvidenceArchive,
  verificationOptions: HeadquartersResearchVerificationOptions,
): ValidatedHeadquartersResearch {
  if (research.schemaVersion !== 1 || research.edition !== data.edition ||
      research.rankingRowsSha256 !== data.rowsSha256 ||
      (research.status !== "in_progress" && research.status !== "complete") ||
      !isIsoDate(research.frozenAt) || research.frozenAt !== data.publishedOn ||
      !Array.isArray(research.entries) || research.entries.length > data.entries.length ||
      !isSha256(research.researchRowsSha256) || !isSha256(research.sourceManifestSha256) ||
      !isSha256(research.evidenceArchiveSha256) ||
      (research.status === "in_progress" && research.completionApproval !== undefined)) {
    throw new Error("invalid_private_enterprise_headquarters_research_metadata");
  }

  const archiveById = validateHeadquartersEvidenceArchive(data, evidenceArchive);
  if (research.evidenceArchiveSha256 !== evidenceArchive.entriesSha256) {
    throw new Error("invalid_private_enterprise_headquarters_research_archive_checksum");
  }
  const canonicalRows = research.entries.map(canonicalHeadquartersResearchEntry);
  if (checksum(canonicalRows) !== research.researchRowsSha256 ||
      checksum(researchSourceManifest(research.entries)) !== research.sourceManifestSha256) {
    throw new Error("invalid_private_enterprise_headquarters_research_checksum");
  }

  const headquartersByRank = new Map<number, VerifiedHeadquarters>();
  const referencedEvidenceIds = new Set<string>();
  let previousRank = 0;
  for (const [index, entry] of research.entries.entries()) {
    const primary = data.entries[entry.rank - 1];
    if (!Number.isInteger(entry.rank) || entry.rank < 1 || entry.rank > data.entries.length ||
        entry.rank <= previousRank || !primary || entry.enterpriseName !== primary.name ||
        entry.rankingRowSha256 !== rankingRowChecksum(primary) || !entry.entityMatch?.trim()) {
      throw new Error(`invalid_private_enterprise_headquarters_research_entry:${index + 1}`);
    }
    previousRank = entry.rank;

    const headquarters = entry.headquarters;
    if (!headquarters || !isCanonicalProvince(headquarters.province) ||
        !isCanonicalHeadquartersCity(headquarters.city, headquarters.administrativeLevel) ||
        !isIsoDate(headquarters.asOf) || headquarters.asOf > research.frozenAt ||
        !Array.isArray(headquarters.evidence) || headquarters.evidence.length === 0) {
      throw new Error(`invalid_private_enterprise_headquarters_research_entry:${index + 1}`);
    }

    let supportingEvidence: HeadquartersEvidence | undefined;
    for (const evidence of headquarters.evidence) {
      if (!isValidHeadquartersEvidence(entry, headquarters, evidence, research.frozenAt, archiveById)) {
        throw new Error(`invalid_private_enterprise_headquarters_research_evidence:${index + 1}`);
      }
      // One captured record can support only one ledger claim. Reusing it
      // would make a superficially complete archive less auditable.
      if (referencedEvidenceIds.has(evidence.evidenceId)) {
        throw new Error(`invalid_private_enterprise_headquarters_research_evidence_reference:${index + 1}`);
      }
      referencedEvidenceIds.add(evidence.evidenceId);
      if (evidence.claimAsOf === headquarters.asOf && !supportingEvidence) {
        supportingEvidence = evidence;
      }
    }
    if (!supportingEvidence) {
      throw new Error(`invalid_private_enterprise_headquarters_research_evidence:${index + 1}`);
    }

    headquartersByRank.set(entry.rank, {
      province: headquarters.province,
      city: headquarters.city,
      administrativeLevel: headquarters.administrativeLevel,
      evidenceId: supportingEvidence.evidenceId,
      sourceUrl: supportingEvidence.sourceUrl,
      sourcePublisher: supportingEvidence.publisher,
      retrievedOn: supportingEvidence.retrievedOn,
      asOf: headquarters.asOf,
    });
  }

  if (referencedEvidenceIds.size !== archiveById.size ||
      [...archiveById.keys()].some((evidenceId) => !referencedEvidenceIds.has(evidenceId))) {
    throw new Error("invalid_private_enterprise_headquarters_research_archive_references");
  }
  if (research.status === "complete" && headquartersByRank.size !== data.entries.length) {
    throw new Error("invalid_private_enterprise_headquarters_research_incomplete");
  }
  if (research.status === "complete") {
    validateHeadquartersResearchApproval(research, verificationOptions);
  }
  return { coverage: headquartersByRank.size, headquartersByRank };
}

function validateHeadquartersEvidenceArchive(
  data: PrivateEnterpriseRankingData,
  archive: HeadquartersEvidenceArchive,
): Map<string, HeadquartersEvidenceArchiveEntry> {
  if (archive.schemaVersion !== 1 || archive.edition !== data.edition ||
      !Array.isArray(archive.entries) || !isSha256(archive.entriesSha256) ||
      checksum(archive.entries.map(canonicalHeadquartersEvidenceArchiveEntry)) !== archive.entriesSha256) {
    throw new Error("invalid_private_enterprise_headquarters_evidence_archive");
  }
  const byId = new Map<string, HeadquartersEvidenceArchiveEntry>();
  let previousId = "";
  for (const [index, entry] of archive.entries.entries()) {
    if (!isEvidenceId(entry.evidenceId) || entry.evidenceId <= previousId ||
        !isSha256(entry.capturedContentSha256) || typeof entry.capturedContent !== "string" ||
        entry.capturedContent.trim().length < 16 || Buffer.byteLength(entry.capturedContent, "utf8") > 24_000 ||
        capturedContentChecksum(entry.capturedContent) !== entry.capturedContentSha256) {
      throw new Error(`invalid_private_enterprise_headquarters_evidence_archive_entry:${index + 1}`);
    }
    previousId = entry.evidenceId;
    byId.set(entry.evidenceId, entry);
  }
  return byId;
}

export function headquartersResearchCompletionLedgerSha256(
  research: Pick<HeadquartersResearchData,
    "schemaVersion" | "edition" | "rankingRowsSha256" | "frozenAt" | "status" |
    "researchRowsSha256" | "sourceManifestSha256" | "evidenceArchiveSha256">,
): string {
  return checksum({
    schemaVersion: research.schemaVersion,
    edition: research.edition,
    rankingRowsSha256: research.rankingRowsSha256,
    frozenAt: research.frozenAt,
    status: research.status,
    researchRowsSha256: research.researchRowsSha256,
    sourceManifestSha256: research.sourceManifestSha256,
    evidenceArchiveSha256: research.evidenceArchiveSha256,
  });
}

export function headquartersResearchApprovalPayload(
  research: Pick<HeadquartersResearchData,
    "edition" | "rankingRowsSha256" | "frozenAt" | "researchRowsSha256" |
    "sourceManifestSha256" | "evidenceArchiveSha256">,
  approval: Pick<HeadquartersResearchApproval,
    "reviewProtocol" | "reviewerId" | "reviewedAt" | "scope" | "ledgerSha256" |
    "evidenceArchiveSha256" | "publicKeyId">,
) {
  return {
    reviewProtocol: approval.reviewProtocol,
    reviewerId: approval.reviewerId,
    reviewedAt: approval.reviewedAt,
    scope: approval.scope,
    edition: research.edition,
    rankingRowsSha256: research.rankingRowsSha256,
    frozenAt: research.frozenAt,
    researchRowsSha256: research.researchRowsSha256,
    sourceManifestSha256: research.sourceManifestSha256,
    evidenceArchiveSha256: research.evidenceArchiveSha256,
    ledgerSha256: approval.ledgerSha256,
    publicKeyId: approval.publicKeyId,
  };
}

function validateHeadquartersResearchApproval(
  research: HeadquartersResearchData,
  verificationOptions: HeadquartersResearchVerificationOptions,
): void {
  const approval = research.completionApproval;
  const publicKey = verificationOptions.approvalPublicKey?.trim();
  const publicKeyId = verificationOptions.approvalPublicKeyId?.trim();
  const latestEvidenceRetrievedOn = research.entries.reduce((latest, entry) =>
    entry.headquarters.evidence.reduce(
      (current, evidence) => evidence.retrievedOn > current ? evidence.retrievedOn : current,
      latest,
    ), research.frozenAt);
  if (!approval || approval.reviewProtocol !== 1 || !approval.reviewerId?.trim() ||
      !isIsoDate(approval.reviewedAt) || approval.reviewedAt < research.frozenAt ||
      approval.reviewedAt < latestEvidenceRetrievedOn ||
      approval.scope !== "2026_private_enterprise_top_500_headquarters" ||
      approval.ledgerSha256 !== headquartersResearchCompletionLedgerSha256(research) ||
      approval.evidenceArchiveSha256 !== research.evidenceArchiveSha256 ||
      !isPublicKeyId(approval.publicKeyId) || !publicKey || !publicKeyId ||
      approval.publicKeyId !== publicKeyId) {
    throw new Error("invalid_private_enterprise_headquarters_research_approval");
  }
  const keyBytes = decodeBase64(publicKey);
  const signature = decodeBase64(approval.signature);
  if (!keyBytes || !signature || signature.length !== 64) {
    throw new Error("invalid_private_enterprise_headquarters_research_approval");
  }
  try {
    const key = createPublicKey({ key: keyBytes, format: "der", type: "spki" });
    const payload = Buffer.from(JSON.stringify(headquartersResearchApprovalPayload(research, approval)), "utf8");
    if (key.asymmetricKeyType !== "ed25519" || !verifySignature(null, payload, key, signature)) {
      throw new Error("signature_invalid");
    }
  } catch {
    throw new Error("invalid_private_enterprise_headquarters_research_approval");
  }
}

function canonicalHeadquartersResearchEntry(entry: HeadquartersResearchEntry) {
  return {
    rank: entry.rank,
    enterpriseName: entry.enterpriseName,
    rankingRowSha256: entry.rankingRowSha256,
    entityMatch: entry.entityMatch,
    headquarters: {
      province: entry.headquarters?.province,
      city: entry.headquarters?.city,
      administrativeLevel: entry.headquarters?.administrativeLevel,
      asOf: entry.headquarters?.asOf,
      evidence: entry.headquarters?.evidence?.map((evidence) => ({
        evidenceId: evidence.evidenceId,
        authority: evidence.authority,
        publisher: evidence.publisher,
        sourceUrl: evidence.sourceUrl,
        sourcePublishedOn: evidence.sourcePublishedOn,
        claimAsOf: evidence.claimAsOf,
        retrievedOn: evidence.retrievedOn,
        capturedContentSha256: evidence.capturedContentSha256,
        sourceSubject: evidence.sourceSubject,
        claimText: evidence.claimText,
        entityRelationText: evidence.entityRelationText,
      })),
    },
  };
}

function researchSourceManifest(entries: HeadquartersResearchEntry[]) {
  return entries.flatMap((entry) => entry.headquarters?.evidence?.map((evidence) => ({
    rank: entry.rank,
    enterpriseName: entry.enterpriseName,
    rankingRowSha256: entry.rankingRowSha256,
    evidenceId: evidence.evidenceId,
    authority: evidence.authority,
    publisher: evidence.publisher,
    sourceUrl: evidence.sourceUrl,
    sourcePublishedOn: evidence.sourcePublishedOn,
    claimAsOf: evidence.claimAsOf,
    retrievedOn: evidence.retrievedOn,
    capturedContentSha256: evidence.capturedContentSha256,
    sourceSubject: evidence.sourceSubject,
    claimText: evidence.claimText,
    entityRelationText: evidence.entityRelationText,
  })) ?? []);
}

function canonicalHeadquartersEvidenceArchiveEntry(entry: HeadquartersEvidenceArchiveEntry) {
  return {
    evidenceId: entry.evidenceId,
    capturedContentSha256: entry.capturedContentSha256,
    capturedContent: entry.capturedContent,
  };
}

function rankingRowChecksum(entry: Pick<RankedEnterprise, "rank" | "name" | "province" | "revenueWan">): string {
  return checksum({
    rank: entry.rank,
    name: entry.name,
    province: entry.province,
    revenueWan: entry.revenueWan,
  });
}

function withoutHeadquarters(entry: RankedEnterprise): RankedEnterprise {
  const { headquarters: _headquarters, ...rankingEntry } = entry;
  return rankingEntry;
}

function isValidHeadquartersEvidence(
  entry: HeadquartersResearchEntry,
  headquarters: HeadquartersResearchEntry["headquarters"],
  evidence: HeadquartersEvidence,
  frozenAt: string,
  archiveById: ReadonlyMap<string, HeadquartersEvidenceArchiveEntry>,
): boolean {
  const archived = archiveById.get(evidence.evidenceId);
  const normalizedClaim = normalize(evidence.claimText ?? "");
  const normalizedSubject = normalize(evidence.sourceSubject ?? "");
  const normalizedEnterprise = normalize(entry.enterpriseName ?? "");
  const normalizedEntityMatch = normalize(entry.entityMatch ?? "");
  const sourceSubjectIsExactEnterprise = normalizedSubject === normalizedEnterprise;
  const entityMatchIsDocumented = sourceSubjectIsExactEnterprise
    ? normalizedEntityMatch.includes(normalizedEnterprise)
    : hasIndependentEntityMentions(normalizedEntityMatch, normalizedEnterprise, normalizedSubject);
  const entityRelationIsSourced = sourceSubjectIsExactEnterprise || (
    sourceCitedSameEntityNameContinuity(
      evidence.entityRelationText,
      entry.enterpriseName,
      evidence.sourceSubject,
    )
  );
  const claimBindsSubjectToHeadquartersCity = sourceClaimBindsSubjectToHeadquartersCity(
    evidence.claimText,
    evidence.sourceSubject,
    headquarters.city,
  );
  const supportsFrozenHeadquartersDate = evidence.claimAsOf !== headquarters.asOf ||
    isWithinHeadquartersSupportWindow(evidence.sourcePublishedOn, frozenAt) &&
    isWithinHeadquartersSupportWindow(evidence.claimAsOf, frozenAt);
  return isEvidenceId(evidence.evidenceId) &&
    (evidence.authority === "enterprise" || evidence.authority === "government") &&
    Boolean(evidence.publisher?.trim()) && isEvidenceUrl(evidence.sourceUrl) &&
    isIsoDate(evidence.sourcePublishedOn) && isIsoDate(evidence.claimAsOf) &&
    isIsoDate(evidence.retrievedOn) && evidence.sourcePublishedOn <= frozenAt &&
    evidence.claimAsOf <= frozenAt && evidence.claimAsOf <= evidence.sourcePublishedOn &&
    evidence.retrievedOn >= evidence.sourcePublishedOn && isSha256(evidence.capturedContentSha256) &&
    normalizedSubject.length >= 2 && normalizedClaim.length >= 8 &&
    claimBindsSubjectToHeadquartersCity &&
    entityMatchIsDocumented &&
    entityRelationIsSourced &&
    supportsFrozenHeadquartersDate && Boolean(archived) &&
    archived!.capturedContentSha256 === evidence.capturedContentSha256 &&
    archived!.capturedContent.includes(evidence.sourceSubject) &&
    archived!.capturedContent.includes(evidence.claimText) &&
    (sourceSubjectIsExactEnterprise || archived!.capturedContent.includes(evidence.entityRelationText ?? ""));
}

/**
 * Verify a self-contained source quotation or source table row. The exact
 * source subject, an explicit headquarters predicate, and the canonical city
 * (or a narrowly allowed source-faithful form) must appear in one clause.
 * Splitting on Chinese commas is intentional: a city mentioned after a comma
 * cannot be borrowed to turn a different headquarters location into evidence.
 */
function sourceClaimBindsSubjectToHeadquartersCity(
  claimText: string,
  sourceSubject: string,
  canonicalCity: string,
): boolean {
  if (typeof claimText !== "string" || typeof sourceSubject !== "string" || typeof canonicalCity !== "string") {
    return false;
  }
  const subject = compactSourceQuoteText(sourceSubject);
  if (!subject) return false;
  const cityForms = headquartersCitySourceForms(canonicalCity)
    .map(compactSourceQuoteText)
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  if (cityForms.length === 0) return false;

  const canonicalCityForm = compactSourceQuoteText(canonicalCity);
  const cityPattern = cityForms.map((cityForm) =>
    `${escapeRegex(cityForm)}${cityForm === canonicalCityForm ? "" : "(?=$|[^\\u4e00-\\u9fff])"}`,
  ).join("|");
  // The subject must begin as its own token. Without this boundary, a short
  // source subject could be borrowed from the tail of another Chinese or
  // Latin-named entity (for example `京东` from `北京京东`).
  const subjectPattern = `(?<![\\p{L}\\p{N}])${escapeRegex(subject)}`;
  const headquartersLabel = "(?:总部所在地|总部地址|总部|总公司)";
  const headquartersLocationVerb = "(?:位于|坐落于|坐落在|设于|设在|在|为|是|[:：])";
  const administrativePrefix = "(?:(?:中国|中华人民共和国)?[\\u4e00-\\u9fff]{2,12}(?:省|自治区|特别行政区))?";
  const naturalClause = new RegExp(
    `${subjectPattern}(?:的)?${headquartersLabel}${headquartersLocationVerb}${administrativePrefix}(?:${cityPattern})`,
    "u",
  );
  // A source table row may use explicit labels and a column separator instead
  // of prose, but must still carry all three fields in that one quoted row.
  const tableRow = new RegExp(
    `${subjectPattern}(?:[:：|])+${headquartersLabel}(?:[:：|]|为|是)+(?:${cityPattern})`,
    "u",
  );
  return splitSourceQuoteClauses(claimText).some((clause) => {
    const compactClause = compactSourceQuoteText(clause);
    return naturalClause.test(compactClause) || tableRow.test(compactClause);
  });
}

function headquartersCitySourceForms(city: string): string[] {
  const forms = new Set([city]);
  if (city.endsWith("市")) {
    forms.add(city.slice(0, -1));
  }
  const autonomousPrefectureAlias = AUTONOMOUS_PREFECTURE_SHORT_ALIASES.get(city);
  if (autonomousPrefectureAlias) forms.add(autonomousPrefectureAlias);
  return [...forms];
}

function splitSourceQuoteClauses(value: string): string[] {
  return value.normalize("NFKC").split(/[，,。！？!?；;\r\n]/u);
}

function compactSourceQuoteText(value: string): string {
  return value.normalize("NFKC").replace(/[\s\u3000]/gu, "");
}

function escapeRegex(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
}

function sourceCitedSameEntityNameContinuity(
  relationText: unknown,
  enterpriseName: string,
  sourceSubject: string,
): boolean {
  if (typeof relationText !== "string") return false;
  if (typeof enterpriseName !== "string" || typeof sourceSubject !== "string") return false;
  const enterprise = compactSourceQuoteText(enterpriseName);
  const subject = compactSourceQuoteText(sourceSubject);
  if (!enterprise || !subject || enterprise === subject) return false;
  const compactRelation = compactSourceQuoteText(relationText);
  // A short name can occur inside a longer legal name. Require a separate
  // occurrence in the quoted relationship before the continuity grammar can
  // bind it, rather than accepting a prefix/suffix of the other entity.
  if (!hasIndependentEntityMentions(compactRelation, enterprise, subject)) return false;

  // This is intentionally narrower than an ownership mapping. Each accepted
  // form says that the two names are the same entity across a rename or a
  // documented alias. A subsidiary, holding-company, or brand relationship
  // never proves that two entities share a headquarters.
  const nameContinuityMarker = "(?:以下简称|简称(?:为)?|又称|亦称|即(?:为)?|原名(?:为)?|原称(?:为)?|曾用名(?:称)?(?:为)?|更名为|变更为)";
  const relationGap = "(?:[\\s\\u3000，,、:：()（）\"“”'‘’]|的){0,8}";
  const identityVerb = "(?:是|为|系)";
  const directNameContinuity = (left: string, right: string) => [
    // `left` must also begin as an independent token. The following grammar
    // already constrains its right side to a continuity relation.
    // In `X原名为Y`, Y terminates the relation. Do not let a short source
    // name match only the leading part of a longer legal name such as
    // `京东` inside `京东集团`.
    new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(left)}${relationGap}(?:的|已|曾|现)?${nameContinuityMarker}${relationGap}${escapeRegex(right)}(?=$|[^\\u4e00-\\u9fff])`, "u"),
    new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(left)}${relationGap}${identityVerb}${relationGap}${escapeRegex(right)}${relationGap}(?:的)?${nameContinuityMarker}`, "u"),
  ];
  return directNameContinuity(enterprise, subject).some((pattern) => pattern.test(compactRelation)) ||
    directNameContinuity(subject, enterprise).some((pattern) => pattern.test(compactRelation));
}

function hasIndependentEntityMentions(
  normalizedText: string,
  normalizedEnterprise: string,
  normalizedSubject: string,
): boolean {
  if (!normalizedEnterprise || !normalizedSubject) return false;
  if (!normalizedEnterprise.includes(normalizedSubject) && !normalizedSubject.includes(normalizedEnterprise)) {
    return normalizedText.includes(normalizedEnterprise) && normalizedText.includes(normalizedSubject);
  }

  const [longer, shorter] = normalizedEnterprise.length >= normalizedSubject.length
    ? [normalizedEnterprise, normalizedSubject]
    : [normalizedSubject, normalizedEnterprise];
  const longerPositions = allStringPositions(normalizedText, longer);
  return longerPositions.length > 0 && allStringPositions(normalizedText, shorter).some((position) =>
    !longerPositions.some((longerPosition) =>
      position >= longerPosition && position + shorter.length <= longerPosition + longer.length));
}

function allStringPositions(value: string, needle: string): number[] {
  if (!needle) return [];
  const positions: number[] = [];
  let position = value.indexOf(needle);
  while (position >= 0) {
    positions.push(position);
    position = value.indexOf(needle, position + 1);
  }
  return positions;
}

function isWithinHeadquartersSupportWindow(value: string, frozenAt: string): boolean {
  if (!isIsoDate(value) || !isIsoDate(frozenAt) || value > frozenAt) return false;
  const cutoff = new Date(`${frozenAt}T00:00:00.000Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - HEADQUARTERS_SUPPORT_MAX_AGE_DAYS);
  return value >= cutoff.toISOString().slice(0, 10);
}

function isEvidenceId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]{2,127}$/u.test(value);
}

function isPublicKeyId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u.test(value);
}

function capturedContentChecksum(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function decodeBase64(value: unknown): Buffer | undefined {
  if (typeof value !== "string" || value.length < 4 || value.length > 16_384) return undefined;
  const normalized = value.replace(/-/gu, "+").replace(/_/gu, "/");
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(normalized)) return undefined;
  const decoded = Buffer.from(normalized, "base64");
  return decoded.length ? decoded : undefined;
}

function isCanonicalProvince(value: unknown): value is string {
  return typeof value === "string" && /^(?:[\u4e00-\u9fff]{2,12}(?:省|市|自治区|特别行政区)|新疆生产建设兵团)$/u.test(value);
}

function isCanonicalHeadquartersCity(
  value: unknown,
  administrativeLevel: unknown,
): value is string {
  if (typeof value !== "string" ||
      (administrativeLevel !== "municipality" && administrativeLevel !== "prefecture")) return false;
  if (administrativeLevel === "municipality") return MUNICIPALITIES.has(value);
  return !MUNICIPALITIES.has(value) && /^[\u4e00-\u9fff]{2,12}(?:市|自治州|地区|盟|特别行政区)$/u.test(value);
}

function isEvidenceUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "").replace(/\.$/u, "");
    return url.protocol === "https:" && !url.username && !url.password && Boolean(hostname) &&
      (!url.port || url.port === "443") && isIP(hostname) === 0 && !isReservedEvidenceHostname(hostname);
  } catch {
    return false;
  }
}

function isReservedEvidenceHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost") ||
    hostname === "example" || hostname.endsWith(".example") ||
    hostname === "example.com" || hostname.endsWith(".example.com") ||
    hostname === "example.net" || hostname.endsWith(".example.net") ||
    hostname === "example.org" || hostname.endsWith(".example.org") ||
    ["test", "invalid", "local", "internal", "home"].includes(hostname) ||
    hostname.endsWith(".test") || hostname.endsWith(".invalid") ||
    hostname.endsWith(".local") || hostname.endsWith(".internal") || hostname.endsWith(".home");
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function checksum(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
