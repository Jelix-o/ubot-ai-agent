import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const projectRoot = path.resolve(".");
const workflowScript = path.join(projectRoot, "scripts", "private-enterprises-2026-headquarters-research.mjs");
const manifestRelativePath = path.join("research", "private", "private-enterprises-2026-headquarters-candidates.json");

function temporaryWorkspace() {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "ubot-hq-research-workflow-"));
  mkdirSync(path.join(workspace, "assets"), { recursive: true });
  mkdirSync(path.join(workspace, "research", "private"), { recursive: true });
  cpSync(
    path.join(projectRoot, "assets", "private-enterprises-2026.json"),
    path.join(workspace, "assets", "private-enterprises-2026.json"),
  );
  return workspace;
}

function runWorkflow(workspace: string, ...args: string[]) {
  return spawnSync(
    process.execPath,
    [workflowScript, ...args, "--workspace", workspace],
    { cwd: projectRoot, encoding: "utf8", shell: false },
  );
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize((value as Record<string, unknown>)[key])]));
  }
  return value;
}

function entriesChecksum(entries: unknown) {
  return createHash("sha256").update(JSON.stringify(canonicalize(entries)), "utf8").digest("hex");
}

function sha256Text(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function reseal(manifestPath: string, manifest: { entries: unknown; entriesSha256: string }) {
  manifest.entriesSha256 = entriesChecksum(manifest.entries);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

test("offline headquarters workflow deterministically seeds a 500-row private manifest without city claims", () => {
  const firstWorkspace = temporaryWorkspace();
  const secondWorkspace = temporaryWorkspace();
  const publicLedger = path.join(projectRoot, "assets", "private-enterprises-2026-headquarters.json");
  const ledgerBefore = readFileSync(publicLedger, "utf8");
  try {
    const first = runWorkflow(firstWorkspace, "seed");
    const second = runWorkflow(secondWorkspace, "seed");
    assert.equal(first.status, 0, first.stdout + first.stderr);
    assert.equal(second.status, 0, second.stdout + second.stderr);
    const idempotent = runWorkflow(firstWorkspace, "seed");
    assert.equal(idempotent.status, 0, idempotent.stdout + idempotent.stderr);

    const firstManifestPath = path.join(firstWorkspace, manifestRelativePath);
    const secondManifestPath = path.join(secondWorkspace, manifestRelativePath);
    const firstBytes = readFileSync(firstManifestPath, "utf8");
    assert.equal(firstBytes, readFileSync(secondManifestPath, "utf8"));

    const manifest = JSON.parse(firstBytes) as {
      privateOnly: boolean;
      entries: Array<{ rank: number; reviewState: string; claim: unknown; rankingRowSha256: string }>;
    };
    assert.equal(manifest.privateOnly, true);
    assert.equal(manifest.entries.length, 500);
    assert.deepEqual(manifest.entries.map((entry) => entry.rank), Array.from({ length: 500 }, (_, index) => index + 1));
    assert.equal(manifest.entries.every((entry) => entry.reviewState === "unresearched" && entry.claim === null), true);
    assert.equal(manifest.entries.every((entry) => /^[a-f0-9]{64}$/u.test(entry.rankingRowSha256)), true);

    const sealed = runWorkflow(firstWorkspace, "seal");
    assert.equal(sealed.status, 0, sealed.stdout + sealed.stderr);
    const validation = runWorkflow(firstWorkspace, "validate");
    assert.equal(validation.status, 0, validation.stdout + validation.stderr);
    assert.equal(readFileSync(publicLedger, "utf8"), ledgerBefore);
  } finally {
    rmSync(firstWorkspace, { recursive: true, force: true });
    rmSync(secondWorkspace, { recursive: true, force: true });
  }
});

test("offline headquarters workflow refuses public output paths and unaudited city promotion", () => {
  const workspace = temporaryWorkspace();
  try {
    const publicPath = runWorkflow(workspace, "seed", "--output", "assets/private-enterprises-2026-headquarters.json");
    assert.notEqual(publicPath.status, 0, publicPath.stdout + publicPath.stderr);
    assert.match(publicPath.stderr, /private manifest|public assets/i);

    const existingManifestPath = path.join(workspace, "research", "private", "existing.json");
    writeFileSync(existingManifestPath, "{\"unreviewed\":true}\n", "utf8");
    const overwrite = runWorkflow(workspace, "seed", "--output", "research/private/existing.json");
    assert.notEqual(overwrite.status, 0, overwrite.stdout + overwrite.stderr);
    assert.match(overwrite.stderr, /refusing to overwrite/i);
    assert.equal(readFileSync(existingManifestPath, "utf8"), "{\"unreviewed\":true}\n");

    const nonRegularManifestPath = path.join(workspace, "research", "private", "not-a-file.json");
    mkdirSync(nonRegularManifestPath);
    const sealDirectory = runWorkflow(workspace, "seal", "--input", "research/private/not-a-file.json");
    assert.notEqual(sealDirectory.status, 0, sealDirectory.stdout + sealDirectory.stderr);
    assert.match(sealDirectory.stderr, /non-symlink regular file/i);

    const seeded = runWorkflow(workspace, "seed");
    assert.equal(seeded.status, 0, seeded.stdout + seeded.stderr);
    const manifestPath = path.join(workspace, manifestRelativePath);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      entries: Array<Record<string, unknown>>;
      entriesSha256: string;
    };
    manifest.entries[0] = {
      ...manifest.entries[0],
      reviewState: "approved_for_ledger",
      claim: {
        entityMatch: "京东集团与京东集团来源主体一致",
        headquarters: { province: "广东省", city: "深圳市", administrativeLevel: "prefecture", asOf: "2026-09-22" },
        source: {
          evidenceId: "hq-test-001",
          authority: "enterprise",
          publisher: "测试来源",
          url: "https://www.gov.cn/test/headquarters-001",
          publishedOn: "2026-09-22",
          claimAsOf: "2026-09-22",
          retrievedOn: "2026-09-22",
          sourceSubject: "京东集团",
          claimText: "京东集团总部位于深圳市。",
          capturePath: "evidence/hq-test-001.txt",
          captureSha256: "0".repeat(64),
        },
      },
    };
    reseal(manifestPath, manifest);

    const missingCapture = runWorkflow(workspace, "validate");
    assert.notEqual(missingCapture.status, 0, missingCapture.stdout + missingCapture.stderr);
    assert.match(missingCapture.stderr, /capture/i);

    const capture = "sourceSubject: 京东集团\nclaim: 京东集团总部位于深圳市。\n";
    const evidenceDirectory = path.join(workspace, "research", "private", "evidence");
    mkdirSync(evidenceDirectory, { recursive: true });
    writeFileSync(path.join(evidenceDirectory, "hq-test-001.txt"), capture, "utf8");
    const source = (manifest.entries[0].claim as { source: { captureSha256: string } }).source;
    source.captureSha256 = sha256Text(capture);
    reseal(manifestPath, manifest);

    const missingReviewer = runWorkflow(workspace, "validate");
    assert.notEqual(missingReviewer.status, 0, missingReviewer.stdout + missingReviewer.stderr);
    assert.match(missingReviewer.stderr, /reviewer/i);

    const promotion = runWorkflow(workspace, "validate", "--promotion");
    assert.notEqual(promotion.status, 0, promotion.stdout + promotion.stderr);
    assert.match(promotion.stderr, /reviewer|promotion/i);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("offline headquarters workflow mirrors frozen-date, safe-city-alias, and source-relationship gates", () => {
  const workspace = temporaryWorkspace();
  try {
    const seeded = runWorkflow(workspace, "seed");
    assert.equal(seeded.status, 0, seeded.stdout + seeded.stderr);
    const manifestPath = path.join(workspace, manifestRelativePath);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      entries: Array<Record<string, unknown>>;
      entriesSha256: string;
    };
    const claimText = "京东集团总部位于杭州。";
    const source = {
      evidenceId: "hq-test-002",
      authority: "enterprise",
      publisher: "测试来源",
      url: "https://www.gov.cn/test/headquarters-002",
      publishedOn: "2025-09-22",
      claimAsOf: "2025-09-22",
      retrievedOn: "2026-09-22",
      sourceSubject: "京东集团",
      claimText,
      entityRelationText: undefined as string | undefined,
      capturePath: "evidence/hq-test-002.txt",
      captureSha256: "",
    };
    const review = {
      state: "approved",
      independent: true,
      reviewerId: "test-independent-reviewer",
      reviewedOn: "2026-09-22",
      publisherDomainVerified: true,
      captureVerified: true,
      entityMappingVerified: true,
      headquartersClaimVerified: true,
      attestation: "independently_verified_publisher_capture_entity_and_headquarters_claim",
    };
    manifest.entries[0] = {
      ...manifest.entries[0],
      reviewState: "approved_for_ledger",
      claim: {
        entityMatch: "京东集团与京东集团来源主体一致",
        headquarters: { province: "浙江省", city: "杭州市", administrativeLevel: "prefecture", asOf: "2025-09-22" },
        source,
        review,
      },
    };
    const evidenceDirectory = path.join(workspace, "research", "private", "evidence");
    mkdirSync(evidenceDirectory, { recursive: true });
    const capturePath = path.join(evidenceDirectory, "hq-test-002.txt");
    let capture = `subject: ${source.sourceSubject}\nclaim: ${source.claimText}\n`;
    writeFileSync(capturePath, capture, "utf8");
    source.captureSha256 = sha256Text(capture);
    reseal(manifestPath, manifest);

    const safeAlias = runWorkflow(workspace, "validate");
    assert.equal(safeAlias.status, 0, safeAlias.stdout + safeAlias.stderr);

    source.claimText = "京东集团总部位于杭州市西湖区。";
    capture = `subject: ${source.sourceSubject}\nclaim: ${source.claimText}\n`;
    writeFileSync(capturePath, capture, "utf8");
    source.captureSha256 = sha256Text(capture);
    reseal(manifestPath, manifest);
    const canonicalCityWithDistrict = runWorkflow(workspace, "validate");
    assert.equal(canonicalCityWithDistrict.status, 0, canonicalCityWithDistrict.stdout + canonicalCityWithDistrict.stderr);

    source.claimText = "京东集团总部位于杭州湾。";
    capture = `subject: ${source.sourceSubject}\nclaim: ${source.claimText}\n`;
    writeFileSync(capturePath, capture, "utf8");
    source.captureSha256 = sha256Text(capture);
    reseal(manifestPath, manifest);
    const cityPrefixFalsePositive = runWorkflow(workspace, "validate");
    assert.notEqual(cityPrefixFalsePositive.status, 0, cityPrefixFalsePositive.stdout + cityPrefixFalsePositive.stderr);
    assert.match(cityPrefixFalsePositive.stderr, /headquarters city/i);

    source.claimText = "京东集团总部位于南京市，杭州市设有分公司。";
    capture = `subject: ${source.sourceSubject}\nclaim: ${source.claimText}\n`;
    writeFileSync(capturePath, capture, "utf8");
    source.captureSha256 = sha256Text(capture);
    reseal(manifestPath, manifest);
    const separatedHeadquartersCity = runWorkflow(workspace, "validate");
    assert.notEqual(separatedHeadquartersCity.status, 0, separatedHeadquartersCity.stdout + separatedHeadquartersCity.stderr);
    assert.match(separatedHeadquartersCity.stderr, /headquarters city/i);

    source.claimText = claimText;
    capture = `subject: ${source.sourceSubject}\nclaim: ${source.claimText}\n`;
    writeFileSync(capturePath, capture, "utf8");
    source.captureSha256 = sha256Text(capture);
    reseal(manifestPath, manifest);

    source.publishedOn = "2025-09-21";
    source.claimAsOf = "2025-09-21";
    ((manifest.entries[0].claim as { headquarters: { asOf: string } }).headquarters).asOf = "2025-09-21";
    reseal(manifestPath, manifest);
    const stale = runWorkflow(workspace, "validate");
    assert.notEqual(stale.status, 0, stale.stdout + stale.stderr);
    assert.match(stale.stderr, /365 days/i);

    source.publishedOn = "2025-09-22";
    source.claimAsOf = "2025-09-22";
    ((manifest.entries[0].claim as { headquarters: { asOf: string } }).headquarters).asOf = "2025-09-22";
    source.sourceSubject = "京东集团控股有限公司";
    source.claimText = "京东集团控股有限公司总部位于杭州。";
    source.entityRelationText = "京东集团原名为京东集团控股有限公司。";
    const claim = manifest.entries[0].claim as { entityMatch: string };
    claim.entityMatch = "京东集团原名为京东集团控股有限公司。";
    capture = [
      `subject: ${source.sourceSubject}`,
      `claim: ${source.claimText}`,
      `relation: ${source.entityRelationText}`,
    ].join("\n");
    writeFileSync(capturePath, capture, "utf8");
    source.captureSha256 = sha256Text(capture);
    reseal(manifestPath, manifest);
    const sourcedRelation = runWorkflow(workspace, "validate");
    assert.equal(sourcedRelation.status, 0, sourcedRelation.stdout + sourcedRelation.stderr);

    source.entityRelationText = "京东集团旗下子公司京东集团控股有限公司。";
    claim.entityMatch = "京东集团旗下子公司京东集团控股有限公司。";
    capture = [
      `subject: ${source.sourceSubject}`,
      `claim: ${source.claimText}`,
      `relation: ${source.entityRelationText}`,
    ].join("\n");
    writeFileSync(capturePath, capture, "utf8");
    source.captureSha256 = sha256Text(capture);
    reseal(manifestPath, manifest);
    const ownershipDoesNotEstablishSameHeadquarters = runWorkflow(workspace, "validate");
    assert.notEqual(
      ownershipDoesNotEstablishSameHeadquarters.status,
      0,
      ownershipDoesNotEstablishSameHeadquarters.stdout + ownershipDoesNotEstablishSameHeadquarters.stderr,
    );
    assert.match(ownershipDoesNotEstablishSameHeadquarters.stderr, /entityRelationText|relationship/i);

    // A short name occurring only inside the ranked enterprise's longer name
    // is not an independently cited source entity.
    source.sourceSubject = "京东";
    source.claimText = "京东总部位于杭州。";
    source.entityRelationText = "京东集团原名为京东集团。";
    claim.entityMatch = "京东集团与京东合作。";
    capture = [
      `subject: ${source.sourceSubject}`,
      `claim: ${source.claimText}`,
      `relation: ${source.entityRelationText}`,
    ].join("\n");
    writeFileSync(capturePath, capture, "utf8");
    source.captureSha256 = sha256Text(capture);
    reseal(manifestPath, manifest);
    const namePrefixOnly = runWorkflow(workspace, "validate");
    assert.notEqual(namePrefixOnly.status, 0, namePrefixOnly.stdout + namePrefixOnly.stderr);
    assert.match(namePrefixOnly.stderr, /entityRelationText|relationship/i);

    source.entityRelationText = "京东集团与京东合作且京东集团原名为京东集团。";
    capture = [
      `subject: ${source.sourceSubject}`,
      `claim: ${source.claimText}`,
      `relation: ${source.entityRelationText}`,
    ].join("\n");
    writeFileSync(capturePath, capture, "utf8");
    source.captureSha256 = sha256Text(capture);
    reseal(manifestPath, manifest);
    const namePrefixInSameClause = runWorkflow(workspace, "validate");
    assert.notEqual(namePrefixInSameClause.status, 0, namePrefixInSameClause.stdout + namePrefixInSameClause.stderr);
    assert.match(namePrefixInSameClause.stderr, /entityRelationText|relationship/i);

    source.sourceSubject = "甲公司";
    source.claimText = "甲公司总部位于杭州。";
    source.entityRelationText = "北京京东集团原名为甲公司；京东集团与甲公司合作。";
    claim.entityMatch = "京东集团与甲公司合作。";
    capture = [
      `subject: ${source.sourceSubject}`,
      `claim: ${source.claimText}`,
      `relation: ${source.entityRelationText}`,
    ].join("\n");
    writeFileSync(capturePath, capture, "utf8");
    source.captureSha256 = sha256Text(capture);
    reseal(manifestPath, manifest);
    const leftEntitySuffix = runWorkflow(workspace, "validate");
    assert.notEqual(leftEntitySuffix.status, 0, leftEntitySuffix.stdout + leftEntitySuffix.stderr);
    assert.match(leftEntitySuffix.stderr, /entityRelationText|relationship/i);

    source.sourceSubject = "京东";
    source.claimText = "北京京东总部位于杭州。";
    source.entityRelationText = "京东集团原名为京东。";
    claim.entityMatch = "京东集团原名为京东。";
    capture = [
      `subject: ${source.sourceSubject}`,
      `claim: ${source.claimText}`,
      `relation: ${source.entityRelationText}`,
    ].join("\n");
    writeFileSync(capturePath, capture, "utf8");
    source.captureSha256 = sha256Text(capture);
    reseal(manifestPath, manifest);
    const claimSubjectSuffix = runWorkflow(workspace, "validate");
    assert.notEqual(claimSubjectSuffix.status, 0, claimSubjectSuffix.stdout + claimSubjectSuffix.stderr);
    assert.match(claimSubjectSuffix.stderr, /headquarters city/i);

    source.sourceSubject = "京东集团控股有限公司";
    source.claimText = "京东集团控股有限公司总部位于杭州。";
    source.entityRelationText = "京东集团原名为京东集团控股有限公司。";
    claim.entityMatch = "京东集团原名为京东集团控股有限公司。";
    capture = [
      `subject: ${source.sourceSubject}`,
      `claim: ${source.claimText}`,
      `relation: ${source.entityRelationText}`,
    ].join("\n");
    writeFileSync(capturePath, capture, "utf8");
    source.captureSha256 = sha256Text(capture);
    reseal(manifestPath, manifest);

    source.url = "https://publisher.example/headquarters-002";
    reseal(manifestPath, manifest);
    const placeholderHostname = runWorkflow(workspace, "validate");
    assert.notEqual(placeholderHostname.status, 0, placeholderHostname.stdout + placeholderHostname.stderr);
    assert.match(placeholderHostname.stderr, /placeholder HTTPS/i);
    source.url = "https://www.gov.cn/test/headquarters-002";
    reseal(manifestPath, manifest);

    review.publisherDomainVerified = false;
    reseal(manifestPath, manifest);
    const unverifiedPublisher = runWorkflow(workspace, "validate");
    assert.notEqual(unverifiedPublisher.status, 0, unverifiedPublisher.stdout + unverifiedPublisher.stderr);
    assert.match(unverifiedPublisher.stderr, /publisher-domain/i);
    review.publisherDomainVerified = true;

    source.entityRelationText = "";
    reseal(manifestPath, manifest);
    const missingRelation = runWorkflow(workspace, "validate");
    assert.notEqual(missingRelation.status, 0, missingRelation.stdout + missingRelation.stderr);
    assert.match(missingRelation.stderr, /entityRelationText|relationship/i);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
