#!/usr/bin/env node
import { copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const DEFAULT_DATA_DIR = "/opt/ai-project/data";
const DEFAULT_ENV_PATH = "/opt/ai-project/.env";
const MEMORY_FILE = "group-memory.json";
const CANDIDATE_FILE = "group-memory-candidates.json";

const args = parseArgs(process.argv.slice(2));
const apply = args.apply === true;
const dataDir = args.dataDir || DEFAULT_DATA_DIR;
const envPath = args.env || DEFAULT_ENV_PATH;
const maxAiItems = Number.isFinite(args.maxAiItems) ? Math.max(0, args.maxAiItems) : Number.POSITIVE_INFINITY;
const maxSemanticChecks = Number.isFinite(args.maxSemanticChecks)
  ? Math.max(0, args.maxSemanticChecks)
  : Number.POSITIVE_INFINITY;
const requestTimeoutMs = Number.isFinite(args.timeoutMs) ? Math.max(1000, args.timeoutMs) : 12000;
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
let aiItemsUsed = 0;
let semanticChecksUsed = 0;

const env = await readEnv(envPath);
const profileAi = {
  baseUrl: env.PROFILE_AI_BASE_URL || env.OPENAI_BASE_URL || "",
  apiKey: env.PROFILE_AI_API_KEY || env.OPENAI_API_KEY || "",
  model: env.PROFILE_AI_MODEL || env.OPENAI_MODEL || "",
};

const memoryPath = path.join(dataDir, MEMORY_FILE);
const candidatePath = path.join(dataDir, CANDIDATE_FILE);
const memoryData = await readJson(memoryPath, { memories: [] });
const candidateData = await readJson(candidatePath, { candidates: [] });

const report = {
  apply,
  dataDir,
  model: profileAi.model || "(missing)",
  baseUrl: redactBaseUrl(profileAi.baseUrl),
  memoryCount: memoryData.memories.length,
  candidateCount: candidateData.candidates.length,
  translatedMemories: 0,
  translatedCandidates: 0,
  mergedMemories: 0,
  mergedCandidates: 0,
  regeneratedDailyProfiles: 0,
  skippedAiCalls: 0,
  semanticChecksUsed: 0,
  warnings: [],
};

if (apply) {
  await copyFile(memoryPath, `${memoryPath}.bak-profile-fix-${timestamp}`);
  await copyFile(candidatePath, `${candidatePath}.bak-profile-fix-${timestamp}`);
}

for (const memory of memoryData.memories) {
  if (!shouldChineseRepair(memory)) continue;
  const normalized = await rewriteMemoryToChinese(memory);
  if (!normalized) continue;
  memory.title = normalized.title;
  memory.content = normalized.content;
  memory.updatedAt = new Date().toISOString();
  report.translatedMemories += 1;
}

for (const candidate of candidateData.candidates) {
  if (!shouldChineseRepair(candidate)) continue;
  const normalized = await rewriteMemoryToChinese(candidate);
  if (!normalized) continue;
  candidate.title = normalized.title;
  candidate.content = normalized.content;
  candidate.updatedAt = new Date().toISOString();
  report.translatedCandidates += 1;
}

report.regeneratedDailyProfiles = await regenerateTruncatedDailyProfiles(memoryData.memories);
report.mergedMemories = await mergeDuplicateMemories(memoryData.memories);
report.mergedCandidates = await mergeDuplicateCandidates(candidateData.candidates);
report.semanticChecksUsed = semanticChecksUsed;

if (apply) {
  await writeFile(memoryPath, `${JSON.stringify(memoryData, null, 2)}\n`, "utf8");
  await writeFile(candidatePath, `${JSON.stringify(candidateData, null, 2)}\n`, "utf8");
}

console.log(JSON.stringify(report, null, 2));

async function rewriteMemoryToChinese(item) {
  const result = await chatJson([
    {
      role: "system",
      content: [
        "你是长期记忆中文化助手。",
        "把输入的记忆标题和内容改写为简体中文，保留原事实，不新增事实。",
        "保留 QQ、产品名、模型名、英文专有名词。",
        "只返回 JSON，不要 markdown。",
        'Schema: {"title":"中文标题","content":"中文内容"}',
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify({
        type: item.type,
        subjectUserId: item.subjectUserId,
        title: item.title,
        content: item.content,
      }),
    },
  ], 700);
  if (!result) return null;
  const title = stringValue(result.title).slice(0, 80);
  const content = stringValue(result.content).slice(0, 1200);
  if (!title || !content || !isMostlyChinese(`${title} ${content}`)) {
    report.warnings.push(`translation_failed:${item.id || item.title}`);
    return null;
  }
  return { title, content };
}

async function mergeDuplicateMemories(memories) {
  let merged = 0;
  for (let index = 0; index < memories.length; index += 1) {
    const current = memories[index];
    if (!current || current.enabled === false) continue;
    for (let otherIndex = index + 1; otherIndex < memories.length; otherIndex += 1) {
      const other = memories[otherIndex];
      if (!other || other.enabled === false || !sameScope(current, other)) continue;
      if (memorySimilarity(current, other) < 0.28) continue;
      const relation = await judgeRelation(current, other);
      if (relation !== "duplicate" && relation !== "merge") continue;
      const keep = current.createdAt <= other.createdAt ? current : other;
      const drop = keep === current ? other : current;
      const mergedText = relation === "merge" ? await mergeMemoryText(keep, drop) : null;
      if (mergedText) {
        keep.title = mergedText.title;
        keep.content = mergedText.content;
      } else if (drop.content.length > keep.content.length) {
        keep.title = drop.title;
        keep.content = drop.content;
      }
      keep.confidence = Math.max(Number(keep.confidence || 0), Number(drop.confidence || 0));
      keep.evidence = mergeEvidence(keep.evidence, drop.evidence);
      keep.createdAt = minDate(keep.createdAt, drop.createdAt);
      keep.updatedAt = new Date().toISOString();
      memories.splice(memories.indexOf(drop), 1);
      if (drop === current) index -= 1;
      merged += 1;
      break;
    }
  }
  return merged;
}

async function mergeDuplicateCandidates(candidates) {
  let merged = 0;
  for (let index = 0; index < candidates.length; index += 1) {
    const current = candidates[index];
    if (!current || current.status === "rejected") continue;
    for (let otherIndex = index + 1; otherIndex < candidates.length; otherIndex += 1) {
      const other = candidates[otherIndex];
      if (!other || other.status === "rejected" || !sameScope(current, other)) continue;
      if (memorySimilarity(current, other) < 0.28) continue;
      const relation = await judgeRelation(current, other);
      if (relation !== "duplicate" && relation !== "merge") continue;
      current.title = current.title.length >= other.title.length ? current.title : other.title;
      current.content = current.content.length >= other.content.length ? current.content : other.content;
      current.confidence = Math.max(Number(current.confidence || 0), Number(other.confidence || 0));
      current.evidence = mergeEvidence(current.evidence, other.evidence);
      current.updatedAt = new Date().toISOString();
      candidates.splice(otherIndex, 1);
      otherIndex -= 1;
      merged += 1;
    }
  }
  return merged;
}

async function regenerateTruncatedDailyProfiles(memories) {
  let regenerated = 0;
  for (const memory of memories) {
    if (!memory?.source?.startsWith("daily_profile_review:")) continue;
    if (!looksTruncatedProfile(memory.content)) continue;
    const dateKey = memory.source.slice("daily_profile_review:".length);
    const sourceMemories = memories
      .filter((item) =>
        item.groupId === memory.groupId &&
        item.type === "member_profile" &&
        item.subjectUserId === memory.subjectUserId &&
        item.source !== memory.source &&
        item.source !== "daily_profile_review" &&
        !String(item.source || "").startsWith("daily_profile_review:") &&
        String(item.createdAt || "").slice(0, 10) === dateKey &&
        item.enabled !== false)
      .slice(0, 80);
    if (sourceMemories.length === 0) continue;
    const result = await chatText([
      {
        role: "system",
        content: "你是群成员昨日画像总结助手。基于长期记忆生成一段完整简体中文画像总结，必须完整句结束，不要半句，不要 markdown。",
      },
      {
        role: "user",
        content: JSON.stringify({
          groupId: memory.groupId,
          subjectUserId: memory.subjectUserId,
          dateKey,
          memories: sourceMemories.map((item) => ({ title: item.title, content: item.content })),
        }),
      },
    ], 2200);
    const summary = trimToCompleteSentence(String(result || "").replace(/```(?:text)?|```/gi, "").trim(), 1800);
    if (!summary || !hasSentenceEnd(summary)) continue;
    memory.content = summary;
    memory.updatedAt = new Date().toISOString();
    regenerated += 1;
  }
  return regenerated;
}

async function judgeRelation(left, right) {
  if (semanticChecksUsed >= maxSemanticChecks) {
    report.skippedAiCalls += 1;
    return "new";
  }
  semanticChecksUsed += 1;
  const result = await chatJson([
    {
      role: "system",
      content: [
        "你是长期记忆语义去重审核器。",
        "比较两条记忆是否表达同一事实或同一主题。",
        "只返回 JSON，不要 markdown。",
        'Schema: {"action":"duplicate|merge|new"}',
      ].join("\n"),
    },
    { role: "user", content: JSON.stringify({ left, right }) },
  ], 300);
  const action = result?.action;
  return action === "duplicate" || action === "merge" || action === "new" ? action : "new";
}

async function mergeMemoryText(left, right) {
  const result = await chatJson([
    {
      role: "system",
      content: [
        "你是长期记忆合并助手。",
        "把两条同主题记忆合并成一条更完整的简体中文稳定事实，不编造。",
        "只返回 JSON，不要 markdown。",
        'Schema: {"title":"中文标题","content":"中文内容"}',
      ].join("\n"),
    },
    { role: "user", content: JSON.stringify({ left, right }) },
  ], 700);
  const title = stringValue(result?.title).slice(0, 80);
  const content = stringValue(result?.content).slice(0, 1200);
  return title && content && isMostlyChinese(`${title} ${content}`) ? { title, content } : null;
}

async function chatJson(messages, maxTokens) {
  const text = await chatText(messages, maxTokens);
  const jsonText = extractJsonObject(text || "");
  if (!jsonText) return null;
  try {
    return JSON.parse(jsonText);
  } catch {
    report.warnings.push("invalid_ai_json");
    return null;
  }
}

async function chatText(messages, maxTokens) {
  if (!profileAi.baseUrl || !profileAi.apiKey || !profileAi.model) {
    report.skippedAiCalls += 1;
    return null;
  }
  if (aiItemsUsed >= maxAiItems) {
    report.skippedAiCalls += 1;
    return null;
  }
  aiItemsUsed += 1;
  const baseUrl = profileAi.baseUrl.replace(/\/+$/, "");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  let response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${profileAi.apiKey}`,
      },
      body: JSON.stringify({
        model: profileAi.model,
        temperature: 0,
        max_tokens: maxTokens,
        messages,
      }),
    });
  } catch (error) {
    report.warnings.push(error?.name === "AbortError" ? "profile_ai_timeout" : "profile_ai_request_failed");
    return null;
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    report.warnings.push(`profile_ai_http_${response.status}`);
    return null;
  }
  const data = await response.json();
  return data?.choices?.[0]?.message?.content ?? null;
}

function shouldChineseRepair(item) {
  return item && !isMostlyChinese(`${item.title || ""} ${item.content || ""}`);
}

function isMostlyChinese(value) {
  const letters = String(value).match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return true;
  const han = String(value).match(/\p{Script=Han}/gu) ?? [];
  const asciiWords = String(value).match(/[A-Za-z]{4,}/g) ?? [];
  return han.length >= Math.max(2, letters.length * 0.25) || asciiWords.length <= 1;
}

function sameScope(left, right) {
  return left.groupId === right.groupId &&
    left.type === right.type &&
    String(left.subjectUserId || "") === String(right.subjectUserId || "");
}

function memorySimilarity(left, right) {
  return Math.max(
    textSimilarity(left.title, right.title) * 0.35 + textSimilarity(left.content, right.content) * 0.65,
    textSimilarity(`${left.title} ${left.content}`, `${right.title} ${right.content}`),
  );
}

function textSimilarity(left, right) {
  const leftTokens = tokenize(left);
  const rightTokens = tokenize(right);
  if (leftTokens.length === 0 || rightTokens.length === 0) return 0;
  const leftSet = new Set(leftTokens);
  const rightSet = new Set(rightTokens);
  let intersection = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) intersection += 1;
  }
  return Math.max(intersection / new Set([...leftSet, ...rightSet]).size, intersection / Math.min(leftSet.size, rightSet.size) * 0.88);
}

function tokenize(value) {
  return String(value).toLowerCase().match(/[\p{Script=Han}]|[a-z0-9]{2,}/gu) ?? [];
}

function mergeEvidence(left, right) {
  if (!left) return right;
  if (!right) return left;
  return {
    startAt: minDate(left.startAt, right.startAt),
    endAt: maxDate(left.endAt, right.endAt),
    messageCount: Number(left.messageCount || 0) + Number(right.messageCount || 0),
    speakers: uniqueSpeakers([...(left.speakers || []), ...(right.speakers || [])]),
    summary: [left.summary, right.summary].filter(Boolean).join("\n").slice(0, 2400),
  };
}

function uniqueSpeakers(speakers) {
  const seen = new Set();
  return speakers.filter((speaker) => {
    const key = String(speaker.userId || "");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 20);
}

function looksTruncatedProfile(value) {
  const text = String(value || "").trim();
  return text.length >= 240 && text.length <= 280 && !hasSentenceEnd(text);
}

function hasSentenceEnd(value) {
  return /[。！？.!?]$/.test(String(value || "").trim());
}

function trimToCompleteSentence(value, maxChars) {
  const text = String(value || "").trim();
  if (text.length <= maxChars) return text;
  const clipped = text.slice(0, maxChars);
  const end = Math.max(
    clipped.lastIndexOf("。"),
    clipped.lastIndexOf("！"),
    clipped.lastIndexOf("？"),
    clipped.lastIndexOf("."),
    clipped.lastIndexOf("!"),
    clipped.lastIndexOf("?"),
  );
  return end >= Math.floor(maxChars * 0.6) ? clipped.slice(0, end + 1).trim() : clipped.replace(/[，,、；;：:\s]+[^，,、；;：:\s]*$/, "").trim();
}

function extractJsonObject(text) {
  const trimmed = String(text || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  return start >= 0 && end > start ? trimmed.slice(start, end + 1) : "";
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function readEnv(filePath) {
  try {
    const content = await readFile(filePath, "utf8");
    const values = {};
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index <= 0) continue;
      const key = trimmed.slice(0, index).trim();
      const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
      values[key] = value;
    }
    return values;
  } catch {
    return {};
  }
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--apply") parsed.apply = true;
    else if (value === "--dry-run") parsed.apply = false;
    else if (value === "--data-dir") parsed.dataDir = values[++index];
    else if (value === "--env") parsed.env = values[++index];
    else if (value === "--max-ai-items") parsed.maxAiItems = Number(values[++index]);
    else if (value === "--max-semantic-checks") parsed.maxSemanticChecks = Number(values[++index]);
    else if (value === "--timeout-ms") parsed.timeoutMs = Number(values[++index]);
  }
  return parsed;
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function minDate(left, right) {
  return String(left || "") <= String(right || "") ? left : right;
}

function maxDate(left, right) {
  return String(left || "") >= String(right || "") ? left : right;
}

function redactBaseUrl(value) {
  return value ? value.replace(/[?].*$/, "") : "(missing)";
}
