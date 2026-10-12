import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { BtSearchError, BtSearchService, btEngineArguments, normalizeBtSearchResult, parseBtSearchRequest, type BtSearchResult } from "./bt-search-service.js";
import { BT_ADULT_CONTENT_WARNING, btHelp, btEmptyResultMessage, renderBtForwardNodes } from "./bt-search-renderer.js";
import { toNapCatForwardNodes } from "../forward-message.js";
import { matchBtCommand } from "./command-prefixes.js";

const require = createRequire(import.meta.url);
const root = path.resolve("assets/bt/scripts");
const magnet = `magnet:?xt=urn:btih:${"a".repeat(40)}&dn=完整标题&tr=https%3A%2F%2Ftracker.example%2Fa`;
const payload = { query: "测试", requestedType: "anime", resolvedType: "anime", totalResults: 1, rawResultCount: 2, uniqueResultCount: 1,
  durationMs: 100, fromCache: false, cacheAgeMs: 0, budgetExceeded: false, warnings: [],
  sites: [{ siteId: "mikan", siteName: "Mikan", via: "fixture", durationMs: 20, resultCount: 1, warnings: [] }],
  items: [{ title: "完整中文标题", magnet, page: "https://example.test/item", torrent: "", size: "1 GB", resolution: "1080p", subtitle: "中字", sources: ["Mikan"], episodeStart: 1, episodeEnd: 1, isBatch: false }],
};
const request = () => parseBtSearchRequest("测试 anime")!;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate: () => boolean, timeout = 4000) {
  const end = Date.now() + timeout;
  while (!predicate() && Date.now() < end) await delay(20);
  assert.equal(predicate(), true);
}
function fixture(t: { after(fn: () => unknown): void }, source: string, budgetMs = 2000) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "bt-service-"));
  const enginePath = path.join(dir, "engine.cjs");
  writeFileSync(enginePath, `const payload = ${JSON.stringify(payload)};\n${source}`);
  const service = new BtSearchService({ dataDir: path.join(dir, "data", "bt"), enginePath, budgetMs, graceMs: 150 });
  t.after(async () => { await service.stop(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, service };
}

test("BT parses every supported flag without interpreting shell characters", () => {
  const parsed = parseBtSearchRequest(`'test; echo dangerous & $(whoami)' movie --fast --detail --source nyaa,btbtla --timeout=8s --limit 3 --no-cache --no-deep --json --debug`)!;
  assert.equal(parsed.query, "test; echo dangerous & $(whoami)");
  assert.equal(parsed.type, "movie");
  assert.equal(parsed.timeoutMs, 8000);
  assert.equal(parsed.limit, 3);
  assert.equal(parsed.full && parsed.json && parsed.debug && parsed.noCache && parsed.noDeep, true);
  assert.deepEqual(btEngineArguments(parsed).slice(0, 3), [parsed.query, "movie", "--json"]);
  assert.equal(request().fast, false);
  assert.equal(request().limit, 5);
  assert.equal(request().timeoutMs, 30000);
  assert.equal(parseBtSearchRequest("test --json")!.full, false);
  assert.equal(parseBtSearchRequest("test --full")!.limit, 20);
  assert.equal(parseBtSearchRequest(""), undefined);
  for (const invalid of ["test --source unknown", "test --timeout 0", "test --limit 99", "test --unknown", "'unclosed", "--fast"]) {
    assert.throws(() => parseBtSearchRequest(invalid), (error: unknown) => error instanceof BtSearchError && error.code === "invalid_arguments");
  }
  assert.ok(matchBtCommand("/bt 测试"));
  assert.equal(matchBtCommand("/btree"), undefined);
});

test("BT forward nodes preserve complete links as literal text and distinguish empty-result failures", () => {
  const value = normalizeBtSearchResult(payload, request());
  value.items = Array.from({ length: 5 }, (_, index) => ({ ...value.items[0]!, title: `${index} [CQ:at,qq=all] ${"长标题".repeat(70)}` }));
  const nodes = renderBtForwardNodes(value, request(), "12345");
  assert.equal(nodes.length, 6);
  assert.ok(nodes[0]!.text.startsWith("【BT 搜索】"));
  const segments = toNapCatForwardNodes(nodes);
  for (const node of segments.slice(1)) {
    assert.equal(node.data.content[0]!.type, "text");
    assert.ok(node.data.content[0]!.data.text.includes("[CQ:at,qq=all]"));
    assert.ok(node.data.content[0]!.data.text.split("\n").includes(magnet));
  }
  for (const adultRequest of [
    { ...request(), type: "adult" as const },
    { ...request(), type: "adult" as const, full: true },
    { ...request(), type: "adult" as const, debug: true },
    { ...request(), type: "adult" as const, json: true },
  ]) {
    const baseline = renderBtForwardNodes(value, adultRequest, "12345");
    const adultNodes = renderBtForwardNodes({ ...value, requestedType: "adult", resolvedType: "adult" }, adultRequest, "12345");
    assert.equal(adultNodes.length, baseline.length);
    assert.equal(adultNodes[0]!.text.split("\n")[0], BT_ADULT_CONTENT_WARNING);
    assert.equal(adultNodes[0]!.text.split("\n").filter(line => line.includes("【成人内容提示】")).length, 1);
    assert.ok(adultNodes[0]!.text.slice(`${BT_ADULT_CONTENT_WARNING}\n`.length).startsWith(`【BT 搜索】${value.query}（成人）`));
    if (adultRequest.json) {
      const adultMagnets = adultNodes.slice(1)
        .map(node => JSON.parse(node.text) as { item?: { magnet?: string } })
        .flatMap(value => value.item?.magnet ? [value.item.magnet] : []);
      const baselineMagnets = baseline.slice(1)
        .map(node => JSON.parse(node.text) as { item?: { magnet?: string } })
        .flatMap(value => value.item?.magnet ? [value.item.magnet] : []);
      assert.deepEqual(adultMagnets, baselineMagnets);
    } else {
      for (const [index, node] of adultNodes.slice(1).entries()) assert.equal(node.text, baseline[index + 1]!.text);
    }
  }
  for (const [warning, expected] of [["", "未找到"], ["搜索超时", "超时"], ["Cloudflare 验证页", "验证页"], ["抓取依赖 curl_cffi 不可用", "依赖缺失"]]) {
    const empty = { ...value, items: [], warnings: warning ? [warning!] : [] };
    assert.ok(btEmptyResultMessage(empty).includes(expected!));
  }
  const json = renderBtForwardNodes(normalizeBtSearchResult(payload, request()), { ...request(), json: true }, "12345");
  for (const node of json.slice(1)) assert.doesNotThrow(() => JSON.parse(node.text));
  assert.equal(btHelp().split("\n").length, 4);
  assert.ok(btHelp("/资源", true).includes("--source"));
  value.sites[0]!.items = value.items;
  const details = renderBtForwardNodes(value, { ...request(), full: true, debug: true }, "12345");
  assert.equal(details.filter(node => node.text.includes("磁力（完整链接）")).length, 5);
  assert.ok(details.at(-1)!.text.includes("原始 2 条"));
});

test("BT subprocess passes literal argv and persistent paths and decodes split UTF-8", async (t) => {
  const { service, dir } = fixture(t, `
    require('fs').writeFileSync(require('path').join(__dirname, 'argv.json'), JSON.stringify({ args: process.argv.slice(2), cache: process.env.OPENCLAW_BT_CACHE_DIR }));
    const bytes = Buffer.from(JSON.stringify(payload));
    const start = bytes.indexOf(Buffer.from('完整中文标题'));
    process.stdout.write(bytes.subarray(0, start + 1));
    setTimeout(() => process.stdout.end(bytes.subarray(start + 1)), 30);
  `);
  const literal = { ...request(), query: `test; echo hacked > ${path.join(dir, "sentinel")} & $(whoami)` };
  const result = await service.search(literal);
  assert.equal(result.items[0]?.title, "完整中文标题");
  const captured = JSON.parse(readFileSync(path.join(dir, "argv.json"), "utf8"));
  assert.equal(captured.args[0], literal.query);
  assert.equal(captured.cache, path.join(dir, "data", "bt", "cache"));
  assert.equal(existsSync(path.join(dir, "sentinel")), false);
});

test("BT globally serializes requests, bounds the waiting queue and releases cancelled slots", async (t) => {
  const { service } = fixture(t, "setTimeout(() => { payload.query = process.argv[2]; console.log(JSON.stringify(payload)); }, 30);");
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const order: string[] = [];
  const search = (query: string, signal?: AbortSignal) => service.search({ ...request(), query }, { signal, onStarted: async () => { order.push(query); if (query === "0") await gate; } });
  const running = search("0");
  const controller = new AbortController();
  const cancelled = search("1", controller.signal);
  const cancellation = assert.rejects(cancelled, (error: unknown) => error instanceof BtSearchError && error.code === "cancelled");
  const waiting = [search("2"), search("3"), search("4")];
  await assert.rejects(search("over-limit"), (error: unknown) => error instanceof BtSearchError && error.code === "busy");
  controller.abort();
  await cancellation;
  const replacement = search("5");
  await delay(30);
  assert.deepEqual(order, ["0"]);
  release();
  const results = await Promise.all([running, ...waiting, replacement]);
  assert.deepEqual(results.map(value => value.query), ["0", "2", "3", "4", "5"]);
  assert.deepEqual(order, ["0", "2", "3", "4", "5"]);
});

test("BT deadline returns IPC partial results and classifies a missing result as timeout", async (t) => {
  const partial = fixture(t, "process.send({kind:'bt-progress', result:payload}); setInterval(() => {}, 1000);", 300);
  const result = await partial.service.search(request());
  assert.equal(result.budgetExceeded, true);
  assert.equal(result.items[0]?.magnet, magnet);
  const empty = fixture(t, "setInterval(() => {}, 1000);", 100);
  await assert.rejects(empty.service.search(request()), (error: unknown) => error instanceof BtSearchError && error.code === "timeout");
});

test("BT active cancellation kills the child process tree and subsequent searches still run", async (t) => {
  const { service, dir } = fixture(t, `
    if (process.argv[2] === 'normal') console.log(JSON.stringify(payload));
    else {
      const descendant = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'});
      require('fs').writeFileSync(require('path').join(__dirname, 'pid'), String(descendant.pid));
      setInterval(() => {}, 1000);
    }
  `);
  const controller = new AbortController();
  const task = service.search(request(), { signal: controller.signal });
  const rejected = assert.rejects(task, (error: unknown) => error instanceof BtSearchError && error.code === "cancelled");
  await waitFor(() => existsSync(path.join(dir, "pid")));
  const pid = Number(readFileSync(path.join(dir, "pid"), "utf8"));
  controller.abort();
  await rejected;
  await waitFor(() => {
    try {
      process.kill(pid, 0);
      return process.platform === "linux" && readFileSync(`/proc/${pid}/stat`, "utf8").split(" ")[2] === "Z";
    } catch { return true; }
  });
  assert.equal((await service.search({ ...request(), query: "normal" })).items.length, 1);
});

for (const suite of ["media-utils", "mikan-fixture", "tracker-fixture", "onelou-fixture", "btbtlb-fixture", "kpkuang-fixture", "routing"]) {
  test(`original BT offline regression: ${suite}`, () => {
    execFileSync(process.execPath, [path.join(root, "tests", `${suite}.test.js`)], { timeout: 15_000, stdio: "pipe" });
  });
}

test("BT fallback transport leaves site timeout timers responsive", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "bt-transport-"));
  const oldPython = process.env.OPENCLAW_BT_PYTHON;
  process.env.OPENCLAW_BT_PYTHON = process.execPath;
  const runtime = require(path.join(root, "lib/runtime.js")).createRuntime({ workspaceRoot: dir, scriptDir: dir, noCache: true });
  t.after(async () => { await runtime.close(); if (oldPython === undefined) delete process.env.OPENCLAW_BT_PYTHON; else process.env.OPENCLAW_BT_PYTHON = oldPython; rmSync(dir, { recursive: true, force: true }); });
  writeFileSync(path.join(dir, "curl_cffi_fetch.py"), "console.log('<html>old cached content</html>');");
  const warming = require(path.join(root, "lib/runtime.js")).createRuntime({ workspaceRoot: dir, scriptDir: dir });
  await warming.fetchCachedHtml("https://example.test/", { requestOptions: { transportOrder: ["curl_cffi"], timeoutMs: 1000 } });
  await warming.close();
  writeFileSync(path.join(dir, "curl_cffi_fetch.py"), "setTimeout(() => console.log('<html>fixture</html>'), 250);");
  const operation = runtime.fetchCachedHtml("https://example.test/", { requestOptions: { transportOrder: ["curl_cffi"], timeoutMs: 1000 } });
  const first = await Promise.race([operation.then(() => "network"), delay(30).then(() => "timer")]);
  assert.equal(first, "timer");
  const result = await operation;
  assert.equal(result.via, "直连(curl_cffi)");
  assert.ok(result.html.includes("fixture"));
});

test("BT real orchestrator treats --timeout as per-site, keeps full source coverage and returns deadline partials", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "bt-orchestrator-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const preload = path.join(dir, "preload.cjs");
  writeFileSync(preload, `
    const root = ${JSON.stringify(root)};
    const runtime = { readSearchResultCache: () => null, writeSearchResultCache: () => {}, isSiteCircuitOpen: () => false, recordSiteSuccess: () => {}, recordSiteFailure: () => ({openUntil:0}) , close: async () => {} };
    const sites = ['mikan','nyaa','onelou','kpkuang','btbtla'].map((id, index) => ({id,
      describe: () => ({name:id}), collectJsonItems: run => ({items:run.results, nextIndex:2}),
      search: async (_context, _runtime, overrides) => {
        if (process.env.SLOW_SECOND === '1' && index === 1) await new Promise(resolve => setTimeout(resolve, 1000));
        else await new Promise(resolve => setTimeout(resolve, 55));
        return {siteName:id, via:'fixture', warnings:[], results:[{title:'fixture '+id, page:'https://example.test/'+id, magnet:'magnet:?xt=urn:btih:'+String(index+1).repeat(40)}]};
      }
    }));
    const runtimePath = require.resolve(root+'/lib/runtime.js');
    require.cache[runtimePath] = { id:runtimePath, filename:runtimePath, loaded:true, exports:{createRuntime:() => runtime} };
    const registryPath = require.resolve(root+'/lib/site-registry.js');
    require.cache[registryPath] = { id:registryPath, filename:registryPath, loaded:true, exports:{getSitesForType:() => sites} };
  `);
  const run = (budget: number, slow: boolean) => JSON.parse(execFileSync(process.execPath, ["--require", preload, path.join(root, "bt.js"), "fixture", "anime", "--json", "--timeout", "100", "--no-cache"], {
    encoding: "utf8", timeout: 5000, env: { ...process.env, OPENCLAW_BT_PYTHON: "missing-bt-test-python", UBOT_BT_TOTAL_BUDGET_MS: String(budget), SLOW_SECOND: slow ? "1" : "0" },
  }));
  const complete = run(2000, false);
  assert.equal(complete.sites.length, 5, "--json does not enable fast complementary skipping");
  assert.ok(complete.durationMs > 100, "single-site timeout must not cut off the entire search");
  const partial = run(180, true);
  assert.equal(partial.budgetExceeded, true);
  assert.ok(partial.items.length >= 1);
  assert.equal(partial.sites[0].siteId, "mikan");
  assert.ok(partial.sites.some((site: { via: string }) => site.via === "超时"));
});


test("BT pasted five-resource regression keeps every original encoded link inside one card", () => {
  const originalItems = [
  {
    "title": "[千夏字幕组][葬送的芙莉莲_Sousou no Frieren][第29-38话][1080p_HEVC][简繁内封][合集]",
    "magnet": "magnet:?xt=urn:btih:b083f2e4b02783c9292718cbbfd8a98a4aa0b42e&dn=%5B%E5%8D%83%E5%A4%8F%E5%AD%97%E5%B9%95%E7%BB%84%5D%5B%E8%91%AC%E9%80%81%E7%9A%84%E8%8A%99%E8%8E%89%E8%8E%B2_Sousou%20no%20Frieren%5D%5B%E7%AC%AC29-38%E8%AF%9D%5D%5B1080p_HEVC%5D%5B%E7%AE%80%E7%B9%81%E5%86%85%E5%B0%81%5D%5B%E5%90%88%E9%9B%86%5D&tr=udp%3A%2F%2Ftracker.nyaa.net%3A6969%2Fannounce&tr=http%3A%2F%2Fnyaa.tracker.wf%3A7777%2Fannounce&tr=udp%3A%2F%2Fopen.stealth.si%3A80%2Fannounce&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&tr=udp%3A%2F%2Fexodus.desync.com%3A6969%2Fannounce&tr=udp%3A%2F%2Ftracker.torrent.eu.org%3A451%2Fannounce",
    "torrent": "https://nyaa.net/download/2108703.torrent",
    "page": "https://nyaa.net/view/2108703",
    "resolution": "1080P",
    "size": "7.5 GiB",
    "subtitle": "中字",
    "sources": [
      "nyaa"
    ],
    "episodeStart": 0,
    "episodeEnd": 0,
    "isBatch": false
  },
  {
    "title": "[❀拨雪寻春❀] 送葬者芙莉莲第二季/ 葬送のフリーレン 第二期/ Sousou no Frieren 2nd Season - 37 [WebRip][HEVC-10bit 1080p][简繁日内封]（检索用：葬送的芙莉莲第二季）",
    "magnet": "magnet:?xt=urn:btih:63a0cddb0dcba7b14ee26873265987f21e3a4012&dn=%5B%E2%9D%80%E6%8B%A8%E9%9B%AA%E5%AF%BB%E6%98%A5%E2%9D%80%5D%20%E9%80%81%E8%91%AC%E8%80%85%E8%8A%99%E8%8E%89%E8%8E%B2%20%E7%AC%AC%E4%BA%8C%E5%AD%A3%20%2F%20%E8%91%AC%E9%80%81%E3%81%AE%E3%83%95%E3%83%AA%E3%83%BC%E3%83%AC%E3%83%B3%20%E7%AC%AC%E4%BA%8C%E6%9C%9F%20%2F%20Sousou%20no%20Frieren%202nd%20Season%20-%2037%20%5BWebRip%5D%5BHEVC-10bit%201080p%5D%5B%E7%AE%80%E7%B9%81%E6%97%A5%E5%86%85%E5%B0%81%5D%EF%BC%88%E6%A3%80%E7%B4%A2%E7%94%A8%EF%BC%9A%E8%91%AC%E9%80%81%E7%9A%84%E8%8A%99%E8%8E%89%E8%8E%B2%20%E7%AC%AC%E4%BA%8C%E5%AD%A3%EF%BC%89&tr=udp%3A%2F%2Ftracker.nyaa.net%3A6969%2Fannounce&tr=http%3A%2F%2Fnyaa.tracker.wf%3A7777%2Fannounce&tr=udp%3A%2F%2Fopen.stealth.si%3A80%2Fannounce&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&tr=udp%3A%2F%2Fexodus.desync.com%3A6969%2Fannounce&tr=udp%3A%2F%2Ftracker.torrent.eu.org%3A451%2Fannounce",
    "torrent": "https://nyaa.net/download/2099067.torrent",
    "page": "https://nyaa.net/view/2099067",
    "resolution": "1080P",
    "size": "710.2 MiB",
    "subtitle": "中字",
    "sources": [
      "nyaa"
    ],
    "episodeStart": 0,
    "episodeEnd": 0,
    "isBatch": false
  },
  {
    "title": "[❀拨雪寻春❀] 送葬者芙莉莲第二季/ 葬送のフリーレン 第二期/ Sousou no Frieren 2nd Season - 38 [WebRip][HEVC-10bit 1080p][简繁日内封]（检索用：葬送的芙莉莲第二季）",
    "magnet": "magnet:?xt=urn:btih:5a273992839ab058f3120d0b5767890f8202b321&dn=%5B%E2%9D%80%E6%8B%A8%E9%9B%AA%E5%AF%BB%E6%98%A5%E2%9D%80%5D%20%E9%80%81%E8%91%AC%E8%80%85%E8%8A%99%E8%8E%89%E8%8E%B2%20%E7%AC%AC%E4%BA%8C%E5%AD%A3%20%2F%20%E8%91%AC%E9%80%81%E3%81%AE%E3%83%95%E3%83%AA%E3%83%BC%E3%83%AC%E3%83%B3%20%E7%AC%AC%E4%BA%8C%E6%9C%9F%20%2F%20Sousou%20no%20Frieren%202nd%20Season%20-%2038%20%5BWebRip%5D%5BHEVC-10bit%201080p%5D%5B%E7%AE%80%E7%B9%81%E6%97%A5%E5%86%85%E5%B0%81%5D%EF%BC%88%E6%A3%80%E7%B4%A2%E7%94%A8%EF%BC%9A%E8%91%AC%E9%80%81%E7%9A%84%E8%8A%99%E8%8E%89%E8%8E%B2%20%E7%AC%AC%E4%BA%8C%E5%AD%A3%EF%BC%89&tr=udp%3A%2F%2Ftracker.nyaa.net%3A6969%2Fannounce&tr=http%3A%2F%2Fnyaa.tracker.wf%3A7777%2Fannounce&tr=udp%3A%2F%2Fopen.stealth.si%3A80%2Fannounce&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&tr=udp%3A%2F%2Fexodus.desync.com%3A6969%2Fannounce&tr=udp%3A%2F%2Ftracker.torrent.eu.org%3A451%2Fannounce",
    "torrent": "https://nyaa.net/download/2099408.torrent",
    "page": "https://nyaa.net/view/2099408",
    "resolution": "1080P",
    "size": "642.5 MiB",
    "subtitle": "中字",
    "sources": [
      "nyaa"
    ],
    "episodeStart": 0,
    "episodeEnd": 0,
    "isBatch": false
  },
  {
    "title": "[❀拨雪寻春❀] 送葬者芙莉莲第二季/ 葬送のフリーレン 第二期/ Sousou no Frieren 2nd Season - 37 [WebRip][HEVC-10bit 1080p][简日内嵌]（检索用：葬送的芙莉莲第二季）",
    "magnet": "magnet:?xt=urn:btih:4350a985b3c65fe31617407d340f5ee4b8a75510&dn=%5B%E2%9D%80%E6%8B%A8%E9%9B%AA%E5%AF%BB%E6%98%A5%E2%9D%80%5D%20%E9%80%81%E8%91%AC%E8%80%85%E8%8A%99%E8%8E%89%E8%8E%B2%20%E7%AC%AC%E4%BA%8C%E5%AD%A3%20%2F%20%E8%91%AC%E9%80%81%E3%81%AE%E3%83%95%E3%83%AA%E3%83%BC%E3%83%AC%E3%83%B3%20%E7%AC%AC%E4%BA%8C%E6%9C%9F%20%2F%20Sousou%20no%20Frieren%202nd%20Season%20-%2037%20%5BWebRip%5D%5BHEVC-10bit%201080p%5D%5B%E7%AE%80%E6%97%A5%E5%86%85%E5%B5%8C%5D%EF%BC%88%E6%A3%80%E7%B4%A2%E7%94%A8%EF%BC%9A%E8%91%AC%E9%80%81%E7%9A%84%E8%8A%99%E8%8E%89%E8%8E%B2%20%E7%AC%AC%E4%BA%8C%E5%AD%A3%EF%BC%89&tr=udp%3A%2F%2Ftracker.nyaa.net%3A6969%2Fannounce&tr=http%3A%2F%2Fnyaa.tracker.wf%3A7777%2Fannounce&tr=udp%3A%2F%2Fopen.stealth.si%3A80%2Fannounce&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&tr=udp%3A%2F%2Fexodus.desync.com%3A6969%2Fannounce&tr=udp%3A%2F%2Ftracker.torrent.eu.org%3A451%2Fannounce",
    "torrent": "https://nyaa.net/download/2099065.torrent",
    "page": "https://nyaa.net/view/2099065",
    "resolution": "1080P",
    "size": "610.0 MiB",
    "subtitle": "中字",
    "sources": [
      "nyaa"
    ],
    "episodeStart": 0,
    "episodeEnd": 0,
    "isBatch": false
  },
  {
    "title": "[北宇治字幕组] 葬送的芙莉莲/ Sousou no Frieren [36][WebRip][1080p][HEVC_AAC][简繁日内封]",
    "magnet": "magnet:?xt=urn:btih:27e517212a878ac905ad37b66bdeee41450d7ff2&dn=%5B%E5%8C%97%E5%AE%87%E6%B2%BB%E5%AD%97%E5%B9%95%E7%BB%84%5D%20%E8%91%AC%E9%80%81%E7%9A%84%E8%8A%99%E8%8E%89%E8%8E%B2%20%2F%20Sousou%20no%20Frieren%20%5B36%5D%5BWebRip%5D%5B1080p%5D%5BHEVC_AAC%5D%5B%E7%AE%80%E7%B9%81%E6%97%A5%E5%86%85%E5%B0%81%5D&tr=udp%3A%2F%2Ftracker.nyaa.net%3A6969%2Fannounce&tr=http%3A%2F%2Fnyaa.tracker.wf%3A7777%2Fannounce&tr=udp%3A%2F%2Fopen.stealth.si%3A80%2Fannounce&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&tr=udp%3A%2F%2Fexodus.desync.com%3A6969%2Fannounce&tr=udp%3A%2F%2Ftracker.torrent.eu.org%3A451%2Fannounce",
    "torrent": "https://nyaa.net/download/2092441.torrent",
    "page": "https://nyaa.net/view/2092441",
    "resolution": "1080P",
    "size": "636.9 MiB",
    "subtitle": "中字",
    "sources": [
      "nyaa"
    ],
    "episodeStart": 0,
    "episodeEnd": 0,
    "isBatch": false
  }
];
  const result = normalizeBtSearchResult({ ...payload, rawResultCount: 40, uniqueResultCount: 39, items: originalItems }, request());
  const nodes = renderBtForwardNodes(result, request(), "12345");
  assert.equal(nodes.length, 6);
  assert.ok(nodes[0].text.includes("共 39 条资源"));
  for (const [index, original] of originalItems.entries()) {
    const lines = nodes[index + 1].text.split("\n");
    assert.ok(lines.includes(original.magnet));
    assert.ok(lines.includes(original.torrent));
    assert.ok(lines.includes(original.page));
    assert.ok(nodes[index + 1].text.includes(original.title));
  }
});
