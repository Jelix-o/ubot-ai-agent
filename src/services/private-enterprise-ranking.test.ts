import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyPrivateEnterpriseRankingRequest,
  loadPrivateEnterpriseRanking,
  PrivateEnterpriseRanking,
} from "./private-enterprise-ranking.js";

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
  assert.match(ranking.answer("美团在民营企业500强排名多少？")?.messages[0] ?? "", /第19/);
  assert.match(ranking.answer("万向在民营企业500强排第几？")?.messages[0] ?? "", /多个可能的企业/);
  assert.match(ranking.answer("浙江省有多少家民营企业500强？")?.messages[0] ?? "", /104家/);
  assert.match(ranking.answer("黑龙江省有多少家民营企业500强？")?.messages[0] ?? "", /共0家/);
  assert.match(ranking.answer("新疆生产建设兵团有多少家民营企业500强？")?.messages[0] ?? "", /共2家/);
  assert.match(ranking.answer("2026中国民营企业500强第500名是谁？")?.messages[0] ?? "", /玲珑集团/);
  assert.equal(ranking.answer("第2名是谁？"), undefined);
  assert.match(ranking.answer("2026第2名是什么公司？")?.messages[0] ?? "", /阿里巴巴（中国）有限公司/);
  assert.equal(ranking.answer("第2位是什么？"), undefined);
  assert.match(ranking.answer("2025中国民营企业500强京东排名多少？")?.messages[0] ?? "", /仅收录2026/);
  assert.match(ranking.answer("2025中国民营企业500强第2名是谁？")?.messages[0] ?? "", /仅收录2026/);
  assert.match(ranking.answer("2025年第2名是谁？")?.messages[0] ?? "", /仅收录2026/);
  assert.match(ranking.answer("2025年阿里排几名？")?.messages[0] ?? "", /仅收录2026/);
  assert.match(ranking.answer("2025年字节跳动排几名？")?.messages[0] ?? "", /仅收录2026/);
  assert.match(ranking.answer("2026中国民营企业500强按2025年营收吗？")?.messages[0] ?? "", /按2025年营收排序/);
  assert.match(ranking.answer("全国有多少家2026民营企业500强？")?.messages[0] ?? "", /共500家/);
  assert.equal(ranking.answer("今天浙江天气如何？"), undefined);
  assert.equal(ranking.answer("今天2026年天气怎么样？"), undefined);
  assert.equal(ranking.answer("2026年世界500强前十"), undefined);
  assert.equal(ranking.answer("2026年电影榜单前十"), undefined);
  assert.match(ranking.answer("2026中国民营企业500强有哪些？")?.messages[0] ?? "", /请指定榜单中的省级地区/);

  const topTen = ranking.answer("2026中国民营企业500强前10名有哪些？")?.messages ?? [];
  assert.equal(topTen.length, 1);
  assert.equal(topTen.join("\n").match(/第\d+名 /g)?.length, 10);
  assert.match(topTen[0] ?? "", /第1名 京东集团/);
  assert.match(topTen[0] ?? "", /第10名 山东魏桥创业集团有限公司/);
  const range = ranking.answer("2026中国民营企业500强第10到第20名有哪些？")?.messages ?? [];
  assert.equal(range.join("\n").match(/第\d+名 /g)?.length, 11);
  assert.match(range[0] ?? "", /第10至20名/);
  assert.match(ranking.answer("2026中国民营企业500强前0名")?.messages[0] ?? "", /名次范围应在1至500之间/);
  assert.match(ranking.answer("2026中国民营企业500强第20到第10名")?.messages[0] ?? "", /名次范围应在1至500之间/);

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
  assert.match(ranking.answer("湖北省和湖南省哪个多？", [
    { role: "user", content: "2026中国民营企业500强各省上榜情况" },
    { role: "assistant", content: "2026中国民营企业500强：浙江省共104家。" },
  ])?.messages[0] ?? "", /湖北省12家；湖南省10家。湖北省多2家/);
  assert.equal(ranking.answer("湖北省和湖南省哪个多？"), undefined);
});

test("ranking scope is explicit or tied to the immediately preceding verified answer", () => {
  assert.equal(classifyPrivateEnterpriseRankingRequest("2026中国民营企业500强前十名"), "explicit");
  assert.equal(classifyPrivateEnterpriseRankingRequest("2026年世界500强前十"), "none");
  assert.equal(classifyPrivateEnterpriseRankingRequest("2026年电影榜单前十"), "none");
  assert.equal(classifyPrivateEnterpriseRankingRequest("今天2026年天气怎么样？"), "none");
  assert.equal(classifyPrivateEnterpriseRankingRequest("第2名是谁？"), "none");
  assert.equal(classifyPrivateEnterpriseRankingRequest("2025年第2名是谁？"), "explicit");
  assert.equal(classifyPrivateEnterpriseRankingRequest("第2名是谁？", [
    { role: "assistant", content: "2026中国民营企业500强：浙江省共104家。" },
  ]), "contextual");
});

test("city counts fail closed until every headquarters has a dated source", () => {
  const ranking = loadPrivateEnterpriseRanking();
  assert.match(ranking.answer("杭州有多少家2026民营企业500强？")?.messages[0] ?? "", /尚未全部核验/);
  assert.match(ranking.answer("浙江省杭州市有哪些民营企业500强？")?.messages[0] ?? "", /暂不能给出/);
  assert.match(ranking.answer("浙江省杭州有多少家民营企业500强？")?.messages[0] ?? "", /尚未全部核验/);
  assert.match(ranking.answer("浙江杭州有多少家民营企业500强？")?.messages[0] ?? "", /尚未全部核验/);
  assert.match(ranking.answer("北京市有多少家2026民营企业500强？")?.messages[0] ?? "", /24家/);
  assert.match(ranking.answer("北京总部城市有多少家2026民营企业500强？")?.messages[0] ?? "", /尚未全部核验/);

  const partial = structuredClone(ranking.data);
  partial.entries[0]!.headquarters = { city: "深圳市", sourceUrl: "https://example.com/jd", asOf: "2026-09-22" };
  assert.equal(new PrivateEnterpriseRanking(partial).cityReady, false);
  const complete = structuredClone(ranking.data);
  complete.entries.forEach((entry) => {
    entry.headquarters = { city: entry.rank === 1 ? "深圳市" : "杭州市", sourceUrl: "https://example.com/evidence", asOf: "2026-09-22" };
  });
  const verified = new PrivateEnterpriseRanking(complete);
  assert.equal(verified.cityReady, true);
  assert.match(verified.answer("深圳市有多少家2026民营企业500强？")?.messages[0] ?? "", /1家/);
  assert.match(verified.answer("深圳市有哪些2026民营企业500强？")?.messages[0] ?? "", /按榜单发布时核验的总部城市/);
  assert.equal(verified.listPage({ city: "深圳市", page: 1, pageSize: 20 }).pagination.total, 1);
  assert.equal(verified.listPage({ province: "北京市", page: 1, pageSize: 20 }).pagination.total, 24);
});
