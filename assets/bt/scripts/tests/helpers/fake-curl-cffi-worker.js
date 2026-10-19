#!/usr/bin/env node
const fs = require('fs');

let hasCookie = false;

function writeResponse(response) {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

writeResponse({ id: null, ok: true, ready: true });

process.stdin.setEncoding('utf8');
let buffered = '';
process.stdin.on('data', chunk => {
  buffered += chunk;
  while (true) {
    const newline = buffered.indexOf('\n');
    if (newline < 0) return;
    const line = buffered.slice(0, newline).trim();
    buffered = buffered.slice(newline + 1);
    if (!line) continue;

    let request;
    try {
      request = JSON.parse(line);
    } catch {
      continue;
    }

    const url = String(request.url || '');
    if (url.includes('/cookies/set/bt_worker/yes')) {
      hasCookie = true;
    }
    const body = url.includes('/cookies')
      ? JSON.stringify({ cookies: hasCookie ? { bt_worker: 'yes' } : {} })
      : 'cookie set';
    fs.writeFileSync(request.out, body);
    writeResponse({ id: request.id, ok: true, status: 200, bytes: Buffer.byteLength(body) });
  }
});
