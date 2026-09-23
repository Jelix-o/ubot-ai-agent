import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign as signPayload } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  headquartersResearchApprovalPayload,
  headquartersResearchCompletionLedgerSha256,
} from "./services/private-enterprise-ranking.js";
import type {
  HeadquartersEvidenceArchive,
  HeadquartersResearchApproval,
  HeadquartersResearchData,
  PrivateEnterpriseRankingData,
} from "./services/private-enterprise-ranking.js";

const projectRoot = path.resolve(".");
const reviewKeyName = "UBOT_PRIVATE_ENTERPRISE_HEADQUARTERS_REVIEW_PUBLIC_KEY";
const reviewKeyIdName = "UBOT_PRIVATE_ENTERPRISE_HEADQUARTERS_REVIEW_PUBLIC_KEY_ID";
const releaseVersion = String(JSON.parse(readFileSync(path.join(projectRoot, "package.json"), "utf8")).version);

const releasePaths = [
  ".env.example",
  ".env.server-2022.example",
  "COMMANDS.md",
  "README.md",
  `RELEASE-v${releaseVersion}.md`,
  "package-lock.json",
  "package.json",
  "assets/blacklisted-at-meme.jpg",
  "assets/huixian-profile.json",
  "assets/private-enterprises-2026-audit.json",
  "assets/private-enterprises-2026-headquarters-evidence.json",
  "assets/private-enterprises-2026-headquarters-review.md",
  "assets/private-enterprises-2026-headquarters.json",
  "assets/private-enterprises-2026-review.md",
  "assets/private-enterprises-2026.json",
  "deploy/nginx/bot.9958.uk.conf",
  "deploy/nginx/preview.9958.uk.conf",
  "deploy/nginx/ubot-preview-static.conf",
  "deploy/systemd/ubot-admin.service.template",
  "deploy/systemd/ubot-ingress.service.template",
  "deploy/systemd/ubot-maintenance.service.template",
  "deploy/systemd/ubot-maintenance.timer.template",
  "deploy/systemd/ubot-worker.service.template",
  "deploy/systemd/ubot.target.template",
  "docs/ADMIN-RECOVERY-v3.md",
  "docs/MIGRATION-v3.md",
  "docs/OPERATIONS-v3.md",
  "docs/ROLLBACK-v3.md",
  "scripts/configure-image-model.mjs",
  "scripts/configure-v3-network.mjs",
  "scripts/deploy-linux-release.sh",
  "scripts/migrate-v3-state.mjs",
  "scripts/normalize-dotenv-bom.mjs",
  "scripts/verify-release-source.mjs",
];

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function capturedContentSha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalResearchEntry(entry: HeadquartersResearchData["entries"][number]) {
  return {
    rank: entry.rank,
    enterpriseName: entry.enterpriseName,
    rankingRowSha256: entry.rankingRowSha256,
    entityMatch: entry.entityMatch,
    headquarters: {
      province: entry.headquarters.province,
      city: entry.headquarters.city,
      administrativeLevel: entry.headquarters.administrativeLevel,
      asOf: entry.headquarters.asOf,
      evidence: entry.headquarters.evidence.map((evidence) => ({
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
      })),
    },
  };
}

function sourceManifest(entries: HeadquartersResearchData["entries"]) {
  return entries.flatMap((entry) => entry.headquarters.evidence.map((evidence) => ({
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
  })));
}

function rankingRowSha256(entry: PrivateEnterpriseRankingData["entries"][number]): string {
  return sha256({
    rank: entry.rank,
    name: entry.name,
    province: entry.province,
    revenueWan: entry.revenueWan,
  });
}

function makeCompleteHeadquartersFixture(data: PrivateEnterpriseRankingData) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const research: HeadquartersResearchData = {
    schemaVersion: 1,
    edition: 2026,
    rankingRowsSha256: data.rowsSha256,
    frozenAt: data.publishedOn,
    status: "complete",
    researchRowsSha256: "",
    sourceManifestSha256: "",
    evidenceArchiveSha256: "",
    entries: [],
  };
  const evidenceArchive: HeadquartersEvidenceArchive = {
    schemaVersion: 1,
    edition: 2026,
    entriesSha256: "",
    entries: [],
  };

  for (const entry of data.entries) {
    const evidenceId = `hq-2026-${String(entry.rank).padStart(3, "0")}`;
    const sourceUrl = `https://www.gov.cn/zhengce/headquarters-2026/${entry.rank}`;
    const claimText = `${entry.name}的可核验资料明确其总部位于深圳市。`;
    const capturedContent = [
      `evidenceId: ${evidenceId}`,
      `sourceUrl: ${sourceUrl}`,
      `sourceSubject: ${entry.name}`,
      `claim: ${claimText}`,
    ].join("\n");
    const evidence = {
      evidenceId,
      authority: "government" as const,
      publisher: "国务院公开资料",
      sourceUrl,
      sourcePublishedOn: data.publishedOn,
      claimAsOf: data.publishedOn,
      retrievedOn: data.publishedOn,
      capturedContentSha256: capturedContentSha256(capturedContent),
      sourceSubject: entry.name,
      claimText,
    };
    research.entries.push({
      rank: entry.rank,
      enterpriseName: entry.name,
      rankingRowSha256: rankingRowSha256(entry),
      entityMatch: `${entry.name}与${entry.name}来源主体一致`,
      headquarters: {
        province: "广东省",
        city: "深圳市",
        administrativeLevel: "prefecture",
        asOf: data.publishedOn,
        evidence: [evidence],
      },
    });
    evidenceArchive.entries.push({
      evidenceId,
      capturedContentSha256: evidence.capturedContentSha256,
      capturedContent,
    });
  }

  evidenceArchive.entriesSha256 = sha256(evidenceArchive.entries.map((entry) => ({
    evidenceId: entry.evidenceId,
    capturedContentSha256: entry.capturedContentSha256,
    capturedContent: entry.capturedContent,
  })));
  research.researchRowsSha256 = sha256(research.entries.map(canonicalResearchEntry));
  research.sourceManifestSha256 = sha256(sourceManifest(research.entries));
  research.evidenceArchiveSha256 = evidenceArchive.entriesSha256;

  const approval: HeadquartersResearchApproval = {
    reviewProtocol: 1,
    reviewerId: "release-verifier-test-reviewer",
    reviewedAt: data.publishedOn,
    scope: "2026_private_enterprise_top_500_headquarters",
    ledgerSha256: headquartersResearchCompletionLedgerSha256(research),
    evidenceArchiveSha256: evidenceArchive.entriesSha256,
    publicKeyId: "release-verifier-test-key-2026",
    signature: "",
  };
  research.completionApproval = {
    ...approval,
    signature: signPayload(
      null,
      Buffer.from(JSON.stringify(headquartersResearchApprovalPayload(research, approval)), "utf8"),
      privateKey,
    ).toString("base64"),
  };

  return {
    research,
    evidenceArchive,
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    publicKeyId: approval.publicKeyId,
  };
}

function copyReleaseFixture(root: string): void {
  cpSync(path.join(projectRoot, "dist"), path.join(root, "dist"), { recursive: true });
  for (const relativePath of releasePaths) {
    const destination = path.join(root, relativePath);
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(path.join(projectRoot, relativePath), destination, { recursive: true });
  }
}

function verifierEnvironment(additions: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => {
      const normalized = key.toUpperCase();
      return normalized !== reviewKeyName && normalized !== reviewKeyIdName;
    }),
  );
  return { ...environment, ...additions };
}

function runVerifier(root: string, args: string[] = [], env: NodeJS.ProcessEnv = verifierEnvironment()) {
  return spawnSync(
    process.execPath,
    [path.join(root, "scripts", "verify-release-source.mjs"), root, ...args],
    { cwd: projectRoot, encoding: "utf8", env, shell: false },
  );
}

test("release source verification requires the pinned reviewer key for a completed 500-row headquarters ledger", () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "ubot-release-verifier-"));
  const releaseRoot = path.join(temporaryRoot, "release");
  const reviewEnvPath = path.join(temporaryRoot, "headquarters-review.env");
  try {
    copyReleaseFixture(releaseRoot);
    const primary = JSON.parse(
      readFileSync(path.join(projectRoot, "assets", "private-enterprises-2026.json"), "utf8"),
    ) as PrivateEnterpriseRankingData;
    const fixture = makeCompleteHeadquartersFixture(primary);
    assert.equal(fixture.research.entries.length, 500);
    assert.equal(fixture.evidenceArchive.entries.length, 500);
    writeFileSync(
      path.join(releaseRoot, "assets", "private-enterprises-2026-headquarters.json"),
      `${JSON.stringify(fixture.research, null, 2)}\n`,
      "utf8",
    );
    writeFileSync(
      path.join(releaseRoot, "assets", "private-enterprises-2026-headquarters-evidence.json"),
      `${JSON.stringify(fixture.evidenceArchive, null, 2)}\n`,
      "utf8",
    );

    const noKey = runVerifier(releaseRoot);
    assert.notEqual(noKey.status, 0, noKey.stdout + noKey.stderr);
    assert.match(noKey.stderr, /headquarters.*approval|approval.*headquarters/i);

    const withEnvironmentKey = runVerifier(releaseRoot, [], verifierEnvironment({
      [reviewKeyName]: fixture.publicKey,
      [reviewKeyIdName]: fixture.publicKeyId,
    }));
    assert.equal(withEnvironmentKey.status, 0, withEnvironmentKey.stdout + withEnvironmentKey.stderr);

    writeFileSync(
      reviewEnvPath,
      `${reviewKeyName}=${fixture.publicKey}\n${reviewKeyIdName}=${fixture.publicKeyId}\n`,
      "utf8",
    );
    const withReviewEnv = runVerifier(
      releaseRoot,
      ["--headquarters-review-env", reviewEnvPath],
      verifierEnvironment(),
    );
    assert.equal(withReviewEnv.status, 0, withReviewEnv.stdout + withReviewEnv.stderr);

    const { publicKey: wrongPublicKey } = generateKeyPairSync("ed25519");
    const wrongKey = runVerifier(releaseRoot, [], verifierEnvironment({
      [reviewKeyName]: wrongPublicKey.export({ format: "der", type: "spki" }).toString("base64"),
      [reviewKeyIdName]: fixture.publicKeyId,
    }));
    assert.notEqual(wrongKey.status, 0, wrongKey.stdout + wrongKey.stderr);
    assert.match(wrongKey.stderr, /headquarters.*approval|approval.*headquarters/i);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
