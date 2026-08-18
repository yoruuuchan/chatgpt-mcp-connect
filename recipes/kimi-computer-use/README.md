# Kimi Computer Use → ChatGPT

> Let ChatGPT see and control your Windows desktop — click, type, scroll, and launch apps — through Moonshot's KimiCU agent.

| | |
|---|---|
| **Upstream** | Moonshot AI "Kimi CU" (Kimi Computer Use) · **proprietary, no public license terms located** — do not redistribute the binary; obtain it from Moonshot's official distribution · tested at `0.2.15` |
| **Transport** | stdio — requires a Streamable HTTP bridge (see §2) |
| **Auth** | Cloudflare Access Managed OAuth (zero custom auth code) |
| **Exposure** | Cloudflare Tunnel, token mode |
| **Status** | 2026-08-18 — bridge on `:9879` verified live (`/ping` → `pong`); `cloudflared` running; public `/mcp` returns `401` without a token (correct). |

## What this is

This recipe documents how to expose KimiCU's local stdio MCP server to ChatGPT. The headline is the auth pattern: **Cloudflare Access Managed OAuth** — you write zero auth code. Cloudflare Zero Trust runs the entire OAuth 2.1 flow at the edge, and `cloudflared` validates the Access JWT before forwarding to the local bridge. There is no gateway process.

Compare this with the [Blender](../blender/) or [DaVinci Resolve](../davinci-resolve/) recipes, which use a local OAuth gateway (`templates/oauth-gateway/`). **Choose Cloudflare Access Managed OAuth when:** you are already on Cloudflare, you don't need custom consent logic or scopes, and you want strictly less code to own.

```
ChatGPT
  → Cloudflare Access (managed OAuth, JWT validation at edge)
    → cloudflared (validates Access JWT)
      → 127.0.0.1:9879 (mcp-proxy bridge, Streamable HTTP)
        → (stdio) kimi-cu.exe mcp
          → KimiCU background agent
            → interactive Windows desktop
```

**Available tools:** `activate_window`, `click`, `drag`, `get_app_state`, `launch_app`, `list_apps`, `perform_secondary_action`, `press_key`, `scroll`, `select_text`, `set_value`, `type_text`, `turn_ended`.

## Tested environment

- Windows 11 (interactive desktop session — KimiCU requires it)
- KimiCU 0.2.15
- Node.js >= 18
- `mcp-proxy` 6.7.0
- `cloudflared` installed
- Cloudflare Zero Trust account

## Prerequisites

1. **KimiCU installed and its background agent running.** KimiCU is a closed-source Windows binary distributed from Moonshot's CDN (`cdn.kimi.com`). Obtain it from Moonshot's official channels. The background agent must be running — it owns the IPC channel that captures the screen and injects input.
2. Node.js on PATH.
3. `cloudflared` installed.
4. A Cloudflare account with Zero Trust enabled and a domain you control.

## 1. Get the MCP server running locally

KimiCU's MCP server is a stdio transport invoked as:

```powershell
kimi-cu.exe mcp
```

It speaks MCP over stdin/stdout. It does not listen on any port by itself — you need the bridge (§2).

Verify the binary exists:

```powershell
# Typical install location
Test-Path "$env:LOCALAPPDATA\KimiCU\kimi-cu.exe"
```

Verify the background agent is running:

```powershell
Get-Process -Name "kimi-cu" -ErrorAction SilentlyContinue
```

## 2. Make it speak Streamable HTTP

**A Cloudflare Tunnel forwards network traffic — it does NOT turn stdio into HTTP.** The bridge is a separate, mandatory layer. This is the most common misunderstanding.

This recipe uses [`mcp-proxy`](https://github.com/punkpeye/mcp-proxy) (MIT, by Frank Fiegel). It spawns the stdio server as a child process, translates between stdio and Streamable HTTP, and exposes a standard `/mcp` endpoint.

### Start the bridge

```powershell
npx --yes mcp-proxy@6.7.0 `
  --host 127.0.0.1 `
  --port 9879 `
  --server stream `
  --connectionTimeout 60000 `
  --requestTimeout 300000 `
  -- `
  kimi-cu.exe mcp
```

Notes:
- `--server stream` selects Streamable HTTP (what ChatGPT requires).
- `--connectionTimeout 60000 --requestTimeout 300000` — computer-use tool calls are slow (screenshot capture, UI interaction). The default timeouts will cause premature disconnects. These values are tested in production.

### Verify

```powershell
# Bridge liveness check
Invoke-WebRequest -Uri http://127.0.0.1:9879/ping -UseBasicParsing
# Expected: StatusCode 200, Content "pong"
```

## 3. Put OAuth in front of it

This recipe uses **Cloudflare Access Managed OAuth** — no local auth process, no gateway code, no SQLite state. Cloudflare runs the entire OAuth 2.1 flow.

### Create the Access application

In the Cloudflare Zero Trust dashboard:

1. Go to **Access → Applications → Add an application**.
2. Application type: **MCP** (this is a specific type in the dropdown).
3. Configure:
   - **Session duration:** `336h` (14 days) — or shorter if you prefer.
   - **Access token lifetime:** `15m`.
   - **Allowed redirect URIs:**
     ```
     https://chatgpt.com/connector/oauth/*
     https://chatgpt.com/connector_platform_oauth_redirect
     ```
     These are the values ChatGPT used at time of testing. **Re-check current values** — OpenAI changes these.
   - Enable **Allow localhost** and **Allow loopback** (needed for local development/testing).
4. Save. Cloudflare generates the application ID and audience tag — you'll need the audience tag for the tunnel ingress rule.

### No gateway process

There is nothing to start here. Cloudflare handles token issuance, validation, and refresh at the edge. The `cloudflared` process validates the Access JWT before forwarding traffic to the bridge.

## 4. Expose it on a public HTTPS URL

### Create the tunnel

In the Cloudflare Zero Trust dashboard:

1. Create a tunnel (token mode).
2. Add a public hostname rule:
   - Hostname: `kimi-cu-mcp.example.com`
   - Service: `http://127.0.0.1:9879`
   - Under **Access**, enable **Require Access JWT** and set the **Audience** to the tag from your Access application.
3. Save the tunnel token to a file.

The JWT validation in the ingress rule is critical — it is what prevents unauthenticated traffic from reaching the bridge.

### Run cloudflared

```powershell
cloudflared tunnel run --token-file <your-token-file>
```

### Supervisor pattern (recommended)

For unattended operation, use the supervisor pattern from [`templates/supervisor/`](../../templates/supervisor/). Key behaviors tested in production:

- Bridge and tunnel start immediately and stay up permanently.
- A global mutex prevents duplicate supervisor instances.
- Both are restarted automatically if they crash.
- Polls every 5 seconds.

Unlike the Blender recipe, there is no conditional start — the bridge runs whether or not KimiCU's agent is actively doing anything.

### Verify

```powershell
# From outside your network — should return 401 (no token, Access blocks it)
curl -s -o /dev/null -w "%{http_code}" https://kimi-cu-mcp.example.com/mcp
# Expected: 401
```

A `401` is a **pass** — it means Cloudflare Access is live and rejecting unauthenticated requests.

## 5. Add it in ChatGPT

1. Go to [ChatGPT → Settings → Connected apps](https://chatgpt.com/settings).
2. Click **Add** → enter your public MCP URL: `https://kimi-cu-mcp.example.com/mcp`.
3. ChatGPT will redirect you through the Cloudflare Access OAuth flow. Authenticate with your configured identity provider.
4. Approve the connection.

## 6. Verify the whole chain

1. Ensure KimiCU's background agent is running.
2. In ChatGPT, send: _"Use the computer-use tools to list all open applications."_
3. ChatGPT should call `list_apps` and return the list of running applications.

For layered connectivity checking, see [`scripts/doctor.mjs`](../../scripts/doctor.mjs).

## Common errors

| Symptom | Cause | Fix |
|---|---|---|
| `401` on public `/mcp` | No Access token — this is correct behavior | Complete the OAuth flow in ChatGPT |
| Bridge timeout / `504` on tool calls | Default `mcp-proxy` timeouts are too short for computer-use operations | Add `--connectionTimeout 60000 --requestTimeout 300000` to the bridge command |
| `kimi-cu.exe mcp` exits immediately | KimiCU background agent not running | Start KimiCU from the system tray or Start Menu |
| Bridge starts but tools return empty results | Interactive desktop session required — KimiCU cannot capture a locked/disconnected screen | Ensure the Windows session is unlocked and interactive |
| Cloudflare Access shows "Invalid redirect URI" during OAuth | ChatGPT changed their callback URLs | Update the allowed redirect URIs in the Access application settings |
| `403` instead of `401` on public `/mcp` | Access application misconfigured or audience tag mismatch in tunnel ingress | Verify the audience tag in the tunnel ingress rule matches the Access application |

## Security notes

**This recipe exposes full interactive desktop control.**

KimiCU's tools allow a connected client to: see the screen, click anywhere, type anything, scroll, drag, and launch any application. There are no tool exclusions applied here.

Even without a shell tool, **"launch any app + type anything" is effectively equivalent to shell access.** An authenticated client can open `cmd.exe`, `powershell.exe`, or any terminal and type arbitrary commands. Treat this accordingly.

Compare with the [Windows Desktop](../windows-desktop/) recipe, which uses Windows-MCP and **excludes** the shell, file, registry, and process tools. This recipe applies no such exclusions — all KimiCU tools are exposed.

**Mitigations:**

1. Cloudflare Access controls WHO can authenticate. Configure restrictive access policies — limit to specific email addresses or identity provider groups.
2. The Access token lifetime is short (15 minutes). Session duration (14 days) controls how often re-authentication is required.
3. The Cloudflare Tunnel can be paused instantly from the dashboard.
4. Consider whether you want this exposed at all. A Tailscale Funnel to a private tailnet may be more appropriate.

See [`docs/security.md`](../../docs/security.md) for the repo-wide threat model.

## Known limitations

- Requires an **interactive Windows desktop session**. KimiCU cannot capture the screen or inject input on a locked, disconnected, or headless session.
- KimiCU is closed-source with no public license terms located. You cannot inspect, modify, or redistribute the binary.
- Computer-use operations are inherently slow — screenshot capture, analysis, and UI interaction take seconds per step. Set generous timeouts.
- KimiCU's tools operate at the pixel/UI level. They are fragile to display scaling, resolution changes, and UI redesigns in target applications.

## Attribution

- **Upstream:** Moonshot AI "Kimi CU" (Kimi Computer Use) — proprietary, no public license terms located. This recipe does not ship or modify the upstream binary.
- **Bridge:** [punkpeye/mcp-proxy](https://github.com/punkpeye/mcp-proxy) by Frank Fiegel — MIT. Used as a runtime dependency (`npx`), not vendored.
- **This recipe:** Integration knowledge — what to run, in what order, with what config. Part of [chatgpt-mcp-connect](../../).
- **Infrastructure:** Cloudflare Access Managed OAuth and Cloudflare Tunnel — Cloudflare products, not part of this repo.
