# ComfyUI MCP → ChatGPT

> Give ChatGPT agent-native control of a local ComfyUI instance — image, video, and audio generation; workflow authoring and execution; model and custom-node management — over a public HTTPS endpoint with OAuth 2.1 running entirely at the Cloudflare edge.

| | |
|---|---|
| **Upstream** | [artokun/comfyui-mcp](https://github.com/artokun/comfyui-mcp) · MIT · tested at `0.51.57`, latest `0.52.1` |
| **Transport** | Native Streamable HTTP on `127.0.0.1:9100` — no bridge needed |
| **Auth** | [Cloudflare Worker OAuth](#3-put-oauth-in-front-of-it) (pattern #2 — [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider) `0.10.3`, MIT) |
| **Exposure** | Cloudflare Tunnel, token mode (for the origin); Cloudflare Worker route (for the public endpoint) |
| **Status** | Verified 2026-08-18 — comfyui-mcp LISTENING on :9100, tunnel RUNNING, local `/mcp` → 401, public `/mcp` → 401 (OAuth enforced). ComfyUI itself (:8188) was deliberately not started (see [Known limitations](#known-limitations)); auth and transport chain verified, end-to-end generation not re-verified on this date |

## What this is

This recipe connects ChatGPT to a locally-running ComfyUI instance through `comfyui-mcp`, a local-first MCP server that exposes ComfyUI's full capability surface.

**How this differs from the other recipes in this repo:** there is no local OAuth gateway process. OAuth 2.1 runs in a Cloudflare Worker at the edge, using `@cloudflare/workers-oauth-provider`. The Worker authenticates the caller, swaps the OAuth bearer token for a shared secret, and byte-forwards the request through a Cloudflare Tunnel to the local MCP server. This means:

- No local Node auth process to supervise or keep alive.
- OAuth stays up even when the workstation is asleep — the caller gets a clean 502 ("origin unreachable") rather than a dead hostname.
- State (client registrations, tokens) is managed by Workers KV, not a local SQLite file.

The cost: you need a Cloudflare Workers + KV plan, and **two hostnames** — one for the Worker (public MCP endpoint) and one for the tunnel origin.

**What is ours vs. upstream:**
- **Upstream** — `comfyui-mcp` itself. You install it from npm; you do not modify it.
- **This recipe** — the integration knowledge: the Worker source, the tunnel config, the supervisor, and the order of operations.
- **Our components** — the Worker source is yours to write (template below). MIT.

## Tested environment

- Windows 11, RTX 4060 Laptop (8 GB VRAM), 32 GB RAM
- ComfyUI v0.33.1 (Windows portable distribution)
- Node 22+
- cloudflared
- Cloudflare account with Workers, KV, Tunnels, and a DNS zone

## Prerequisites

1. **ComfyUI** installed and launchable. Tested with the Windows portable distribution and an NVIDIA GPU (8 GB).
2. **Node 22+** for the MCP server.
3. **cloudflared** installed ([download](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)).
4. A **Cloudflare account** with:
   - A domain you control (for DNS records).
   - Workers + KV enabled.
   - A named tunnel configured in the Zero Trust dashboard.
5. **Two DNS records** you will create:
   - `comfyui-mcp.example.com` — Worker route (the public MCP endpoint ChatGPT talks to).
   - `comfyui-origin.example.com` — tunnel hostname (the Worker forwards here; not accessed directly by clients).

## 1. Get the MCP server running locally

Create a minimal install directory so the upstream package stays unmodified and updates are a version bump:

```powershell
mkdir C:\mcp\comfyui-mcp
cd C:\mcp\comfyui-mcp
```

```json
{
  "dependencies": {
    "comfyui-mcp": "^0.51.57"
  }
}
```

Save the above as `package.json`, then install:

```powershell
npm install
```

Generate a shared secret the MCP server will require on every HTTP request:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))" > secrets\http-token.txt
```

Set environment variables and start the server:

```powershell
$env:COMFYUI_URL = 'http://127.0.0.1:8188'
$env:COMFYUI_PATH = '<your ComfyUI dir>'    # e.g. C:\ComfyUI\ComfyUI_windows_portable\ComfyUI
$env:COMFYUI_MCP_HTTP_TOKEN = (Get-Content secrets\http-token.txt -Raw).Trim()

node node_modules\comfyui-mcp\dist\index.js --http --host 127.0.0.1 --port 9100
```

Verify:

```powershell
# Should return 401 — the shared secret is enforced
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:9100/mcp
```

A `401` here is correct — it means the server is up and rejecting unauthenticated requests.

> **`COMFYUI_URL` is set explicitly** because `comfyui-mcp`'s built-in port probe silently falls back to a guess when ComfyUI is slow to respond (see [Known limitations](#known-limitations)).

## 3. Put OAuth in front of it

This is the headline difference from the [DaVinci Resolve recipe](../davinci-resolve/) and others that use the [local OAuth gateway](../../templates/oauth-gateway/). Here, OAuth runs in a Cloudflare Worker. The Worker holds zero ComfyUI logic — it authenticates the caller with OAuth 2.1 and byte-forwards to the tunnel origin.

### Two-hostname topology

```
ChatGPT
  │ OAuth 2.1 (authorization_code + PKCE S256 + RFC 7591 DCR + RFC 8707 resource)
  ▼
https://comfyui-mcp.example.com/mcp        ← Worker route; OAuth terminates here
  │ swaps OAuth bearer → origin shared secret
  ▼
https://comfyui-origin.example.com/mcp      ← Cloudflare Tunnel hostname
  │
  ▼
127.0.0.1:9100  (comfyui-mcp, Streamable HTTP)
  │
  ▼
127.0.0.1:8188  (ComfyUI itself)
```

**Why two hostnames?** The Worker intercepts requests on the first hostname and proxies them to the tunnel on the second. This gives you two independent layers of auth: OAuth at the Worker (ChatGPT must present a valid access token), and a shared secret at the origin (the Worker must present the correct bearer). An unauthenticated request fails at *both* layers. If someone discovers the tunnel hostname directly, they still cannot call the MCP server without the shared secret.

### Write the Worker

Create a Worker project:

```powershell
mkdir C:\mcp\comfyui-mcp-worker
cd C:\mcp\comfyui-mcp-worker
npm init -y
npm install @cloudflare/workers-oauth-provider@0.10.3
```

Create `wrangler.jsonc`:

```jsonc
{
  "name": "comfyui-mcp-oauth",
  "main": "src/index.js",
  "compatibility_date": "2026-08-01",
  "compatibility_flags": ["global_fetch_strictly_public"],
  "workers_dev": false,
  "kv_namespaces": [
    { "binding": "OAUTH_KV", "id": "<your-kv-namespace-id>" }
  ],
  "routes": [
    { "pattern": "comfyui-mcp.example.com/*", "zone_name": "example.com" }
  ],
  "vars": {
    "ORIGIN_URL": "https://comfyui-origin.example.com/mcp"
  }
  // Secrets (set via `wrangler secret put`, never committed):
  //   ORIGIN_TOKEN         — the shared secret from secrets/http-token.txt
  //   APPROVAL_PASSPHRASE  — what you type on the /authorize approval page
}
```

Create `src/index.js`. The Worker has four endpoints:

- `GET /authorize` + `POST /authorize` — approval page gated by a passphrase you choose.
- `POST /token` — token exchange.
- `POST /register` — RFC 7591 dynamic client registration.
- `ALL /mcp` — authenticated MCP proxy (the `OAuthProvider` gates this automatically).

```js
import OAuthProvider from '@cloudflare/workers-oauth-provider';

const RESOURCE = 'https://comfyui-mcp.example.com/mcp';

// Timing-safe string compare
function safeEqual(a, b) {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Reached only with a valid access token — OAuthProvider gates it.
// Forwards the MCP request to the tunnel origin, swapping the caller's
// OAuth bearer for the origin's shared secret.
const mcpProxy = {
  async fetch(request, env) {
    const inUrl = new URL(request.url);
    const target = new URL(env.ORIGIN_URL);
    target.search = inUrl.search;

    const headers = new Headers();
    for (const h of ['content-type', 'accept', 'mcp-session-id',
                      'mcp-protocol-version', 'last-event-id']) {
      const v = request.headers.get(h);
      if (v) headers.set(h, v);
    }
    headers.set('authorization', `Bearer ${env.ORIGIN_TOKEN}`);

    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    let upstream;
    try {
      upstream = await fetch(target.toString(), {
        method: request.method,
        headers,
        body: hasBody ? await request.arrayBuffer() : undefined,
      });
    } catch (e) {
      return Response.json({
        jsonrpc: '2.0', id: null,
        error: { code: -32001, message: `MCP origin unreachable: ${e.message}` },
      }, { status: 502 });
    }

    const out = new Headers();
    for (const h of ['content-type', 'mcp-session-id', 'cache-control']) {
      const v = upstream.headers.get(h);
      if (v) out.set(h, v);
    }
    return new Response(upstream.body, { status: upstream.status, headers: out });
  },
};

const defaultHandler = {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/authorize') {
      const authReq = await env.OAUTH_PROVIDER.parseAuthRequest(request);
      const client = await env.OAUTH_PROVIDER.lookupClient(authReq.clientId);

      if (request.method === 'GET') {
        return new Response(approvalPage({ client, authReq, error: null }), {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
      if (request.method === 'POST') {
        const form = await request.formData();
        if (!safeEqual(form.get('passphrase') ?? '', env.APPROVAL_PASSPHRASE)) {
          return new Response(approvalPage({ client, authReq, error: 'Wrong passphrase.' }), {
            status: 401, headers: { 'content-type': 'text/html; charset=utf-8' },
          });
        }
        const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
          request: authReq,
          userId: 'owner',
          metadata: { approvedAt: new Date().toISOString() },
          scope: authReq.scope.length ? authReq.scope : ['comfyui'],
          props: { user: 'owner' },
        });
        return Response.redirect(redirectTo, 302);
      }
      return new Response('Method Not Allowed', { status: 405 });
    }

    return new Response('Not Found', { status: 404 });
  },
};

function approvalPage({ client, authReq, error }) {
  const name = esc(client?.clientName || client?.clientId || 'an unidentified client');
  const scopes = authReq.scope.length ? authReq.scope.join(', ') : 'comfyui';
  return `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize ComfyUI MCP</title>
<style>:root{color-scheme:light dark}body{font:15px/1.6 system-ui;max-width:30rem;margin:12vh auto;padding:0 1.25rem}
input{width:100%;padding:.55rem .7rem;font:inherit;box-sizing:border-box}
button{margin-top:.9rem;padding:.55rem 1.1rem;font:inherit;cursor:pointer}
.err{color:#c0392b;font-weight:600}</style>
<h1>Authorize ComfyUI MCP</h1>
<p><strong>${name}</strong> is asking to control your ComfyUI instance.</p>
<p>Scope: <code>${esc(scopes)}</code></p>
${error ? `<p class="err">${esc(error)}</p>` : ''}
<form method="POST">
  <label>Passphrase<br><input type="password" name="passphrase" autofocus></label>
  <button type="submit">Approve</button>
</form>`;
}

export default new OAuthProvider({
  apiRoute: '/mcp',
  apiHandler: mcpProxy,
  defaultHandler,
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: '/register',
  clientIdMetadataDocumentEnabled: true,
  scopesSupported: ['comfyui'],
  resourceMetadata: {
    resource: RESOURCE,
    scopes_supported: ['comfyui'],
  },
});
```

### Deploy the Worker and set secrets

Create the KV namespace:

```powershell
wrangler kv namespace create COMFYUI_MCP_OAUTH
# Copy the returned ID into wrangler.jsonc
```

Set secrets (never committed):

```powershell
# The shared secret from secrets/http-token.txt
wrangler secret put ORIGIN_TOKEN

# A passphrase you will type on the /authorize approval page
wrangler secret put APPROVAL_PASSPHRASE
```

Deploy:

```powershell
wrangler deploy
```

The `compatibility_flags: ["global_fetch_strictly_public"]` flag is required because `OAuthProvider`'s client-ID metadata document feature fetches a URL `client_id` from the public internet — without this flag, the subrequest loops back inside the zone.

## 4. Expose it on a public HTTPS URL

You need a Cloudflare Tunnel for the **origin** hostname (the second hostname in the topology above). The Worker route on the first hostname is handled by the Worker deployment.

1. Create a named tunnel in the Cloudflare Zero Trust dashboard.
2. Add a public hostname rule: `comfyui-origin.example.com` → `http://127.0.0.1:9100`.
3. Save the tunnel token to a file:

```powershell
mkdir "%USERPROFILE%\.cloudflared"
Set-Content -Path "%USERPROFILE%\.cloudflared\comfyui-mcp.token" -Value "<your-tunnel-token>"
```

Run the tunnel:

```powershell
cloudflared tunnel run --token-file "%USERPROFILE%\.cloudflared\comfyui-mcp.token"
```

### Autostart (optional)

A supervisor script keeps both the MCP server and the tunnel alive. It polls every 5 seconds, restarting whichever component died. It uses a named global mutex to prevent duplicate instances. ComfyUI itself is **deliberately not supervised** — it loads ~20 GiB of models onto a GPU, so starting it should be a conscious decision.

See [`templates/supervisor/`](../../templates/supervisor/) for the pattern. Register a Windows Scheduled Task triggered at logon, using a VBS wrapper to hide the console window.

## 5. Add it in ChatGPT

1. Go to **ChatGPT → Settings → Connected apps**.
2. Add a new MCP connector with URL: `https://comfyui-mcp.example.com/mcp`
3. ChatGPT will discover the OAuth endpoints, redirect you to the Worker's `/authorize` page, and ask for the **passphrase**.
4. Enter the passphrase you set with `wrangler secret put APPROVAL_PASSPHRASE`.
5. After authorization, ChatGPT should list the ComfyUI tools.

## 6. Verify the whole chain

```bash
# 1. Local MCP — should return 401 (shared secret enforced)
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:9100/mcp

# 2. Public MCP — should return 401 (OAuth enforced)
curl -s -o /dev/null -w "%{http_code}\n" https://comfyui-mcp.example.com/mcp

# 3. Tunnel origin directly — should also return 401 (shared secret enforced)
curl -s -o /dev/null -w "%{http_code}\n" https://comfyui-origin.example.com/mcp

# 4. Layered check
node scripts/doctor.mjs --url https://comfyui-mcp.example.com
```

A `401` at steps 1–3 is **correct** — it means auth is enforced at every layer. A `502` at step 2 means the tunnel or the local MCP server is down.

Then in ChatGPT, try: *"List available ComfyUI checkpoints."* or *"Show the current queue status."*

## Common errors

### `401` from the public endpoint even after OAuth

**Symptom:** ChatGPT completes the OAuth flow successfully, but tool calls return 401.

**Cause:** The Worker's `ORIGIN_TOKEN` secret does not match the local `COMFYUI_MCP_HTTP_TOKEN`. The Worker authenticated the caller (OAuth passed) but the origin rejected the forwarded request (shared secret wrong).

**Fix:** Verify the values match. Re-set the Worker secret with `wrangler secret put ORIGIN_TOKEN` using the exact contents of `secrets/http-token.txt`.

### `502` from the public endpoint

**Symptom:** OAuth works, but every tool call returns `{"error":{"code":-32001,"message":"MCP origin unreachable: ..."}}`.

**Cause:** The tunnel is down, or the local MCP server is not running.

**Fix:** Check that `cloudflared` is running and the MCP server is listening on :9100. The supervisor log will show which component died.

### ComfyUI is unresponsive for minutes after launch

**Symptom:** The MCP server is up but all tool calls time out or return errors from ComfyUI.

**Cause:** ComfyUI-Manager fetches `api.comfy.org` on startup and blocks the aiohttp event loop while it does. Measured 4m48s on a slow international route.

**Fix:** Wait for the log line `[ComfyUI-Manager] All startup tasks have been completed.` before trusting tool calls. This is why `COMFYUI_URL` is set explicitly — the built-in port probe fails during this window and silently falls back to a guess.

### `global_fetch_strictly_public` compatibility flag missing

**Symptom:** Worker deployment succeeds but ChatGPT OAuth flow hangs during client registration.

**Cause:** Without this flag, `OAuthProvider`'s client-ID metadata document fetch loops back inside the zone instead of reaching the public internet.

**Fix:** Add `"compatibility_flags": ["global_fetch_strictly_public"]` to `wrangler.jsonc`.

## Security notes

- **Two layers of auth.** OAuth at the Worker edge, shared secret at the origin. Unauthenticated requests fail at both.
- The MCP server binds to `127.0.0.1` only. It is not directly reachable from the network.
- Worker secrets (`ORIGIN_TOKEN`, `APPROVAL_PASSPHRASE`) are set with `wrangler secret put`, never committed to source control.
- The local shared secret is read from a file (`secrets/http-token.txt`), not hardcoded in the supervisor script.
- OAuth state lives in Workers KV. Token lifetimes are controlled by `@cloudflare/workers-oauth-provider` defaults.
- **Blast radius is large.** `comfyui-mcp` exposes the full upstream tool surface: execute arbitrary ComfyUI workflows (any node graph, including custom nodes), generate images/video/audio, read and write files in ComfyUI's input/output directories, download and install models AND custom nodes, access queue and history. Custom nodes execute arbitrary Python inside ComfyUI's process, so installing a custom node is effectively code execution. Anyone with a valid OAuth token has full control of the ComfyUI instance.
- See [`docs/security.md`](../../docs/security.md) for the repo-wide security model.

## Known limitations

- **ComfyUI is not auto-started.** The supervisor deliberately does not start ComfyUI — it loads ~20 GiB of model weights onto an 8 GB GPU, which should be a conscious decision. Tool calls will fail with ComfyUI-specific errors until you start it manually.
- **GPU memory.** An 8 GB GPU can run ComfyUI but only with careful model selection. Large checkpoints may OOM.
- **Startup delay.** ComfyUI-Manager's startup fetch blocks the event loop for several minutes on slow connections. All tools are effectively unavailable during this window.
- **Two hostnames required.** Unlike the local-gateway pattern, this approach needs a Worker route hostname and a separate tunnel hostname. Both must be in the same Cloudflare zone (or the Worker must be able to reach the tunnel hostname).

## Attribution

| Component | Source | License |
|---|---|---|
| ComfyUI MCP server | [artokun/comfyui-mcp](https://github.com/artokun/comfyui-mcp) | MIT |
| OAuth provider library | [@cloudflare/workers-oauth-provider](https://github.com/cloudflare/workers-oauth-provider) | MIT |
| Worker source, supervisor, this recipe | This repo (`chatgpt-mcp-connect`) | MIT |

The upstream project does not endorse or ship this integration.
