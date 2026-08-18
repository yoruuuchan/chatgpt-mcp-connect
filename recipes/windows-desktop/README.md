# Windows Desktop (Windows-MCP) → ChatGPT

> Give ChatGPT the ability to see your Windows screen, click, type, and operate GUI applications — with the most dangerous tools (shell, filesystem, process, registry) excluded at the config level.

| | |
|---|---|
| **Upstream** | [CursorTouch/Windows-MCP](https://github.com/CursorTouch/Windows-MCP) · MIT · tested at `v0.8.5` |
| **Transport** | Native Streamable HTTP (`python -m windows_mcp serve --transport streamable-http`) — no bridge needed |
| **Auth** | [Local OAuth gateway](../../templates/oauth-gateway/) |
| **Exposure** | Cloudflare Tunnel, token mode |
| **Status** | Verified 2026-08-18 — ports 8766 + 8767 listening, `/healthz` ok, public `/mcp` returns 401 without token |

## What this is

This recipe connects ChatGPT to your Windows desktop via [Windows-MCP](https://github.com/CursorTouch/Windows-MCP), a lightweight MCP server that exposes Windows GUI automation through UIAutomation, screen capture, and input simulation. An OAuth gateway authenticates ChatGPT, and a Cloudflare Tunnel provides the public HTTPS endpoint.

**Critical design choice: tool exclusion.** This deployment deliberately excludes four tools — **PowerShell, FileSystem, Process, Registry** — from the HTTP endpoint via `config.toml`. What remains reachable from ChatGPT: App, Click, Clipboard, Move, MultiEdit, MultiSelect, Notification, Scrape, Screenshot, Scroll, Shortcut, Snapshot, Type, Wait. Even with these exclusions, this is a high-privilege integration — it can see the entire screen and operate any GUI app the logged-in user can — but removing the four high-risk tools eliminates the "one tool call = arbitrary code execution" path.

**What is ours vs. upstream:**
- **Upstream** — the Windows-MCP server itself. Installed via `uv`; you do not fork it.
- **This recipe** — the integration knowledge and the security-scoped configuration.
- **Our components** — the OAuth gateway (`templates/oauth-gateway/`) and the supervisor script pattern (`templates/supervisor/`). MIT-licensed, in this repo.

## Tested environment

- Windows 11
- Python 3.13 (via `uv`)
- Node 22+
- cloudflared
- Interactive desktop session (UIAutomation requires it)

## Prerequisites

1. **Windows 11** with an interactive desktop session (remote desktop works; a background service does not — UIAutomation needs a desktop).
2. **uv** installed ([docs](https://docs.astral.sh/uv/getting-started/installation/)).
3. **Node 22+** for the OAuth gateway.
4. **cloudflared** installed ([download](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)).
5. A **Cloudflare account** with a domain you control, and a named tunnel configured in the Zero Trust dashboard with an ingress rule pointing your chosen hostname at `http://127.0.0.1:8767`.
6. A **Cloudflare Tunnel token** for that tunnel, saved to a local file.

## 1. Get the MCP server running locally

Install Windows-MCP:

```powershell
uv tool install windows-mcp
```

Create a config file to exclude high-risk tools and set the transport. Save as `%USERPROFILE%\.windows-mcp\config.toml`:

```toml
[tools]
exclude = ["PowerShell", "FileSystem", "Process", "Registry"]

[server]
transport = "streamable-http"
host = "127.0.0.1"
port = 8766
auth_key = "<generate-a-random-key>"
```

Generate the `auth_key`:

```bash
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

Start the server:

```powershell
python -m windows_mcp serve --transport streamable-http --host 127.0.0.1 --port 8766
```

Verify:

```powershell
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8766/mcp
```

### Why exclude tools?

| Excluded tool | What it can do | Risk |
|---|---|---|
| **PowerShell** | Execute arbitrary PowerShell commands | Full code execution as the logged-in user |
| **FileSystem** | Read, write, delete any file the user can access | Data exfiltration, data destruction |
| **Process** | List, start, kill processes | Privilege escalation, denial of service |
| **Registry** | Read and write Windows Registry | System configuration tampering |

The remaining tools (App, Click, Clipboard, Move, MultiEdit, MultiSelect, Notification, Scrape, Screenshot, Scroll, Shortcut, Snapshot, Type, Wait) still let ChatGPT see and interact with the entire GUI. That is the intended use case, but understand the surface: a capable enough sequence of GUI clicks can do almost anything the user can. The exclusions remove the *direct* path to code execution.

## 3. Put OAuth in front of it

The gateway lives at [`templates/oauth-gateway/`](../../templates/oauth-gateway/). Copy and configure it:

```powershell
mkdir %USERPROFILE%\.windows-mcp\gateway
cp ../../templates/oauth-gateway/* %USERPROFILE%\.windows-mcp\gateway\
cd %USERPROFILE%\.windows-mcp\gateway
npm install
```

Configure the gateway with environment variables or a `.env` file:

| Variable | Value |
|---|---|
| `UPSTREAM_URL` | `http://127.0.0.1:8766/mcp` |
| `UPSTREAM_BEARER` | The `auth_key` from your `config.toml` |
| `GATEWAY_PORT` | `8767` |
| `OAUTH_SCOPE` | `windows-gui` |
| `OWNER_TOKEN` | A new token you generate — this is what you will paste into ChatGPT's consent screen |

Generate the owner token:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Start the gateway:

```powershell
node windows-mcp-gateway.mjs
```

Verify:

```powershell
# Should return 200
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8767/healthz

# Full health check
curl -s http://127.0.0.1:8767/healthz
# -> {"ok":true,"gateway":true,"upstream":true}
```

The gateway serves:
- `/.well-known/oauth-authorization-server` — OAuth discovery
- `/.well-known/oauth-protected-resource/mcp` — resource metadata
- `POST /register` — RFC 7591 Dynamic Client Registration
- `GET` + `POST /authorize` — consent form with PKCE S256
- `POST /token` — token exchange; access tokens valid 1 hour, refresh tokens 30 days
- `ALL /mcp` — bearer-gated reverse proxy to the upstream
- `GET /healthz` — health check

Allowed redirect hosts: `chatgpt.com`, `localhost`, `127.0.0.1`.

## 4. Expose it on a public HTTPS URL

Use a Cloudflare Tunnel in token mode. In the Cloudflare Zero Trust dashboard:

1. Create a named tunnel (e.g. `windows-mcp`).
2. Add a public hostname rule: `windows-mcp.example.com` → `http://127.0.0.1:8767`.
3. Copy the tunnel token and save it to a file:

```powershell
Set-Content -Path "%USERPROFILE%\.cloudflared\windows-mcp.token" -Value "<your-tunnel-token>"
```

Run the tunnel:

```powershell
cloudflared tunnel run --token-file "%USERPROFILE%\.cloudflared\windows-mcp.token"
```

Verify the public endpoint:

```bash
# OAuth discovery — should return 200
curl -s -o /dev/null -w "%{http_code}\n" https://windows-mcp.example.com/.well-known/oauth-authorization-server

# Protected resource metadata — should return 200
curl -s -o /dev/null -w "%{http_code}\n" https://windows-mcp.example.com/.well-known/oauth-protected-resource/mcp

# MCP endpoint with no token — should return 401 (this is CORRECT — it means auth is enforced)
curl -s -o /dev/null -w "%{http_code}\n" https://windows-mcp.example.com/mcp
```

## 5. Add it in ChatGPT

1. Go to **ChatGPT → Settings → Connected apps** (or the MCP connector flow).
2. Add a new MCP connector with URL: `https://windows-mcp.example.com/mcp`
3. ChatGPT will discover the OAuth endpoints automatically, redirect you to the consent form, and ask for the **owner token**.
4. Paste the owner token you generated in step 3.
5. After authorization, ChatGPT should list the available tools (the 14 non-excluded tools).

## 6. Verify the whole chain

```bash
# Local health
curl -s http://127.0.0.1:8767/healthz
# -> {"ok":true,"gateway":true,"upstream":true}

# Public health
curl -s https://windows-mcp.example.com/healthz
# -> {"ok":true,"gateway":true,"upstream":true}

# Layered connectivity check
node scripts/doctor.mjs --url https://windows-mcp.example.com
```

Then in ChatGPT, try: *"Take a screenshot of my desktop."* It should return a screen capture.

### Autostart (optional)

To keep the upstream, gateway, and tunnel alive across reboots, use a Windows Scheduled Task running a [supervisor script](../../templates/supervisor/). The supervisor polls every 5 seconds, restarting any component that dies. It uses a named global mutex (`Global\WindowsMCPChatGPTGatewaySupervisor`) to prevent duplicate instances.

To run the supervisor with no visible console window, use a VBS wrapper:

```vbs
Set shell = CreateObject("WScript.Shell")
shell.Run "powershell -ExecutionPolicy Bypass -File ""C:\mcp\start-chatgpt-gateway.ps1""", 0, False
```

Register the VBS as a Scheduled Task triggered at logon.

## Common errors

### Auth failures return HTTP 500 instead of 401/400

**Symptom:** Invalid or expired tokens produce `{"error":"server_error"}` with status 500.

**Cause A:** Two copies of the MCP SDK are loaded. `createRequire().resolve()` picks the SDK's CJS build (`dist/cjs`), while the ESM OAuth provider imports the ESM build (`dist/esm`). `error instanceof InvalidTokenError` compares objects from different module instances and always fails, falling through to a generic `ServerError`.

**Fix A:** Rewrite the resolved SDK path from `dist/cjs` to `dist/esm` before importing, so both the gateway and the auth middleware share one module instance. See the gateway template for the exact fix.

**Cause B:** `app.set('trust proxy', true)` triggers `ERR_ERL_PERMISSIVE_TRUST_PROXY` in express-rate-limit (used internally by `mcpAuthRouter`).

**Fix B:** Set trust proxy to `'loopback'` instead of `true`. The only proxy hop is cloudflared on localhost.

### ChatGPT refuses the connector or tools do not appear

**Symptom:** ChatGPT shows an error when connecting, or connects but shows zero tools.

**Cause:** Too many tools exposed. If you removed the `exclude` list from `config.toml`, all tools (including PowerShell, FileSystem, etc.) are exposed, which may exceed ChatGPT's tolerance.

**Fix:** Ensure `config.toml` has the `[tools] exclude` list. The 14 non-excluded tools are well within ChatGPT's limit.

### Tunnel is green but /mcp returns 502

**Symptom:** The Cloudflare Tunnel shows healthy in the dashboard, but requests to `/mcp` return 502.

**Cause:** The upstream Windows-MCP server process died. The gateway is running but has nothing behind it.

**Fix:** Check `/healthz` — it distinguishes `"upstream":false` from `"gateway":false`. Restart the upstream server. If using the supervisor, check `logs/server.stderr.log`.

### Screenshot returns black or fails

**Symptom:** The Screenshot tool returns a black image or errors out.

**Cause:** Windows-MCP uses `dxcam` for screen capture, which requires an active desktop session. A service account or a disconnected RDP session may not have a desktop.

**Fix:** Ensure you are logged in to an interactive desktop session. If using RDP, do not disconnect — minimize instead, or use a tool like `tscon` to keep the session active.

## Security notes

- **Tool exclusion is not a security boundary.** The `config.toml` `exclude` list removes tools from the HTTP endpoint, but it is a configuration choice, not a sandbox. A motivated attacker with a valid access token could potentially chain GUI interactions (Type + Click + Shortcut) to open a terminal and execute commands. The exclusions raise the bar significantly but do not eliminate all risk.
- The upstream server binds to `127.0.0.1` only. It is not directly reachable from the network.
- The OAuth gateway binds to `127.0.0.1` only. The Cloudflare Tunnel is the sole public ingress.
- Access tokens expire in 1 hour; refresh tokens in 30 days.
- The owner token (used during the ChatGPT consent flow) is a secret — store it like a password.
- The `auth_key` in `config.toml` is a shared secret between the gateway and the upstream server, never exposed to the public. **Do not commit `config.toml` with a real `auth_key` to version control.**
- Anyone with a valid access token can see your screen and click anything. Use this integration only on machines where that level of access is acceptable.
- See [`docs/security.md`](../../docs/security.md) for the repo-wide security model.

## Known limitations

- Requires an interactive desktop session. Background services and disconnected RDP sessions do not work.
- Screen capture resolution and performance depend on the GPU and `dxcam` support.
- The excluded tools (PowerShell, FileSystem, Process, Registry) are genuinely useful — excluding them is a security trade-off. If you need shell access from ChatGPT, consider the risk carefully before removing entries from the exclude list.

## Attribution

| Component | Source | License |
|---|---|---|
| Windows-MCP | [CursorTouch/Windows-MCP](https://github.com/CursorTouch/Windows-MCP) | MIT — Copyright (c) 2025 Jeomon George |
| MCP TypeScript SDK (`@modelcontextprotocol/sdk`) | [modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk) | Apache-2.0 / MIT / CC-BY-4.0 — Copyright Model Context Protocol, a Series of LF Projects, LLC |
| SingleUserOAuthProvider (`@waishnav/devspace`) | [Waishnav/devspace](https://github.com/Waishnav/devspace) | MIT — Copyright (c) 2026 Waishnav |
| OAuth gateway, supervisor, this recipe | This repo (`chatgpt-mcp-connect`) | MIT |

The upstream project does not endorse or ship this integration.
