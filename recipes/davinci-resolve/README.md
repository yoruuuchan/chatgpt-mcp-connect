# DaVinci Resolve MCP → ChatGPT

> Give ChatGPT full control of DaVinci Resolve Studio through the Resolve Scripting API — timeline creation, editing, color grading, markers, rendering — over a public HTTPS endpoint with OAuth 2.1.

| | |
|---|---|
| **Upstream** | [samuelgursky/davinci-resolve-mcp](https://github.com/samuelgursky/davinci-resolve-mcp) · MIT · tested at `v2.97.3` |
| **Transport** | Native Streamable HTTP (`--transport streamable-http`) — no bridge needed |
| **Auth** | [Local OAuth gateway](../../templates/oauth-gateway/) |
| **Exposure** | Cloudflare Tunnel, token mode |
| **Status** | Verified 2026-08-18 — see [Verify the whole chain](#6-verify-the-whole-chain) for exactly what was and was not re-run |

## What this is

This recipe connects ChatGPT to a locally-running DaVinci Resolve Studio instance. The upstream MCP server exposes 35 compound tools that cover the full 336-method Resolve Scripting API. An OAuth gateway sits in front of it so ChatGPT can authenticate via its standard Remote MCP flow, and a Cloudflare Tunnel makes the gateway reachable at a public HTTPS URL.

**What is ours vs. upstream:**
- **Upstream** — the MCP server itself (`davinci-resolve-mcp`). You clone it; you do not modify it (unless you hit the known Windows issues below).
- **This recipe** — the integration knowledge: what to run, in what order, with what config.
- **Our components** — the OAuth gateway (`templates/oauth-gateway/`) and the supervisor script pattern (`templates/supervisor/`). MIT-licensed, in this repo.

## Tested environment

- Windows 11
- DaVinci Resolve **Studio** 20.2.0.13 (the free edition cannot do external scripting)
- Python 3.14 in a venv
- Node 22+
- cloudflared

## Prerequisites

1. **DaVinci Resolve Studio** installed and launchable. The free edition's `scriptapp("Resolve")` does not work — you need Studio.
2. **Python 3.12+** (tested on 3.14). Create a venv for the upstream server.
3. **Node 22+** for the OAuth gateway.
4. **cloudflared** installed ([download](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)).
5. A **Cloudflare account** with a domain you control, and a named tunnel configured in the Zero Trust dashboard with an ingress rule pointing your chosen hostname at `http://127.0.0.1:8771`.
6. A **Cloudflare Tunnel token** for that tunnel, saved to a local file.

## 1. Get the MCP server running locally

Clone the upstream repo and install dependencies:

```powershell
git clone https://github.com/samuelgursky/davinci-resolve-mcp.git C:\mcp\davinci-resolve-mcp
cd C:\mcp\davinci-resolve-mcp
python -m venv .venv
.venv\Scripts\pip install "mcp[cli]>=1.29,<2" "pyaaf2>=1.7.0"
```

Generate a bearer token the upstream server will require:

```powershell
python -c "import secrets; print(secrets.token_urlsafe(32))" > upstream-token.txt
```

Set the required environment variables and start the server:

```powershell
$env:RESOLVE_SCRIPT_API = 'C:\ProgramData\Blackmagic Design\DaVinci Resolve\Support\Developer\Scripting'
$env:RESOLVE_SCRIPT_LIB = 'C:\Program Files\Blackmagic Design\DaVinci Resolve\fusionscript.dll'
$env:DAVINCI_MCP_TOKEN   = (Get-Content upstream-token.txt -Raw).Trim()
$env:DAVINCI_MCP_HOST    = '127.0.0.1'
$env:DAVINCI_MCP_PORT    = '8770'
$env:PYTHONIOENCODING    = 'utf-8'

.venv\Scripts\python.exe src\server.py --transport streamable-http
```

Adjust `RESOLVE_SCRIPT_LIB` to match your actual Resolve install path.

Verify:

```powershell
curl -s http://127.0.0.1:8770/mcp -H "Authorization: Bearer $(Get-Content upstream-token.txt -Raw)"
```

You should get a valid MCP response (or a session-initialization prompt). If it hangs or errors, check that Resolve Studio is running with a project open (see [Common errors](#common-errors)).

> **Do NOT use `--full`.** It expands the 35 compound tools into 353 individual tools, which exceeds ChatGPT's tool budget. The default compound-tool mode already covers the entire Scripting API.

## 3. Put OAuth in front of it

The gateway lives at [`templates/oauth-gateway/`](../../templates/oauth-gateway/). Copy and configure it:

```powershell
mkdir C:\mcp\davinci-resolve-mcp-gateway
cp ../../templates/oauth-gateway/* C:\mcp\davinci-resolve-mcp-gateway/
cd C:\mcp\davinci-resolve-mcp-gateway
npm install
```

Create a `.env` or set environment variables for the gateway. It needs to know:

| Variable | Value |
|---|---|
| `UPSTREAM_URL` | `http://127.0.0.1:8770/mcp` |
| `UPSTREAM_BEARER` | Contents of your `upstream-token.txt` |
| `GATEWAY_PORT` | `8771` |
| `OAUTH_SCOPE` | `resolve-control` |
| `OWNER_TOKEN` | A new token you generate — this is what you will paste into ChatGPT's consent screen |

Generate the owner token:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Save it somewhere safe; you will need it when adding the connector in ChatGPT.

Start the gateway:

```powershell
node davinci-mcp-gateway.mjs
```

Verify:

```powershell
# Should return 200
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8771/healthz

# Full health check
curl -s http://127.0.0.1:8771/healthz
# -> {"ok":true,"gateway":true,"upstream":true}
```

The gateway serves the following endpoints:
- `/.well-known/oauth-authorization-server` — OAuth discovery
- `/.well-known/oauth-protected-resource/mcp` — resource metadata (note: the path-suffixed form; the bare `/.well-known/oauth-protected-resource` returns 404)
- `POST /register` — RFC 7591 Dynamic Client Registration
- `GET` + `POST /authorize` — consent form with PKCE S256
- `POST /token` — token exchange; access tokens valid 1 hour, refresh tokens 30 days
- `ALL /mcp` — bearer-gated reverse proxy to the upstream
- `GET /healthz` — health check

Allowed redirect hosts: `chatgpt.com`, `localhost`, `127.0.0.1`.

## 4. Expose it on a public HTTPS URL

Use a Cloudflare Tunnel in token mode. In the Cloudflare Zero Trust dashboard:

1. Create a named tunnel (e.g. `resolve-mcp`).
2. Add a public hostname rule: `resolve-mcp.example.com` → `http://127.0.0.1:8771`.
3. Copy the tunnel token and save it to a file:

```powershell
# Save the token from the dashboard
Set-Content -Path "%USERPROFILE%\.cloudflared\resolve-mcp.token" -Value "<your-tunnel-token>"
```

Run the tunnel:

```powershell
cloudflared tunnel run --token-file "%USERPROFILE%\.cloudflared\resolve-mcp.token"
```

Verify the public endpoint:

```bash
# OAuth discovery — should return 200
curl -s -o /dev/null -w "%{http_code}\n" https://resolve-mcp.example.com/.well-known/oauth-authorization-server

# Protected resource metadata — should return 200
curl -s -o /dev/null -w "%{http_code}\n" https://resolve-mcp.example.com/.well-known/oauth-protected-resource/mcp

# MCP endpoint with no token — should return 401 (this is CORRECT — it means auth is enforced)
curl -s -o /dev/null -w "%{http_code}\n" https://resolve-mcp.example.com/mcp
```

## 5. Add it in ChatGPT

1. Go to **ChatGPT → Settings → Connected apps** (or the MCP connector flow).
2. Add a new MCP connector with URL: `https://resolve-mcp.example.com/mcp`
3. ChatGPT will discover the OAuth endpoints automatically, redirect you to the consent form, and ask for the **owner token**.
4. Paste the owner token you generated in step 3.
5. After authorization, ChatGPT should list the 35 Resolve tools.

## 6. Verify the whole chain

Work outwards. Each step tells you something the previous one couldn't.

```bash
# 1. Local health — is the gateway up, and can it see the MCP server?
curl -s http://127.0.0.1:8771/healthz
# -> {"ok":true,"gateway":true,"upstream":true}

# 2. Public health — does the tunnel reach the gateway?
curl -s https://resolve-mcp.example.com/healthz
# -> {"ok":true,"gateway":true,"upstream":true}

# 3. Every layer at once, including the OAuth discovery documents
node scripts/doctor.mjs --url https://resolve-mcp.example.com \
                        --upstream 127.0.0.1:8770 --gateway 127.0.0.1:8771

# 4. The endpoint must reject an unauthenticated call
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://resolve-mcp.example.com/mcp \
     -H 'content-type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
# -> 401   ← this is a PASS. It reads like a failure the first time and it isn't.
#           A 500 here means one of the two bugs in Common errors below.
```

Then, in ChatGPT, add the connector and ask: *"List all projects in DaVinci Resolve."*

**Nothing above is acceptance.** A green tunnel, a healthy `/healthz`, and a passing doctor run only prove the plumbing. The connector is done when ChatGPT itself completes OAuth and returns real data from a real tool call.

### What was actually verified on 2026-08-18

Being specific, because "verified" gets used loosely:

| Checked | Result |
|---|---|
| Ports 8770 and 8771 listening | pass |
| `/healthz`, local and public | `{"ok":true,"gateway":true,"upstream":true}` |
| Both OAuth discovery documents over the public URL | 200, with DCR and PKCE `S256` advertised |
| Unauthenticated `/mcp` | 401 with `WWW-Authenticate` |
| Full OAuth flow — dynamic client registration, consent page, wrong owner token refused, code exchange, single-use code enforcement, refresh grant | pass |
| MCP `initialize` using a real OAuth access token, then again using a refreshed token | pass |
| Tool round-trip against Resolve — read, marker write, cleanup — via the upstream's own acceptance script | pass |
| Tool calls issued from **inside the ChatGPT UI** | confirmed when this connector was first set up; **not re-run** as part of writing this recipe |

The last row is the honest limit of this document. Everything below the ChatGPT UI was re-tested; the UI itself was not.

### Autostart (optional)

To keep the upstream, gateway, and tunnel alive across reboots, use a Windows Scheduled Task running a [supervisor script](../../templates/supervisor/). The supervisor polls every 5 seconds, restarting any component that dies. It uses a named global mutex (`Global\DaVinciMCPChatGPTGatewaySupervisor`) to prevent duplicate instances.

To run the supervisor with no visible console window, use a VBS wrapper:

```vbs
Set shell = CreateObject("WScript.Shell")
shell.Run "powershell -ExecutionPolicy Bypass -File ""C:\mcp\start-chatgpt-gateway.ps1""", 0, False
```

Register the VBS as a Scheduled Task triggered at logon.

## Common errors

### Reads work but all writes silently fail

**Symptom:** `project_manager` reads succeed, `GetCurrentPage()` returns `None`, timeline creation returns `None`, markers report `NO_CURRENT_TIMELINE`.

**Cause:** Resolve is sitting on the **Project Manager** screen (cold start, no project open). In this state, every read works normally but every write silently fails. Calling `OpenPage()` or `LoadProject()` on the already-current project does **not** fix it.

**Fix:** Use the `project_manager` tool with action `create` or `load` to move Resolve into a project workspace. Once it leaves the Project Manager, it stays in the workspace for the session. ChatGPT can perform this step itself if you tell it.

### Headless mode does not work

**Symptom:** `scriptapp("Resolve")` returns `None` when Resolve is launched with `-nogui`.

**Cause:** Resolve's scripting server does not start in headless mode. The GUI must be running in an interactive desktop session.

**Fix:** Run Resolve normally (with its GUI). Remote desktop or a persistent login session works.

### Auth failures return HTTP 500 instead of 401/400

**Symptom:** Invalid or expired tokens produce `{"error":"server_error"}` with status 500.

**Cause A:** Two copies of the MCP SDK are loaded. `createRequire().resolve()` picks the SDK's CJS build (`dist/cjs`), while the ESM OAuth provider imports the ESM build (`dist/esm`). `error instanceof InvalidTokenError` compares objects from different module instances and always fails, falling through to a generic `ServerError`.

**Fix A:** Rewrite the resolved SDK path from `dist/cjs` to `dist/esm` before importing, so both the gateway and the auth middleware share one module instance. See the gateway template for the exact fix.

**Cause B:** `app.set('trust proxy', true)` triggers `ERR_ERL_PERMISSIVE_TRUST_PROXY` in express-rate-limit (used internally by `mcpAuthRouter`).

**Fix B:** Set trust proxy to `'loopback'` instead of `true`. The only proxy hop is cloudflared on localhost.

### ChatGPT refuses the connector or tools do not appear

**Symptom:** ChatGPT shows an error when connecting, or connects but shows zero tools.

**Cause:** Too many tools exposed. The `--full` flag expands to 353 individual tools, exceeding ChatGPT's limit.

**Fix:** Use the default mode (35 compound tools). Do not pass `--full`.

### Tunnel is green but /mcp returns 502

**Symptom:** The Cloudflare Tunnel shows healthy in the dashboard, but requests to `/mcp` return 502.

**Cause:** The upstream MCP server process died. The gateway is running but has nothing behind it.

**Fix:** Check `/healthz` — it distinguishes `"upstream":false` from `"gateway":false`. Restart the upstream server. If using the supervisor, check `logs/server.stderr.log`.

### Upstream hardcodes Resolve's install path (Windows)

**Symptom:** Auto-launch fails; the server cannot find `Resolve.exe`.

**Cause:** Upstream `launch_command()` only looks under `C:\Program Files\Blackmagic Design\DaVinci Resolve\`. A non-default install directory is not found.

**Fix:** Set `RESOLVE_SCRIPT_LIB` to point at `fusionscript.dll` in your actual Resolve install directory. The upstream code can be patched to derive the exe path from `RESOLVE_SCRIPT_LIB`'s parent directory as a first-choice fallback.

### `runtime_mode` always reports "not running" (Windows)

**Symptom:** The MCP server reports Resolve is not running even though it is.

**Cause:** On Windows, the Resolve command line is quoted (`"C:\...\Resolve.exe"`). The upstream's `_is_resolve_command()` strips flags but not the trailing `"`, so `endswith("Resolve.exe")` is always false.

**Fix:** Strip surrounding quotes from the command-line string before checking the suffix.

> Both upstream issues above were encountered on Windows. They are worth knowing about if you hit them; the shape of the fix is simple in each case.

## Security notes

- The upstream MCP server binds to `127.0.0.1` only. It is not directly reachable from the network.
- The OAuth gateway binds to `127.0.0.1` only. The Cloudflare Tunnel is the sole public ingress.
- Access tokens expire in 1 hour; refresh tokens in 30 days.
- The owner token (used during the ChatGPT consent flow) is a secret — store it like a password.
- The upstream bearer token (`DAVINCI_MCP_TOKEN`) is a shared secret between the gateway and the upstream server, never exposed to the public.
- Resolve's Scripting API is powerful: it can create, modify, and delete projects, timelines, and media. Anyone with a valid access token has full control. Use this integration only on machines where that level of access is acceptable.
- See [`docs/security.md`](../../docs/security.md) for the repo-wide security model.

## Known limitations

- DaVinci Resolve must be running with its GUI in an interactive desktop session. Headless operation is not supported.
- Resolve must have a project open (not sitting on the Project Manager screen) for write operations to work.
- The default 35 compound tools cover the full API, but ChatGPT may occasionally struggle with the `action` parameter on complex tools. Be specific in your prompts.

## Attribution

| Component | Source | License |
|---|---|---|
| DaVinci Resolve MCP server | [samuelgursky/davinci-resolve-mcp](https://github.com/samuelgursky/davinci-resolve-mcp) | MIT — Copyright (c) 2025-2026 DaVinci Resolve MCP Contributors and Bradford Operations LLC |
| MCP TypeScript SDK (`@modelcontextprotocol/sdk`) | [modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk) | Apache-2.0 / MIT / CC-BY-4.0 — Copyright Model Context Protocol, a Series of LF Projects, LLC |
| SingleUserOAuthProvider (`@waishnav/devspace`) | [Waishnav/devspace](https://github.com/Waishnav/devspace) | MIT — Copyright (c) 2026 Waishnav |
| OAuth gateway, supervisor, this recipe | This repo (`chatgpt-mcp-connect`) | MIT |

The upstream project does not endorse or ship this integration.
