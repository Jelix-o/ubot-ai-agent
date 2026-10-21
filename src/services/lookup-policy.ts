import { detectRealtimeIntent } from "./realtime-lookup-service.js";
import { planWebQueries } from "./web-search-policy.js";

export interface LookupDecision {
  lookupRequired?: boolean;
  lookupQuery?: string;
  lookupSubject?: string;
  lookupFallbackQueries?: string[];
}

// These are transformations of supplied material, not requests for fresh facts.
const TRANSFORM_REQUEST = /(?:翻译(?:成|为|一下)?|译成|润色|改写|续写|编写|写(?:一|个|篇|段|首|封|份)|创作|编个|构思)/u;
const WORK_FACT = /(?:剧情|结局|主线|战役|发售|上市|发布日期|发布会|版本号|更新日志|产品参数|硬件参数)/u;
const FACT_CHECK = /(?:不对|你错了|真的吗|属实|核实|查证|有来源|有依据|联网|搜索|查一下)/u;
const FACT_QUESTION = /(?:[?？]|是什么|有哪些|怎么样|如何|多少|什么|结果|怎么|何时|哪(?:天|个|些)|是否|吗$)/u;
const EXPLICIT_LOOKUP = /(?:联网|搜索|查证|核实|查(?:一下|一查|看))/u;

export function lookupByRules(text: string): LookupDecision {
  if (TRANSFORM_REQUEST.test(text)) return { lookupRequired: false };
  if (detectRealtimeIntent(text) || (WORK_FACT.test(text) && FACT_QUESTION.test(text))) {
    return { lookupRequired: true, lookupQuery: text.trim().slice(0, 240) };
  }
  return {};
}

export function isFactCheck(text: string): boolean {
  return FACT_CHECK.test(text);
}

/** Explicit requests and transformation exclusions also protect model fallbacks. */
export function resolveLookupDecision(text: string, semantic: LookupDecision = {}): LookupDecision {
  const rules = lookupByRules(text);
  if (rules.lookupRequired === false) return rules;
  const kind = detectRealtimeIntent(text);
  const strongRequest = EXPLICIT_LOOKUP.test(text) || kind === "weather" || kind === "stock" ||
    (WORK_FACT.test(text) && FACT_QUESTION.test(text));
  const required = semantic.lookupRequired === false && !strongRequest
    ? false : rules.lookupRequired === true || semantic.lookupRequired;
  if (required === undefined) return {};
  return required
    ? { lookupRequired: true, ...planWebQueries(text, { ...semantic, lookupQuery: semantic.lookupQuery || rules.lookupQuery }) }
    : { lookupRequired: false };
}
