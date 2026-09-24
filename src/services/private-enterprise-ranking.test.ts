import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign as signPayload } from "node:crypto";
import type { KeyObject } from "node:crypto";
import test from "node:test";

import {
  classifyPrivateEnterpriseRankingRequest,
  headquartersResearchApprovalPayload,
  headquartersResearchCompletionLedgerSha256,
  loadPrivateEnterpriseRanking,
  PrivateEnterpriseRanking,
} from "./private-enterprise-ranking.js";
import type {
  HeadquartersEvidenceArchive,
  HeadquartersResearchApproval,
  HeadquartersResearchData,
  HeadquartersResearchVerificationOptions,
  PrivateEnterpriseRankingData,
} from "./private-enterprise-ranking.js";

type ResearchStatus = "in_progress" | "complete";

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function rankingRowSha256(entry: PrivateEnterpriseRankingData["entries"][number]): string {
  return sha256({
    rank: entry.rank,
    name: entry.name,
    province: entry.province,
    revenueWan: entry.revenueWan,
  });
}

type SecureHeadquartersFixture = {
  research: HeadquartersResearchData;
  evidenceArchive: HeadquartersEvidenceArchive;
  verificationOptions: HeadquartersResearchVerificationOptions;
  privateKey: KeyObject;
};

function archiveContentSha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalSecureResearchRows(research: HeadquartersResearchData) {
  return research.entries.map((entry) => ({
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
        entityRelationText: evidence.entityRelationText,
      })),
    },
  }));
}

function secureSourceManifest(research: HeadquartersResearchData) {
  return research.entries.flatMap((entry) => entry.headquarters.evidence.map((evidence) => ({
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
  })));
}

function sealSecureResearch(fixture: SecureHeadquartersFixture): SecureHeadquartersFixture {
  fixture.evidenceArchive.entriesSha256 = sha256(fixture.evidenceArchive.entries);
  fixture.research.researchRowsSha256 = sha256(canonicalSecureResearchRows(fixture.research));
  fixture.research.sourceManifestSha256 = sha256(secureSourceManifest(fixture.research));
  fixture.research.evidenceArchiveSha256 = fixture.evidenceArchive.entriesSha256;
  return fixture;
}

function approveSecureResearch(
  fixture: SecureHeadquartersFixture,
  reviewedAt = fixture.research.frozenAt,
): SecureHeadquartersFixture {
  const approval: HeadquartersResearchApproval = {
    reviewProtocol: 1,
    reviewerId: "test-headquarters-reviewer",
    reviewedAt,
    scope: "2026_private_enterprise_top_500_headquarters",
    ledgerSha256: headquartersResearchCompletionLedgerSha256(fixture.research),
    evidenceArchiveSha256: fixture.evidenceArchive.entriesSha256,
    publicKeyId: "test-headquarters-review-key-2026",
    signature: "",
  };
  fixture.research.completionApproval = {
    ...approval,
    signature: signPayload(
      null,
      Buffer.from(JSON.stringify(headquartersResearchApprovalPayload(fixture.research, approval))),
      fixture.privateKey,
    ).toString("base64"),
  };
  return fixture;
}

function resealAndApproveSecureResearch(fixture: SecureHeadquartersFixture): SecureHeadquartersFixture {
  fixture.research.completionApproval = undefined;
  sealSecureResearch(fixture);
  return fixture.research.status === "complete" ? approveSecureResearch(fixture) : fixture;
}

function capturedContentForEvidence(
  evidence: HeadquartersResearchData["entries"][number]["headquarters"]["evidence"][number],
): string {
  return [
    "evidenceId: " + evidence.evidenceId,
    "sourceUrl: " + evidence.sourceUrl,
    "sourceSubject: " + evidence.sourceSubject,
    "claim: " + evidence.claimText,
    ...(evidence.entityRelationText ? ["entityRelation: " + evidence.entityRelationText] : []),
  ].join("\\n");
}

function syncArchiveCapture(fixture: SecureHeadquartersFixture, rank: number): void {
  const evidence = fixture.research.entries[rank - 1]!.headquarters.evidence[0]!;
  const archived = fixture.evidenceArchive.entries.find((entry) => entry.evidenceId === evidence.evidenceId);
  assert.ok(archived, "fixture archive record must exist");
  const capturedContent = capturedContentForEvidence(evidence);
  const capturedHash = archiveContentSha256(capturedContent);
  archived.capturedContent = capturedContent;
  archived.capturedContentSha256 = capturedHash;
  evidence.capturedContentSha256 = capturedHash;
}

function setMismatchedSourceSubject(fixture: SecureHeadquartersFixture): void {
  const entry = fixture.research.entries[0]!;
  const evidence = entry.headquarters.evidence[0]!;
  const sourceSubject = "京东集团控股有限公司";
  entry.entityMatch = `${entry.enterpriseName}原名为${sourceSubject}`;
  evidence.sourceSubject = sourceSubject;
  evidence.claimText = `${sourceSubject}总部位于${entry.headquarters.city}。`;
  evidence.entityRelationText = `${entry.enterpriseName}原名为${sourceSubject}。`;
}

function reuseEvidenceIdForTwoEntries(fixture: SecureHeadquartersFixture): void {
  const first = fixture.research.entries[0]!;
  const second = fixture.research.entries[1]!;
  const evidenceId = "hq-2026-shared";
  const firstEvidence = {
    evidenceId,
    authority: "enterprise" as const,
    publisher: "联合企业官方资料",
    sourceUrl: "https://www.gov.cn/zhengce/headquarters-2026/shared",
    sourcePublishedOn: "2026-09-01",
    claimAsOf: "2026-09-01",
    retrievedOn: fixture.research.frozenAt,
    capturedContentSha256: "",
    sourceSubject: first.enterpriseName,
    claimText: `${first.enterpriseName}总部位于深圳市。`,
  };
  const secondEvidence = {
    ...firstEvidence,
    sourceSubject: second.enterpriseName,
    claimText: `${second.enterpriseName}总部位于深圳市。`,
  };
  const capturedContent = [
    capturedContentForEvidence(firstEvidence),
    capturedContentForEvidence(secondEvidence),
  ].join("\n");
  const capturedContentSha256 = archiveContentSha256(capturedContent);
  firstEvidence.capturedContentSha256 = capturedContentSha256;
  secondEvidence.capturedContentSha256 = capturedContentSha256;

  for (const [entry, evidence] of [[first, firstEvidence], [second, secondEvidence]] as const) {
    entry.entityMatch = entry.enterpriseName + "与来源主体一致";
    entry.headquarters.province = "广东省";
    entry.headquarters.city = "深圳市";
    entry.headquarters.administrativeLevel = "prefecture";
    entry.headquarters.asOf = "2026-09-01";
    entry.headquarters.evidence = [structuredClone(evidence)];
  }
  fixture.evidenceArchive.entries = fixture.evidenceArchive.entries
    .filter((entry) => entry.evidenceId !== "hq-2026-001" && entry.evidenceId !== "hq-2026-002");
  fixture.evidenceArchive.entries.push({
    evidenceId,
    capturedContentSha256,
    capturedContent,
  });
  resealAndApproveSecureResearch(fixture);
}

function makeSecureResearch(
  data: PrivateEnterpriseRankingData,
  status: ResearchStatus,
  count: number,
): SecureHeadquartersFixture {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const evidenceArchive: HeadquartersEvidenceArchive = {
    schemaVersion: 1,
    edition: 2026,
    entriesSha256: "",
    entries: [],
  };
  const research: HeadquartersResearchData = {
    schemaVersion: 1,
    edition: 2026,
    rankingRowsSha256: data.rowsSha256,
    frozenAt: data.publishedOn,
    status,
    researchRowsSha256: "",
    sourceManifestSha256: "",
    evidenceArchiveSha256: "",
    entries: data.entries.slice(0, count).map((entry) => {
      // This deliberate cross-province record verifies that headquarters and
      // published-ranking province remain independent fields.
      const isCrossProvince = entry.rank === 1;
      const city = isCrossProvince ? "深圳市" : "杭州市";
      const evidenceId = "hq-2026-" + String(entry.rank).padStart(3, "0");
      const sourceUrl = "https://www.gov.cn/zhengce/headquarters-2026/" + entry.rank;
      const claimText = entry.name + "总部位于" + city + "。";
      const capturedContent = [
        "evidenceId: " + evidenceId,
        "sourceUrl: " + sourceUrl,
        "sourceSubject: " + entry.name,
        "claim: " + claimText,
      ].join("\\n");
      const capturedHash = archiveContentSha256(capturedContent);
      evidenceArchive.entries.push({
        evidenceId,
        capturedContentSha256: capturedHash,
        capturedContent,
      });
      return {
        rank: entry.rank,
        enterpriseName: entry.name,
        rankingRowSha256: rankingRowSha256(entry),
        entityMatch: entry.name + "与可核验来源主体一致",
        headquarters: {
          province: isCrossProvince ? "广东省" : "浙江省",
          city,
          administrativeLevel: "prefecture",
          asOf: "2026-09-01",
          evidence: [{
            evidenceId,
            authority: entry.rank % 2 === 0 ? "government" : "enterprise",
            publisher: entry.rank % 2 === 0 ? "测试市人民政府" : entry.name + "官方网站",
            sourceUrl,
            sourcePublishedOn: "2026-09-01",
            claimAsOf: "2026-09-01",
            retrievedOn: data.publishedOn,
            capturedContentSha256: capturedHash,
            sourceSubject: entry.name,
            claimText,
          }],
        },
      };
    }),
  };
  const fixture: SecureHeadquartersFixture = {
    research,
    evidenceArchive,
    verificationOptions: {
      approvalPublicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
      approvalPublicKeyId: "test-headquarters-review-key-2026",
    },
    privateKey,
  };
  sealSecureResearch(fixture);
  return status === "complete" ? approveSecureResearch(fixture) : fixture;
}

test("the published asset has 500 ordered, checksum-verified rows", () => {
  const ranking = loadPrivateEnterpriseRanking();
  assert.equal(ranking.data.entries.length, 500);
  assert.equal(ranking.data.entries[0]?.name, "京东集团");
  assert.equal(ranking.data.entries[499]?.name, "玲珑集团有限公司");
  assert.equal(ranking.data.entries.reduce((count, entry) => count + Number(entry.province === "广东省"), 0), 49);
  assert.equal(ranking.data.entries.reduce((count, entry) => count + Number(entry.province === "浙江省"), 0), 104);
  assert.deepEqual(ranking.data.entries[380], { rank: 381, name: "浙江协和集团有限公司", province: "浙江省", revenueWan: 3497839 });
  assert.equal(ranking.data.entries[392]?.revenueWan, 3401313);
  assert.deepEqual(ranking.listPage({ query: "2", page: 1, pageSize: 20 }).items.map((entry) => entry.rank), [2]);
  assert.deepEqual(ranking.listPage({ query: "第2名", page: 1, pageSize: 20 }).items.map((entry) => entry.rank), [2]);
  assert.equal(ranking.cityCoverage, 0);
  assert.equal(ranking.cityReady, false);

  const damaged = structuredClone(ranking.data);
  damaged.entries[1]!.revenueWan = 1;
  assert.throws(() => new PrivateEnterpriseRanking(damaged), /checksum_mismatch/);
  const duplicate = structuredClone(ranking.data);
  duplicate.entries[1]!.name = duplicate.entries[0]!.name;
  assert.throws(() => new PrivateEnterpriseRanking(duplicate), /invalid_private_enterprise_ranking_row/);
});

test("ranking and province queries are deterministic and exhaustive", () => {
  const ranking = loadPrivateEnterpriseRanking();
  assert.match(ranking.answer("腾讯在2026中国民营企业500强排名第几？")?.messages[0] ?? "", /第6/);
  assert.match(ranking.answer("京东排名第几？")?.messages[0] ?? "", /第1/);
  assert.match(ranking.answer("阿里排几名？")?.messages[0] ?? "", /阿里巴巴（中国）有限公司.*排名第2/);
  assert.match(ranking.answer("阿里在2026榜单里怎样")?.messages[0] ?? "", /阿里巴巴（中国）有限公司.*排名第2/);
  assert.match(ranking.answer("阿里在2026民营500强里排第几？")?.messages[0] ?? "", /阿里巴巴（中国）有限公司.*排名第2/);
  assert.match(ranking.answer("阿里位居第几？")?.messages[0] ?? "", /阿里巴巴（中国）有限公司.*排名第2/);
  assert.match(ranking.answer("阿里排在第几名？")?.messages[0] ?? "", /阿里巴巴（中国）有限公司.*排名第2/);
  assert.match(ranking.answer("阿里名列第几？")?.messages[0] ?? "", /阿里巴巴（中国）有限公司.*排名第2/);
  assert.match(ranking.answer("阿里位于第几？")?.messages[0] ?? "", /阿里巴巴（中国）有限公司.*排名第2/);
  assert.match(ranking.answer("阿里进榜了吗？")?.messages[0] ?? "", /阿里巴巴（中国）有限公司.*排名第2/);
  assert.match(ranking.answer("比亚迪是否进入2026民营500强？")?.messages[0] ?? "", /比亚迪股份有限公司.*排名第5/);
  assert.match(ranking.answer("美团在民营企业500强排名多少？")?.messages[0] ?? "", /第19/);
  assert.match(ranking.answer("万向在民营企业500强排第几？")?.messages[0] ?? "", /多个可能的企业/);
  assert.match(ranking.answer("浙江省有多少家民营企业500强？")?.messages[0] ?? "", /104家/);
  assert.match(ranking.answer("浙江有几家")?.messages[0] ?? "", /浙江省共104家/);
  assert.match(ranking.answer("浙江上榜多少家")?.messages[0] ?? "", /浙江省共104家/);
  assert.match(ranking.answer("浙江省上榜家数")?.messages[0] ?? "", /浙江省共104家/);
  assert.equal((ranking.answer("浙江有哪些")?.messages ?? []).length, 6);
  assert.match(ranking.answer("全国有多少家")?.messages[0] ?? "", /共500家/);
  assert.match(ranking.answer("黑龙江省有多少家民营企业500强？")?.messages[0] ?? "", /共0家/);
  assert.match(ranking.answer("新疆生产建设兵团有多少家民营企业500强？")?.messages[0] ?? "", /共2家/);
  assert.match(ranking.answer("2026中国民营企业500强第500名是谁？")?.messages[0] ?? "", /玲珑集团/);
  assert.match(ranking.answer("中国民营500强排名第一是谁？")?.messages[0] ?? "", /第1名是京东集团/);
  assert.match(ranking.answer("第2名是谁？")?.messages[0] ?? "", /阿里巴巴（中国）有限公司/);
  assert.match(ranking.answer("2026第2名是什么公司？")?.messages[0] ?? "", /阿里巴巴（中国）有限公司/);
  assert.match(ranking.answer("第2位是什么？")?.messages[0] ?? "", /阿里巴巴（中国）有限公司/);
  assert.match(ranking.answer("谁排名第一？")?.messages[0] ?? "", /第1名是京东集团/);
  assert.match(ranking.answer("2025中国民营企业500强京东排名多少？")?.messages[0] ?? "", /仅收录2026/);
  assert.match(ranking.answer("2025中国民营企业500强第2名是谁？")?.messages[0] ?? "", /仅收录2026/);
  assert.match(ranking.answer("2025年第2名是谁？")?.messages[0] ?? "", /仅收录2026/);
  assert.match(ranking.answer("2025年阿里排几名？")?.messages[0] ?? "", /仅收录2026/);
  assert.match(ranking.answer("2025年字节跳动排几名？")?.messages[0] ?? "", /仅收录2026/);
  assert.match(ranking.answer("2026中国民营企业500强按2025年营收吗？")?.messages[0] ?? "", /按2025年营收排序/);
  assert.match(ranking.answer("全国有多少家2026民营企业500强？")?.messages[0] ?? "", /共500家/);
  assert.equal(ranking.answer("今天浙江天气如何？"), undefined);
  assert.equal(ranking.answer("今天2026年天气怎么样？"), undefined);
  assert.equal(ranking.answer("这部电影排名第一"), undefined);
  assert.equal(ranking.answer("2026年世界500强前十"), undefined);
  assert.equal(ranking.answer("2026年电影榜单前十"), undefined);
  assert.match(ranking.answer("2026中国民营企业500强有哪些？")?.messages[0] ?? "", /请指定榜单中的省级地区/);

  const topTen = ranking.answer("2026中国民营企业500强前10名有哪些？")?.messages ?? [];
  assert.equal(topTen.length, 1);
  assert.equal(topTen.join("\n").match(/第\d+名 /g)?.length, 10);
  assert.match(topTen[0] ?? "", /第1名 京东集团/);
  assert.match(topTen[0] ?? "", /第10名 山东魏桥创业集团有限公司/);
  const bareTopTen = ranking.answer("列出前十名")?.messages ?? [];
  assert.equal(bareTopTen.join("\n").match(/第\d+名 /g)?.length, 10);
  assert.equal((ranking.answer("前十名都有谁")?.messages ?? []).join("\n").match(/第\d+名 /g)?.length, 10);
  assert.equal((ranking.answer("第一到第十名")?.messages ?? []).join("\n").match(/第\d+名 /g)?.length, 10);
  const chineseTopTwenty = ranking.answer("2026民营500强前二十名")?.messages ?? [];
  assert.equal(chineseTopTwenty.join("\n").match(/第\d+名 /g)?.length, 20);
  const chineseTopHundred = ranking.answer("2026民营500强前一百名")?.messages ?? [];
  assert.equal(chineseTopHundred.length, 5);
  assert.equal(chineseTopHundred.join("\n").match(/第\d+名 /g)?.length, 100);
  const range = ranking.answer("2026中国民营企业500强第10到第20名有哪些？")?.messages ?? [];
  assert.equal(range.join("\n").match(/第\d+名 /g)?.length, 11);
  assert.match(range[0] ?? "", /第10至20名/);
  const chineseRange = ranking.answer("2026民营500强第十到第二十名")?.messages ?? [];
  assert.equal(chineseRange.join("\n").match(/第\d+名 /g)?.length, 11);
  assert.match(ranking.answer("2026中国民营企业500强前0名")?.messages[0] ?? "", /名次范围应在1至500之间/);
  assert.match(ranking.answer("2026中国民营企业500强第20到第10名")?.messages[0] ?? "", /名次范围应在1至500之间/);
  assert.match(ranking.answer("第501名是谁")?.messages[0] ?? "", /名次范围应在1至500之间/);
  assert.match(ranking.answer("前501名")?.messages[0] ?? "", /名次范围应在1至500之间/);
  assert.match(ranking.answer("前零名")?.messages[0] ?? "", /名次范围应在1至500之间/);
  assert.equal((ranking.answer("前一百零一名")?.messages ?? []).join("\n").match(/第\d+名 /g)?.length, 101);
  assert.match(ranking.answer("第两百零一名是谁")?.messages[0] ?? "", /第201名/);

  assert.match(
    ranking.query({ operation: "national_count", edition: 2025 }).messages[0] ?? "",
    /仅收录2026|不能用这份榜单回答其他年份/,
  );

  const list = ranking.answer("浙江省有哪些民营企业500强？")?.messages ?? [];
  assert.equal(list.length, 6);
  assert.match(list[0] ?? "", /104家（按榜单省份，1\/6）/);
  assert.match(list.at(-1) ?? "", /104家（按榜单省份，6\/6）/);
  assert.equal(list.join("\n").match(/第\d+名 /g)?.length, 104);
  assert.deepEqual(ranking.answer("分别是哪些？", [
    { role: "user", content: "浙江省有多少家民营企业500强？" },
    { role: "assistant", content: "2026中国民营企业500强：浙江省共104家。" },
  ])?.messages, list);
  assert.match(ranking.answer("那个省最多？", [
    { role: "user", content: "湖北省有多少家2026民营企业500强？" },
    { role: "assistant", content: "2026中国民营企业500强：湖北省共12家（按榜单省份；2025年营收）。" },
  ])?.messages[0] ?? "", /浙江省.*104家/);
  assert.match(ranking.answer("最多的是哪个省？", [
    { role: "assistant", content: "2026中国民营企业500强：浙江省共104家。" },
  ])?.messages[0] ?? "", /浙江省.*104家/);
  assert.match(ranking.answer("各省分别有多少家", [
    { role: "assistant", content: "2026中国民营企业500强：浙江省共104家。" },
  ])?.messages[0] ?? "", /1\. 浙江省104家；2\. 江苏省90家/);
  assert.match(ranking.answer("按省份排名呢", [
    { role: "assistant", content: "2026中国民营企业500强：浙江省共104家。" },
  ])?.messages[0] ?? "", /1\. 浙江省104家；2\. 江苏省90家/);
  assert.match(ranking.answer("排名第二的省份呢", [
    { role: "assistant", content: "2026中国民营企业500强：浙江省共104家。" },
  ])?.messages[0] ?? "", /排名第2的是江苏省，共90家/);
  assert.match(ranking.answer("按省份排序")?.messages[0] ?? "", /1\. 浙江省104家；2\. 江苏省90家/);
  assert.match(ranking.answer("各省上榜家数")?.messages[0] ?? "", /1\. 浙江省104家；2\. 江苏省90家/);
  assert.match(ranking.answer("哪个省上榜最多？")?.messages[0] ?? "", /浙江省.*104家/);
  assert.match(ranking.answer("湖北省和湖南省上榜家数哪个多？")?.messages[0] ?? "", /湖北省12家；湖南省10家。湖北省多2家/);
  assert.match(ranking.answer("排名第二的省")?.messages[0] ?? "", /排名第2的是江苏省，共90家/);
  assert.match(ranking.answer("第二名省份")?.messages[0] ?? "", /排名第2的是江苏省.*90家/);
  assert.match(ranking.answer("排名第10的省份")?.messages[0] ?? "", /排名第10的是安徽省、湖北省，各12家/);
  const contextualCount = ranking.answer("有几家？", [
    { role: "user", content: "浙江省有多少家2026民营企业500强？" },
    { role: "assistant", content: "2026中国民营企业500强：浙江省共104家。" },
  ])?.messages ?? [];
  assert.equal(contextualCount.length, 1);
  assert.match(contextualCount[0] ?? "", /浙江省共104家（按榜单省份；2025年营收）/);
  assert.equal(ranking.answer("有谁？", [
    { role: "assistant", content: "2026中国民营企业500强：浙江省共104家。" },
  ])?.messages.length, 6);
  assert.equal(ranking.answer("那些呢", [
    { role: "assistant", content: "2026中国民营企业500强：浙江省共104家。" },
  ])?.messages.length, 6);
  assert.match(ranking.answer("字节跳动是否上榜")?.messages[0] ?? "", /没有在2026中国民营企业500强中找到该企业/);
  assert.equal(ranking.answer("哪个省最多？"), undefined);
  const largestProvince = ranking.answer("那个省最多？", [
    { role: "user", content: "湖北省有多少家2026民营企业500强？" },
    { role: "assistant", content: "2026中国民营企业500强：湖北省共12家（按榜单省份；2025年营收）。" },
  ])?.messages[0] ?? "";
  const largestProvinceList = ranking.answer("分别是哪些？", [
    { role: "user", content: "那个省最多？" },
    { role: "assistant", content: largestProvince },
  ])?.messages ?? [];
  assert.equal(largestProvinceList.length, 6);
  assert.match(largestProvinceList[0] ?? "", /浙江省共104家/);
  assert.match(ranking.answer("第2名是谁？", [
    { role: "user", content: "2026中国民营企业500强第1名是谁？" },
    { role: "assistant", content: "2026中国民营企业500强第1名是京东集团。" },
  ])?.messages[0] ?? "", /阿里巴巴（中国）有限公司/);
  assert.match(ranking.answer("湖北省和湖南省上榜家数哪个多？", [
    { role: "user", content: "2026中国民营企业500强各省上榜情况" },
    { role: "assistant", content: "2026中国民营企业500强：浙江省共104家。" },
  ])?.messages[0] ?? "", /湖北省12家；湖南省10家。湖北省多2家/);
  assert.equal(ranking.answer("湖北省和湖南省哪个多？"), undefined);
});

test("ranking scope is explicit or tied to the immediately preceding verified answer", () => {
  assert.equal(classifyPrivateEnterpriseRankingRequest("2026中国民营企业500强前十名"), "explicit");
  assert.equal(classifyPrivateEnterpriseRankingRequest("2026民营500强前十名"), "explicit");
  assert.equal(classifyPrivateEnterpriseRankingRequest("前十名"), "explicit");
  assert.equal(classifyPrivateEnterpriseRankingRequest("列出前十名"), "explicit");
  assert.equal(classifyPrivateEnterpriseRankingRequest("前十名都有谁"), "explicit");
  assert.equal(classifyPrivateEnterpriseRankingRequest("第一到第十名"), "explicit");
  assert.equal(classifyPrivateEnterpriseRankingRequest("第2名是谁"), "explicit");
  assert.equal(classifyPrivateEnterpriseRankingRequest("按省份排序"), "explicit");
  assert.equal(classifyPrivateEnterpriseRankingRequest("各省上榜家数"), "explicit");
  assert.equal(classifyPrivateEnterpriseRankingRequest("哪个省上榜最多"), "explicit");
  assert.equal(classifyPrivateEnterpriseRankingRequest("湖北省和湖南省上榜家数哪个多"), "explicit");
  assert.equal(classifyPrivateEnterpriseRankingRequest("排名第二的省"), "explicit");
  assert.equal(classifyPrivateEnterpriseRankingRequest("民营500强里浙江有几家"), "explicit");
  assert.equal(classifyPrivateEnterpriseRankingRequest("民营企业五百强里浙江有几家"), "explicit");
  assert.equal(classifyPrivateEnterpriseRankingRequest("2026年世界500强前十"), "none");
  assert.equal(classifyPrivateEnterpriseRankingRequest("2026年电影榜单前十"), "none");
  assert.equal(classifyPrivateEnterpriseRankingRequest("今天2026年天气怎么样？"), "none");
  assert.equal(classifyPrivateEnterpriseRankingRequest("第2名是谁？"), "explicit");
  assert.equal(classifyPrivateEnterpriseRankingRequest("2025年第2名是谁？"), "explicit");
  assert.equal(classifyPrivateEnterpriseRankingRequest("第2名是谁？", [
    { role: "assistant", content: "2026中国民营企业500强：浙江省共104家。" },
  ]), "explicit");
  assert.equal(classifyPrivateEnterpriseRankingRequest("按省份排名呢", [
    { role: "assistant", content: "2026中国民营企业500强：浙江省共104家。" },
  ]), "explicit");
});

test("ranking context does not capture ordinary questions after a ranking reply", () => {
  const ranking = loadPrivateEnterpriseRanking();
  const history = [
    { role: "user", content: "浙江省有多少家2026民营企业500强？" },
    { role: "assistant", content: "2026中国民营企业500强：浙江省共104家（按榜单省份；2025年营收）。" },
  ];

  // Keep compact, explicit continuations on the deterministic ranking path.
  assert.equal(classifyPrivateEnterpriseRankingRequest("分别是哪些？", history), "contextual");
  assert.equal(ranking.answer("分别是哪些？", history)?.messages.length, 6);

  // These are ordinary questions. The ranking service must decline them so the
  // normal model can answer instead of inventing a Top 500 response.
  for (const ordinaryQuestion of [
    "南京的本科院校有哪些？",
    "武汉的本科院校有多少个，前十的分别是？",
    "2026中国民营企业500强中，武汉的本科院校有多少个，前十的分别是？",
    "哪个省本科院校最多？",
    "北京市和上海市哪个大学多？",
    "金山办公是什么公司？",
    // A year and ordinal describe many ordinary rankings; they do not name
    // this Top 500 dataset.
    "2026年第一名大学是谁？",
    "2026年前十名大学有哪些？",
    // Province words plus count/list wording are likewise normal chat until
    // the user supplies a Top 500 scope.
    "江苏省有哪些大学？",
    "浙江省有多少家医院？",
    // An unknown organisation's rank or location must not become a Top 500
    // no-result merely because it resembles a company lookup.
    "清华大学排几名？",
    "南京大学位于哪里？",
    // Even after a ranking turn, a generic enterprise comparison needs an
    // explicit listing/count qualifier before it can inherit that context.
    "江苏省和安徽省企业哪个多？",
  ]) {
    assert.equal(classifyPrivateEnterpriseRankingRequest(ordinaryQuestion, history), "none");
    assert.equal(ranking.answer(ordinaryQuestion, history), undefined);
  }

  // Keep the corresponding, explicitly scoped ranking operations local.
  assert.equal(classifyPrivateEnterpriseRankingRequest("2026中国民营企业500强第1名是谁？", history), "explicit");
  assert.match(ranking.answer("2026中国民营企业500强第1名是谁？", history)?.messages[0] ?? "", /第1名是京东集团/);
  assert.equal(classifyPrivateEnterpriseRankingRequest("江苏省有哪些2026民营企业500强？", history), "explicit");
  assert.match(ranking.answer("江苏省有哪些2026民营企业500强？", history)?.messages[0] ?? "", /江苏省共90家/);
  assert.equal(classifyPrivateEnterpriseRankingRequest("江苏省和安徽省上榜家数哪个多？", history), "explicit");
  assert.match(ranking.answer("江苏省和安徽省上榜家数哪个多？", history)?.messages[0] ?? "", /江苏省90家；安徽省12家/);
});

test("city counts fail closed until the independent headquarters sidecar is complete and auditable", () => {
  const ranking = loadPrivateEnterpriseRanking();
  assert.match(ranking.answer("杭州有多少家2026民营企业500强？")?.messages[0] ?? "", /尚未全部核验/);
  assert.match(ranking.answer("2026中国民营企业500强里，杭州有多少家？")?.messages[0] ?? "", /尚未全部核验/);
  assert.match(ranking.answer("浙江省杭州市有哪些民营企业500强？")?.messages[0] ?? "", /暂不能给出/);
  assert.match(ranking.answer("浙江省杭州有多少家民营企业500强？")?.messages[0] ?? "", /尚未全部核验/);
  assert.match(ranking.answer("浙江杭州有多少家民营企业500强？")?.messages[0] ?? "", /尚未全部核验/);
  for (const municipality of ["北京市", "天津市", "上海市", "重庆市"]) {
    assert.match(ranking.answer(`${municipality}有多少家2026民营企业500强？`)?.messages[0] ?? "", /尚未全部核验/);
  }
  assert.match(ranking.answer("按榜单省份，北京市有多少家2026民营企业500强？")?.messages[0] ?? "", /24家/);
  assert.match(ranking.answer("北京总部城市有多少家2026民营企业500强？")?.messages[0] ?? "", /尚未全部核验/);

  const partialFixture = makeSecureResearch(ranking.data, "in_progress", 1);
  const partial = new PrivateEnterpriseRanking(
    ranking.data,
    partialFixture.research,
    partialFixture.evidenceArchive,
    partialFixture.verificationOptions,
  );
  assert.equal(partial.cityReady, false);
  assert.match(partial.answer("深圳市有多少家2026民营企业500强？")?.messages[0] ?? "", /尚未全部核验/);
  // Partial evidence is strictly internal research progress. It must never be
  // projected into a general admin list, even for a direct rank lookup.
  const partialPage = partial.listPage({ rank: 1, page: 1, pageSize: 20 });
  assert.equal(partialPage.items[0]?.headquarters, undefined);
  assert.equal(partial.listPage({ city: "深圳市", page: 1, pageSize: 20 }).pagination.total, 0);

  const completeFixture = makeSecureResearch(ranking.data, "complete", 500);
  const verified = new PrivateEnterpriseRanking(
    ranking.data,
    completeFixture.research,
    completeFixture.evidenceArchive,
    completeFixture.verificationOptions,
  );
  assert.equal(verified.cityReady, true);
  assert.equal(verified.cityCoverage, 500);
  assert.equal(verified.data.entries[0]?.province, "北京市");
  assert.equal(verified.data.entries[0]?.headquarters?.city, "深圳市");
  assert.match(verified.answer("深圳市有多少家2026民营企业500强？")?.messages[0] ?? "", /1家/);
  assert.match(verified.answer("深圳市有哪些2026民营企业500强？")?.messages[0] ?? "", /按榜单发布时核验的总部城市/);
  assert.equal(verified.listPage({ city: "深圳市", page: 1, pageSize: 20 }).pagination.total, 1);
  assert.equal(verified.listPage({ province: "北京市", page: 1, pageSize: 20 }).pagination.total, 24);

  const missingApproval = makeSecureResearch(ranking.data, "complete", 500);
  missingApproval.research.completionApproval = undefined;
  assert.throws(
    () => new PrivateEnterpriseRanking(
      ranking.data,
      missingApproval.research,
      missingApproval.evidenceArchive,
      missingApproval.verificationOptions,
    ),
    /headquarters.*approval|approval.*headquarters/i,
  );

  const badSignature = makeSecureResearch(ranking.data, "complete", 500);
  badSignature.research.completionApproval!.signature = "not-a-valid-ed25519-signature";
  assert.throws(
    () => new PrivateEnterpriseRanking(
      ranking.data,
      badSignature.research,
      badSignature.evidenceArchive,
      badSignature.verificationOptions,
    ),
    /headquarters.*approval|approval.*headquarters|signature/i,
  );

  const wrongKey = makeSecureResearch(ranking.data, "complete", 500);
  const { publicKey: unrelatedPublicKey } = generateKeyPairSync("ed25519");
  wrongKey.verificationOptions = {
    ...wrongKey.verificationOptions,
    approvalPublicKey: unrelatedPublicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
  assert.throws(
    () => new PrivateEnterpriseRanking(
      ranking.data,
      wrongKey.research,
      wrongKey.evidenceArchive,
      wrongKey.verificationOptions,
    ),
    /headquarters.*approval|approval.*headquarters|signature/i,
  );

  const archiveMismatch = makeSecureResearch(ranking.data, "complete", 500);
  archiveMismatch.evidenceArchive.entries[0]!.capturedContent += " tampered";
  assert.throws(
    () => new PrivateEnterpriseRanking(
      ranking.data,
      archiveMismatch.research,
      archiveMismatch.evidenceArchive,
      archiveMismatch.verificationOptions,
    ),
    /headquarters.*(?:archive|evidence)|(?:archive|evidence).*headquarters/i,
  );

  const incompleteComplete = makeSecureResearch(ranking.data, "complete", 499);
  assert.throws(
    () => new PrivateEnterpriseRanking(
      ranking.data,
      incompleteComplete.research,
      incompleteComplete.evidenceArchive,
      incompleteComplete.verificationOptions,
    ),
    /headquarters.*(?:incomplete|research)|(?:incomplete|research).*headquarters/i,
  );

  const futureEvidence = makeSecureResearch(ranking.data, "complete", 500);
  futureEvidence.research.entries[0]!.headquarters.evidence[0]!.claimAsOf = "2026-09-23";
  resealAndApproveSecureResearch(futureEvidence);
  assert.throws(
    () => new PrivateEnterpriseRanking(
      ranking.data,
      futureEvidence.research,
      futureEvidence.evidenceArchive,
      futureEvidence.verificationOptions,
    ),
    /headquarters.*(?:evidence|research)|(?:evidence|research).*headquarters/i,
  );

  const backdatedApproval = makeSecureResearch(ranking.data, "complete", 500);
  backdatedApproval.research.completionApproval = undefined;
  sealSecureResearch(backdatedApproval);
  approveSecureResearch(backdatedApproval, "2026-08-31");
  assert.throws(
    () => new PrivateEnterpriseRanking(
      ranking.data,
      backdatedApproval.research,
      backdatedApproval.evidenceArchive,
      backdatedApproval.verificationOptions,
    ),
    /headquarters.*approval|approval.*headquarters/i,
  );

  const reviewBeforeLatestRetrieval = makeSecureResearch(ranking.data, "complete", 500);
  reviewBeforeLatestRetrieval.research.entries[0]!.headquarters.evidence[0]!.retrievedOn = "2026-09-23";
  resealAndApproveSecureResearch(reviewBeforeLatestRetrieval);
  assert.throws(
    () => new PrivateEnterpriseRanking(
      ranking.data,
      reviewBeforeLatestRetrieval.research,
      reviewBeforeLatestRetrieval.evidenceArchive,
      reviewBeforeLatestRetrieval.verificationOptions,
    ),
    /headquarters.*approval|approval.*headquarters/i,
  );

  const placeholderUrl = makeSecureResearch(ranking.data, "complete", 500);
  placeholderUrl.research.entries[0]!.headquarters.evidence[0]!.sourceUrl = "https://example.com/not-evidence";
  syncArchiveCapture(placeholderUrl, 1);
  resealAndApproveSecureResearch(placeholderUrl);
  assert.throws(
    () => new PrivateEnterpriseRanking(
      ranking.data,
      placeholderUrl.research,
      placeholderUrl.evidenceArchive,
      placeholderUrl.verificationOptions,
    ),
    /headquarters.*(?:evidence|research)|(?:evidence|research).*headquarters/i,
  );
});

test("headquarters evidence accepts source-faithful canonical city suffix aliases without changing the quote", () => {
  const ranking = loadPrivateEnterpriseRanking();
  const municipalAlias = makeSecureResearch(ranking.data, "in_progress", 1);
  const municipalEvidence = municipalAlias.research.entries[0]!.headquarters.evidence[0]!;
  municipalAlias.research.entries[0]!.headquarters.city = "杭州市";
  municipalAlias.research.entries[0]!.headquarters.province = "浙江省";
  municipalEvidence.claimText = `${municipalEvidence.sourceSubject}总部位于杭州。`;
  syncArchiveCapture(municipalAlias, 1);
  resealAndApproveSecureResearch(municipalAlias);
  assert.doesNotThrow(() => new PrivateEnterpriseRanking(
    ranking.data,
    municipalAlias.research,
    municipalAlias.evidenceArchive,
    municipalAlias.verificationOptions,
 ));
  assert.match(municipalEvidence.claimText, /杭州。$/);
  assert.doesNotMatch(municipalEvidence.claimText, /杭州市/u);
  const municipalCapture = municipalAlias.evidenceArchive.entries[0]!.capturedContent;
  assert.match(municipalCapture, /杭州。$/);
  assert.doesNotMatch(municipalCapture, /杭州市/u);

  const autonomousPrefectureAlias = makeSecureResearch(ranking.data, "in_progress", 1);
  const autonomousEntry = autonomousPrefectureAlias.research.entries[0]!;
  const autonomousEvidence = autonomousEntry.headquarters.evidence[0]!;
  autonomousEntry.headquarters.province = "四川省";
  autonomousEntry.headquarters.city = "阿坝藏族羌族自治州";
  autonomousEvidence.claimText = `${autonomousEvidence.sourceSubject}总部位于阿坝州。`;
  syncArchiveCapture(autonomousPrefectureAlias, 1);
  resealAndApproveSecureResearch(autonomousPrefectureAlias);
  assert.doesNotThrow(() => new PrivateEnterpriseRanking(
    ranking.data,
    autonomousPrefectureAlias.research,
    autonomousPrefectureAlias.evidenceArchive,
    autonomousPrefectureAlias.verificationOptions,
  ));
  assert.match(autonomousPrefectureAlias.evidenceArchive.entries[0]!.capturedContent, /阿坝州。$/);

  const canonicalCityWithDistrict = makeSecureResearch(ranking.data, "in_progress", 1);
  const districtEntry = canonicalCityWithDistrict.research.entries[0]!;
  const districtEvidence = districtEntry.headquarters.evidence[0]!;
  districtEntry.headquarters.city = "杭州市";
  districtEntry.headquarters.province = "浙江省";
  districtEvidence.claimText = `${districtEvidence.sourceSubject}总部位于杭州市西湖区。`;
  syncArchiveCapture(canonicalCityWithDistrict, 1);
  resealAndApproveSecureResearch(canonicalCityWithDistrict);
  assert.doesNotThrow(() => new PrivateEnterpriseRanking(
    ranking.data,
    canonicalCityWithDistrict.research,
    canonicalCityWithDistrict.evidenceArchive,
    canonicalCityWithDistrict.verificationOptions,
  ));

  const cityPrefixOnly = makeSecureResearch(ranking.data, "in_progress", 1);
  const prefixEvidence = cityPrefixOnly.research.entries[0]!.headquarters.evidence[0]!;
  cityPrefixOnly.research.entries[0]!.headquarters.city = "杭州市";
  cityPrefixOnly.research.entries[0]!.headquarters.province = "浙江省";
  prefixEvidence.claimText = `${prefixEvidence.sourceSubject}总部位于杭州湾。`;
  syncArchiveCapture(cityPrefixOnly, 1);
  resealAndApproveSecureResearch(cityPrefixOnly);
  assert.throws(
    () => new PrivateEnterpriseRanking(
      ranking.data,
      cityPrefixOnly.research,
      cityPrefixOnly.evidenceArchive,
      cityPrefixOnly.verificationOptions,
    ),
    /headquarters.*(?:evidence|research)|(?:evidence|research).*headquarters/i,
  );
});

test("headquarters evidence requires one source clause to bind the exact subject, headquarters predicate, and city", () => {
  const ranking = loadPrivateEnterpriseRanking();
  const differentHeadquartersCity = makeSecureResearch(ranking.data, "in_progress", 1);
  const evidence = differentHeadquartersCity.research.entries[0]!.headquarters.evidence[0]!;
  differentHeadquartersCity.research.entries[0]!.headquarters.city = "杭州市";
  differentHeadquartersCity.research.entries[0]!.headquarters.province = "浙江省";
  evidence.claimText = `${evidence.sourceSubject}总部位于南京市，杭州市设有分公司。`;
  syncArchiveCapture(differentHeadquartersCity, 1);
  resealAndApproveSecureResearch(differentHeadquartersCity);
  assert.throws(
    () => new PrivateEnterpriseRanking(
      ranking.data,
      differentHeadquartersCity.research,
      differentHeadquartersCity.evidenceArchive,
      differentHeadquartersCity.verificationOptions,
    ),
    /headquarters.*(?:evidence|research)|(?:evidence|research).*headquarters/i,
  );

  const separatedSubject = makeSecureResearch(ranking.data, "in_progress", 1);
  const separatedEvidence = separatedSubject.research.entries[0]!.headquarters.evidence[0]!;
  separatedSubject.research.entries[0]!.headquarters.city = "杭州市";
  separatedSubject.research.entries[0]!.headquarters.province = "浙江省";
  separatedEvidence.claimText = `${separatedEvidence.sourceSubject}发布公告，总部位于杭州市。`;
  syncArchiveCapture(separatedSubject, 1);
  resealAndApproveSecureResearch(separatedSubject);
  assert.throws(
    () => new PrivateEnterpriseRanking(
      ranking.data,
      separatedSubject.research,
      separatedSubject.evidenceArchive,
      separatedSubject.verificationOptions,
    ),
    /headquarters.*(?:evidence|research)|(?:evidence|research).*headquarters/i,
  );
});

test("headquarters evidence only uses a source published within 365 days for the frozen claim", () => {
  const ranking = loadPrivateEnterpriseRanking();
  const boundary = makeSecureResearch(ranking.data, "in_progress", 1);
  const boundaryEntry = boundary.research.entries[0]!;
  const boundaryEvidence = boundaryEntry.headquarters.evidence[0]!;
  boundaryEntry.headquarters.asOf = "2025-09-22";
  boundaryEvidence.sourcePublishedOn = "2025-09-22";
  boundaryEvidence.claimAsOf = "2025-09-22";
  syncArchiveCapture(boundary, 1);
  resealAndApproveSecureResearch(boundary);
  assert.doesNotThrow(() => new PrivateEnterpriseRanking(
    ranking.data,
    boundary.research,
    boundary.evidenceArchive,
    boundary.verificationOptions,
 ));

  const stale = makeSecureResearch(ranking.data, "in_progress", 1);
  const staleEntry = stale.research.entries[0]!;
  const staleEvidence = staleEntry.headquarters.evidence[0]!;
  staleEntry.headquarters.asOf = "2025-09-21";
  staleEvidence.sourcePublishedOn = "2025-09-21";
  staleEvidence.claimAsOf = "2025-09-21";
  syncArchiveCapture(stale, 1);
  resealAndApproveSecureResearch(stale);
  assert.throws(
    () => new PrivateEnterpriseRanking(
      ranking.data,
      stale.research,
      stale.evidenceArchive,
      stale.verificationOptions,
    ),
    /headquarters.*(?:evidence|research)|(?:evidence|research).*headquarters/i,
  );

  const weakEntityMatch = makeSecureResearch(ranking.data, "in_progress", 1);
  weakEntityMatch.research.entries[0]!.entityMatch = "审核人员认为来源主体一致。";
  syncArchiveCapture(weakEntityMatch, 1);
  resealAndApproveSecureResearch(weakEntityMatch);
  assert.throws(
    () => new PrivateEnterpriseRanking(
      ranking.data,
      weakEntityMatch.research,
      weakEntityMatch.evidenceArchive,
      weakEntityMatch.verificationOptions,
    ),
    /headquarters.*(?:evidence|research)|(?:evidence|research).*headquarters/i,
  );
});

test("mismatched headquarters source subjects need captured relationship evidence", () => {
  const ranking = loadPrivateEnterpriseRanking();

  const validRelation = makeSecureResearch(ranking.data, "in_progress", 1);
  setMismatchedSourceSubject(validRelation);
  syncArchiveCapture(validRelation, 1);
  resealAndApproveSecureResearch(validRelation);
  assert.doesNotThrow(() => new PrivateEnterpriseRanking(
    ranking.data,
    validRelation.research,
    validRelation.evidenceArchive,
    validRelation.verificationOptions,
 ));

  const missingRelation = makeSecureResearch(ranking.data, "in_progress", 1);
  setMismatchedSourceSubject(missingRelation);
  missingRelation.research.entries[0]!.headquarters.evidence[0]!.entityRelationText = undefined;
  syncArchiveCapture(missingRelation, 1);
  resealAndApproveSecureResearch(missingRelation);
  assert.throws(
    () => new PrivateEnterpriseRanking(
      ranking.data,
      missingRelation.research,
      missingRelation.evidenceArchive,
      missingRelation.verificationOptions,
    ),
    /headquarters.*(?:evidence|research)|(?:evidence|research).*headquarters/i,
  );

  const weakRelation = makeSecureResearch(ranking.data, "in_progress", 1);
  setMismatchedSourceSubject(weakRelation);
  weakRelation.research.entries[0]!.headquarters.evidence[0]!.entityRelationText =
    "京东集团与京东集团控股有限公司存在业务关系。";
  syncArchiveCapture(weakRelation, 1);
  resealAndApproveSecureResearch(weakRelation);
  assert.throws(
    () => new PrivateEnterpriseRanking(
      ranking.data,
      weakRelation.research,
      weakRelation.evidenceArchive,
      weakRelation.verificationOptions,
    ),
    /headquarters.*(?:evidence|research)|(?:evidence|research).*headquarters/i,
  );

  const captureTamper = makeSecureResearch(ranking.data, "in_progress", 1);
  setMismatchedSourceSubject(captureTamper);
  syncArchiveCapture(captureTamper, 1);
  captureTamper.research.entries[0]!.headquarters.evidence[0]!.entityRelationText =
    "京东集团旗下子公司京东集团控股有限公司（篡改后的关系说明）。";
  resealAndApproveSecureResearch(captureTamper);
  assert.throws(
    () => new PrivateEnterpriseRanking(
      ranking.data,
      captureTamper.research,
      captureTamper.evidenceArchive,
      captureTamper.verificationOptions,
    ),
    /headquarters.*(?:evidence|research)|(?:evidence|research).*headquarters/i,
  );

  const ownershipRelation = makeSecureResearch(ranking.data, "in_progress", 1);
  const ownershipEntry = ownershipRelation.research.entries[0]!;
  const ownershipEvidence = ownershipEntry.headquarters.evidence[0]!;
  const ownershipSubject = "京东集团控股有限公司";
  ownershipEntry.entityMatch = `${ownershipEntry.enterpriseName}旗下子公司${ownershipSubject}。`;
  ownershipEvidence.sourceSubject = ownershipSubject;
  ownershipEvidence.claimText = `${ownershipSubject}总部位于${ownershipEntry.headquarters.city}。`;
  ownershipEvidence.entityRelationText = `${ownershipEntry.enterpriseName}旗下子公司${ownershipSubject}。`;
  syncArchiveCapture(ownershipRelation, 1);
  resealAndApproveSecureResearch(ownershipRelation);
  assert.throws(
    () => new PrivateEnterpriseRanking(
      ranking.data,
      ownershipRelation.research,
      ownershipRelation.evidenceArchive,
      ownershipRelation.verificationOptions,
    ),
    /headquarters.*(?:evidence|research)|(?:evidence|research).*headquarters/i,
  );

  const unrelatedMarker = makeSecureResearch(ranking.data, "in_progress", 1);
  const unrelatedEntry = unrelatedMarker.research.entries[0]!;
  const unrelatedEvidence = unrelatedEntry.headquarters.evidence[0]!;
  const unrelatedSubject = "京东集团控股有限公司";
  unrelatedEntry.entityMatch = `${unrelatedEntry.enterpriseName}与${unrelatedSubject}合作。`;
  unrelatedEvidence.sourceSubject = unrelatedSubject;
  unrelatedEvidence.claimText = `${unrelatedSubject}总部位于${unrelatedEntry.headquarters.city}。`;
  unrelatedEvidence.entityRelationText = `${unrelatedEntry.enterpriseName}与${unrelatedSubject}合作，即将发布新产品。`;
  syncArchiveCapture(unrelatedMarker, 1);
  resealAndApproveSecureResearch(unrelatedMarker);
  assert.throws(
    () => new PrivateEnterpriseRanking(
      ranking.data,
      unrelatedMarker.research,
      unrelatedMarker.evidenceArchive,
      unrelatedMarker.verificationOptions,
    ),
    /headquarters.*(?:evidence|research)|(?:evidence|research).*headquarters/i,
  );

  const namePrefixOnly = makeSecureResearch(ranking.data, "in_progress", 1);
  const prefixEntry = namePrefixOnly.research.entries[0]!;
  const prefixEvidence = prefixEntry.headquarters.evidence[0]!;
  // The source subject is mentioned independently in entityMatch, but its
  // only appearance in the quoted relation is the prefix of 京东集团.
  prefixEntry.entityMatch = `${prefixEntry.enterpriseName}与京东合作。`;
  prefixEvidence.sourceSubject = "京东";
  prefixEvidence.claimText = `京东总部位于${prefixEntry.headquarters.city}。`;
  prefixEvidence.entityRelationText = `${prefixEntry.enterpriseName}原名为${prefixEntry.enterpriseName}。`;
  syncArchiveCapture(namePrefixOnly, 1);
  resealAndApproveSecureResearch(namePrefixOnly);
  assert.throws(
    () => new PrivateEnterpriseRanking(
      ranking.data,
      namePrefixOnly.research,
      namePrefixOnly.evidenceArchive,
      namePrefixOnly.verificationOptions,
    ),
    /headquarters.*(?:evidence|research)|(?:evidence|research).*headquarters/i,
  );

  const namePrefixInSameClause = makeSecureResearch(ranking.data, "in_progress", 1);
  const sameClauseEntry = namePrefixInSameClause.research.entries[0]!;
  const sameClauseEvidence = sameClauseEntry.headquarters.evidence[0]!;
  sameClauseEntry.entityMatch = `${sameClauseEntry.enterpriseName}与京东合作。`;
  sameClauseEvidence.sourceSubject = "京东";
  sameClauseEvidence.claimText = `京东总部位于${sameClauseEntry.headquarters.city}。`;
  // The independent short-name mention is deliberately unrelated. The
  // following relation must not borrow `京东` from inside the final 京东集团.
  sameClauseEvidence.entityRelationText =
    `${sameClauseEntry.enterpriseName}与京东合作且${sameClauseEntry.enterpriseName}原名为${sameClauseEntry.enterpriseName}。`;
  syncArchiveCapture(namePrefixInSameClause, 1);
  resealAndApproveSecureResearch(namePrefixInSameClause);
  assert.throws(
    () => new PrivateEnterpriseRanking(
      ranking.data,
      namePrefixInSameClause.research,
      namePrefixInSameClause.evidenceArchive,
      namePrefixInSameClause.verificationOptions,
    ),
    /headquarters.*(?:evidence|research)|(?:evidence|research).*headquarters/i,
  );

  const leftEntitySuffix = makeSecureResearch(ranking.data, "in_progress", 1);
  const leftEntry = leftEntitySuffix.research.entries[0]!;
  const leftEvidence = leftEntry.headquarters.evidence[0]!;
  leftEntry.entityMatch = `${leftEntry.enterpriseName}与甲公司合作。`;
  leftEvidence.sourceSubject = "甲公司";
  leftEvidence.claimText = `甲公司总部位于${leftEntry.headquarters.city}。`;
  // The actual rename belongs to 北京京东集团, not the ranked 京东集团.
  leftEvidence.entityRelationText = `北京${leftEntry.enterpriseName}原名为甲公司；${leftEntry.enterpriseName}与甲公司合作。`;
  syncArchiveCapture(leftEntitySuffix, 1);
  resealAndApproveSecureResearch(leftEntitySuffix);
  assert.throws(
    () => new PrivateEnterpriseRanking(
      ranking.data,
      leftEntitySuffix.research,
      leftEntitySuffix.evidenceArchive,
      leftEntitySuffix.verificationOptions,
    ),
    /headquarters.*(?:evidence|research)|(?:evidence|research).*headquarters/i,
  );

  const claimSubjectSuffix = makeSecureResearch(ranking.data, "in_progress", 1);
  const claimEntry = claimSubjectSuffix.research.entries[0]!;
  const claimEvidence = claimEntry.headquarters.evidence[0]!;
  claimEntry.entityMatch = `${claimEntry.enterpriseName}原名为京东。`;
  claimEvidence.sourceSubject = "京东";
  // The city claim belongs to 北京京东, not the exact source subject 京东.
  claimEvidence.claimText = `北京京东总部位于${claimEntry.headquarters.city}。`;
  claimEvidence.entityRelationText = `${claimEntry.enterpriseName}原名为京东。`;
  syncArchiveCapture(claimSubjectSuffix, 1);
  resealAndApproveSecureResearch(claimSubjectSuffix);
  assert.throws(
    () => new PrivateEnterpriseRanking(
      ranking.data,
      claimSubjectSuffix.research,
      claimSubjectSuffix.evidenceArchive,
      claimSubjectSuffix.verificationOptions,
    ),
    /headquarters.*(?:evidence|research)|(?:evidence|research).*headquarters/i,
  );
});

test("a completed headquarters ledger projects the evidence matching its frozen headquarters date", () => {
  const ranking = loadPrivateEnterpriseRanking();
  const fixture = makeSecureResearch(ranking.data, "complete", 500);
  const firstEntry = fixture.research.entries[0]!;
  const earlierEvidence = firstEntry.headquarters.evidence[0]!;
  earlierEvidence.claimAsOf = "2026-08-31";
  syncArchiveCapture(fixture, 1);

  const matchingEvidence = {
    evidenceId: "hq-2026-001-current",
    authority: "government" as const,
    publisher: "京东集团总部核验资料",
    sourceUrl: "https://www.gov.cn/zhengce/headquarters-2026/1-current",
    sourcePublishedOn: "2026-09-01",
    claimAsOf: firstEntry.headquarters.asOf,
    retrievedOn: ranking.data.publishedOn,
    capturedContentSha256: "",
    sourceSubject: firstEntry.enterpriseName,
    claimText: firstEntry.enterpriseName + "总部位于" + firstEntry.headquarters.city + "。",
  };
  const capturedContent = capturedContentForEvidence(matchingEvidence);
  matchingEvidence.capturedContentSha256 = archiveContentSha256(capturedContent);
  firstEntry.headquarters.evidence.push(matchingEvidence);
  fixture.evidenceArchive.entries.push({
    evidenceId: matchingEvidence.evidenceId,
    capturedContentSha256: matchingEvidence.capturedContentSha256,
    capturedContent,
  });
  fixture.evidenceArchive.entries.sort((left, right) => left.evidenceId < right.evidenceId ? -1 :
    left.evidenceId > right.evidenceId ? 1 : 0);
  resealAndApproveSecureResearch(fixture);

  const verified = new PrivateEnterpriseRanking(
    ranking.data,
    fixture.research,
    fixture.evidenceArchive,
    fixture.verificationOptions,
  );
  const headquarters = verified.data.entries[0]?.headquarters;
  assert.equal(earlierEvidence.claimAsOf < firstEntry.headquarters.asOf, true);
  assert.equal(headquarters?.evidenceId, matchingEvidence.evidenceId);
  assert.equal(headquarters?.sourceUrl, matchingEvidence.sourceUrl);
  assert.equal(headquarters?.sourcePublisher, matchingEvidence.publisher);
  assert.equal(headquarters?.retrievedOn, matchingEvidence.retrievedOn);
});

test("a completed headquarters ledger rejects a resealed private source IP literal", () => {
  const ranking = loadPrivateEnterpriseRanking();
  const fixture = makeSecureResearch(ranking.data, "complete", 500);
  fixture.research.entries[0]!.headquarters.evidence[0]!.sourceUrl = "https://10.0.0.1/headquarters/1";
  syncArchiveCapture(fixture, 1);
  resealAndApproveSecureResearch(fixture);

  assert.throws(
    () => new PrivateEnterpriseRanking(
      ranking.data,
      fixture.research,
      fixture.evidenceArchive,
      fixture.verificationOptions,
    ),
    /headquarters.*(?:evidence|research)|(?:evidence|research).*headquarters/i,
  );
});

test("a completed headquarters ledger rejects example placeholder hostnames", () => {
  const ranking = loadPrivateEnterpriseRanking();
  for (const hostname of ["example", "publisher.example", "example.com"]) {
    const fixture = makeSecureResearch(ranking.data, "complete", 500);
    fixture.research.entries[0]!.headquarters.evidence[0]!.sourceUrl = `https://${hostname}/headquarters/1`;
    syncArchiveCapture(fixture, 1);
    resealAndApproveSecureResearch(fixture);
    assert.throws(
      () => new PrivateEnterpriseRanking(
        ranking.data,
        fixture.research,
        fixture.evidenceArchive,
        fixture.verificationOptions,
      ),
      /headquarters.*(?:evidence|research)|(?:evidence|research).*headquarters/i,
    );
  }
});

test("a completed headquarters ledger rejects a reused evidence ID", () => {
  const ranking = loadPrivateEnterpriseRanking();
  const fixture = makeSecureResearch(ranking.data, "complete", 500);
  reuseEvidenceIdForTwoEntries(fixture);

  assert.throws(
    () => new PrivateEnterpriseRanking(
      ranking.data,
      fixture.research,
      fixture.evidenceArchive,
      fixture.verificationOptions,
    ),
    /headquarters.*evidence.*reference|evidence.*reference.*headquarters/i,
  );
});
