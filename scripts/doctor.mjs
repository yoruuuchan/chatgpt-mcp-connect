#!/usr/bin/env node
/**
 * doctor.mjs — find out which layer of a ChatGPT MCP connection is broken.
 *
 *   node scripts/doctor.mjs --url https://mcp.example.com
 *   node scripts/doctor.mjs --url https://mcp.example.com --upstream 127.0.0.1:8770 --gateway 127.0.0.1:8771
 *
 * Checks each hop in order and names the first one that fails. It never
 * substitutes a working layer for a broken one, and it never reports success
 * from a partial result — a layer is PASS only when that exact layer answered
 * correctly.
 *
 * No dependencies. Node 18+.
 *
 * SPDX-License-Identifier: MIT
 */

import net from 'node:net';
import process from 'node:process';

// ------------------------------------------------------------------- args ---

const args = process.argv.slice(2);
const arg = (name, fallback = undefined) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);

if (flag('help') || args.length === 0) {
  console.log(`
Usage: node scripts/doctor.mjs --url <public-https-origin> [options]

  --url       <url>         Public origin ChatGPT connects to, e.g. https://mcp.example.com
  --path      <path>        MCP path on that origin                        (default /mcp)
  --upstream  <host:port>   Your MCP server's local address, if you have it
  --gateway   <host:port>   Your OAuth gateway's local address, if you have one
  --timeout   <ms>          Per-request timeout                            (default 10000)
  --insecure                Skip TLS certificate verification
  --json                    Emit machine-readable results instead of a report
`);
  process.exit(flag('help') ? 0 : 2);
}

const publicUrl = arg('url');
if (!publicUrl) {
  console.error('doctor: --url is required');
  process.exit(2);
}

let origin;
try {
  origin = new URL(publicUrl).origin;
} catch {
  console.error(`doctor: --url is not a valid URL: ${publicUrl}`);
  process.exit(2);
}

const mcpPath = arg('path', '/mcp');
const timeout = Number(arg('timeout', '10000'));
const jsonOut = flag('json');
if (flag('insecure')) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const splitAddr = (value) => {
  if (!value) return undefined;
  const i = value.lastIndexOf(':');
  if (i === -1) return { host: value, port: 80 };
  return { host: value.slice(0, i) || '127.0.0.1', port: Number(value.slice(i + 1)) };
};
const upstream = splitAddr(arg('upstream'));
const gateway = splitAddr(arg('gateway'));

// ----------------------------------------------------------------- probes ---

const tcpProbe = ({ host, port }) =>
  new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (result) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(Math.min(timeout, 3000));
    socket.once('connect', () => done({ ok: true }));
    socket.once('timeout', () => done({ ok: false, reason: 'timed out' }));
    socket.once('error', (error) => done({ ok: false, reason: error.code ?? error.message }));
  });

const httpProbe = async (url, init = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { redirect: 'manual', ...init, signal: controller.signal });
    const text = await response.text();
    return { ok: true, status: response.status, headers: response.headers, text };
  } catch (error) {
    const cause = error.cause ?? error;
    return { ok: false, reason: cause.code ?? cause.message ?? String(error) };
  } finally {
    clearTimeout(timer);
  }
};

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

// ------------------------------------------------------------------ layer ---

const results = [];
let firstFailure = null;

const record = (layer, status, detail, hint) => {
  results.push({ layer, status, detail, hint });
  if (status === 'FAIL' && !firstFailure) firstFailure = { layer, detail, hint };
};

// --- 1. MCP server process -------------------------------------------------

if (upstream) {
  const probe = await tcpProbe(upstream);
  if (probe.ok) record('1. MCP server', 'PASS', `${upstream.host}:${upstream.port} accepting connections`);
  else
    record(
      '1. MCP server',
      'FAIL',
      `cannot connect to ${upstream.host}:${upstream.port} (${probe.reason})`,
      'The MCP server itself is not running. Start it and re-run. Nothing downstream can work until this passes.',
    );
} else {
  record('1. MCP server', 'SKIP', 'no --upstream given');
}

// --- 2. Local OAuth gateway ------------------------------------------------

if (gateway) {
  const probe = await tcpProbe(gateway);
  if (!probe.ok) {
    record(
      '2. OAuth gateway',
      'FAIL',
      `cannot connect to ${gateway.host}:${gateway.port} (${probe.reason})`,
      'The gateway process is not running or crashed at startup. Check its stderr — a bad OWNER_TOKEN or an unresolvable PUBLIC_BASE_URL both exit immediately.',
    );
  } else {
    const health = await httpProbe(`http://${gateway.host}:${gateway.port}/healthz`);
    const body = health.ok ? parseJson(health.text) : undefined;
    if (health.ok && health.status === 200 && body?.ok) {
      record('2. OAuth gateway', 'PASS', `/healthz ok, upstream reachable`);
    } else if (health.ok && body?.ok === false) {
      // The gateway is answering and telling us its own dependency is down.
      // Which key it names varies (upstream, bridge, ...) — report whichever
      // one it set to false rather than guessing at a fixed schema.
      const down = Object.entries(body)
        .filter(([key, value]) => key !== 'ok' && value === false)
        .map(([key]) => key);
      record(
        '2. OAuth gateway',
        'FAIL',
        `gateway is up and reports ${down.length ? down.join(', ') : 'its upstream'} unreachable (HTTP ${health.status})`,
        'The gateway itself is fine — what sits behind it is down. A public request would return 502, not 401.',
      );
    } else if (health.ok) {
      record(
        '2. OAuth gateway',
        'WARN',
        `port open but /healthz returned HTTP ${health.status} with no recognisable body`,
        'Something is listening on this port but it does not look like this gateway. Check for a port collision.',
      );
    } else {
      record('2. OAuth gateway', 'FAIL', `/healthz failed: ${health.reason}`);
    }
  }
} else {
  record('2. OAuth gateway', 'SKIP', 'no --gateway given (edge-auth setups have no local gateway)');
}

// --- 3. Public endpoint reachable -----------------------------------------

const reach = await httpProbe(`${origin}/healthz`);
const reachFallback = reach.ok ? null : await httpProbe(origin);
const reachable = reach.ok || reachFallback?.ok;

if (reachable) {
  record('3. Public HTTPS', 'PASS', `${origin} responded`);
} else {
  const reason = reach.reason ?? reachFallback?.reason ?? 'unknown';
  const hint =
    reason === 'ENOTFOUND'
      ? 'DNS does not resolve. The hostname has no record, or the tunnel never created one.'
      : reason.includes('CERT') || reason.includes('TLS')
        ? 'TLS failed. Re-run with --insecure to confirm, then fix the certificate.'
        : 'The tunnel is down, or it is running but no ingress rule maps this hostname to your local port.';
  record('3. Public HTTPS', 'FAIL', `${origin} unreachable (${reason})`, hint);
}

// --- 4. Protected-resource metadata ---------------------------------------
// RFC 9728 puts the metadata for resource https://host/mcp at
// https://host/.well-known/oauth-protected-resource/mcp. Plenty of servers only
// publish the bare path. Try both and say which one answered — clients differ.

let authServerUrl = null;

if (reachable) {
  const suffixed = `${origin}/.well-known/oauth-protected-resource${mcpPath}`;
  const bare = `${origin}/.well-known/oauth-protected-resource`;
  const a = await httpProbe(suffixed);
  const b = a.ok && a.status === 200 ? null : await httpProbe(bare);

  const winner =
    a.ok && a.status === 200
      ? { url: suffixed, body: parseJson(a.text), which: 'path-suffixed' }
      : b?.ok && b.status === 200
        ? { url: bare, body: parseJson(b.text), which: 'bare' }
        : null;

  if (!winner) {
    record(
      '4. Resource metadata',
      'FAIL',
      `neither ${suffixed} nor ${bare} returned 200`,
      'ChatGPT cannot discover your authorization server. If your gateway is up, this usually means PUBLIC_BASE_URL does not match the hostname you are actually calling.',
    );
  } else if (!winner.body?.authorization_servers?.length) {
    record(
      '4. Resource metadata',
      'FAIL',
      `${winner.which} path returned 200 but no authorization_servers field`,
      'The document is served but incomplete. ChatGPT needs authorization_servers to continue.',
    );
  } else {
    authServerUrl = winner.body.authorization_servers[0];
    record(
      '4. Resource metadata',
      'PASS',
      `${winner.which} path, authorization server: ${authServerUrl}`,
      winner.which === 'bare'
        ? 'Note: only the bare path answered. Some clients look for the path-suffixed form first.'
        : undefined,
    );
  }
} else {
  record('4. Resource metadata', 'SKIP', 'public endpoint unreachable');
}

// --- 5. Authorization server metadata -------------------------------------

if (authServerUrl) {
  const metaUrl = `${authServerUrl.replace(/\/$/, '')}/.well-known/oauth-authorization-server`;
  const probe = await httpProbe(metaUrl);
  const body = probe.ok ? parseJson(probe.text) : undefined;

  if (!probe.ok || probe.status !== 200) {
    record(
      '5. Auth server metadata',
      'FAIL',
      `${metaUrl} -> ${probe.ok ? `HTTP ${probe.status}` : probe.reason}`,
      'The resource metadata points at an authorization server that does not publish its own metadata.',
    );
  } else {
    const missing = ['authorization_endpoint', 'token_endpoint'].filter((k) => !body?.[k]);
    const noDcr = !body?.registration_endpoint;
    const noPkce = !body?.code_challenge_methods_supported?.includes('S256');

    if (missing.length) {
      record('5. Auth server metadata', 'FAIL', `missing ${missing.join(', ')}`);
    } else if (noDcr || noPkce) {
      record(
        '5. Auth server metadata',
        'WARN',
        [noDcr && 'no registration_endpoint (dynamic client registration)', noPkce && 'no S256 in code_challenge_methods_supported']
          .filter(Boolean)
          .join('; '),
        'ChatGPT registers itself dynamically and uses PKCE S256. Without both, the connector usually fails at the "add" step with no useful message.',
      );
    } else {
      record('5. Auth server metadata', 'PASS', 'endpoints, DCR and PKCE S256 all advertised');
    }
  }
} else {
  record('5. Auth server metadata', 'SKIP', 'no authorization server discovered');
}

// --- 6. The MCP endpoint itself -------------------------------------------
// An unauthenticated request MUST be rejected with 401. Anything else is a bug,
// and each wrong answer means something specific.

if (reachable) {
  const probe = await httpProbe(`${origin}${mcpPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });

  if (!probe.ok) {
    record('6. MCP endpoint', 'FAIL', `request failed: ${probe.reason}`);
  } else if (probe.status === 401) {
    const challenge = probe.headers.get('www-authenticate');
    record(
      '6. MCP endpoint',
      'PASS',
      `401 without a token — correct${challenge ? ', WWW-Authenticate present' : ''}`,
      challenge
        ? undefined
        : 'No WWW-Authenticate header. Some clients rely on it to find the resource metadata.',
    );
  } else if (probe.status === 500) {
    record(
      '6. MCP endpoint',
      'FAIL',
      '500 where 401 was expected',
      'Auth is failing open into a generic error. Two known causes: two copies of @modelcontextprotocol/sdk loaded (CJS and ESM), so `instanceof InvalidTokenError` never matches; or `trust proxy` set to true, which makes express-rate-limit throw. See docs/troubleshooting.md.',
    );
  } else if (probe.status === 502 || probe.status === 503) {
    record(
      '6. MCP endpoint',
      'FAIL',
      `HTTP ${probe.status}`,
      'The auth layer let the request through but nothing is behind it. The MCP server or the stdio bridge is down.',
    );
  } else if (probe.status === 200 || probe.status === 202) {
    record(
      '6. MCP endpoint',
      'WARN',
      `HTTP ${probe.status} with no credentials — this endpoint is unauthenticated`,
      'Anyone who learns this hostname can call your tools. Put OAuth in front of it before leaving it up.',
    );
  } else if (probe.status === 404) {
    record('6. MCP endpoint', 'FAIL', `404 at ${mcpPath}`, 'Wrong path, or ingress routes this hostname somewhere else.');
  } else {
    record('6. MCP endpoint', 'FAIL', `unexpected HTTP ${probe.status}`);
  }
} else {
  record('6. MCP endpoint', 'SKIP', 'public endpoint unreachable');
}

// ------------------------------------------------------------------ report ---

if (jsonOut) {
  console.log(JSON.stringify({ url: origin, path: mcpPath, results, firstFailure }, null, 2));
} else {
  const mark = { PASS: '  ok  ', FAIL: ' FAIL ', WARN: ' warn ', SKIP: ' --   ' };
  console.log(`\nChecking ${origin}${mcpPath}\n`);
  for (const r of results) {
    console.log(`[${mark[r.status]}] ${r.layer.padEnd(24)} ${r.detail}`);
    if (r.hint) console.log(`${' '.repeat(9)}${r.hint}`);
  }
  console.log('');
  if (firstFailure) {
    console.log(`Broken at: ${firstFailure.layer}`);
    console.log(`           ${firstFailure.detail}`);
    console.log('\nFix that layer before looking at anything below it.\n');
  } else if (results.some((r) => r.status === 'WARN')) {
    console.log('No hard failures, but see the warnings above.\n');
  } else {
    console.log('All checked layers pass. ChatGPT should be able to complete OAuth against this URL.');
    console.log('That is not the same as a successful tool call — finish by calling one real tool from ChatGPT.\n');
  }
}

process.exit(firstFailure ? 1 : 0);
