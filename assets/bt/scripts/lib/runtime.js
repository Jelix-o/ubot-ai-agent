const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const https = require('https');
const zlib = require('zlib');
const { execFile, spawn } = require('child_process');
const readline = require('readline');
const { absolutizeUrl, stripHtml } = require('./html-utils');

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';
const DEFAULT_TIMEOUT_MS = 6000;
const DEFAULT_MAX_BUFFER = 20 * 1024 * 1024;
const CACHE_TTLS = {
  search: 10 * 60 * 1000,
  detail: 30 * 60 * 1000,
  tdown: 30 * 60 * 1000,
  result: 15 * 60 * 1000,
  default: 10 * 60 * 1000
};

function getCacheTtl(kind) {
  if (kind === 'result' && process.env.OPENCLAW_BT_RESULT_TTL_MINS) {
    return Number(process.env.OPENCLAW_BT_RESULT_TTL_MINS) * 60 * 1000;
  }
  return CACHE_TTLS[kind] || CACHE_TTLS.default;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function uniquePaths(items) {
  return [...new Set((items || []).filter(Boolean).map(item => path.resolve(item)))];
}

function findNearestExistingPath(targetPath) {
  let current = path.resolve(targetPath);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (!parent || parent === current) {
      return '';
    }
    current = parent;
  }
  return current;
}

function canWriteToTarget(targetPath) {
  const probe = findNearestExistingPath(targetPath);
  if (!probe) return false;
  try {
    fs.accessSync(probe, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function chooseWritableTarget(candidates) {
  const normalizedCandidates = uniquePaths(candidates);
  return normalizedCandidates.find(canWriteToTarget) || normalizedCandidates[0];
}

function choosePythonExecutable(skillRoot) {
  const candidates = [
    process.env.OPENCLAW_BT_PYTHON,
    path.join(skillRoot, '.venv', 'bin', 'python'),
    path.join(skillRoot, '.venv', 'bin', 'python3'),
    'python3'
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate === 'python3') {
      return candidate;
    }
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }

  return 'python3';
}

function createRuntime(options = {}) {
  const bypassAllCache = Boolean(options.noCache);
  const workspaceRoot = options.workspaceRoot || process.cwd();
  const scriptDir = options.scriptDir || process.cwd();
  const skillRoot = path.resolve(scriptDir, '..');
  const tempRoot = path.join(os.tmpdir(), 'openclaw-bt');
  const stateFileCandidates = [
    process.env.OPENCLAW_BT_STATE_FILE,
    path.join(workspaceRoot, 'memory', 'bt-search-state.json'),
    path.join(skillRoot, 'memory', 'bt-search-state.json'),
    path.join(tempRoot, 'memory', 'bt-search-state.json')
  ];
  const cacheDirCandidates = [
    process.env.OPENCLAW_BT_CACHE_DIR,
    path.join(workspaceRoot, 'memory', 'bt-cache'),
    path.join(skillRoot, 'memory', 'bt-cache'),
    path.join(tempRoot, 'memory', 'bt-cache')
  ];
  const stateFile = chooseWritableTarget(stateFileCandidates);
  const cacheDir = chooseWritableTarget(cacheDirCandidates);
  const userAgent = options.userAgent || DEFAULT_USER_AGENT;
  const pythonExecutable = choosePythonExecutable(skillRoot);
  // Tests can replace the subprocess protocol without requiring curl_cffi or
  // public network access. Production keeps the bundled Python helpers.
  const curlCffiFetchCommand = options.curlCffiFetchCommand || pythonExecutable;
  const curlCffiFetchScript = options.curlCffiFetchScript || path.join(scriptDir, 'curl_cffi_fetch.py');
  const curlCffiWorkerCommand = options.curlCffiWorkerCommand || pythonExecutable;
  const curlCffiWorkerScript = options.curlCffiWorkerScript || path.join(scriptDir, 'curl_cffi_worker.py');
  let curlCffiWorker = null;
  let curlCffiWorkerReady = null;
  let curlCffiRequestId = 0;
  const curlCffiPending = new Map();
  const subprocesses = new Set();
  const pendingKills = new Set();

  function killManagedChild(child) {
    if (!child || !child.pid) return Promise.resolve();
    const task = process.platform === 'win32'
      ? new Promise(resolve => {
          const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
          killer.once('error', () => { child.kill('SIGKILL'); resolve(); });
          killer.once('close', resolve);
        })
      : Promise.resolve(child.kill('SIGKILL'));
    pendingKills.add(task);
    task.finally(() => pendingKills.delete(task));
    return task;
  }

  // Fallback transports must leave the event loop free for site deadlines.
  function runFile(command, args, options) {
    return new Promise((resolve, reject) => {
      const { timeout, ...spawnOptions } = options;
      let timer;
      const child = execFile(command, args, { ...spawnOptions, shell: false, windowsHide: true }, (error, stdout, stderr) => {
        clearTimeout(timer);
        subprocesses.delete(child);
        if (error) { error.stderr = stderr; reject(error); }
        else resolve(stdout);
      });
      subprocesses.add(child);
      if (timeout) timer = setTimeout(() => { void killManagedChild(child); }, timeout);
    });
  }

  function stopCurlCffiWorker(reason = 'worker_stopped') {
    const worker = curlCffiWorker;
    curlCffiWorker = null;
    curlCffiWorkerReady = null;
    if (worker && !worker.killed) void killManagedChild(worker);
    for (const pending of curlCffiPending.values()) {
      clearTimeout(pending.timer);
      pending.resolve({
        ok: false,
        statusCode: 0,
        headers: {},
        body: Buffer.alloc(0),
        text: '',
        via: 'curl_cffi_worker',
        error: new Error(reason)
      });
    }
    curlCffiPending.clear();
  }

  function ensureCurlCffiWorker() {
    if (curlCffiWorker && curlCffiWorkerReady) return curlCffiWorkerReady;

    const child = spawn(curlCffiWorkerCommand, [curlCffiWorkerScript], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    curlCffiWorker = child;
    let stderr = '';
    child.stderr.on('data', chunk => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-8192);
    });

    const lines = readline.createInterface({ input: child.stdout });
    curlCffiWorkerReady = new Promise((resolve, reject) => {
      const readyTimer = setTimeout(() => {
        reject(new Error('curl_cffi_worker_ready_timeout'));
        stopCurlCffiWorker('curl_cffi_worker_ready_timeout');
      }, 5000);

      lines.on('line', line => {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          return;
        }
        if (message.ready) {
          clearTimeout(readyTimer);
          resolve(child);
          return;
        }
        const pending = curlCffiPending.get(message.id);
        if (!pending) return;
        curlCffiPending.delete(message.id);
        clearTimeout(pending.timer);
        let body = Buffer.alloc(0);
        try {
          body = fs.readFileSync(pending.outPath);
        } catch {
          body = Buffer.alloc(0);
        }
        try { fs.unlinkSync(pending.outPath); } catch {}
        pending.resolve({
          ok: Boolean(message.ok) && body.length > 0,
          statusCode: Number(message.status || 0),
          headers: {},
          body,
          text: body.toString('utf8'),
          via: 'curl_cffi_worker',
          error: message.error ? new Error(message.error) : null,
          stderr
        });
      });
    });

    child.once('error', error => { if (curlCffiWorker === child) stopCurlCffiWorker(error.message); });
    child.once('exit', code => { if (curlCffiWorker === child) stopCurlCffiWorker(`curl_cffi_worker_exit_${code}`); });
    return curlCffiWorkerReady;
  }

  function detectCacheKind(url) {
    if (/\/tdown\//i.test(url)) return 'tdown';
    if (/\/detail\//i.test(url)) return 'detail';
    if (/\/search\//i.test(url)) return 'search';
    return 'default';
  }

  function getCachePath(url, baseDir = cacheDir) {
    const kind = detectCacheKind(url);
    const hash = crypto.createHash('sha1').update(url).digest('hex');
    return path.join(baseDir, `${kind}-${hash}.json`);
  }

  function readCache(url, options = {}) {
    let newestStale = null;
    for (const candidateDir of uniquePaths(cacheDirCandidates)) {
      const filePath = getCachePath(url, candidateDir);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (!data.createdAt) {
          if (options.allowStale && !newestStale) newestStale = data;
          continue;
        }
        const ageMs = Date.now() - data.createdAt;
        const fresh = ageMs <= getCacheTtl(detectCacheKind(url));
        if (fresh) {
          return {
            ...data,
            stale: false,
            ageMs
          };
        }
        if (options.allowStale && (!newestStale || (newestStale.createdAt || 0) < data.createdAt)) {
          newestStale = {
            ...data,
            stale: true,
            ageMs
          };
        }
      } catch {
        continue;
      }
    }
    return newestStale;
  }

  function writeCache(url, html) {
    ensureDir(cacheDir);
    const filePath = getCachePath(url);
    fs.writeFileSync(
      filePath,
      JSON.stringify(
        {
          url,
          createdAt: Date.now(),
          html
        },
        null,
        2
      )
    );
  }

  function getResultCachePath(cacheKey, baseDir = cacheDir) {
    const hash = crypto.createHash('sha1').update(String(cacheKey || '')).digest('hex');
    return path.join(baseDir, `result-${hash}.json`);
  }

  function readSearchResultCache(cacheKey, options = {}) {
    if (!cacheKey) return null;
    const ttl = Number.isFinite(options.ttlMs) ? options.ttlMs : getCacheTtl('result');
    let newestStale = null;
    for (const candidateDir of uniquePaths(cacheDirCandidates)) {
      const filePath = getResultCachePath(cacheKey, candidateDir);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (!data || !data.createdAt) continue;
        const ageMs = Date.now() - data.createdAt;
        if (ageMs <= ttl) {
          return {
            ...data,
            stale: false,
            ageMs,
            cachePath: filePath
          };
        }
        if (options.allowStale && (!newestStale || (newestStale.createdAt || 0) < data.createdAt)) {
          newestStale = {
            ...data,
            stale: true,
            ageMs,
            cachePath: filePath
          };
        }
      } catch {
        continue;
      }
    }
    return newestStale;
  }

  function writeSearchResultCache(cacheKey, payload = {}) {
    if (!cacheKey) return '';
    ensureDir(cacheDir);
    const filePath = getResultCachePath(cacheKey);
    const body = {
      cacheKey,
      createdAt: Date.now(),
      ...payload
    };
    fs.writeFileSync(filePath, JSON.stringify(body, null, 2));
    return filePath;
  }

  function readState() {
    for (const candidateFile of uniquePaths(stateFileCandidates)) {
      try {
        return JSON.parse(fs.readFileSync(candidateFile, 'utf8'));
      } catch {
        continue;
      }
    }
    return {};
  }

  function writeState(nextState) {
    ensureDir(path.dirname(stateFile));
    fs.writeFileSync(stateFile, JSON.stringify(nextState, null, 2));
  }

  function getCooldownRemaining(key, cooldownSeconds) {
    const state = readState();
    const lastSearch = state[key] || 0;
    const elapsed = (Date.now() - lastSearch) / 1000;
    return elapsed < cooldownSeconds ? Math.ceil(cooldownSeconds - elapsed) : 0;
  }

  function markCooldown(key) {
    writeState({
      ...readState(),
      [key]: Date.now()
    });
  }

  function getSiteHealth(siteId) {
    const state = readState();
    const health = state.siteHealth || {};
    const item = health[siteId] || {};
    return {
      failures: Number(item.failures || 0),
      openUntil: Number(item.openUntil || 0),
      lastError: item.lastError || '',
      lastSuccessAt: Number(item.lastSuccessAt || 0),
      lastFailureAt: Number(item.lastFailureAt || 0)
    };
  }

  function isSiteCircuitOpen(siteId, now = Date.now()) {
    const health = getSiteHealth(siteId);
    return Number(health.openUntil || 0) > now;
  }

  function recordSiteSuccess(siteId) {
    if (!siteId) return getSiteHealth(siteId);
    const state = readState();
    const health = { ...(state.siteHealth || {}) };
    health[siteId] = {
      failures: 0,
      openUntil: 0,
      lastError: '',
      lastSuccessAt: Date.now(),
      lastFailureAt: Number((health[siteId] || {}).lastFailureAt || 0)
    };
    writeState({ ...state, siteHealth: health });
    return health[siteId];
  }

  function recordSiteFailure(siteId, errorMessage = '', options = {}) {
    if (!siteId) return getSiteHealth(siteId);
    const threshold = Number(options.threshold || 3);
    const openMs = Number(options.openMs || (5 * 60 * 1000));
    const state = readState();
    const health = { ...(state.siteHealth || {}) };
    const prev = health[siteId] || {};
    const failures = Number(prev.failures || 0) + 1;
    const openUntil = failures >= threshold ? (Date.now() + openMs) : Number(prev.openUntil || 0);
    health[siteId] = {
      failures,
      openUntil,
      lastError: String(errorMessage || prev.lastError || ''),
      lastSuccessAt: Number(prev.lastSuccessAt || 0),
      lastFailureAt: Date.now()
    };
    writeState({ ...state, siteHealth: health });
    return health[siteId];
  }

  function matchesResolvedHost(url, resolveHost) {
    if (!resolveHost) return false;
    try {
      return new URL(url).hostname === resolveHost;
    } catch {
      return false;
    }
  }

  function getTlsSplitConfig(url, requestOptions = {}) {
    try {
      const parsed = new URL(url);
      const resolveHost = requestOptions.resolveHost || '';
      const sniHost = requestOptions.sniHost || '';
      const resolveIp = requestOptions.resolveIp || '';
      const applies = Boolean(
        resolveHost
        && sniHost
        && resolveHost !== sniHost
        && (parsed.hostname === resolveHost || parsed.hostname === sniHost)
      );
      if (!applies) {
        return {
          applies: false,
          resolveHost,
          sniHost,
          resolveIp,
          hostHeader: parsed.hostname,
          connectHost: resolveIp || parsed.hostname,
          servername: parsed.hostname
        };
      }
      return {
        applies: true,
        resolveHost,
        sniHost,
        resolveIp,
        hostHeader: resolveHost,
        connectHost: resolveIp || sniHost,
        servername: sniHost
      };
    } catch {
      return {
        applies: false,
        resolveHost: requestOptions.resolveHost || '',
        sniHost: requestOptions.sniHost || '',
        resolveIp: requestOptions.resolveIp || '',
        hostHeader: '',
        connectHost: '',
        servername: ''
      };
    }
  }

  async function fetchUrlWithHttps(url, requestOptions = {}, redirectCount = 0) {
    return new Promise(resolve => {
      const parsed = new URL(url);
      const timeoutMs = requestOptions.timeoutMs || DEFAULT_TIMEOUT_MS;
      const tls = getTlsSplitConfig(url, requestOptions);
      const headers = {
        'User-Agent': requestOptions.userAgent || userAgent,
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
      };

      if (requestOptions.referer) {
        headers.Referer = requestOptions.referer;
      }

      let requestConfig;
      if (tls.applies) {
        requestConfig = {
          protocol: 'https:',
          hostname: tls.connectHost,
          servername: tls.servername,
          path: `${parsed.pathname}${parsed.search}`,
          headers: {
            ...headers,
            Host: tls.hostHeader
          }
        };
      } else if (matchesResolvedHost(url, requestOptions.resolveHost) && requestOptions.resolveIp) {
        requestConfig = {
          protocol: 'https:',
          hostname: requestOptions.resolveIp,
          servername: requestOptions.resolveHost,
          path: `${parsed.pathname}${parsed.search}`,
          headers: {
            ...headers,
            Host: requestOptions.resolveHost
          }
        };
      } else {
        requestConfig = {
          protocol: 'https:',
          hostname: parsed.hostname,
          port: parsed.port,
          path: `${parsed.pathname}${parsed.search}`,
          headers
        };
      }

      const request = https.get(requestConfig, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectCount < 5) {
          res.resume();
          const nextUrl = absolutizeUrl(url, res.headers.location);
          // Keep TLS split when redirect stays on same site family.
          resolve(fetchUrlWithHttps(nextUrl, requestOptions, redirectCount + 1));
          return;
        }

        let stream = res;
        const encoding = (res.headers['content-encoding'] || '').toLowerCase();
        if (encoding === 'gzip') stream = res.pipe(zlib.createGunzip());
        else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate());
        else if (encoding === 'br') stream = res.pipe(zlib.createBrotliDecompress());

        const chunks = [];
        stream.on('data', chunk => chunks.push(chunk));
        stream.on('error', error => {
          resolve({
            ok: false,
            statusCode: res.statusCode || 0,
            headers: res.headers || {},
            body: Buffer.alloc(0),
            text: '',
            error
          });
        });
        stream.on('end', () => {
          const body = Buffer.concat(chunks);
          resolve({
            ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300,
            statusCode: res.statusCode || 0,
            headers: res.headers,
            body,
            text: body.toString('utf8'),
            via: 'https'
          });
        });
      });

      request.on('error', error => {
        resolve({
          ok: false,
          statusCode: 0,
          headers: {},
          body: Buffer.alloc(0),
          text: '',
          error
        });
      });
      request.setTimeout(timeoutMs, () => {
        request.destroy(new Error('timeout'));
      });
    });
  }

  async function fetchUrlWithCurlCffi(url, requestOptions = {}) {
    try {
      const timeoutMs = requestOptions.timeoutMs || DEFAULT_TIMEOUT_MS;
      const timeoutSec = String(Math.max(1, Math.ceil(timeoutMs / 1000)));
      const body = await runFile(
        curlCffiFetchCommand,
        [
          curlCffiFetchScript,
          url,
          requestOptions.referer || '',
          requestOptions.resolveIp || '',
          requestOptions.resolveHost || '',
          requestOptions.sniHost || '',
          requestOptions.warmupUrl || '',
          requestOptions.cookieJar || '',
          timeoutSec
        ],
        {
          encoding: 'buffer',
          maxBuffer: requestOptions.maxBuffer || DEFAULT_MAX_BUFFER,
          timeout: Math.max(timeoutMs + 2000, 5000),
          stdio: ['ignore', 'pipe', 'pipe']
        }
      );

      if (body.length === 0) {
        return {
          ok: false,
          statusCode: 0,
          headers: {},
          body: Buffer.alloc(0),
          text: ''
        };
      }

      return {
        ok: true,
        statusCode: 200,
        headers: {},
        body,
        text: body.toString('utf8'),
        via: 'curl_cffi'
      };
    } catch (error) {
      const stderr = Buffer.isBuffer(error?.stderr)
        ? error.stderr.toString('utf8')
        : String(error?.stderr || '');
      const statusMatch = stderr.match(/"status"\s*:\s*(\d{3})/);
      const statusCode = statusMatch ? (Number.parseInt(statusMatch[1], 10) || 0) : 0;
      return {
        ok: false,
        statusCode,
        headers: {},
        body: Buffer.alloc(0),
        text: '',
        error,
        stderr
      };
    }
  }

  async function fetchUrlWithCurlCffiWorker(url, requestOptions = {}) {
    const timeoutMs = requestOptions.timeoutMs || DEFAULT_TIMEOUT_MS;
    try {
      const worker = await ensureCurlCffiWorker();
      const id = ++curlCffiRequestId;
      const outPath = path.join(tempRoot, `curl-cffi-${process.pid}-${id}.body`);
      ensureDir(path.dirname(outPath));
      const payload = {
        id,
        url,
        referer: requestOptions.referer || '',
        resolve_ip: requestOptions.resolveIp || '',
        resolve_host: requestOptions.resolveHost || '',
        sni_host: requestOptions.sniHost || '',
        warmup_url: requestOptions.warmupUrl || '',
        cookie_jar: requestOptions.cookieJar || '',
        timeout: Math.max(1, Math.ceil(timeoutMs / 1000)),
        out: outPath
      };
      return await new Promise(resolve => {
        const timer = setTimeout(() => {
          curlCffiPending.delete(id);
          try { fs.unlinkSync(outPath); } catch {}
          stopCurlCffiWorker('curl_cffi_worker_request_timeout');
          resolve({ ok: false, statusCode: 0, headers: {}, body: Buffer.alloc(0), text: '', via: 'curl_cffi_worker', error: new Error('timeout') });
        }, Math.max(timeoutMs + 1500, 3000));
        curlCffiPending.set(id, { resolve, timer, outPath });
        worker.stdin.write(`${JSON.stringify(payload)}\n`);
      });
    } catch (error) {
      stopCurlCffiWorker(error.message);
      return { ok: false, statusCode: 0, headers: {}, body: Buffer.alloc(0), text: '', via: 'curl_cffi_worker', error };
    }
  }

  async function fetchUrlWithCurl(url, requestOptions = {}) {
    try {
      const args = [
        '-fsSL',
        '--compressed',
        '--max-time',
        String(Math.ceil((requestOptions.timeoutMs || DEFAULT_TIMEOUT_MS) / 1000)),
        '-A',
        requestOptions.userAgent || userAgent,
        '-H',
        'Accept-Language: zh-CN,zh;q=0.9,en;q=0.8'
      ];

      if (requestOptions.referer) {
        args.push('-e', requestOptions.referer);
      }

      const tls = getTlsSplitConfig(url, requestOptions);
      if (tls.applies) {
        // Use apex SNI URL + Host:www to avoid blocked www SNI.
        const parsed = new URL(url);
        const apexUrl = `${parsed.protocol}//${tls.sniHost}${parsed.pathname}${parsed.search}`;
        if (tls.resolveIp) {
          args.push('--resolve', `${tls.sniHost}:443:${tls.resolveIp}`);
          args.push('--resolve', `${tls.resolveHost}:443:${tls.resolveIp}`);
        }
        args.push('-H', `Host: ${tls.hostHeader}`);
        args.push('--max-redirs', '0');
        args.push(apexUrl);
      } else {
        if (requestOptions.resolveHost && requestOptions.resolveIp && matchesResolvedHost(url, requestOptions.resolveHost)) {
          args.push('--resolve', `${requestOptions.resolveHost}:443:${requestOptions.resolveIp}`);
        }
        args.push(url);
      }

      const body = await runFile('curl', args, {
        encoding: 'buffer',
        maxBuffer: requestOptions.maxBuffer || DEFAULT_MAX_BUFFER,
        stdio: ['ignore', 'pipe', 'ignore']
      });

      return {
        ok: true,
        statusCode: 200,
        headers: {},
        body,
        text: body.toString('utf8'),
        via: 'curl'
      };
    } catch (error) {
      return {
        ok: false,
        statusCode: 0,
        headers: {},
        body: Buffer.alloc(0),
        text: '',
        error
      };
    }
  }

  function resolveTransportOrder(requestOptions = {}) {
    const defaultOrder = ['curl_cffi_worker', 'curl_cffi', 'curl', 'https'];
    const requestedOrder = Array.isArray(requestOptions.transportOrder)
      ? requestOptions.transportOrder
      : defaultOrder;
    const normalized = requestedOrder
      .map(item => String(item || '').trim())
      .filter(Boolean);
    const deduped = [];
    for (const item of normalized) {
      if (!deduped.includes(item)) {
        deduped.push(item);
      }
    }
    return deduped.length > 0 ? deduped : ['curl_cffi_worker', 'curl_cffi', 'curl', 'https'];
  }

  function isAborted(signal) {
    return Boolean(signal && signal.aborted);
  }

  function classifyFetchFailure(response) {
    const message = String(response?.error?.message || '').toLowerCase();
    if (message === 'timeout' || message.includes('timed out')) return 'timeout';
    if (response?.statusCode >= 400) return `http_${response.statusCode}`;
    if (response?.error) return 'network_error';
    return 'empty_response';
  }

  function scoreFetchFailure(response) {
    const kind = classifyFetchFailure(response);
    if (kind === 'timeout') return 5;
    if (kind.startsWith('http_')) return 4;
    if (kind === 'network_error') return 3;
    if (kind === 'empty_response') return 2;
    return 1;
  }

  function normalizeFailureResponse(response, transport, attempts) {
    const normalized = response || {
      ok: false,
      statusCode: 0,
      headers: {},
      body: Buffer.alloc(0),
      text: ''
    };
    return {
      ...normalized,
      ok: false,
      via: transport || normalized.via || '',
      failureKind: classifyFetchFailure(normalized),
      attempts: attempts.map(item => ({
        transport: item.transport,
        statusCode: item.statusCode || 0,
        failureKind: item.failureKind,
        error: item.error ? item.error.message : ''
      }))
    };
  }

  async function fetchUrl(url, requestOptions = {}, redirectCount = 0) {
    if (isAborted(requestOptions.abortSignal)) {
      return {
        ok: false,
        statusCode: 0,
        headers: {},
        body: Buffer.alloc(0),
        text: '',
        via: 'aborted',
        failureKind: 'aborted',
        attempts: []
      };
    }
    const transportOrder = resolveTransportOrder(requestOptions);
    let bestFailure = null;
    const attempts = [];

    for (const transport of transportOrder) {
      let response;
      if (transport === 'https') {
        response = await fetchUrlWithHttps(url, requestOptions, redirectCount);
      } else if (transport === 'curl_cffi_worker') {
        response = await fetchUrlWithCurlCffiWorker(url, requestOptions);
      } else if (transport === 'curl_cffi') {
        response = await fetchUrlWithCurlCffi(url, requestOptions);
      } else if (transport === 'curl') {
        response = await fetchUrlWithCurl(url, requestOptions);
      } else {
        continue;
      }

      if (isAborted(requestOptions.abortSignal)) {
        return bestFailure || {
          ok: false,
          statusCode: 0,
          headers: {},
          body: Buffer.alloc(0),
          text: '',
          via: 'aborted',
          failureKind: 'aborted',
          attempts: attempts.map(item => ({
            transport: item.transport,
            statusCode: item.statusCode || 0,
            failureKind: item.failureKind,
            error: item.error ? item.error.message : ''
          }))
        };
      }

      if (response.ok && response.text) {
        return {
          ...response,
          via: response.via || transport,
          attempts
        };
      }

      const normalizedFailure = normalizeFailureResponse(response, transport, attempts);
      attempts.push({
        transport,
        statusCode: normalizedFailure.statusCode || 0,
        failureKind: normalizedFailure.failureKind,
        error: normalizedFailure.error || null
      });
      normalizedFailure.attempts = attempts.map(item => ({
        transport: item.transport,
        statusCode: item.statusCode || 0,
        failureKind: item.failureKind,
        error: item.error ? item.error.message : ''
      }));
      if (!bestFailure || scoreFetchFailure(normalizedFailure) >= scoreFetchFailure(bestFailure)) {
        bestFailure = normalizedFailure;
      }
    }

    return bestFailure || {
      ok: false,
      statusCode: 0,
      headers: {},
      body: Buffer.alloc(0),
      text: '',
      failureKind: 'empty_response',
      attempts: []
    };
  }

  function isLikelyBtbtlaChallenge(html) {
    const normalized = stripHtml(html).toLowerCase();
    const hasChallengeHints =
      normalized.includes('just a moment')
      || normalized.includes('verify you are human')
      || normalized.includes('cloudflare')
      || /challenge-platform|cf-browser-verification|turnstile/i.test(html || '');
    const hasUsableSearchMarkup =
      /class="module-items"|class="module-item"|class="module-row-info"|href="\/detail\/\d+\.html"|href="\/tdown\/\d+\.html"/i.test(html || '')
      || /搜索结果|资源下载|影片相关种子/i.test(html || '');
    return hasChallengeHints && !hasUsableSearchMarkup;
  }

  async function fetchCachedHtml(url, options = {}) {
    const noCache = bypassAllCache || options.noCache || options.requestOptions?.noCache;
    if (isAborted(options.requestOptions?.abortSignal)) {
      return {
        html: '',
        via: '中止',
        reason: 'aborted',
        attempts: []
      };
    }
    if (!noCache) {
      const cached = readCache(url);
      if (cached && cached.html) {
        return {
          html: cached.html,
          via: '缓存',
          reason: 'cache_hit'
        };
      }
    }

    if (options.allowNetwork === false) {
      const stale = noCache ? null : readCache(url, { allowStale: true });
      if (stale && stale.html) {
        return {
          html: stale.html,
          via: '过期缓存',
          reason: 'stale_cache'
        };
      }
      return {
        html: '',
        via: '缓存未命中',
        reason: 'cache_miss',
        error: new Error('cache_miss')
      };
    }

    const response = await fetchUrl(url, options.requestOptions || {});
    const isChallenge = typeof options.detectChallenge === 'function' && response.text
      ? options.detectChallenge(response.text)
      : false;

    if (response.ok && response.text && !isChallenge) {
      writeCache(url, response.text);
      const viaLabels = {
        curl: '直连(curl)',
        curl_cffi: '直连(curl_cffi)'
      };
      return {
        html: response.text,
        via: viaLabels[response.via] || '直连',
        reason: 'network_ok'
      };
    }

    const stale = noCache ? null : readCache(url, { allowStale: true });
    if (stale && stale.html) {
      return {
        html: stale.html,
        via: '过期缓存',
        reason: 'stale_cache',
        error: response.error
      };
    }

    return {
      html: '',
      via: '失败',
      reason: isChallenge ? 'challenge' : (response.failureKind === 'timeout' ? 'timeout' : 'network_failed'),
      attempts: response.attempts || [],
      error: response.error
    };
  }

  return {
    fetchUrl,
    fetchCachedHtml,
    readState,
    writeState,
    getCooldownRemaining,
    markCooldown,
    isLikelyBtbtlaChallenge,
    readSearchResultCache,
    writeSearchResultCache,
    getSiteHealth,
    isSiteCircuitOpen,
    recordSiteSuccess,
    recordSiteFailure,
    cacheDir,
    close: async () => {
      stopCurlCffiWorker('runtime_closed');
      await Promise.all([...subprocesses].map(killManagedChild));
      await Promise.all([...pendingKills]);
    }
  };
}

module.exports = {
  createRuntime
};
