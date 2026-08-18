# Blender MCP → ChatGPT

> Let ChatGPT drive Blender — create and manipulate 3D scenes, run Python scripts, and import assets via natural language.

| | |
|---|---|
| **Upstream** | [ahujasid/blender-mcp](https://github.com/ahujasid/blender-mcp) · MIT · tested at `1.8.0` (latest `1.8.3`) |
| **Transport** | stdio — requires a Streamable HTTP bridge (see §2) |
| **Auth** | Local OAuth gateway (`templates/oauth-gateway/`) |
| **Exposure** | Cloudflare Tunnel, token mode |
| **Status** | 2026-08-18 — OAuth gateway (`:9878`) and Cloudflare Tunnel verified live; public `/mcp` returns `401` without a token (correct). End-to-end tool call NOT re-verified on this date because Blender was not running (`:9876` and bridge `:9877` were down; `/healthz` returned `{"ok":false,"gateway":true,"bridge":false}`). |

## What this is

This recipe documents how to expose a **local** blender-mcp server to ChatGPT over the public internet. It is integration knowledge — what to run, in what order, with what config. The upstream MCP server and the Blender addon are third-party projects; this recipe does not ship or modify them.

blender-mcp has an unusual two-part architecture:

```
ChatGPT
  → Cloudflare Tunnel
    → Local OAuth gateway :9878
      → mcp-proxy bridge :9877  (Streamable HTTP)
        → (stdio) uvx blender-mcp
          → TCP :9876
            → Blender addon (addon.py)
              → Blender Python API
```

The **Blender addon** opens a raw TCP socket on `127.0.0.1:9876` from inside Blender. The **PyPI package** (`blender-mcp`) is a stdio MCP server that connects to that socket and relays JSON commands. Neither half speaks HTTP — so you need the bridge (§2) before ChatGPT can reach it.

**Available tools:** `get_scene_info`, `get_object_info`, `get_viewport_screenshot`, `execute_blender_code`, Poly Haven asset download, Hyper3D/Rodin model generation, Sketchfab download, `set_texture`.

## Tested environment

- Windows 11
- Blender 4.5.3 LTS
- Python >= 3.10, `uv` / `uvx` on PATH
- Node.js >= 18
- `cloudflared` installed
- `mcp-proxy` 6.7.0

## Prerequisites

1. Blender installed, with the blender-mcp addon enabled (see §1).
2. `uvx` on PATH (install with `pip install uv` or via the [uv installer](https://docs.astral.sh/uv/getting-started/installation/)).
3. Node.js on PATH.
4. `cloudflared` installed.
5. A Cloudflare account with a domain you control.
6. The OAuth gateway from `../../templates/oauth-gateway/` configured.

## 1. Get the MCP server running locally

### Install the Blender addon

1. Download `addon.py` from the [blender-mcp releases](https://github.com/ahujasid/blender-mcp/releases) or clone the repo.
2. In Blender: **Edit → Preferences → Add-ons → Install from Disk** → select `addon.py`.
3. Enable the addon in the list. It appears as "BlenderMCP" in the sidebar.

The addon installs to:

```
%APPDATA%\Blender Foundation\Blender\4.5\scripts\addons\
```

### Start the addon's TCP server

1. Open the **BlenderMCP** panel in Blender's sidebar (press `N` if hidden).
2. Click **Start Server**. This opens a TCP socket on `127.0.0.1:9876`.

Nothing else works until this socket is up. The bridge (§2) should not start until `:9876` is listening.

### Verify

```powershell
# Check that 9876 is listening
Get-NetTCPConnection -State Listen -LocalPort 9876
```

## 2. Make it speak Streamable HTTP

The bridge is the layer that turns a stdio MCP server into an HTTP endpoint that ChatGPT can call. **A Cloudflare Tunnel forwards network traffic — it does NOT turn stdio into HTTP.** The bridge is a separate, mandatory layer.

This recipe uses [`mcp-proxy`](https://github.com/punkpeye/mcp-proxy) (MIT, by Frank Fiegel). It spawns the stdio server as a child process, translates between stdio and Streamable HTTP, and exposes a standard `/mcp` endpoint.

### Start the bridge

```powershell
npx --yes mcp-proxy@6.7.0 `
  --host 127.0.0.1 `
  --port 9877 `
  --server stream `
  -- `
  uvx blender-mcp
```

`--server stream` selects Streamable HTTP (what ChatGPT requires) rather than SSE.

### Dependency pinning note

If `uvx` resolves a newer version of `mcp[cli]` and the server fails to start, pin it with a constraints file:

```
# blender-mcp-constraints.txt
mcp[cli]==1.27.2
```

```powershell
$env:UV_CONSTRAINT = "C:\mcp\blender\blender-mcp-constraints.txt"
npx --yes mcp-proxy@6.7.0 --host 127.0.0.1 --port 9877 --server stream -- uvx blender-mcp
```

### Verify

```powershell
# Bridge liveness check — mcp-proxy exposes /ping
Invoke-WebRequest -Uri http://127.0.0.1:9877/ping -UseBasicParsing
# Expected: StatusCode 200, Content "pong"
```

## 3. Put OAuth in front of it

This recipe uses the **Local OAuth gateway** pattern — a small Node/Express process from [`templates/oauth-gateway/`](../../templates/oauth-gateway/) that puts MCP SDK OAuth 2.1 in front of the bridge.

### Configure the gateway

Create a gateway script (or adapt the template) with these settings:

```javascript
const PORT = 9878;                                          // gateway listens here
const UPSTREAM_PORT = 9877;                                 // bridge from §2
const PUBLIC_BASE_URL = 'https://blender-mcp.example.com';  // your public URL
const SCOPES = ['blender'];
```

The gateway reads your owner token from `~/.devspace/auth.json`. Generate one if you haven't:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# Write the output into ~/.devspace/auth.json as {"ownerToken": "<value>"}
```

**Treat this token like a root password.** See Security notes below.

### Start the gateway

```powershell
node gateway.mjs
# Expected: "OAuth gateway listening on http://127.0.0.1:9878/mcp"
```

### Verify

```powershell
# Health check — reports both gateway and bridge status
Invoke-WebRequest -Uri http://127.0.0.1:9878/healthz -UseBasicParsing
# Expected when bridge is up:   {"ok":true,"gateway":true,"bridge":true}
# Expected when bridge is down: {"ok":false,"gateway":true,"bridge":false}
```

## 4. Expose it on a public HTTPS URL

### Create the tunnel

In the Cloudflare Zero Trust dashboard:

1. Create a tunnel (token mode).
2. Add a public hostname: `blender-mcp.example.com` → `http://127.0.0.1:9878`.
3. Save the tunnel token to a file.

### Run cloudflared

```powershell
cloudflared tunnel run --token-file <your-token-file>
```

### Supervisor pattern (recommended)

For unattended operation, use the supervisor pattern from [`templates/supervisor/`](../../templates/supervisor/). Key behaviors tested in production:

- Gateway and tunnel start immediately and stay up permanently.
- Bridge starts **only when `:9876` is listening** (i.e., Blender's addon is up). It polls every 5 seconds.
- All three are restarted automatically if they crash.
- A global mutex prevents duplicate supervisor instances.

### Verify

```powershell
# From outside your network — should return 401 (no token)
curl -s -o /dev/null -w "%{http_code}" https://blender-mcp.example.com/mcp
# Expected: 401
```

A `401` is a **pass** — it means the gateway is live and rejecting unauthenticated requests.

## 5. Add it in ChatGPT

1. Go to [ChatGPT → Settings → Connected apps](https://chatgpt.com/settings).
2. Click **Add** → enter your public MCP URL: `https://blender-mcp.example.com/mcp`.
3. ChatGPT will redirect you through the OAuth flow. Enter your owner token when prompted.
4. Approve the `blender` scope.

## 6. Verify the whole chain

1. In Blender, ensure the addon's server is running (sidebar panel → **Start Server**).
2. In ChatGPT, send: _"Use the blender tools to get the current scene info."_
3. ChatGPT should call `get_scene_info` and return the scene hierarchy.

If the bridge is not running (Blender closed), ChatGPT will get a `502` from the gateway. The `/healthz` endpoint reports which layer is down.

For layered connectivity checking, see [`scripts/doctor.mjs`](../../scripts/doctor.mjs).

## Common errors

| Symptom | Cause | Fix |
|---|---|---|
| Bridge starts then crashes with `mcp` import error | `uvx` resolved a newer `mcp[cli]` that is incompatible | Pin `mcp[cli]==1.27.2` via `UV_CONSTRAINT` (see §2) |
| `/healthz` returns `{"ok":false,"gateway":true,"bridge":false}` | Blender addon server not started, or Blender not running | Open Blender, enable addon, click **Start Server** in the sidebar |
| `401` on public `/mcp` | No bearer token — this is correct behavior | Pass the OAuth flow in ChatGPT to obtain a token |
| `502` from gateway on `/mcp` | Bridge is down or not yet started | Check that `:9876` is listening, then start the bridge |
| Connection refused on `:9876` | Addon installed but server not started | Click **Start Server** in Blender's BlenderMCP sidebar panel |
| `execute_blender_code` returns an error about missing module | The Blender Python environment doesn't have the dependency | Install it in Blender's Python: `import subprocess; subprocess.check_call([sys.executable, '-m', 'pip', 'install', '<package>'])` |

## Security notes

**This is the most dangerous recipe in this repo.**

blender-mcp exposes `execute_blender_code`, which runs **arbitrary Python** inside Blender's interpreter. That means:

- Full file I/O as the logged-in Windows user.
- Network access.
- Subprocess spawning (`subprocess.run`, `os.system`, etc.).
- No sandbox of any kind.

Anyone who completes your OAuth flow gets **arbitrary code execution on your machine**. This is not theoretical — ChatGPT (or any MCP client that authenticates) can run `import os; os.system('...')` through `execute_blender_code`.

**Mitigations:**

1. **Treat the owner token like a root password.** Do not share it. Do not commit it. Rotate it if compromised.
2. **Consider whether you want this exposed to the public internet at all.** A Tailscale Funnel to a private tailnet may be more appropriate than a Cloudflare Tunnel with a public hostname.
3. The OAuth gateway limits token lifetime (1 hour access, 30 day refresh) and requires explicit scope approval.
4. The Cloudflare Tunnel can be paused instantly from the dashboard if you suspect abuse.

See [`docs/security.md`](../../docs/security.md) for the repo-wide threat model.

## Known limitations

- The bridge only starts when Blender's addon server is listening on `:9876`. If Blender is not running, ChatGPT gets a `502`. This is by design — there is nothing useful to proxy to without Blender.
- `get_viewport_screenshot` returns the 3D viewport as a base64 image. Large renders may exceed ChatGPT's response size limits.
- The addon's TCP socket on `:9876` accepts a single connection. If another MCP client (e.g., Claude Desktop) is already connected, `uvx blender-mcp` will fail to connect. Close the other client first.
- Poly Haven, Hyper3D/Rodin, and Sketchfab integrations require their own API keys configured in the addon — they are upstream features, not part of this recipe.

## Attribution

- **Upstream:** [ahujasid/blender-mcp](https://github.com/ahujasid/blender-mcp) by Siddharth Ahuja — MIT. This recipe does not ship or modify the upstream project.
- **Bridge:** [punkpeye/mcp-proxy](https://github.com/punkpeye/mcp-proxy) by Frank Fiegel — MIT. Used as a runtime dependency (`npx`), not vendored.
- **This recipe:** Integration knowledge — what to run, in what order, with what config. Part of [chatgpt-mcp-connect](../../).
- **Our components:** The OAuth gateway template (`templates/oauth-gateway/`) and supervisor pattern (`templates/supervisor/`) are part of this repo, MIT-licensed.
