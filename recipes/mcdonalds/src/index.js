import { AuthorizationError, OAuthProvider } from '@cloudflare/workers-oauth-provider';

const PUBLIC_BASE_URL = 'https://mcd-mcp.yoru-and-akari.dev';
const RESOURCE = `${PUBLIC_BASE_URL}/mcp`;
const SCOPE = 'mcd';

function safeEqual(a, b) {
  const left = new TextEncoder().encode(String(a));
  const right = new TextEncoder().encode(String(b));
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left[i] ^ right[i];
  return diff === 0;
}

async function deriveApprovalPassphrase(mcdToken) {
  const input = new TextEncoder().encode(
    `chatgpt-mcp-connect:mcdonalds:approval:v1:${mcdToken}`,
  );
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
  const base64url = btoa(String.fromCharCode(...digest))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
  return base64url.slice(0, 32);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]);
}

function authorizationErrorResponse(error) {
  if (!error.redirectUri) {
    return new Response(error.description, { status: 400 });
  }
  const redirect = new URL(error.redirectUri);
  redirect.searchParams.set('error', error.code);
  redirect.searchParams.set('error_description', error.description);
  if (error.state) redirect.searchParams.set('state', error.state);
  if (error.issuer) redirect.searchParams.set('iss', error.issuer);
  return Response.redirect(redirect.toString(), 302);
}

const mcpProxy = {
  async fetch(request, env) {
    const incomingUrl = new URL(request.url);
    const target = new URL(env.MCD_MCP_URL);
    target.search = incomingUrl.search;

    const headers = new Headers();
    for (const [name, value] of request.headers) {
      const lower = name.toLowerCase();
      if (
        lower === 'accept' ||
        lower === 'content-type' ||
        lower === 'last-event-id' ||
        lower.startsWith('mcp-')
      ) {
        headers.set(name, value);
      }
    }
    headers.set('authorization', `Bearer ${env.MCD_MCP_TOKEN}`);

    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';

    let upstream;
    try {
      upstream = await fetch(target, {
        method: request.method,
        headers,
        body: hasBody ? request.body : undefined,
        redirect: 'manual',
      });
    } catch (error) {
      console.error(JSON.stringify({ event: 'mcd_upstream_error', message: error.message }));
      return Response.json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32002, message: `McDonald's MCP upstream unavailable: ${error.message}` },
      }, { status: 502 });
    }

    const responseHeaders = new Headers();
    for (const [name, value] of upstream.headers) {
      const lower = name.toLowerCase();
      if (
        lower === 'content-type' ||
        lower === 'cache-control' ||
        lower === 'retry-after' ||
        lower === 'www-authenticate' ||
        lower.startsWith('mcp-')
      ) {
        responseHeaders.set(name, value);
      }
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  },
};

const defaultHandler = {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/healthz') {
      return Response.json({ ok: true, gateway: true });
    }

    if (url.pathname !== '/authorize') {
      return new Response('Not Found', { status: 404 });
    }

    let authRequest;
    try {
      authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
    } catch (error) {
      if (!(error instanceof AuthorizationError)) throw error;
      return authorizationErrorResponse(error);
    }

    const client = await env.OAUTH_PROVIDER.lookupClient(authRequest.clientId);
    if (!client) return new Response('Unknown OAuth client', { status: 400 });

    if (request.method === 'GET') {
      return new Response(approvalPage({ client, authRequest, error: null }), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }

    if (request.method === 'POST') {
      const form = await request.formData();
      const passphrase = form.get('passphrase') ?? '';
      const expectedPassphrase = await deriveApprovalPassphrase(env.MCD_MCP_TOKEN);
      if (!safeEqual(passphrase, expectedPassphrase)) {
        return new Response(approvalPage({ client, authRequest, error: 'Wrong passphrase.' }), {
          status: 401,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }

      const grantedScopes = authRequest.scope.filter((scope) => scope === SCOPE);
      const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
        request: authRequest,
        userId: 'owner',
        metadata: { clientName: client.clientName ?? client.clientId },
        scope: grantedScopes.length ? grantedScopes : [SCOPE],
        props: { user: 'owner' },
      });
      return Response.redirect(redirectTo, 302);
    }

    return new Response('Method Not Allowed', { status: 405 });
  },
};

function approvalPage({ client, authRequest, error }) {
  const clientName = escapeHtml(client?.clientName || client?.clientId || 'an unidentified client');
  const scopes = escapeHtml(authRequest.scope.length ? authRequest.scope.join(', ') : SCOPE);
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize McDonald's MCP</title>
<style>
:root{color-scheme:light dark}body{font:15px/1.6 system-ui;max-width:32rem;margin:12vh auto;padding:0 1.25rem}
input{width:100%;padding:.6rem .75rem;font:inherit;box-sizing:border-box}button{margin-top:1rem;padding:.6rem 1.1rem;font:inherit;cursor:pointer}
.err{color:#c0392b;font-weight:600}code{overflow-wrap:anywhere}
</style>
<h1>Authorize McDonald's MCP</h1>
<p><strong>${clientName}</strong> is asking to use your McDonald's China MCP account.</p>
<p>Scope: <code>${scopes}</code></p>
${error ? `<p class="err">${escapeHtml(error)}</p>` : ''}
<form method="POST">
  <label>Approval passphrase<br><input type="password" name="passphrase" autocomplete="current-password" autofocus></label>
  <button type="submit">Approve</button>
</form>`;
}

export default new OAuthProvider({
  apiRoute: '/mcp',
  apiHandler: mcpProxy,
  defaultHandler,
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/oauth/token',
  clientRegistrationEndpoint: '/oauth/register',
  clientIdMetadataDocumentEnabled: true,
  scopesSupported: [SCOPE],
  resourceMetadata: {
    resource: RESOURCE,
    authorization_servers: [PUBLIC_BASE_URL],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: "McDonald's China MCP",
  },
});
