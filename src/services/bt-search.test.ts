import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { BtSearchError, BtSearchService, btEngineArguments, normalizeBtSearchResult, parseBtSearchRequest, type BtSearchResult } from "./bt-search-service.js";
import { renderBtSearchMessages } from "./bt-search-renderer.js";
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

test("BT messages preserve complete links, escape CQ and distinguish empty-result failures", () => {
  const value = normalizeBtSearchResult(payload, request());
  value.items = Array.from({ length: 5 }, (_, index) => ({ ...value.items[0]!, title: `${index} [CQ:at,qq=all] ${"长标题".repeat(70)}` }));
  const messages = renderBtSearchMessages(value, request());
  assert.ok(messages.length > 1);
  assert.equal(messages.join("\n").includes("[CQ:at"), false);
  for (const message of messages.filter(message => message.includes("magnet:"))) assert.ok(message.includes(magnet.replaceAll("&", "&amp;")));
  for (const [warning, expected] of [["", "未找到"], ["搜索超时", "超时"], ["Cloudflare 验证页", "验证页"], ["抓取依赖 curl_cffi 不可用", "依赖缺失"]]) {
    const empty = { ...value, items: [], warnings: warning ? [warning!] : [] };
    assert.ok(renderBtSearchMessages(empty, request()).join("\n").includes(expected!));
  }
  const json = renderBtSearchMessages(normalizeBtSearchResult(payload, request()), { ...request(), json: true });
  for (const message of json) assert.doesNotThrow(() => JSON.parse(message.replaceAll("&amp;", "&").replaceAll("&#91;", "[").replaceAll("&#93;", "]")));
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
