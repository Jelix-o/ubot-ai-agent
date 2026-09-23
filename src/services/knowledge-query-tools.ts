import type { KnowledgeBaseEntry } from "../types.js";
import type { AiToolCall, AiToolRuntime } from "./ai-service.js";
import type { KnowledgeBaseStore } from "./knowledge-base-store.js";
import {
  type PrivateEnterpriseToolOperation,
  type PrivateEnterpriseToolQuery,
  type PrivateEnterpriseRanking,
} from "./private-enterprise-ranking.js";

const MAX_FAQ_QUERY_CHARS = 400;
const MAX_FAQ_RESULT_CHARS = 6_000;
const MAX_FAQ_DIRECTORY_ENTRIES = 50;

const RANKING_OPERATIONS: readonly PrivateEnterpriseToolOperation[] = [
  "company_lookup",
  "rank_lookup",
  "province_count",
  "province_list",
  "province_compare",
  "province_max",
  "province_min",
  "province_leaderboard",
  "national_count",
  "city_count",
  "city_list",
];

const privateEnterpriseRankingTool = {
  name: "query_private_enterprise_ranking",
  description: "查询经核验的2026中国民营企业500强。企业名次、省级家数和名单、地区比较、榜单名次、总部城市门槛都必须调用此工具；不要凭记忆回答。",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["operation"],
    properties: {
      operation: { type: "string", enum: RANKING_OPERATIONS },
      edition: { type: "integer", description: "榜单年份；省略时默认2026。明确询问其他年份时必须传入该年份。" },
      company: { type: "string", description: "企业名称或唯一简称，用于 company_lookup" },
      rank: { type: "integer", minimum: 1, maximum: 500, description: "用于 rank_lookup" },
      province: { type: "string", description: "省级地区，用于 province_count 或 province_list" },
      provinces: { type: "array", minItems: 2, maxItems: 8, items: { type: "string" }, description: "用于 province_compare" },
      city: { type: "string", description: "总部城市，用于 city_count 或 city_list" },
      limit: { type: "integer", minimum: 1, maximum: 20, description: "用于 province_leaderboard" },
    },
  },
} as const;

const groupFaqTool = {
  name: "search_group_faq",
  description: "检索当前QQ群已启用的管理员FAQ、制度、流程和固定答案。只能用于当前群；资料未命中时不要编造。",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["query"],
    properties: {
      query: { type: "string", minLength: 1, maxLength: MAX_FAQ_QUERY_CHARS, description: "用简短关键词或用户问题检索当前群FAQ" },
    },
  },
} as const;

export interface KnowledgeToolRuntimeOptions {
  groupId: string;
  ranking?: PrivateEnterpriseRanking;
  knowledgeBaseStore?: Pick<KnowledgeBaseStore, "search" | "listEnabledDirectory">;
  /** Re-check the global capability at execution time, after the model chose a tool. */
  isKnowledgeEnabled?: () => boolean;
  /** For an unmistakable ranking request, force a single native lookup rather than allowing a model guess. */
  forceRankingTool?: boolean;
  /** For an explicit group-rule / FAQ request, require a current-group FAQ lookup. */
  forceGroupFaqTool?: boolean;
}

/**
 * Builds a group-bound, read-only runtime for native model tool calls.  Tool
 * arguments never contain a group id, so the model cannot select another
 * group's FAQ pack.
 */
export function createKnowledgeToolRuntime(options: KnowledgeToolRuntimeOptions): AiToolRuntime | undefined {
  const tools = [
    ...(options.ranking ? [privateEnterpriseRankingTool] : []),
    ...(options.knowledgeBaseStore ? [groupFaqTool] : []),
  ];
  if (tools.length === 0) return undefined;

  return {
    tools,
    ...(options.forceRankingTool && options.ranking
      ? { forceToolName: privateEnterpriseRankingTool.name }
      : options.forceGroupFaqTool && options.knowledgeBaseStore
        ? { forceToolName: groupFaqTool.name }
        : {}),
    async execute(call) {
      if (options.isKnowledgeEnabled && !options.isKnowledgeEnabled()) {
        return {
          finalMessages: ["该功能当前未启用，请联系管理员处理。"],
          content: JSON.stringify({ status: "unavailable", code: "knowledge_capability_disabled" }),
        };
      }
      if (call.name === privateEnterpriseRankingTool.name && options.ranking) {
        return executeRankingTool(options.ranking, call);
      }
      if (call.name === groupFaqTool.name && options.knowledgeBaseStore) {
        return executeGroupFaqTool(options.groupId, options.knowledgeBaseStore, call);
      }
      return { content: JSON.stringify({ status: "error", code: "unknown_or_unavailable_tool" }) };
    },
  };
}

function executeRankingTool(ranking: PrivateEnterpriseRanking, call: AiToolCall) {
  const parsed = parseObject(call.arguments);
  const input = hasOnlyKeys(parsed, RANKING_ARGUMENT_KEYS) ? normalizeRankingQuery(parsed) : undefined;
  if (!input) {
    return {
      finalMessages: ["榜单查询参数无效，请明确企业、名次、省级地区或总部城市。"],
      content: JSON.stringify({ status: "error", code: "invalid_ranking_query" }),
    };
  }
  const answer = ranking.query(input);
  return {
    finalMessages: answer.messages,
    content: JSON.stringify({ status: "terminal", messageCount: answer.messages.length }),
  };
}

async function executeGroupFaqTool(
  groupId: string,
  store: Pick<KnowledgeBaseStore, "search" | "listEnabledDirectory">,
  call: AiToolCall,
) {
  const parsed = parseObject(call.arguments);
  const rawQuery = hasOnlyKeys(parsed, FAQ_ARGUMENT_KEYS) && typeof parsed?.query === "string" ? parsed.query.trim() : "";
  const query = rawQuery.length <= MAX_FAQ_QUERY_CHARS ? rawQuery : "";
  if (!query) {
    return {
      finalMessages: ["当前群知识库查询参数无效，无法核验这项内容。"],
      content: JSON.stringify({ status: "error", code: "invalid_faq_query" }),
    };
  }

  try {
    const hits = await store.search(groupId, query, 3);
    if (hits.length > 0) {
      return { content: serializeFaqData({ status: "found", entries: hits.map((hit) => hit.entry) }, true) };
    }
    const directory = await store.listEnabledDirectory(groupId, MAX_FAQ_DIRECTORY_ENTRIES);
    return {
      finalMessages: [directory.length === 0
        ? "当前群没有可检索的已启用知识库内容，无法核验这项内容。"
        : "当前群知识库未找到可核验的相关内容，请换个关键词或联系管理员补充。"],
      content: serializeFaqData({
        status: "no_match",
        entries: directory,
        message: directory.length === 0 ? "当前群没有可检索的已启用FAQ。" : "未命中；可基于目录换关键词重试。",
      }, false),
    };
  } catch {
    return {
      finalMessages: ["当前群知识库暂时不可用，无法核验这项内容。"],
      content: JSON.stringify({ status: "unavailable", code: "group_faq_read_failed" }),
    };
  }
}

function normalizeRankingQuery(value: Record<string, unknown> | undefined): PrivateEnterpriseToolQuery | undefined {
  const operation = typeof value?.operation === "string" && RANKING_OPERATIONS.includes(value.operation as PrivateEnterpriseToolOperation)
    ? value.operation as PrivateEnterpriseToolOperation
    : undefined;
  if (!operation) return undefined;
  if (!hasOnlyKeys(value, allowedKeysForRankingOperation(operation))) return undefined;
  const edition = Number.isInteger(value?.edition) ? Number(value?.edition) : undefined;
  if (value?.edition !== undefined && edition === undefined) return undefined;
  const text = (key: string, max = 160): string | undefined => {
    if (value?.[key] === undefined) return undefined;
    if (typeof value[key] !== "string") return undefined;
    const normalized = value[key].trim();
    return normalized && normalized.length <= max ? normalized : undefined;
  };
  const company = text("company");
  const province = text("province", 40);
  const city = text("city", 40);
  const rank = Number.isInteger(value?.rank) ? Number(value?.rank) : undefined;
  const limit = Number.isInteger(value?.limit) ? Number(value?.limit) : undefined;
  const provinces = Array.isArray(value?.provinces) && value.provinces.length >= 2 && value.provinces.length <= 8 &&
    value.provinces.every((item) => typeof item === "string" && item.trim().length > 0 && item.trim().length <= 40)
    ? value.provinces.map((item) => (item as string).trim())
    : undefined;
  const query: PrivateEnterpriseToolQuery = {
    operation,
    ...(edition !== undefined ? { edition } : {}),
  };
  switch (operation) {
    case "company_lookup":
      return company ? { ...query, company } : undefined;
    case "rank_lookup":
      return rank !== undefined && rank >= 1 && rank <= 500 ? { ...query, rank } : undefined;
    case "province_count":
    case "province_list":
      return province ? { ...query, province } : undefined;
    case "province_compare":
      return provinces ? { ...query, provinces } : undefined;
    case "province_leaderboard":
      return limit === undefined || (limit >= 1 && limit <= 20) ? { ...query, ...(limit !== undefined ? { limit } : {}) } : undefined;
    case "city_count":
    case "city_list":
      return city ? { ...query, city } : undefined;
    case "province_max":
    case "province_min":
    case "national_count":
      return query;
  }
}

const RANKING_ARGUMENT_KEYS = new Set(["operation", "edition", "company", "rank", "province", "provinces", "city", "limit"]);
const FAQ_ARGUMENT_KEYS = new Set(["query"]);

function allowedKeysForRankingOperation(operation: PrivateEnterpriseToolOperation): ReadonlySet<string> {
  const common = ["operation", "edition"];
  switch (operation) {
    case "company_lookup":
      return new Set([...common, "company"]);
    case "rank_lookup":
      return new Set([...common, "rank"]);
    case "province_count":
    case "province_list":
      return new Set([...common, "province"]);
    case "province_compare":
      return new Set([...common, "provinces"]);
    case "province_leaderboard":
      return new Set([...common, "limit"]);
    case "city_count":
    case "city_list":
      return new Set([...common, "city"]);
    case "province_max":
    case "province_min":
    case "national_count":
      return new Set(common);
  }
}

function hasOnlyKeys(value: Record<string, unknown> | undefined, allowed: ReadonlySet<string>): value is Record<string, unknown> {
  if (!value) return false;
  return Object.keys(value).every((key) => allowed.has(key));
}

function serializeFaqData(
  value: { status: "found" | "no_match"; entries: KnowledgeBaseEntry[]; message?: string },
  includeAnswers: boolean,
): string {
  const entries = value.entries.map((entry) => ({
    title: clip(entry.title, 100),
    question: clip(entry.question, 300),
    keywords: entry.keywords.slice(0, 30).map((keyword) => clip(keyword, 80)),
    ...(includeAnswers ? { answer: clip(entry.answer, 1_200) } : {}),
  }));
  const raw = JSON.stringify({ status: value.status, ...(value.message ? { message: value.message } : {}), entries });
  if (raw.length <= MAX_FAQ_RESULT_CHARS) return raw;

  const message = "FAQ结果过长，已截断；请用更具体关键词重试。";
  const bounded: typeof entries = [];
  for (const entry of entries) {
    const candidate = JSON.stringify({ status: value.status, message, entries: [...bounded, entry] });
    if (candidate.length > MAX_FAQ_RESULT_CHARS) break;
    bounded.push(entry);
  }
  return JSON.stringify({ status: value.status, message, entries: bounded });
}

function parseObject(raw: string): Record<string, unknown> | undefined {
  if (typeof raw !== "string" || raw.length > 8_000) return undefined;
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function clip(value: string, max: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}
