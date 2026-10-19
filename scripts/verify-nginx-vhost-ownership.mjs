#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import process from "node:process";

const [renderedConfigPath, botConfig, botEnabled, botHostname, previewConfig, previewEnabled, previewHostname, ...extraArgs] = process.argv.slice(2);

if (!renderedConfigPath || !botConfig || !botEnabled || !botHostname || !previewConfig || !previewEnabled || !previewHostname || extraArgs.length) {
  throw new Error("Usage: verify-nginx-vhost-ownership.mjs <nginx-T-output> <bot-config> <bot-enabled> <bot-hostname> <preview-config> <preview-enabled> <preview-hostname>");
}

const rendered = await readFile(renderedConfigPath, "utf8");
const servers = parseServerBlocks(rendered);

for (const hostname of [botHostname, previewHostname]) {
  if (new RegExp(`conflicting\\s+server\\s+name\\s+["']?${escapeRegExp(hostname)}["']?`, "i").test(rendered)) {
    throw new Error(`Nginx reported a conflicting server name for ${hostname}.`);
  }
}

verifyHostOwnership({
  label: "Bot",
  hostname: botHostname,
  allowedSources: new Set([botConfig, botEnabled]),
});
verifyHostOwnership({
  label: "Preview",
  hostname: previewHostname,
  allowedSources: new Set([previewConfig, previewEnabled]),
});

process.stdout.write(`${JSON.stringify({
  botHostname,
  previewHostname,
  verifiedServers: servers.length,
})}\n`);

function verifyHostOwnership({ label, hostname, allowedSources }) {
  const matching = servers.filter((server) => server.names.includes(hostname));
  if (matching.length !== 2) {
    throw new Error(`${label} Nginx vhost must own exactly two effective server blocks for ${hostname}; found ${matching.length}.`);
  }
  for (const server of matching) {
    if (!server.source || !allowedSources.has(server.source)) {
      throw new Error(`${label} Nginx vhost for ${hostname} is loaded from an unexpected source: ${server.source || "<unknown>"}.`);
    }
    if (!server.hasRealIpInclude || !server.hasOriginGate || !server.hasOriginDeny) {
      throw new Error(`${label} Nginx vhost for ${hostname} does not enforce the Cloudflare real-IP and origin gate.`);
    }
  }
  const http = matching.filter((server) => server.listenPorts.includes(80));
  const https = matching.filter((server) => server.listenPorts.includes(443));
  if (http.length !== 1 || https.length !== 1) {
    throw new Error(`${label} Nginx vhost for ${hostname} must have exactly one HTTP and one HTTPS listener.`);
  }
}

function parseServerBlocks(renderedConfig) {
  const tokens = tokenize(renderedConfig);
  const stack = [];
  const servers = [];
  let directive = [];

  for (const token of tokens) {
    if (token.value === ";") {
      applyDirective(directive, stack);
      directive = [];
      continue;
    }
    if (token.value === "{") {
      const name = directive[0]?.value;
      if (name === "server") {
        const server = {
          source: directive[0]?.source,
          names: [],
          listenPorts: [],
          hasRealIpInclude: false,
          hasOriginGate: false,
          hasOriginDeny: false,
        };
        servers.push(server);
        stack.push({ type: "server", server });
      } else {
        const server = activeServer(stack);
        const originGate = name === "if" && directive.some((token) => token.value.includes("$ubot_cloudflare_origin_allowed"));
        if (server && originGate) server.hasOriginGate = true;
        stack.push({ type: "other", originGate });
      }
      directive = [];
      continue;
    }
    if (token.value === "}") {
      if (directive.length) {
        throw new Error("Nginx rendered configuration has an unterminated directive.");
      }
      if (!stack.length) {
        throw new Error("Nginx rendered configuration has an unmatched closing brace.");
      }
      stack.pop();
      continue;
    }
    directive.push(token);
  }
  if (directive.length || stack.length) {
    throw new Error("Nginx rendered configuration has an unclosed directive or block.");
  }
  return servers;
}

function applyDirective(directive, stack) {
  if (!directive.length) return;
  const [name, ...args] = directive;
  const server = activeServer(stack);
  if (!server) return;
  if (name.value === "return" && args[0]?.value === "403" && stack.some((entry) => entry.originGate)) {
    server.hasOriginDeny = true;
  }
  if (stack.at(-1)?.type !== "server") return;
  if (name.value === "server_name") {
    server.names.push(...args.map((arg) => arg.value));
  } else if (name.value === "listen") {
    const port = parseListenPort(args[0]?.value);
    if (port !== undefined) server.listenPorts.push(port);
  } else if (name.value === "include" && args.some((arg) => arg.value === "/etc/nginx/ubot-cloudflare-realip.conf")) {
    server.hasRealIpInclude = true;
  }
}

function activeServer(stack) {
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    if (stack[index].type === "server") return stack[index].server;
  }
  return undefined;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseListenPort(value) {
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value);
  const ipv4 = value.match(/^[^:]+:(\d+)$/);
  if (ipv4) return Number(ipv4[1]);
  const ipv6 = value.match(/^\[[^\]]+\]:(\d+)$/);
  if (ipv6) return Number(ipv6[1]);
  return undefined;
}

function tokenize(renderedConfig) {
  const tokens = [];
  let source;
  let current = "";
  let currentSource;
  let quote;
  let escaped = false;
  let comment = false;
  const flush = () => {
    if (!current) return;
    tokens.push({ value: current, source: currentSource });
    current = "";
    currentSource = undefined;
  };
  const append = (character, tokenSource) => {
    if (!current) currentSource = tokenSource;
    current += character;
  };

  for (const rawLine of renderedConfig.split(/\r?\n/)) {
    const header = rawLine.match(/^# configuration file (.+):\s*$/);
    if (header) {
      flush();
      source = header[1];
      continue;
    }
    // `nginx -T` writes a status line before the first configuration-file
    // marker. It is not Nginx syntax and must not become part of a directive.
    if (!source) continue;
    for (const character of `${rawLine}\n`) {
      if (comment) {
        if (character === "\n") comment = false;
        continue;
      }
      if (quote) {
        if (escaped) {
          append(character, source);
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === quote) {
          quote = undefined;
        } else {
          append(character, source);
        }
        continue;
      }
      if (character === "#") {
        flush();
        comment = true;
      } else if (character === "\"" || character === "'") {
        if (current) throw new Error("Nginx rendered configuration has an invalid quoted token.");
        quote = character;
      } else if (/\s/.test(character)) {
        flush();
      } else if (character === "{" || character === "}" || character === ";") {
        flush();
        tokens.push({ value: character, source });
      } else {
        append(character, source);
      }
    }
  }
  if (quote || escaped) {
    throw new Error("Nginx rendered configuration has an unterminated quoted value.");
  }
  flush();
  return tokens;
}
