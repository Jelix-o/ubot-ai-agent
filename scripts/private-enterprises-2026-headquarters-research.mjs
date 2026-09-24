#!/usr/bin/env node
/**
 * Offline-only workflow for researching headquarters cities for the 2026
 * private-enterprise Top 500. This utility deliberately cannot write the
 * runtime ledger or any release asset.
 */
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import process from "node:process";

const DEFAULT_MANIFEST = "research/private/private-enterprises-2026-headquarters-candidates.json";
const MANIFEST_KIND = "private_2026_headquarters_candidate_manifest";
const REVIEW_ATTESTATION = "independently_verified_publisher_capture_entity_and_headquarters_claim";
const HEADQUARTERS_SUPPORT_MAX_AGE_DAYS = 365;
const MUNICIPALITIES = new Set(["北京市", "天津市", "上海市", "重庆市"]);
const AUTONOMOUS_PREFECTURE_SHORT_ALIASES = new Map([
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

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Headquarters research workflow failed: ${message}\n`);
  process.exitCode = 1;
});

async function main() {
  const command = process.argv[2];
  if (!command || command === "--help" || command === "-h") {
    printUsage();
    return;
  }
  if (!["seed", "validate", "seal"].includes(command)) {
    throw new Error(`Unknown command: ${command}`);
  }

  const options = parseOptions(command, process.argv.slice(3));
  const workspace = await resolveWorkspace(options.workspace);
  const ranking = await readRanking(workspace);

  if (command === "seed") {
    const output = await resolvePrivateManifestPath(workspace, options.output ?? DEFAULT_MANIFEST, true);
    const manifest = createCandidateManifest(ranking);
    const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
    const existing = await readOptionalRegularFile(output);
    if (existing !== undefined) {
      if (existing !== serialized) {
        throw new Error(
          `Refusing to overwrite existing private research manifest: ${relative(workspace, output)}. ` +
          "Create a different private manifest or archive the reviewed file first.",
        );
      }
      report("seed", workspace, output, manifest, false);
      return;
    }
    await writePrivateFile(output, serialized);
    report("seed", workspace, output, manifest, true);
    return;
  }

  const input = await resolvePrivateManifestPath(workspace, options.input ?? DEFAULT_MANIFEST, false);
  const manifest = await readManifest(input);
  const validation = await validateCandidateManifest(manifest, ranking, workspace, {
    promotion: options.promotion === true,
    allowEntriesChecksumMismatch: command === "seal",
  });
  if (validation.errors.length) {
    throw new Error(validation.errors.join("; "));
  }

  if (command === "seal") {
    const sealed = { ...manifest, entriesSha256: candidateEntriesChecksum(manifest.entries) };
    await writePrivateFile(input, `${JSON.stringify(sealed, null, 2)}\n`, { replace: true });
    report("seal", workspace, input, sealed, true);
    return;
  }

  report("validate", workspace, input, manifest, false, validation);
}

function printUsage() {
  process.stdout.write(`Usage:\n` +
    `  node scripts/private-enterprises-2026-headquarters-research.mjs seed [--workspace <dir>] [--output <private-file>]\n` +
    `  node scripts/private-enterprises-2026-headquarters-research.mjs validate [--workspace <dir>] [--input <private-file>] [--promotion]\n` +
    `  node scripts/private-enterprises-2026-headquarters-research.mjs seal [--workspace <dir>] [--input <private-file>]\n\n` +
    "All manifests and captured source excerpts must stay under research/private/. " +
    "The utility never writes assets/private-enterprises-2026-headquarters*.json.\n");
}

function parseOptions(command, args) {
  const allowed = new Set(command === "seed"
    ? ["--workspace", "--output"]
    : command === "validate"
      ? ["--workspace", "--input", "--promotion"]
      : ["--workspace", "--input"]);
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (!allowed.has(name)) throw new Error(`Unsupported option for ${command}: ${name}`);
    const key = name.slice(2).replace(/-([a-z])/gu, (_, character) => character.toUpperCase());
    if (Object.hasOwn(options, key)) throw new Error(`Option may appear only once: ${name}`);
    if (name === "--promotion") {
      options[key] = true;
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
    options[key] = value;
    index += 1;
  }
  return options;
}

async function resolveWorkspace(value) {
  const workspace = path.resolve(value ?? process.cwd());
  const metadata = await lstat(workspace).catch(() => undefined);
  if (!metadata?.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Workspace must be an existing non-symlink directory");
  }
  return workspace;
}

async function readRanking(workspace) {
  const asset = path.join(workspace, "assets", "private-enterprises-2026.json");
  const raw = await readRequiredRegularFile(asset, "primary ranking asset");
  let ranking;
  try {
    ranking = JSON.parse(raw);
  } catch {
    throw new Error("Primary ranking asset is not valid JSON");
  }
  if (!isRecord(ranking) || ranking.edition !== 2026 || ranking.revenueYear !== 2025 ||
      !isIsoDate(ranking.publishedOn) || !Array.isArray(ranking.entries) || ranking.entries.length !== 500 ||
      !isSha256(ranking.rowsSha256)) {
    throw new Error("Primary ranking asset has unexpected metadata");
  }
  const names = new Set();
  const canonicalRows = [];
  for (const [index, entry] of ranking.entries.entries()) {
    if (!isRecord(entry) || entry.rank !== index + 1 || !isNonBlankString(entry.name) ||
        !isNonBlankString(entry.province) || !Number.isSafeInteger(entry.revenueWan) || entry.revenueWan <= 0 ||
        names.has(entry.name)) {
      throw new Error(`Primary ranking asset has an invalid row at rank ${index + 1}`);
    }
    names.add(entry.name);
    canonicalRows.push({ rank: entry.rank, name: entry.name, province: entry.province, revenueWan: entry.revenueWan });
  }
  if (runtimeChecksum(canonicalRows) !== ranking.rowsSha256) {
    throw new Error("Primary ranking asset row checksum does not match its entries");
  }
  return ranking;
}

function createCandidateManifest(ranking) {
  const entries = ranking.entries.map((entry) => ({
    rank: entry.rank,
    enterpriseName: entry.name,
    rankingProvince: entry.province,
    rankingRowSha256: rankingRowChecksum(entry),
    reviewState: "unresearched",
    claim: null,
  }));
  return {
    schemaVersion: 1,
    kind: MANIFEST_KIND,
    privateOnly: true,
    edition: 2026,
    revenueYear: 2025,
    rankingRowsSha256: ranking.rowsSha256,
    frozenAt: ranking.publishedOn,
    entriesSha256: candidateEntriesChecksum(entries),
    entries,
  };
}

async function resolvePrivateManifestPath(workspace, requested, createRoot) {
  if (typeof requested !== "string" || !requested.trim() || path.isAbsolute(requested)) {
    throw new Error("Private manifest path must be a non-empty path relative to the workspace");
  }
  const privateRoot = path.join(workspace, "research", "private");
  if (createRoot) await ensurePrivateRoot(workspace);
  else await assertPrivateRoot(workspace);
  const resolved = path.resolve(workspace, requested);
  if (path.dirname(resolved) !== privateRoot || path.extname(resolved).toLowerCase() !== ".json") {
    throw new Error("Private manifest must be a direct .json file under research/private/; public assets are not writable");
  }
  return resolved;
}

async function ensurePrivateRoot(workspace) {
  const researchRoot = path.join(workspace, "research");
  const privateRoot = path.join(researchRoot, "private");
  const evidenceRoot = path.join(privateRoot, "evidence");
  await ensureChildDirectory(workspace, "research", "workspace directory", "research directory");
  await ensureChildDirectory(researchRoot, "private", "research directory", "private research directory");
  await ensureChildDirectory(privateRoot, "evidence", "private research directory", "private evidence directory");
}

async function ensureChildDirectory(parent, name, parentLabel, label) {
  await assertDirectoryWithoutSymlink(parent, parentLabel);
  const target = path.join(parent, name);
  const existing = await lstat(target).catch((error) => error?.code === "ENOENT" ? undefined : Promise.reject(error));
  if (!existing) await mkdir(target);
  await assertDirectoryWithoutSymlink(target, label);
}

async function assertPrivateRoot(workspace) {
  await assertDirectoryWithoutSymlink(path.join(workspace, "research"), "research directory");
  await assertDirectoryWithoutSymlink(path.join(workspace, "research", "private"), "private research directory");
}

async function assertDirectoryWithoutSymlink(target, label) {
  const metadata = await lstat(target).catch(() => undefined);
  if (!metadata?.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be an existing non-symlink directory`);
  }
}

async function readManifest(file) {
  const raw = await readRequiredRegularFile(file, "private research manifest");
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Private research manifest is not valid JSON");
  }
}

async function validateCandidateManifest(manifest, ranking, workspace, options) {
  const errors = [];
  const promotionClaims = [];
  if (!isRecord(manifest)) {
    return { errors: ["Private research manifest must be a JSON object"], promotionClaims };
  }
  if (manifest.schemaVersion !== 1 || manifest.kind !== MANIFEST_KIND || manifest.privateOnly !== true ||
      manifest.edition !== ranking.edition || manifest.revenueYear !== ranking.revenueYear ||
      manifest.rankingRowsSha256 !== ranking.rowsSha256 || manifest.frozenAt !== ranking.publishedOn ||
      !Array.isArray(manifest.entries) || !isSha256(manifest.entriesSha256)) {
    errors.push("Private research manifest metadata does not bind the current 2026 ranking asset");
  }
  if (Object.hasOwn(manifest, "status") || Object.hasOwn(manifest, "completionApproval")) {
    errors.push("Candidate manifest must not contain runtime-ledger status or approval fields");
  }
  if (Array.isArray(manifest.entries)) {
    const actualChecksum = candidateEntriesChecksum(manifest.entries);
    if (!options.allowEntriesChecksumMismatch && actualChecksum !== manifest.entriesSha256) {
      errors.push("Private research manifest entries checksum does not match; run seal after a reviewed edit");
    }
    if (manifest.entries.length !== ranking.entries.length) {
      errors.push("Private research manifest must contain exactly 500 ranking-bound entries");
    }
    const evidenceIds = new Set();
    for (let index = 0; index < ranking.entries.length; index += 1) {
      const primary = ranking.entries[index];
      const candidate = manifest.entries[index];
      const label = `rank ${index + 1}`;
      if (!isRecord(candidate) || candidate.rank !== primary.rank || candidate.enterpriseName !== primary.name ||
          candidate.rankingProvince !== primary.province || candidate.rankingRowSha256 !== rankingRowChecksum(primary)) {
        errors.push(`${label} is not bound to the immutable primary ranking row`);
        continue;
      }
      if (!REVIEW_STATES.has(candidate.reviewState)) {
        errors.push(`${label} has an invalid review state`);
        continue;
      }
      if (candidate.reviewState === "unresearched" && candidate.claim !== null) {
        errors.push(`${label} is unresearched but contains a headquarters claim`);
      }
      if (candidate.reviewState !== "unresearched" && !isRecord(candidate.claim)) {
        errors.push(`${label} must have a claim object before it can leave the unresearched state`);
      }
      if (candidate.reviewState === "approved_for_ledger") {
        const claimErrors = await validateApprovedClaim(candidate, ranking, workspace, evidenceIds);
        errors.push(...claimErrors.map((message) => `${label}: ${message}`));
        if (claimErrors.length === 0) promotionClaims.push(candidate);
      }
    }
    if (options.promotion && promotionClaims.length !== ranking.entries.length) {
      errors.push("Promotion review requires all 500 entries to be approved_for_ledger with verified source, capture, and reviewer attestation");
    }
  }
  return { errors, promotionClaims };
}

const REVIEW_STATES = new Set(["unresearched", "draft", "rejected", "approved_for_ledger"]);

async function validateApprovedClaim(candidate, ranking, workspace, evidenceIds) {
  const errors = [];
  const claim = candidate.claim;
  if (!isRecord(claim)) return ["approved claim is missing"];
  const headquarters = claim.headquarters;
  const source = claim.source;
  const review = claim.review;
  const normalizedEnterprise = normalize(candidate.enterpriseName);
  if (!isNonBlankString(claim.entityMatch) || !normalize(claim.entityMatch).includes(normalizedEnterprise)) {
    errors.push("entityMatch must explicitly identify the ranked enterprise");
  }
  if (!isRecord(headquarters) || !isCanonicalProvince(headquarters.province) ||
      !isCanonicalCity(headquarters.city, headquarters.administrativeLevel) || !isIsoDate(headquarters.asOf) ||
      headquarters.asOf > ranking.publishedOn) {
    errors.push("headquarters province, city, administrative level, and frozen-date claim are required");
  }
  if (!isRecord(source)) {
    errors.push("approved claim requires a real enterprise or government source record");
  } else {
    const normalizedSubject = normalize(source.sourceSubject ?? "");
    const sourceSubjectIsExactEnterprise = normalizedSubject === normalizedEnterprise;
    const normalizedEntityMatch = normalize(claim.entityMatch ?? "");
    if (!isEvidenceId(source.evidenceId) || evidenceIds.has(source.evidenceId)) {
      errors.push("source evidenceId is missing, invalid, or reused");
    } else {
      evidenceIds.add(source.evidenceId);
    }
    if (source.authority !== "enterprise" && source.authority !== "government") {
      errors.push("source authority must be enterprise or government");
    }
    if (!isNonBlankString(source.publisher) || !isEvidenceUrl(source.url)) {
      errors.push("source requires a non-placeholder HTTPS publisher URL");
    }
    if (!isIsoDate(source.publishedOn) || !isIsoDate(source.claimAsOf) || !isIsoDate(source.retrievedOn) ||
        source.publishedOn > ranking.publishedOn || source.claimAsOf > ranking.publishedOn ||
        source.claimAsOf > source.publishedOn || source.retrievedOn < source.publishedOn ||
        !isRecord(headquarters) || source.claimAsOf !== headquarters.asOf ||
        !isWithinHeadquartersSupportWindow(source.publishedOn, ranking.publishedOn) ||
        !isWithinHeadquartersSupportWindow(source.claimAsOf, ranking.publishedOn)) {
      errors.push("selected source publication and claim dates must establish the frozen headquarters date within 365 days");
    }
    if (!isNonBlankString(source.sourceSubject) || !isNonBlankString(source.claimText) ||
        !sourceClaimBindsSubjectToHeadquartersCity(
          source.claimText,
          source.sourceSubject,
          isRecord(headquarters) ? headquarters.city : "",
        ) ||
        (!sourceSubjectIsExactEnterprise && !hasIndependentEntityMentions(
          normalizedEntityMatch,
          normalizedEnterprise,
          normalizedSubject,
        ))) {
      errors.push("source subject, entity match, and claim text must explicitly support the headquarters city");
    }
    if (!sourceSubjectIsExactEnterprise && (
      !sourceCitedSameEntityNameContinuity(
        source.entityRelationText,
        candidate.enterpriseName,
        source.sourceSubject,
      )
    )) {
      errors.push("a different sourceSubject requires source-quoted entityRelationText proving both names are the same entity through name continuity");
    }
    const captureErrors = await validateCapture(workspace, source, headquarters, sourceSubjectIsExactEnterprise);
    errors.push(...captureErrors);
  }
  if (!isRecord(review) || review.state !== "approved" || review.independent !== true ||
      !isNonBlankString(review.reviewerId) || !isIsoDate(review.reviewedOn) ||
      review.publisherDomainVerified !== true || review.captureVerified !== true ||
      review.entityMappingVerified !== true || review.headquartersClaimVerified !== true ||
      review.attestation !== REVIEW_ATTESTATION ||
      (isRecord(source) && isIsoDate(source.retrievedOn) && review.reviewedOn < source.retrievedOn)) {
    errors.push("approved claim requires a dated independent reviewer attestation, publisher-domain, capture, entity-mapping, and headquarters-claim verification after source retrieval");
  }
  return errors;
}

async function validateCapture(workspace, source, headquarters, sourceSubjectIsExactEnterprise) {
  const errors = [];
  if (!isNonBlankString(source.capturePath) || !isSha256(source.captureSha256)) {
    return ["source requires a SHA-256-bound local capture"];
  }
  const capture = await resolveCapturePath(workspace, source.capturePath).catch((error) => {
    errors.push(error instanceof Error ? error.message : String(error));
    return undefined;
  });
  if (!capture) return errors;
  const metadata = await lstat(capture).catch(() => undefined);
  if (!metadata?.isFile() || metadata.isSymbolicLink()) {
    return ["local source capture is missing or is not a regular file"];
  }
  if (metadata.size < 16 || metadata.size > 24_000) {
    return ["local source capture must be between 16 bytes and 24 KB"];
  }
  const content = await readFile(capture, "utf8");
  if (checksumText(content) !== source.captureSha256) {
    errors.push("local source capture SHA-256 does not match the claim");
  }
  if (!content.includes(source.sourceSubject) || !content.includes(source.claimText)) {
    errors.push("local source capture does not contain the cited subject and headquarters claim");
  }
  if (!sourceSubjectIsExactEnterprise &&
      (!isNonBlankString(source.entityRelationText) || !content.includes(source.entityRelationText))) {
    errors.push("local source capture does not contain the cited entity relationship quotation");
  }
  return errors;
}

async function resolveCapturePath(workspace, capturePath) {
  if (path.isAbsolute(capturePath) || !/^evidence\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(?:txt|html|json)$/u.test(capturePath)) {
    throw new Error("source capture path must be a direct evidence/<safe-file> path under research/private");
  }
  const evidenceRoot = path.join(workspace, "research", "private", "evidence");
  await assertDirectoryWithoutSymlink(evidenceRoot, "private evidence directory");
  return path.join(evidenceRoot, path.basename(capturePath));
}

function candidateEntriesChecksum(entries) {
  return checksum(entries.map((entry) => canonicalize(entry)));
}

function rankingRowChecksum(entry) {
  return runtimeChecksum({ rank: entry.rank, name: entry.name, province: entry.province, revenueWan: entry.revenueWan });
}

function checksum(value) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value)), "utf8").digest("hex");
}

// This deliberately mirrors the runtime ranking asset's checksum contract.
// Candidate-manifest checksums use `checksum` above so nested researcher edits
// remain deterministic even when a JSON editor rewrites object key order.
function runtimeChecksum(value) {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function checksumText(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function normalize(value) {
  return String(value).normalize("NFKC").replace(/[\s\p{P}]/gu, "");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonBlankString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isEvidenceId(value) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]{2,127}$/u.test(value);
}

function isIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function isCanonicalProvince(value) {
  return typeof value === "string" && /^(?:[\u4e00-\u9fff]{2,12}(?:省|市|自治区|特别行政区)|新疆生产建设兵团)$/u.test(value);
}

function isCanonicalCity(value, administrativeLevel) {
  if (typeof value !== "string" || (administrativeLevel !== "municipality" && administrativeLevel !== "prefecture")) {
    return false;
  }
  if (administrativeLevel === "municipality") return MUNICIPALITIES.has(value);
  return !MUNICIPALITIES.has(value) && /^[\u4e00-\u9fff]{2,12}(?:市|自治州|地区|盟|特别行政区)$/u.test(value);
}

function headquartersCitySourceForms(city) {
  if (typeof city !== "string") return [];
  const forms = new Set([city]);
  if (city.endsWith("市")) forms.add(city.slice(0, -1));
  const autonomousPrefectureAlias = AUTONOMOUS_PREFECTURE_SHORT_ALIASES.get(city);
  if (autonomousPrefectureAlias) forms.add(autonomousPrefectureAlias);
  return [...forms];
}

function sourceClaimBindsSubjectToHeadquartersCity(claimText, sourceSubject, canonicalCity) {
  if (typeof claimText !== "string" || typeof sourceSubject !== "string" || typeof canonicalCity !== "string") return false;
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
  const subjectPattern = `(?<![\\p{L}\\p{N}])${escapeRegex(subject)}`;
  const headquartersLabel = "(?:总部所在地|总部地址|总部|总公司)";
  const headquartersLocationVerb = "(?:位于|坐落于|坐落在|设于|设在|在|为|是|[:：])";
  const administrativePrefix = "(?:(?:中国|中华人民共和国)?[\\u4e00-\\u9fff]{2,12}(?:省|自治区|特别行政区))?";
  const naturalClause = new RegExp(
    `${subjectPattern}(?:的)?${headquartersLabel}${headquartersLocationVerb}${administrativePrefix}(?:${cityPattern})`,
    "u",
  );
  const tableRow = new RegExp(
    `${subjectPattern}(?:[:：|])+${headquartersLabel}(?:[:：|]|为|是)+(?:${cityPattern})`,
    "u",
  );
  return splitSourceQuoteClauses(claimText).some((clause) => {
    const compactClause = compactSourceQuoteText(clause);
    return naturalClause.test(compactClause) || tableRow.test(compactClause);
  });
}

function splitSourceQuoteClauses(value) {
  return value.normalize("NFKC").split(/[，,。！？!?；;\r\n]/u);
}

function compactSourceQuoteText(value) {
  return value.normalize("NFKC").replace(/[\s\u3000]/gu, "");
}

function escapeRegex(value) {
  return value.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
}

function sourceCitedSameEntityNameContinuity(relationText, enterpriseName, sourceSubject) {
  if (typeof relationText !== "string" || typeof enterpriseName !== "string" || typeof sourceSubject !== "string") return false;
  const enterprise = compactSourceQuoteText(enterpriseName);
  const subject = compactSourceQuoteText(sourceSubject);
  if (!enterprise || !subject || enterprise === subject) return false;
  const compactRelation = compactSourceQuoteText(relationText);
  if (!hasIndependentEntityMentions(compactRelation, enterprise, subject)) return false;

  const nameContinuityMarker = "(?:以下简称|简称(?:为)?|又称|亦称|即(?:为)?|原名(?:为)?|原称(?:为)?|曾用名(?:称)?(?:为)?|更名为|变更为)";
  const relationGap = "(?:[\\s\\u3000，,、:：()（）\"“”'‘’]|的){0,8}";
  const identityVerb = "(?:是|为|系)";
  const directNameContinuity = (left, right) => [
    new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(left)}${relationGap}(?:的|已|曾|现)?${nameContinuityMarker}${relationGap}${escapeRegex(right)}(?=$|[^\\u4e00-\\u9fff])`, "u"),
    new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(left)}${relationGap}${identityVerb}${relationGap}${escapeRegex(right)}${relationGap}(?:的)?${nameContinuityMarker}`, "u"),
  ];
  return directNameContinuity(enterprise, subject).some((pattern) => pattern.test(compactRelation)) ||
    directNameContinuity(subject, enterprise).some((pattern) => pattern.test(compactRelation));
}

function hasIndependentEntityMentions(normalizedText, normalizedEnterprise, normalizedSubject) {
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

function allStringPositions(value, needle) {
  if (!needle) return [];
  const positions = [];
  let position = value.indexOf(needle);
  while (position >= 0) {
    positions.push(position);
    position = value.indexOf(needle, position + 1);
  }
  return positions;
}

function isWithinHeadquartersSupportWindow(value, frozenAt) {
  if (!isIsoDate(value) || !isIsoDate(frozenAt) || value > frozenAt) return false;
  const cutoff = new Date(`${frozenAt}T00:00:00.000Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - HEADQUARTERS_SUPPORT_MAX_AGE_DAYS);
  return value >= cutoff.toISOString().slice(0, 10);
}

function isEvidenceUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "").replace(/\.$/u, "");
    return url.protocol === "https:" && !url.username && !url.password && Boolean(hostname) &&
      (!url.port || url.port === "443") && isIP(hostname) === 0 && !isReservedHostname(hostname);
  } catch {
    return false;
  }
}

function isReservedHostname(hostname) {
  return hostname === "localhost" || hostname.endsWith(".localhost") ||
    hostname === "example" || hostname.endsWith(".example") ||
    hostname === "example.com" || hostname.endsWith(".example.com") ||
    hostname === "example.net" || hostname.endsWith(".example.net") ||
    hostname === "example.org" || hostname.endsWith(".example.org") ||
    ["test", "invalid", "local", "internal", "home"].includes(hostname) ||
    hostname.endsWith(".test") || hostname.endsWith(".invalid") || hostname.endsWith(".local") ||
    hostname.endsWith(".internal") || hostname.endsWith(".home");
}

async function readRequiredRegularFile(file, label) {
  const metadata = await lstat(file).catch(() => undefined);
  if (!metadata?.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be an existing non-symlink regular file`);
  }
  return readFile(file, "utf8");
}

async function readOptionalRegularFile(file) {
  const metadata = await lstat(file).catch((error) => error?.code === "ENOENT" ? undefined : Promise.reject(error));
  if (!metadata) return undefined;
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Private research manifest must be a non-symlink regular file");
  }
  return readFile(file, "utf8");
}

async function writePrivateFile(file, content, { replace = false } = {}) {
  const directory = path.dirname(file);
  await assertDirectoryWithoutSymlink(directory, "private research directory");
  const existingTarget = await lstat(file).catch((error) => error?.code === "ENOENT" ? undefined : Promise.reject(error));
  if (existingTarget && (!existingTarget.isFile() || existingTarget.isSymbolicLink())) {
    throw new Error("Private research manifest must be a non-symlink regular file");
  }
  if (existingTarget && !replace) {
    throw new Error("Refusing to overwrite an existing private research manifest");
  }
  if (!existingTarget && replace) {
    throw new Error("Cannot seal a private research manifest that no longer exists");
  }
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.tmp`);
  const existingTemporary = await lstat(temporary).catch(() => undefined);
  if (existingTemporary) throw new Error(`Refusing to reuse existing temporary research file: ${path.basename(temporary)}`);
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function relative(workspace, file) {
  return path.relative(workspace, file).split(path.sep).join("/");
}

function report(operation, workspace, manifestPath, manifest, changed, validation) {
  const states = {};
  for (const entry of Array.isArray(manifest.entries) ? manifest.entries : []) {
    if (isRecord(entry) && typeof entry.reviewState === "string") {
      states[entry.reviewState] = (states[entry.reviewState] ?? 0) + 1;
    }
  }
  const reportBody = {
    operation,
    manifest: relative(workspace, manifestPath),
    changed,
    entries: Array.isArray(manifest.entries) ? manifest.entries.length : 0,
    reviewStates: states,
    rankingRowsSha256: manifest.rankingRowsSha256,
    entriesSha256: manifest.entriesSha256,
    promotionReady: validation ? validation.promotionClaims.length === 500 : false,
    note: "Private research only. This command never writes the public headquarters ledger or enables city answers.",
  };
  process.stdout.write(`${JSON.stringify(reportBody, null, 2)}\n`);
}
