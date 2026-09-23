import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export interface RankedEnterprise {
  rank: number;
  name: string;
  province: string;
  revenueWan: number;
  headquarters?: {
    city: string;
    sourceUrl: string;
    asOf: string;
  };
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
  province?: string;
  provinces?: string[];
  city?: string;
  limit?: number;
}

const CITY_PENDING = "2026中国民营企业500强榜单只公布省份。500家企业的总部城市尚未全部核验，暂不能给出地级市的准确家数或名单。";
const EDITION = "2026中国民营企业500强";
const LIST_BATCH_SIZE = 20;
const MUNICIPALITIES = new Set(["北京市", "天津市", "上海市", "重庆市"]);
const REGIONS_WITHOUT_ENTRIES = ["黑龙江省", "甘肃省", "青海省", "西藏自治区"];

export function loadPrivateEnterpriseRanking(): PrivateEnterpriseRanking {
  const assetUrl = new URL("../../assets/private-enterprises-2026.json", import.meta.url);
  return new PrivateEnterpriseRanking(JSON.parse(readFileSync(assetUrl, "utf8")) as PrivateEnterpriseRankingData);
}

export class PrivateEnterpriseRanking {
  readonly data: PrivateEnterpriseRankingData;
  readonly cityCoverage: number;
  readonly cityReady: boolean;
  private readonly provinces: string[];
  private readonly regions: string[];

  constructor(data: PrivateEnterpriseRankingData) {
    validateRanking(data);
    this.data = data;
    this.cityCoverage = data.entries.filter((entry) => entry.headquarters).length;
    this.cityReady = this.cityCoverage === 500;
    this.provinces = [...new Set(data.entries.map((entry) => entry.province))];
    this.regions = [...this.provinces, ...REGIONS_WITHOUT_ENTRIES];
  }

  listPage(args: RankingPageArgs) {
    const query = normalize(args.query ?? "");
    const province = this.provinces.find((item) => normalize(item) === normalize(args.province ?? ""));
    const city = normalize(args.city ?? "");
    const matched = this.data.entries.filter((entry) =>
      (!query || normalize(`${entry.rank} ${entry.name} ${entry.province}`).includes(query)) &&
      (!args.province || entry.province === province) &&
      (!city || (this.cityReady && normalize(entry.headquarters?.city ?? "") === city))
    );
    const pageSize = Math.min(100, Math.max(1, Math.trunc(args.pageSize) || 20));
    const totalPages = Math.max(1, Math.ceil(matched.length / pageSize));
    const page = Math.min(totalPages, Math.max(1, Math.trunc(args.page) || 1));
    return {
      items: matched.slice((page - 1) * pageSize, page * pageSize),
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
    const years = [...text.matchAll(/20\d{2}/g)].map((match) => Number(match[0]));
    if (years.some((year) => year !== 2026)) {
      return /民营|民企|500强/.test(text) && /排名|名次|第几|多少家|几家|哪些|名单|分别是|最多|最少|比较|哪个省|哪个地区/.test(text)
        ? { messages: ["目前知识库仅收录2026中国民营企业500强，不能用这份榜单回答其他年份的名次或地区统计。"] }
        : undefined;
    }

    const scope = /民营|民企|500强|2026/.test(text);
    const rankIntent = /排名|名次|排(?:第)?几(?:名|位)?|第几(?:名|位)?|多少名|排多少|位列|第\s*\d+\s*(?:名|位)/.test(text);
    const listIntent = /哪些|哪几家|分别是|名单|有谁|都有哪些/.test(text);
    const countIntent = /多少家|几家|上榜|入围/.test(text);
    const previousAssistantContent = history.at(-1)?.role === "assistant"
      ? history.at(-1)?.content ?? ""
      : "";
    const rankingContextActive = previousAssistantContent.includes(EDITION);
    const prior = rankingContextActive
      ? [...history].reverse().find((turn) => turn.role === "user")?.content
      : undefined;
    const extremeIntent = /(?:哪个|哪|那个|什么)(?:省|地区)(?:[^？?。]{0,12})?(?:最多|最少)|(?:最多|最少)(?:的|是)?(?:哪个|哪|什么)(?:省|地区)|(?:各省|省份|地区).*(?:最多|最少)/.test(text);
    const followup = Boolean(!scope && (
      /^(?:分别是哪些|有哪些|都有哪些|哪几家|名单)(?:[？?。])?$/.test(text.trim()) ||
      (rankingContextActive && extremeIntent)
    ));
    const question = followup && prior ? prior : text;
    let provinceMatches = this.matchProvinces(question);
    // A follow-up such as "分别是哪些" after "哪个省最多" has no province
    // in the user's preceding text. The immediately preceding deterministic
    // answer is the authoritative context for recovering that province.
    if (followup && provinceMatches.length === 0 && rankingContextActive) {
      provinceMatches = this.matchProvinces(previousAssistantContent);
    }
    const exactRank = text.match(/第\s*(\d{1,3})\s*(?:名|位)/);
    const rankLookupIntent = Boolean(exactRank && /谁|哪家|什么(?:公司|企业)?|是哪(?:家|个)?/.test(text));
    const companyMatches = rankIntent ? this.matchEnterprises(text) : [];
    const compareIntent = provinceMatches.length > 1 && /(?:哪个|哪(?:个)?|谁|比较|多(?:一些|一点|几家)?|少(?:一些|一点|几家)?)/.test(text);
    if (!scope && !followup && !(provinceMatches.length > 0 && (rankIntent || countIntent || listIntent)) &&
        !(rankIntent && (companyMatches.length > 0 || rankingContextActive || rankLookupIntent)) && !extremeIntent &&
        !compareIntent) {
      return undefined;
    }
    if (!rankIntent && !listIntent && !countIntent && !followup && !extremeIntent && !compareIntent) return undefined;

    if (extremeIntent) {
      return this.answerProvinceExtreme(/最少/.test(text) ? "min" : "max");
    }

    if (rankIntent || (countIntent && /有无|有没有|是否|哪家|公司|企业/.test(text) && !/多少家|几家/.test(text))) {
      if (exactRank && rankLookupIntent) {
        return this.answerRank(Number(exactRank[1]));
      }
      const candidates = companyMatches;
      if (candidates.length > 1) {
        return { messages: [`找到多个可能的企业：${candidates.slice(0, 5).map((item) => item.name).join("、")}。请使用榜单中的完整名称。`] };
      }
      if (candidates.length === 1) {
        const entry = candidates[0]!;
        return { messages: [`${entry.name}在${EDITION}中排名第${entry.rank}，榜单省份为${entry.province}（按2025年营收排序）。`] };
      }
      if (provinceMatches.length === 0 && !/多少家|几家/.test(text)) {
        return { messages: [`没有在${EDITION}中找到该企业；请提供榜单企业的完整名称。`] };
      }
    }

    if (provinceMatches.length > 1) {
      if (compareIntent) {
        return this.answerProvinceComparison(provinceMatches);
      }
      return { messages: ["请一次指定一个省级地区，以便给出准确的家数和名单。"] };
    }
    const province = provinceMatches[0];
    if (!province && /全国|总共|总计/.test(text) && countIntent) {
      return { messages: [`${EDITION}共500家，按2025年营收排序。`] };
    }
    const cityRequested = this.isCityRequest(text, province);
    if (cityRequested && !this.cityReady) return { messages: [CITY_PENDING] };

    if (this.cityReady && cityRequested) {
      const cities = [...new Set(this.data.entries.map((entry) => entry.headquarters!.city))]
        .filter((city) => normalize(text).includes(normalize(city)) || normalize(text).includes(normalize(city).replace(/市$/, "")));
      if (cities.length !== 1) return { messages: ["请明确指定一个地级市的完整名称。"] };
      return this.formatRegion(cities[0]!, this.data.entries.filter((entry) => entry.headquarters?.city === cities[0]), listIntent || followup, "city");
    }
    if (province) {
      return this.formatRegion(province, this.data.entries.filter((entry) => entry.province === province), listIntent || followup);
    }
    if (countIntent || listIntent || followup) {
      return { messages: [this.cityReady ? "请指定一个省份或地级市。" : `请指定榜单中的省级地区。${CITY_PENDING}`] };
    }
    return undefined;
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

  private answerProvinceLeaderboard(limit: number | undefined): RankingAnswer {
    const rows = this.provinceCounts().slice(0, Math.min(20, Math.max(1, Math.trunc(limit ?? 10))));
    return { messages: [`${EDITION}省级地区上榜家数：${rows.map((row, index) => `${index + 1}. ${row.province}${row.count}家`).join("；")}（按榜单省份；2025年营收）。`] };
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
    const candidate = normalize(text.replace(/20\d{2}年?|中国|全国|民营企业|民企|500强|排名|名次|排(?:第)?几(?:名|位)?|排第几|第几名|第几位|多少名|排多少|位列|在|的|是|多少|几|第|名|请问|帮我|查一下|告诉我|上榜|入围|了吗|吗|呢|公司|企业|[？?！!。，、\s]/g, ""));
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
    if (MUNICIPALITIES.has(province ?? "") && !/省|自治区/.test(text)) return false;
    if (/市(?:有|共|的|多少|几家|哪些|民营|500强)|地级市|总部城市/.test(text)) return true;
    if (province) {
      const short = province.replace(/壮族自治区|回族自治区|维吾尔自治区|自治区|省|市$/, "");
      const fullPosition = text.indexOf(province);
      const shortPosition = text.indexOf(short);
      if (fullPosition < 0 && shortPosition < 0) return false;
      const suffix = text.slice(fullPosition >= 0 ? fullPosition + province.length : shortPosition + short.length);
      if (/^(?!一共|所有|全部|企业|民营|分别|排名)[\u4e00-\u9fa5]{2,4}(?:市)?(?:有|共|的|多少|几家|哪些)/.test(suffix)) return true;
      return /省.{2,8}市/.test(text);
    }
    if (/哪个|哪些地区|各省|请指定/.test(text)) return false;
    return /多少家|几家|哪些|哪几家|名单|分别是/.test(text);
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

function validateRanking(data: PrivateEnterpriseRankingData): void {
  if (data.edition !== 2026 || data.revenueYear !== 2025 || data.entries?.length !== 500 ||
      !/^https:\/\//.test(data.rankingSource) || !/^[a-f0-9]{64}$/.test(data.screenshotSha256) ||
      !/^[a-f0-9]{64}$/.test(data.transcriptionRowsSha256) ||
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
    if (entry.headquarters && (!entry.headquarters.city?.trim() ||
        !/^https:\/\//.test(entry.headquarters.sourceUrl) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(entry.headquarters.asOf))) {
      throw new Error(`invalid_private_enterprise_headquarters:${index + 1}`);
    }
  }
  const canonical = data.entries.map(({ rank, name, province, revenueWan }) => ({ rank, name, province, revenueWan }));
  const hash = createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
  if (hash !== data.rowsSha256) throw new Error("private_enterprise_ranking_checksum_mismatch");
}
