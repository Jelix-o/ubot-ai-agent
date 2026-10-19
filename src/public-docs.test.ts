import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import test from "node:test";

const script = path.resolve("scripts/public-docs.mjs");
const { extractReleaseNotes, findPrivacyIssues, checkDocumentation } = await import(pathToFileURL(script).href);
const handbook = (body = "修复成员画像查询。", version = "3.0.46") => `# UBot\n\n<a id="usage"></a>\n## 使用\n\n[使用](#usage)\n\n<!-- release-notes:start -->\n### v${version}\n\n${body}\n<!-- release-notes:end -->\n`;

test("public notes use the exact current version and reject malformed or empty markers", () => {
  assert.equal(extractReleaseNotes(handbook(), "3.0.46"), "# UBot v3.0.46\n\n修复成员画像查询。\n");
  for (const text of [handbook("", "3.0.46"), handbook("修复", "3.0.45"), handbook() + handbook(), handbook().replace("release-notes:end", "removed")]) {
    assert.throws(() => extractReleaseNotes(text, "3.0.46"));
  }
});

test("documentation privacy checks catch personal identifier forms without echoing values", () => {
  const sampleId = "987654321"; // Fictional fixture, never a production identifier.
  for (const text of [`QQ \`${sampleId}\``, `群号：${sampleId}`, `成员 ${sampleId}`, `userId: "${sampleId}"`, `group_id=${sampleId}`, `onebot11_${sampleId}.json`, `[CQ:at,qq=${sampleId}]`, `https://q1.qlogo.cn/g?b=qq&nk=${sampleId}&s=640`, "成员甲: 10-16 15:37:46"]) {
    const issues = findPrivacyIssues(text);
    assert.ok(issues.length, "should reject a personal identifier or transcript");
    assert.ok(!JSON.stringify(issues).includes(sampleId));
  }
  assert.deepEqual(findPrivacyIssues("v3.0.46，2026-10-19，Node 22，端口 6200，30 秒，SHA-256 a0123456789abcdef，QQ <USER_ID>，群 <GROUP_ID>，成员甲"), []);
});

test("release generation checks custom notes, titles and handbook links before writing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ubot-public-docs-"));
  try {
    await writeFile(path.join(root, "package.json"), JSON.stringify({ version: "3.0.46" }));
    await writeFile(path.join(root, "README.md"), handbook());
    await mkdir(path.join(root, ".codex_tmp"));
    const run = (...args: string[]) => spawnSync(process.execPath, [script, "release-notes", "--root", root, ...args], { encoding: "utf8" });
    assert.equal(run().status, 0);
    assert.match(await readFile(path.join(root, ".codex_tmp/release-notes.md"), "utf8"), /^# UBot v3\.0\.46/);
    await writeFile(path.join(root, ".codex_tmp/custom.md"), "# UBot v3.0.46\n\nQQ 987654321");
    assert.notEqual(run("--input", ".codex_tmp/custom.md").status, 0);
    await writeFile(path.join(root, ".codex_tmp/custom.md"), "# UBot v3.0.46");
    assert.notEqual(run("--input", ".codex_tmp/custom.md").status, 0);
    assert.notEqual(run("--title", "群号 987654321").status, 0);
    assert.notEqual(run("--output", "README.md").status, 0);
    await writeFile(path.join(root, "README.md"), handbook() + "\n[部署](docs/removed.md)\n");
    await assert.rejects(checkDocumentation(root), /local link not found/);
    await writeFile(path.join(root, "README.md"), handbook() + "\n[错误锚点](#missing)\n");
    await assert.rejects(checkDocumentation(root), /anchor not found/);
    await writeFile(path.join(root, "README.md"), handbook("QQ 987654321"));
    await assert.rejects(checkDocumentation(root), /privacy check failed/);
    await writeFile(path.join(root, "README.md"), handbook() + "\n[配置](onebot11_987654321.json)\n");
    await assert.rejects(checkDocumentation(root), (error: Error) => {
      assert.match(error.message, /privacy check failed/);
      assert.ok(!error.message.includes("987654321"));
      return true;
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});
