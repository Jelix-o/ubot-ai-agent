#!/usr/bin/env node
import { readFile, readdir, mkdir, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Report locations and rule names only: failed checks must not echo personal data.
export function findPrivacyIssues(text) {
  const rules = [
    ["personal-identifier", /(?:QQ(?:\s*号)?|群号|(?:群|成员|用户)\s*(?:ID|编号)?|(?:group|user|member)_?ids?|bot_qq|superAdminUserIds|switcherUserIds)[\s:=：#'"`\[\](){},*-]{0,20}\d{5,12}(?!\d)/giu],
    ["napcat-account-filename", /onebot11_\d{5,12}\.json/giu],
    ["qq-avatar-identifier", /(?:qlogo\.cn|q\.qlogo\.cn)[^\s<>]*[?&](?:nk|uin)=\d{5,12}/giu],
    ["cq-member-identifier", /\[CQ:at,[^\]\n]*qq=\d{5,12}/giu],
    ["chat-transcript", /^(?:[^\n]{1,40}:?\s+)?\d{1,2}-\d{1,2}\s+\d{2}:\d{2}:\d{2}\s*$/gmu],
  ];
  return rules.flatMap(([rule, pattern]) => Array.from(text.matchAll(pattern), match => ({
    rule, line: text.slice(0, match.index).split("\n").length,
  })));
}

export function extractReleaseNotes(readme, version) {
  const start = "<!-- release-notes:start -->";
  const end = "<!-- release-notes:end -->";
  if (readme.split(start).length !== 2 || readme.split(end).length !== 2 || readme.indexOf(end) < readme.indexOf(start)) {
    throw new Error("README must contain exactly one ordered release-notes marker pair");
  }
  const section = readme.slice(readme.indexOf(start) + start.length, readme.indexOf(end)).trim();
  const [heading, ...body] = section.split(/\r?\n/u);
  if (heading !== `### v${version}`) throw new Error("README release-notes version must match package.json");
  if (!body.join("\n").trim()) throw new Error("Release notes must not be empty");
  const notes = `# UBot v${version}\n\n${body.join("\n").trim()}\n`;
  if (findPrivacyIssues(notes).length) throw new Error("Release notes contain personal identifiers or a chat transcript");
  return notes;
}

const ignoredDirectories = new Set([".git", "node_modules", "dist", "release", "data", "config", ".codex_tmp", ".claude", ".mimocode", ".npm-cache", "bt-runtime", "private"]);
export async function checkDocumentation(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory() && !ignoredDirectories.has(entry.name)) await visit(target);
      else if (entry.isFile() && entry.name.endsWith(".md")) files.push(target);
    }
  }
  await visit(root);
  const issues = [];
  for (const file of files) {
    for (const issue of findPrivacyIssues(await readFile(file, "utf8"))) {
      issues.push({ file: path.relative(root, file).split(path.sep).join("/"), ...issue });
    }
  }
  if (issues.length) throw new Error(`Public documentation privacy check failed: ${JSON.stringify(issues)}`);
  const readme = await readFile(path.join(root, "README.md"), "utf8");
  const { version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  extractReleaseNotes(readme, version);
  const anchors = new Set(Array.from(readme.matchAll(/<a id="([^"]+)"\s*><\/a>/gu), match => match[1]));
  for (const match of readme.matchAll(/(?<!!)\[[^\]\n]+\]\(([^)\s]+)\)/gu)) {
    const target = match[1];
    if (/^[a-z][a-z0-9+.-]*:/iu.test(target)) continue;
    const [filename, anchor] = target.split("#");
    if (!filename && anchor) {
      if (!anchors.has(anchor)) throw new Error(`README anchor not found: ${anchor}`);
    } else if (filename) {
      const resolved = path.resolve(root, decodeURIComponent(filename));
      if (path.relative(root, resolved).startsWith("..") || !(await stat(resolved).catch(() => null))) {
        throw new Error(`README local link not found: ${filename}`);
      }
    }
  }
  return { files: files.length, version };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const allowed = new Set(command === "check" ? ["--root"] : ["--root", "--output", "--input", "--title"]);
  const options = new Map();
  for (let i = 0; i < args.length; i += 2) {
    if (!allowed.has(args[i]) || !args[i + 1] || args[i + 1].startsWith("--") || options.has(args[i])) throw new Error("Invalid documentation command options");
    options.set(args[i], args[i + 1]);
  }
  const root = path.resolve(options.get("--root") ?? fileURLToPath(new URL("..", import.meta.url)));
  if (command === "check") {
    console.log(`PUBLIC_DOCS_OK ${JSON.stringify(await checkDocumentation(root))}`);
  } else if (command === "release-notes") {
    // Always check the public handbook, even if custom release text is supplied.
    await checkDocumentation(root);
    const { version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    let notes = extractReleaseNotes(await readFile(path.join(root, "README.md"), "utf8"), version);
    if (options.has("--input")) {
      notes = await readFile(path.resolve(root, options.get("--input")), "utf8");
      const [heading, ...body] = notes.split(/\r?\n/u);
      if (heading !== `# UBot v${version}` || !body.join("\n").trim()) throw new Error("Custom release notes require a matching version heading and a body");
    }
    if (findPrivacyIssues(`${options.get("--title") ?? ""}\n${notes}`).length) throw new Error("Release title or notes contain personal identifiers or a chat transcript");
    const output = path.resolve(root, options.get("--output") ?? ".codex_tmp/release-notes.md");
    const relative = path.relative(root, output);
    if (!relative.startsWith(`.codex_tmp${path.sep}`) || !output.endsWith(".md")) throw new Error("Generated notes must stay in the ignored .codex_tmp directory");
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, notes, "utf8");
    console.log(`RELEASE_NOTES_OK ${version}`);
  } else throw new Error("Usage: public-docs.mjs check|release-notes [--root path] [--input file] [--output .codex_tmp/file.md] [--title text]");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
