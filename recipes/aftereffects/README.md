# After Effects MCP → ChatGPT

> Let ChatGPT control After Effects — query compositions, inspect layers, render frames, and manipulate projects via natural language.

| | |
|---|---|
| **Upstream** | [kumoproductions/mcp-aftereffects](https://github.com/kumoproductions/mcp-aftereffects) · v0.2.0 |
| **Transport** | FileIpcTransport (file-based IPC to AE) + stdio (MCP protocol) — requires a custom Streamable HTTP bridge |
| **Auth** | Built-in OAuth 2.1 in the bridge (single-user, PKCE + DCR) |
| **Exposure** | Cloudflare Quick Tunnel + Worker reverse proxy + SSH reverse tunnel |
| **Status** | 2026-09-17 — Bridge, OAuth, and public endpoint verified. 11 AE tools discoverable via ChatGPT. End-to-end tool call pending (requires AE running with "Allow Scripts to Write Files and Access Network" enabled). |

## What this is

This recipe documents how to expose a **local** Kumo After Effects MCP server to ChatGPT over the public internet. The upstream MCP server uses a unique two-layer transport:

```
ChatGPT
  ↓ OAuth 2.1
https://ae-mcp.yoru-and-akari.dev/mcp
  ↓ Cloudflare Worker (reverse proxy)
Quick Tunnel URL (xxx-xxx-xxx.trycloudflare.com)
  ↓ cloudflared (Aliyun cloud server)
SSH reverse tunnel (port 3399)
  ↓
Local bridge (:3399)
  ↓ stdio (JSON-RPC)
Kumo MCP server
  ↓ FileIpcTransport (file-based IPC)
AfterFX.exe
```

The **Kumo MCP server** uses `FileIpcTransport` to communicate with After Effects via file-based IPC (not TCP or stdio). It also uses stdio for the MCP protocol itself. This means you can't use `mcp-proxy` directly — you need a custom bridge that handles both the stdio MCP protocol and spawns the Kumo server as a child process.

**Available tools (11):** `ae_project_info`, `ae_comp_info`, `ae_layer_info`, `ae_render_frame`, `ae_save_project`, `ae_project_export_json`, `ae_project_import_json`, `ae_version_info`, `ae_catalog`, `ae_do`, `ae_context`.

## Tested environment

- Windows 11
- Adobe After Effects 2025
- Node.js >= 24 (for the bridge)
- `cloudflared` installed (on Aliyun cloud server, not local machine)
- SSH access to a cloud server with public IP (for reverse tunnel)
- Cloudflare account with a domain (for Worker and quick tunnel)

## Prerequisites

1. After Effects 2025 installed.
2. Node.js >= 24 on PATH (install via [fnm](https://github.com/Schniz/fnm) or [nvm](https://github.com/corenvm/nvm)).
3. `cloudflared` installed on a cloud server (not the local machine, see §4).
4. SSH access to a cloud server with a public IP.
5. A Cloudflare account with a domain you control.

## 1. Get the MCP server running locally

### Clone and build Kumo AE MCP

```bash
cd /path/to/MCP
git clone https://github.com/kumoproductions/mcp-aftereffects.git kumo-src
cd kumo-src
npm install
npx tsc
```

This produces `dist/index.js`, the entry point for the Kumo MCP server.

### Configure AE scripting preferences

In After Effects:

1. **Edit → Preferences → Scripting & Expressions** (or **After Effects → Preferences → Scripting & Expressions** on macOS).
2. Enable **"Allow Scripts to Write Files and Access Network"**.

Without this, the FileIpcTransport cannot communicate with AE.

### Verify Kumo MCP locally

```bash
# Set the AE executable path
export AE_MCP_EXE="D:/Adobe/Adobe After Effects 2025/Support Files/AfterFX.exe"

# Start Kumo MCP server (stdio)
node dist/index.js
```

The server starts and waits for JSON-RPC on stdin. Send an `initialize` request to verify:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}
```

Expected: a JSON-RPC response on stdout. Press `Ctrl+C` to exit.

## 2. Build the custom Streamable HTTP bridge

The Kumo MCP server uses `FileIpcTransport` (not standard stdio MCP), so you can't use `mcp-proxy`. Instead, write a minimal bridge that:

1. Spawns the Kumo server as a child process.
2. Forwards JSON-RPC from HTTP POST to the child's stdin.
3. Parses JSON-RPC responses from the child's stdout.
4. Handles session management and OAuth 2.1.

### Bridge implementation

Create `server/server.js` (~400 lines). Key components:

- **Express server** on port 3399 (configurable via `BRIDGE_PORT`).
- **OAuth 2.1 endpoints**: `/oauth/register` (DCR), `/oauth/authorize`, `/oauth/token`.
- **MCP endpoint**: `/mcp` (POST for JSON-RPC, GET for SSE, DELETE for session cleanup).
- **Session management**: spawn one Kumo child per session, 30-minute TTL cleanup.
- **OAuth metadata**: `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`.

**Config via environment variables:**

```bash
export BRIDGE_PORT=3399
export BRIDGE_HOST=127.0.0.1
export PUBLIC_URL=https://ae-mcp.yoru-and-akari.dev  # must be public URL
export AE_MCP_EXE="D:/Adobe/Adobe After Effects 2025/Support Files/AfterFX.exe"
export OAUTH_USER=yoru
export OAUTH_PASS=akari2026
```

**Critical**: `PUBLIC_URL` must be the public-facing URL (not `localhost:3399`), otherwise OAuth metadata returns wrong URLs and ChatGPT fails to complete the flow.

### Start the bridge

```bash
cd /path/to/MCP/aftereffects-mcp-bridge/server
npm install express@5.1.0
node server.js
```

### Verify

```bash
curl http://127.0.0.1:3399/health
# Expected: {"status":"ok","sessions":0,"clients":0,"uptime":...}
```

## 3. Put OAuth 2.1 in front of it

The bridge has built-in OAuth 2.1 (no separate gateway needed). It supports:

- **Dynamic Client Registration (DCR)**: `POST /oauth/register`
- **Authorization endpoint**: `GET/POST /oauth/authorize`
- **Token endpoint**: `POST /oauth/token` (supports `authorization_code` and `refresh_token` grants)
- **PKCE**: S256 and plain challenge methods
- **Single-user mode**: hardcoded username/password in `OAUTH_USER` and `OAUTH_PASS` env vars.

### OAuth metadata discovery

ChatGPT discovers OAuth via:

```
GET /.well-known/oauth-protected-resource
GET /.well-known/oauth-authorization-server
```

Both must return `Cache-Control: no-store` header. The bridge handles this automatically.

### WWW-Authenticate header

The `/mcp` endpoint returns `401 Unauthorized` with:

```
WWW-Authenticate: Bearer resource_metadata="https://ae-mcp.yoru-and-akari.dev/.well-known/oauth-protected-resource"
```

ChatGPT uses this header to trigger the OAuth flow. Without it, ChatGPT won't proceed to authorization.

### Verify OAuth flow

```bash
# Check OAuth metadata
curl -I https://ae-mcp.yoru-and-akari.dev/.well-known/oauth-protected-resource
# Expected: Cache-Control: no-store

# Check that /mcp requires auth
curl -s -o /dev/null -w "%{http_code}" https://ae-mcp.yoru-and-akari.dev/mcp
# Expected: 401
```

## 4. Expose it on a public HTTPS URL

This recipe uses a **non-standard exposure pattern** due to network constraints:

### Why not a standard Cloudflare Tunnel?

The local machine runs xray in TUN mode, which hijacks system DNS. `cloudflared` is a Go binary — Go's DNS resolver **does not read the Windows hosts file** and cannot resolve `argotunnel.com`. The tunnel fails at precheck with `lookup argotunnel.com: no such host`.

**Solution**: run `cloudflared` on a cloud server (Aliyun) where DNS works normally, then use SSH reverse tunnel to forward traffic back to the local machine.

### Architecture

```
ChatGPT → CF Worker (ae-mcp.yoru-and-akari.dev)
  ↓ reverse proxy
Quick Tunnel URL (xxx-xxx-xxx.trycloudflare.com)
  ↓
cloudflared (Aliyun cloud server, PID 2861255)
  ↓
SSH reverse tunnel (port 3399)
  ↓
Local bridge (:3399)
```

### Step 1: SSH reverse tunnel

From the local machine:

```bash
ssh -R 3399:127.0.0.1:3399 -N -o ServerAliveInterval=60 admin@8.148.5.250
```

This maps the local bridge's port 3399 to the cloud server's `127.0.0.1:3399`.

### Step 2: cloudflared quick tunnel on cloud server

On the Aliyun server:

```bash
cloudflared --no-autoupdate tunnel --protocol http2 --url http://localhost:3399
```

This creates a quick tunnel and outputs a URL like `https://climate-ends-bristol-pale.trycloudflare.com`.

**Note**: quick tunnel URLs change when cloudflared restarts. You must manually update the Worker.

### Step 3: Cloudflare Worker reverse proxy

Create a Cloudflare Worker (`ae-mcp-proxy`) that reverse-proxies to the quick tunnel URL:

```javascript
addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  const url = new URL(request.url);
  url.hostname = 'climate-ends-bristol-pale.trycloudflare.com';  // quick tunnel URL
  url.protocol = 'https:';
  
  const newRequest = new Request(url.toString(), {
    method: request.method,
    headers: request.headers,
    body: request.body,
  });
  
  return fetch(newRequest);
}
```

Bind the Worker to a route: `ae-mcp.yoru-and-akari.dev/*`.

### Why not a named tunnel?

Named tunnels (`cloudflared tunnel run --token <token>`) returned 1016/530 errors even though the tunnel was healthy (4 connections, SSH working, localhost reachable). Requests never reached cloudflared (no request logs). Root cause unclear (possibly API token permissions or CF edge routing). Quick tunnel + Worker is a reliable fallback.

### Verify

```bash
curl -s -o /dev/null -w "%{http_code}" https://ae-mcp.yoru-and-akari.dev/mcp
# Expected: 401 (correct — requires OAuth)
```

## 5. Add it in ChatGPT

1. Go to [ChatGPT → Settings → Connected apps](https://chatgpt.com/settings).
2. Click **Add** → enter your public MCP URL: `https://ae-mcp.yoru-and-akari.dev/mcp`.
3. ChatGPT will redirect you through the OAuth flow. Enter your credentials (`yoru` / `akari2026`).
4. Approve the scope.

## 6. Verify the whole chain

1. In After Effects, ensure it's running and "Allow Scripts to Write Files and Access Network" is enabled.
2. In ChatGPT, send: _"Use the AE tools to get the current project info."_
3. ChatGPT should call `ae_project_info` and return project details.

If the bridge is not running, ChatGPT will get a `502` or `504`. The `/health` endpoint reports bridge status.

## Common errors

| Symptom | Cause | Fix |
|---|---|---|
| `cloudflared` fails with `lookup argotunnel.com: no such host` | xray TUN mode hijacks DNS, Go resolver doesn't read hosts file | Run cloudflared on a machine without TUN mode (e.g., cloud server) |
| Named tunnel returns 1016/530 | Tunnel healthy but requests don't reach cloudflared | Use quick tunnel + Worker reverse proxy as fallback |
| OAuth metadata returns `localhost:3399` | `PUBLIC_URL` env var not set or set to localhost | Set `PUBLIC_URL=https://ae-mcp.yoru-and-akari.dev` |
| `/mcp` returns `401` but ChatGPT doesn't trigger OAuth | Missing `WWW-Authenticate` header | Ensure bridge returns `WWW-Authenticate: Bearer resource_metadata="..."` |
| ChatGPT caches old OAuth metadata | Metadata endpoint missing `Cache-Control: no-store` | Bridge already adds this header; check Worker proxy doesn't strip it |
| `ae_project_info` returns error | AE not running or scripting preferences not enabled | Open AE, enable "Allow Scripts to Write Files and Access Network" |
| Quick tunnel URL changes | cloudflared restarted | Update Worker's target URL manually |

## Security notes

**This recipe exposes After Effects to the public internet.**

The Kumo MCP server can:

- Query project, composition, and layer information.
- Render frames to PNG.
- Save and export/import projects.
- Execute arbitrary ExtendScript via `ae_do`.

Anyone who completes your OAuth flow gets **script execution inside After Effects**. This is not theoretical — ChatGPT (or any MCP client that authenticates) can run arbitrary ExtendScript through `ae_do`.

**Mitigations:**

1. **Use strong OAuth credentials.** Change `OAUTH_USER` and `OAUTH_PASS` from defaults.
2. **Treat OAuth credentials like a password.** Do not share them. Rotate if compromised.
3. The bridge limits token lifetime (24-hour access tokens) and requires explicit authorization.
4. The Cloudflare Worker and quick tunnel can be paused instantly from the dashboard if you suspect abuse.

See [`docs/security.md`](../../docs/security.md) for the repo-wide threat model.

## Known limitations

- **Quick tunnel URL changes on restart.** You must manually update the Worker's target URL. Consider using a named tunnel if you can resolve the DNS issues.
- **AE must be running with scripting enabled.** If AE is closed or scripting is disabled, tool calls fail.
- **Single-user OAuth only.** The bridge uses hardcoded credentials. Multi-user support requires a real OAuth provider.
- **FileIpcTransport is Windows-only.** The Kumo MCP server uses file-based IPC that only works on Windows.
- **No supervisor pattern yet.** The bridge, SSH tunnel, and cloudflared must be started manually. Consider adding systemd services or a supervisor script.

## Unique patterns in this recipe

This recipe introduces several patterns not covered by other recipes:

1. **Custom stdio→HTTP bridge** — when `mcp-proxy` doesn't work (e.g., FileIpcTransport), write a minimal bridge that spawns the MCP server as a child process and forwards JSON-RPC.
2. **SSH reverse tunnel** — when the local machine is behind NAT and can't run cloudflared, use a cloud server as a jump host.
3. **Quick tunnel + Worker reverse proxy** — when named tunnels fail (1016/530), use a quick tunnel for the actual connection and a Worker for the stable domain.
4. **Built-in OAuth in the bridge** — no separate gateway needed for single-user MCP servers.

These patterns are documented in [`docs/troubleshooting.md`](../../docs/troubleshooting.md).

## Attribution

- **Upstream:** [kumoproductions/mcp-aftereffects](https://github.com/kumoproductions/mcp-aftereffects) by Kumo — v0.2.0. This recipe does not ship or modify the upstream project.
- **Bridge:** Custom 405-line Node.js Express server. Not vendored; see the bridge implementation in §2.
- **This recipe:** Integration knowledge — what to run, in what order, with what config. Part of [chatgpt-mcp-connect](../..//).
- **Our components:** The bridge server and OAuth implementation are specific to this recipe. The patterns (SSH reverse tunnel, quick tunnel + Worker) are documented in [`docs/troubleshooting.md`](../../docs/troubleshooting.md).
