#!/usr/bin/env node
const { spawnSync } = require('child_process');
const path = require('path');

const script = path.resolve(__dirname, '../bt.js');
const cases = [
  ['anime-mikan', ['凡人修仙传', 'anime', '--source', 'mikan', '--no-cache', '--json']],
  ['anime-nyaa', ['凡人修仙传', 'anime', '--source', 'nyaa', '--no-cache', '--json']],
  ['anime-fast', ['大主宰', 'anime', '--fast', '--no-cache', '--json']],
  ['movie-fast', ['三体', 'movie', '--fast', '--no-cache', '--json']],
  ['adult-fast', ['波多野结衣', 'adult', '--fast', '--no-cache', '--json']]
];

const rows = [];
for (const [name, args] of cases) {
  const start = Date.now();
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 20 * 1024 * 1024
  });
  const durationMs = Date.now() - start;
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    parsed = null;
  }
  rows.push({
    name,
    durationMs,
    exitCode: result.status,
    timedOut: Boolean(result.error && result.error.code === 'ETIMEDOUT'),
    totalResults: parsed ? parsed.totalResults : 0,
    sites: parsed ? (parsed.sites || []).map(s => `${s.siteId}:${s.resultCount}:${s.via || '-'}`).join(',') : '',
    stderr: (result.stderr || '').trim().slice(0, 200)
  });
}

console.table(rows);
if (rows.some(row => row.exitCode !== 0 || row.timedOut)) process.exitCode = 1;
