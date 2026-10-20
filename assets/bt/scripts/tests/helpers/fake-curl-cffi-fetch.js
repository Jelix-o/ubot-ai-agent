#!/usr/bin/env node
// Local stand-in for curl_cffi_fetch.py. It exercises the subprocess contract
// without depending on a public endpoint or an installed Python environment.
const url = process.argv[2] || '';

if (url.includes('definitely-not-found-bt-test')) {
  process.stderr.write(`${JSON.stringify({ error: 'http_404', status: 404 })}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('<html><title>Example Domain</title></html>');
}
