#!/usr/bin/env node
/**
 * Minimal OAuth 2.1 gateway that puts a ChatGPT-compatible authorization layer
 * in front of an MCP server that speaks Streamable HTTP but has no OAuth.
 *
 *   ChatGPT --OAuth 2.1--> this gateway --static bearer--> your MCP server
 *
 * It does not implement an authorization server itself. It reuses
 * SingleUserOAuthProvider from @waishnav/devspace (MIT) and the auth router
 * from @modelcontextprotocol/sdk, and adds the proxying, the health check, and
 * the two workarounds documented in docs/troubleshooting.md.
 *
 * Configure entirely through environment variables. See .env.example.
 *
 * SPDX-License-Identifier: MIT
 */

import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------- config ---

const cfg = {
  host: process.env.GATEWAY_HOST ?? '127.0.0.1',
  port: Number(process.env.GATEWAY_PORT ?? 8771),
  upstreamHost: process.env.UPSTREAM_HOST ?? '127.0.0.1',
  upstreamPort: Number(process.env.UPSTREAM_PORT ?? 8770),
  upstreamPath: process.env.UPSTREAM_PATH ?? '/mcp',
  publicBaseUrl: process.env.PUBLIC_BASE_URL,
  mcpPath: process.env.MCP_PATH ?? '/mcp',
  scope: process.env.SCOPE ?? 'mcp',
  resourceName: process.env.RESOURCE_NAME ?? 'MCP server',
  stateDir: process.env.STATE_DIR ?? path.join(process.cwd(), 'gateway-state'),
  allowedRedirectHosts: (process.env.ALLOWED_REDIRECT_HOSTS ?? 'chatgpt.com,localhost,127.0.0.1')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean),
  accessTokenTtl: Number(process.env.ACCESS_TOKEN_TTL_SECONDS ?? 60 * 60),
  refreshTokenTtl: Number(process.env.REFRESH_TOKEN_TTL_SECONDS ?? 30 * 24 * 60 * 60),
  bodyLimit: process.env.BODY_LIMIT ?? '32mb',
};

const die = (message) => {
  console.error(`[gateway] ${message}`);
  process.exit(1);
};

/** Read a secret from VAR, or from the file named by VAR_FILE. */
const secret = (name, { required = true } = {}) => {
  const inline = process.env[name];
  if (inline) return inline.trim();
  const file = process.env[`${name}_FILE`];
  if (file) {
    try {
      return fs.readFileSync(file, 'utf8').trim();
    } catch (error) {
      die(`${name}_FILE is set to ${file} but could not be read: ${error.message}`);
    }
  }
  if (required) die(`missing ${name} (set ${name} or ${name}_FILE)`);
  return undefined;
};

if (!cfg.publicBaseUrl) die('missing PUBLIC_BASE_URL, e.g. https://mcp.example.com');

const ownerToken = secret('OWNER_TOKEN');
if (ownerToken.length < 32) {
  die('OWNER_TOKEN must be at least 32 characters. Generate one with: openssl rand -hex 32');
}

// Sent upstream in place of the caller's OAuth token. Omit if your MCP server
// has no auth of its own — but prefer giving it one, so the gateway is not the
// only thing standing between the internet and your tools.
const upstreamAuthorization = secret('UPSTREAM_AUTHORIZATION', { required: false });
if (upstreamAuthorization && !/^Bearer\s+\S+$/.test(upstreamAuthorization)) {
  die('UPSTREAM_AUTHORIZATION must look like "Bearer <token>"');
}

// ------------------------------------------------------- module resolution ---

const requireHere = createRequire(import.meta.url);

/**
 * Locate the installed @waishnav/devspace package directory. Everything is
 * resolved relative to that root so the gateway and devspace's own
 * oauth-provider.js load exactly one copy of the MCP SDK. See below.
 */
const devspaceRoot = (() => {
  if (process.env.DEVSPACE_ROOT) return process.env.DEVSPACE_ROOT;
  let entry;
  try {
    entry = requireHere.resolve('@waishnav/devspace');
  } catch {
    die('cannot find @waishnav/devspace. Run `npm install` here, or set DEVSPACE_ROOT.');
  }
  let dir = path.dirname(entry);
  while (dir !== path.dirname(dir)) {
    const manifest = path.join(dir, 'package.json');
    if (fs.existsSync(manifest)) {
      try {
        if (JSON.parse(fs.readFileSync(manifest, 'utf8')).name === '@waishnav/devspace') return dir;
      } catch {
        /* keep walking */
      }
    }
    dir = path.dirname(dir);
  }
  return die('found @waishnav/devspace but could not locate its package root');
})();

const requireFromDevSpace = createRequire(path.join(devspaceRoot, 'package.json'));
const express = requireFromDevSpace('express');

// createRequire().resolve() picks the package's `require` condition, i.e.
// dist/cjs. devspace's oauth-provider.js is ESM and pulls dist/esm, so
// importing the CJS build here would give us a SECOND copy of the SDK's error
// classes — and every `error instanceof InvalidTokenError` check inside
// requireBearerAuth would compare two different class objects, always fail, and
// fall through to the generic handler. The symptom is that every auth failure
// comes back as HTTP 500 server_error instead of 401. Rewrite onto the ESM
// build so both halves share one module instance.
const importResolved = async (specifier) => {
  const resolved = requireFromDevSpace.resolve(specifier);
  const esm = resolved.replace(/([\\/])dist[\\/]cjs[\\/]/, '$1dist$1esm$1');
  return import(pathToFileURL(esm).href);
};

const { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } = await importResolved(
  '@modelcontextprotocol/sdk/server/auth/router.js',
);
const { requireBearerAuth } = await importResolved(
  '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js',
);
const { checkResourceAllowed, resourceUrlFromServerUrl } = await importResolved(
  '@modelcontextprotocol/sdk/shared/auth-utils.js',
);
const { SingleUserOAuthProvider } = await import(
  pathToFileURL(path.join(devspaceRoot, 'dist', 'oauth-provider.js')).href
);

// ------------------------------------------------------------------ setup ---

const mcpUrl = new URL(cfg.mcpPath, cfg.publicBaseUrl);
const resourceServerUrl = resourceUrlFromServerUrl(mcpUrl);

fs.mkdirSync(cfg.stateDir, { recursive: true });

const oauthProvider = new SingleUserOAuthProvider(
  {
    ownerToken,
    accessTokenTtlSeconds: cfg.accessTokenTtl,
    refreshTokenTtlSeconds: cfg.refreshTokenTtl,
    scopes: [cfg.scope],
    allowedRedirectHosts: cfg.allowedRedirectHosts,
  },
  mcpUrl,
  cfg.stateDir,
);

const bearerAuth = requireBearerAuth({
  verifier: oauthProvider,
  requiredScopes: [cfg.scope],
  resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
});

const app = express();

// Only the loopback hop (cloudflared, or whatever terminates TLS on this box)
// is a trusted proxy. `true` trusts every hop, which makes the express-rate-limit
// instance inside mcpAuthRouter throw ERR_ERL_PERMISSIVE_TRUST_PROXY and turn
// 401/400 auth failures into 500s — the same symptom as the CJS/ESM bug above,
// from a completely different cause.
app.set('trust proxy', 'loopback');
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: cfg.bodyLimit }));

app.use(
  mcpAuthRouter({
    provider: oauthProvider,
    issuerUrl: new URL(cfg.publicBaseUrl),
    baseUrl: new URL(cfg.publicBaseUrl),
    resourceServerUrl,
    scopesSupported: [cfg.scope],
    resourceName: cfg.resourceName,
  }),
);

// ----------------------------------------------------------------- health ---

const upstreamReachable = () =>
  new Promise((resolve) => {
    const socket = net.createConnection({ host: cfg.upstreamHost, port: cfg.upstreamPort });
    const finish = (value) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(1500);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });

// Unauthenticated on purpose: it reports liveness only, never data. This is what
// lets you tell "the gateway is down" apart from "the MCP server behind it died".
app.get('/healthz', async (_req, res) => {
  const upstream = await upstreamReachable();
  res.status(upstream ? 200 : 503).json({ ok: upstream, gateway: true, upstream });
});

// ------------------------------------------------------------------ proxy ---

app.all(cfg.mcpPath, bearerAuth, async (req, res) => {
  // RFC 8707: the token must have been issued for *this* resource, not merely
  // be a valid token from this authorization server.
  if (
    !req.auth?.resource ||
    !checkResourceAllowed({
      requestedResource: req.auth.resource,
      configuredResource: resourceServerUrl,
    })
  ) {
    res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Unauthorized' },
      id: null,
    });
    return;
  }

  const headers = { ...req.headers };
  if (upstreamAuthorization) headers.authorization = upstreamAuthorization;
  else delete headers.authorization;
  delete headers.host;
  delete headers['content-length'];
  delete headers.connection;

  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.body !== undefined) {
    body = Buffer.from(JSON.stringify(req.body));
    headers['content-length'] = String(body.length);
    headers['content-type'] ||= 'application/json';
  }

  const upstreamRequest = http.request(
    {
      host: cfg.upstreamHost,
      port: cfg.upstreamPort,
      path: cfg.upstreamPath,
      method: req.method,
      headers,
    },
    (upstreamResponse) => {
      const responseHeaders = { ...upstreamResponse.headers };
      delete responseHeaders.connection;
      res.status(upstreamResponse.statusCode ?? 502);
      for (const [name, value] of Object.entries(responseHeaders)) {
        if (value !== undefined) res.setHeader(name, value);
      }
      upstreamResponse.pipe(res);
    },
  );

  upstreamRequest.on('error', (error) => {
    if (!res.headersSent) {
      res.status(502).json({
        jsonrpc: '2.0',
        error: { code: -32002, message: `MCP upstream unavailable: ${error.message}` },
        id: req.body?.id ?? null,
      });
    } else {
      res.end();
    }
  });

  req.on('aborted', () => upstreamRequest.destroy());
  upstreamRequest.end(body);
});

// ------------------------------------------------------------------ start ---

const server = app.listen(cfg.port, cfg.host, () => {
  console.log(`[gateway] listening on http://${cfg.host}:${cfg.port}${cfg.mcpPath}`);
  console.log(`[gateway] upstream  http://${cfg.upstreamHost}:${cfg.upstreamPort}${cfg.upstreamPath}`);
  console.log(`[gateway] public    ${mcpUrl.href}`);
  console.log(`[gateway] paste that public URL into ChatGPT`);
});

const shutdown = () => {
  server.close(() => {
    oauthProvider.close();
    process.exit(0);
  });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
