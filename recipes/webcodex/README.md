# WebCodex → ChatGPT

> Give ChatGPT controlled access to project tools and a browser-accessible console — file operations, coding, and validation — over a public HTTPS endpoint with built-in OAuth, exposed through a Cloudflare Tunnel running in local-config mode inside WSL.

| | |
|---|---|
| **Upstream** | [yyjeqhc/webcodex](https://github.com/yyjeqhc/webcodex) · Apache-2.0 · tested at `0.3.2`, latest `v0.3.7` (2026-08-14) · actively maintained (7 releases in 3 weeks) |
| **Transport** | Native Streamable HTTP on `127.0.0.1:8080` — no bridge needed |
| **Auth** | Built-in (pattern #4 — WebCodex ships its own OAuth) |
| **Exposure** | Cloudflare Tunnel, local config mode (pattern #2 — `/etc/cloudflared/config.yml` + credentials JSON, systemd service inside WSL) |
| **Status** | Verified 2026-08-18 — cloudflared systemd unit active inside WSL, tunnel connected over QUIC, container listening on :8080, public hostname resolving |

## What this is

This recipe connects ChatGPT to a self-hosted WebCodex instance running in Docker inside WSL2. WebCodex is both an MCP server *and* a browser-accessible console — the same public hostname serves both.

**How this differs from the other recipes:** the Cloudflare Tunnel does NOT use token mode. It runs as a **systemd service inside WSL** with a local `config.yml` and a credentials JSON file. Ingress rules live in YAML on disk, not in the Cloudflare dashboard.

**When local-config mode beats token mode:**
- It is version-controllable — `config.yml` is a file you can commit (minus the credentials).
- It works on headless Linux without dashboard access.
- You can change routing without logging into Cloudflare.
- It is the natural fit for systemd service management.

Token mode is simpler if you only have one hostname and manage everything through the dashboard.

**What is ours vs. upstream:**
- **Upstream** — WebCodex itself. You run it via Docker Compose; you do not modify it.
- **This recipe** — the integration knowledge: tunnel config, WSL systemd setup, the keepalive anchor, and the gotchas below.
- **Our components** — none for this recipe. WebCodex ships its own OAuth and the tunnel config is standard cloudflared.

## Tested environment

- Windows 11 with WSL2 (Ubuntu), `systemd=true` in `/etc/wsl.conf`
- Docker and Docker Compose inside WSL
- cloudflared installed inside WSL
- Cloudflare account with a DNS zone

## Prerequisites

1. **WSL2** with a Linux distro (tested on Ubuntu). **systemd must be enabled:**
   ```bash
   # /etc/wsl.conf must contain:
   [boot]
   systemd=true
   ```
   Restart WSL after adding this (`wsl --shutdown` from PowerShell).
2. **Docker** and **Docker Compose** inside WSL.
3. **cloudflared** installed inside WSL ([Linux install](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)).
4. A **Cloudflare account** with a domain you control.
5. A **Cloudflare Tunnel** created via CLI (not the dashboard) with a credentials JSON file. See step 4.

## 1. Get the MCP server running locally

Clone the upstream repo inside WSL:

```bash
git clone https://github.com/yyjeqhc/webcodex.git ~/webcodex
cd ~/webcodex
```

Configure the environment. WebCodex needs a `PUBLIC_URL` that matches the public hostname you will set up in step 4:

```bash
cp .env.example .env
# Edit .env:
#   PUBLIC_URL=https://webcodex.example.com
#   (plus any other settings — consult upstream docs)
```

Start with Docker Compose:

```bash
docker compose up -d
```

Verify:

```bash
# Should return 200
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8080
```

> WebCodex is both an MCP server and a browser console. Visiting `http://127.0.0.1:8080` in a browser gives you the console; MCP clients hit the same origin.

## 3. Put OAuth in front of it

Nothing to do. WebCodex ships its own OAuth. When ChatGPT connects, it will discover the OAuth endpoints automatically.

## 4. Expose it on a public HTTPS URL

This is the headline of this recipe: a Cloudflare Tunnel in **local-config mode** running as a systemd service inside WSL.

### Create the tunnel and credentials

```bash
# Authenticate cloudflared (one-time)
cloudflared tunnel login

# Create a named tunnel
cloudflared tunnel create webcodex
# This creates a credentials JSON at ~/.cloudflared/<tunnel-id>.json
# Note the tunnel UUID from the output.
```

### Create the DNS record

```bash
cloudflared tunnel route dns webcodex webcodex.example.com
```

### Write the config

Create `/etc/cloudflared/config.yml`:

```yaml
tunnel: <your-tunnel-id>
credentials-file: /home/<you>/.cloudflared/<your-tunnel-id>.json

ingress:
  - hostname: webcodex.example.com
    service: http://127.0.0.1:8080
  - service: http_status:404
```

The final `- service: http_status:404` catch-all rule is **mandatory** — cloudflared refuses to start without it. People forget this one.

### Install as a systemd service

```bash
sudo cloudflared service install
sudo systemctl enable cloudflared
sudo systemctl start cloudflared
```

Verify:

```bash
sudo systemctl status cloudflared
# Should show active (running)

# Public endpoint — should resolve and return a response
curl -s -o /dev/null -w "%{http_code}" https://webcodex.example.com
```

### The WSL keepalive — this is the most important part

**WSL shuts the entire distro down when no foreground process is attached.** When the last WSL terminal closes, background services — the Docker container AND the cloudflared systemd unit — die silently. The public endpoint goes away with no error; it just stops resolving.

The fix is an anchor process: a Windows Scheduled Task that runs a hidden `wsl.exe` process, keeping the distro alive indefinitely.

1. Create a VBS wrapper (e.g. `%USERPROFILE%\wsl-keepalive.vbs`):

```vbs
Set shell = CreateObject("WScript.Shell")
shell.Run "wsl.exe -d Ubuntu -u root --exec /usr/bin/sleep infinity", 0, False
```

Replace `Ubuntu` with your distro name (`wsl -l -q` to check).

2. Create a Windows Scheduled Task:
   - **Trigger:** At log on.
   - **Action:** `wscript.exe "%USERPROFILE%\wsl-keepalive.vbs"`
   - **Settings:** "If the task is already running, do not start a new instance" — so duplicate instances are ignored rather than stacked.

This keeps the distro alive so Docker and cloudflared continue running even after you close all terminals.

## 5. Add it in ChatGPT

1. Go to **ChatGPT → Settings → Connected apps**.
2. Add a new MCP connector with URL: `https://webcodex.example.com/mcp` (or the path WebCodex documents for MCP — consult the upstream README).
3. ChatGPT will discover the OAuth endpoints and redirect you to WebCodex's built-in consent screen.
4. Authorize.
5. After authorization, ChatGPT should list the WebCodex tools.

## 6. Verify the whole chain

```bash
# 1. Local — should return 200
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8080

# 2. Tunnel service — should show active
sudo systemctl status cloudflared

# 3. Public — should return 200
curl -s -o /dev/null -w "%{http_code}\n" https://webcodex.example.com

# 4. Public MCP — should return 401 (OAuth enforced; this is CORRECT)
curl -s -o /dev/null -w "%{http_code}\n" https://webcodex.example.com/mcp
```

A `401` at step 4 is a **pass**, not a failure — it means OAuth is enforced.

Then in ChatGPT, try: *"List the files in the current project."*

## Common errors

### WSL services die when the terminal closes

**Symptom:** Everything works until you close the last WSL terminal. Then the public endpoint stops responding.

**Cause:** WSL shuts the distro down when no foreground process is attached. Docker and cloudflared die with it.

**Fix:** Set up the keepalive anchor described in step 4. Verify it is running:

```powershell
# From PowerShell — should show a wsl.exe process with "sleep infinity"
Get-Process wsl -ErrorAction SilentlyContinue | ForEach-Object {
    (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)").CommandLine
}
```

### cloudflared refuses to start — missing catch-all rule

**Symptom:** `cloudflared tunnel run` or the systemd service fails immediately with an ingress error.

**Cause:** The `config.yml` is missing the mandatory catch-all rule at the end of the ingress list.

**Fix:** Add `- service: http_status:404` as the last entry in the `ingress` array. It must have no `hostname` field.

### systemd not available inside WSL

**Symptom:** `systemctl` commands fail with "System has not been booted with systemd as init system."

**Cause:** `/etc/wsl.conf` does not have `systemd=true` under `[boot]`.

**Fix:** Add it and restart WSL:

```bash
# Inside WSL:
echo -e '[boot]\nsystemd=true' | sudo tee /etc/wsl.conf
```

```powershell
# From PowerShell:
wsl --shutdown
```

Then reopen WSL.

### `PUBLIC_URL` mismatch

**Symptom:** OAuth redirects fail or the consent screen shows the wrong URL.

**Cause:** WebCodex's `PUBLIC_URL` environment variable does not match the actual public hostname.

**Fix:** Set `PUBLIC_URL` in `.env` to the exact public hostname (e.g. `https://webcodex.example.com`) and restart the container.

## Security notes

- WebCodex exposes controlled project tools **and a browser-accessible console** over the public internet. Scope the exposed project roots deliberately.
- OAuth is enforced on the MCP endpoint. Unauthenticated requests return 401.
- The tunnel credentials JSON (`<tunnel-id>.json`) is a secret — do not commit it. The `config.yml` itself is safe to commit (it contains no credentials, only the tunnel UUID and routing rules).
- **Blast radius** depends on the project roots you expose. WebCodex provides file operations, coding tools, and validation within those roots. Scope them narrowly.
- See [`docs/security.md`](../../docs/security.md) for the repo-wide security model.

## Known limitations

- **WSL keepalive is mandatory.** Without the anchor process, the public endpoint silently dies when you close your last terminal. There is no warning.
- **License formality gap.** The upstream repo's LICENSE file is the verbatim Apache 2.0 text with the unfilled `Copyright [yyyy] [name of copyright owner]` template. This is a formality gap, not a licensing problem — the Apache-2.0 license terms still apply, and there is no NOTICE file, so the only obligation is retaining the LICENSE file and any existing notices.
- **Local-config tunnel requires CLI-created tunnels.** If you created the tunnel through the dashboard (token mode), you need to create a new one via `cloudflared tunnel create` to get the credentials JSON for local-config mode.
- **Docker Compose restart policy** should be set to `unless-stopped` or `always` so the container comes back after a WSL restart.

## Attribution

| Component | Source | License |
|---|---|---|
| WebCodex | [yyjeqhc/webcodex](https://github.com/yyjeqhc/webcodex) | Apache-2.0 |
| This recipe | This repo (`chatgpt-mcp-connect`) | MIT |

The upstream project does not endorse or ship this integration.
