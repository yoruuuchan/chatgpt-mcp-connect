# Troubleshooting

Real failures hit while building the recipes in this repo, with the actual cause rather than a guess.

Start with the layered check — it tells you which section to read:

```bash
node scripts/doctor.mjs --url https://mcp.example.com --upstream 127.0.0.1:8770 --gateway 127.0.0.1:8771
```

---

## Auth layer

### Every auth failure returns HTTP 500 `server_error` instead of 401

The most expensive bug in this repo, because the response is the same for two unrelated causes and neither is mentioned in any error message.

**Cause A — two copies of the MCP SDK are loaded.**

`createRequire().resolve()` picks a package's `require` export condition, which resolves to `dist/cjs`. DevSpace's `oauth-provider.js` is ESM and pulls `dist/esm`. So the provider throws an `InvalidTokenError` from one module instance, while `requireBearerAuth`'s `error instanceof InvalidTokenError` check compares against a *different class object* from the other instance. The check is always false, execution falls through to the generic `else`, and you get `new ServerError('Internal Server Error')`.

Fix: rewrite the resolved path onto the ESM build before importing, so both halves share one module instance.

```js
const importResolved = async (specifier) => {
  const resolved = requireFromDevSpace.resolve(specifier);
  const esm = resolved.replace(/([\\/])dist[\\/]cjs[\\/]/, '$1dist$1esm$1');
  return import(pathToFileURL(esm).href);
};
```

This is already applied in [`templates/oauth-gateway/gateway.mjs`](../templates/oauth-gateway/gateway.mjs). It bites whenever you mix `createRequire` with an ESM dependency from the same package — not just here.

**Cause B — `trust proxy` is too permissive.**

```js
app.set('trust proxy', true);   // wrong
app.set('trust proxy', 'loopback');  // right
```

`mcpAuthRouter` contains an `express-rate-limit` instance. With `trust proxy` set to `true`, it throws `ERR_ERL_PERMISSIVE_TRUST_PROXY`, and the throw turns a 401 into a 500. Your only proxy hop is `cloudflared` on localhost, so `'loopback'` is both correct and sufficient.

Check both. Fixing one while the other is still present looks like the fix didn't work.

### ChatGPT completes OAuth but immediately asks again, in a loop

`PUBLIC_BASE_URL` doesn't match the hostname ChatGPT is actually calling. The gateway publishes discovery documents built from `PUBLIC_BASE_URL`; if that says `https://a.example.com` while ChatGPT is talking to `https://b.example.com`, the issuer check fails after the redirect and the flow restarts. Watch for trailing slashes and for `http` vs `https`.

### The connector fails to add, with no useful message

Check the authorization server metadata has both:

- `registration_endpoint` — ChatGPT registers itself dynamically (RFC 7591). Without it there is no way to configure a client ID by hand.
- `code_challenge_methods_supported` containing `S256`.

`doctor.mjs` warns on both.

### `/.well-known/oauth-protected-resource` returns 404 but everything else looks right

For a resource at `https://host/mcp`, RFC 9728 puts the metadata at the **path-suffixed** URL:

```
https://host/.well-known/oauth-protected-resource/mcp     ← this one
https://host/.well-known/oauth-protected-resource          ← often 404, and that's fine
```

The MCP SDK's router serves the suffixed form. If you hand-rolled your metadata and only served the bare path, clients that follow the spec won't find it. `doctor.mjs` tries both and tells you which answered.

---

## Transport layer

### The tunnel is up but ChatGPT can't use the server at all

If the MCP server is stdio-only, no amount of tunnel configuration will help. A tunnel forwards network traffic; it does not create an HTTP server. Put [`mcp-proxy`](https://github.com/punkpeye/mcp-proxy) in between:

```bash
npx --yes mcp-proxy@6.7.0 --host 127.0.0.1 --port 9877 --server stream -- <your stdio command>
```

`--server stream` selects Streamable HTTP. Omitting it gives you SSE, which is not what you want here.

### Tool calls die partway through, short calls are fine

`mcp-proxy`'s default timeouts are too short for computer-use and rendering tools. Raise them:

```
--connectionTimeout 60000 --requestTimeout 300000
```

### ChatGPT rejects the connector, or only some tools appear

Too many tools. There is a practical ceiling and large tool sets get rejected or silently truncated. The fix is on the server side: expose fewer tools, or use a server that groups operations behind a compound tool with an `action` parameter. The DaVinci Resolve server does this — 35 compound tools cover the same 336-method API that its `--full` flag would expose as 353 individual tools. Do not use `--full`.

---

## Origin layer

### Public URL returns 502 or 503, but OAuth worked

Auth passed and there is nothing behind it. The MCP server or the stdio bridge died while the gateway and tunnel stayed up. `/healthz` on the gateway distinguishes the two:

```json
{"ok":false,"gateway":true,"upstream":false}
```

Gateway fine, upstream gone. Restart the MCP server, and check why your supervisor didn't.

### `cloudflared` refuses to start with a local config

The ingress list must end with a catch-all. Without it, config validation fails:

```yaml
ingress:
  - hostname: mcp.example.com
    service: http://127.0.0.1:8771
  - service: http_status:404      # required, must be last
```

### Everything worked, then stopped after the last terminal closed (WSL)

WSL shuts the whole distribution down when no foreground process is attached, taking Docker containers and systemd units with it — including your tunnel. Anchor the distro with a hidden process that never exits:

```
wsl.exe -d <distro> -u root --exec /usr/bin/sleep infinity
```

Run it from a scheduled task at logon, configured to ignore new instances rather than stack them. Also confirm `systemd=true` is set in `/etc/wsl.conf`, or your systemd units never start in the first place.

### `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` behind Tailscale Funnel

The mirror image of the `trust proxy` trap above: the Funnel sets `X-Forwarded-For` but Express isn't configured to trust any proxy, so `express-rate-limit` complains. Non-fatal — but set `trust proxy` to match your actual hop count rather than leaving it noisy.

---

## Application layer

### DaVinci Resolve: reads work, writes silently do nothing

The highest-value gotcha in this repo. When Resolve is sitting on the **Project Manager** window — the state it cold-starts into — `GetCurrentPage()` returns `None` and every write operation fails silently. Creating a timeline returns `None`. Setting a marker reports `NO_CURRENT_TIMELINE`. Meanwhile every read works perfectly, so the connection looks healthy and you go hunting in the wrong layer.

`OpenPage()` does not fix it. Neither does `LoadProject()` on the already-current project. What fixes it is `project_manager` with action `create` or `load` — once the session leaves the Project Manager, it never returns there. ChatGPT can do this itself as its first call.

### DaVinci Resolve: `scriptapp("Resolve")` returns None

Two possibilities:

- You're running headless. `-nogui` has no scripting server; Resolve must run with its GUI in an interactive desktop session.
- You have the free edition. External scripting requires **Resolve Studio**.

### Blender: gateway is up, tool calls 502

The Blender addon's socket only exists once you enable the addon in Preferences *and* start its server from the sidebar panel inside Blender. Until then nothing is listening on the addon port, and the bridge has nothing to connect to. Starting Blender is not enough.

### `uvx`-launched server suddenly fails to start after working for weeks

`uvx` resolved a newer dependency. Pin it with a constraints file:

```
UV_CONSTRAINT=<path>/constraints.txt
```

The Blender recipe pins `mcp[cli]` this way.

---

## Supervision layer

### Works when you run it by hand, fails as a scheduled task

Almost always the desktop session. GUI-dependent servers — screen capture, UI automation, Blender, Resolve — need an **interactive** session. "Run whether user is logged on or not" gives a session with no desktop, and these fail in unhelpful ways. Trigger at logon and run in the user's session instead.

If you also want no console window flashing, launch PowerShell through a small VBS wrapper with `wscript.exe //B //NoLogo` rather than fighting `-WindowStyle Hidden`.

### Two of everything after a few days

Your supervisor stacked. Guard it with a named global mutex so a second instance exits immediately, and set the scheduled task to ignore new instances rather than run them in parallel. See [`templates/supervisor`](../templates/supervisor/).

---

## Development environment

### `git push` fails in WSL even though GitHub is already logged in on Windows

WSL Git and Windows Git do not necessarily share credential helpers. A failed HTTPS push from WSL does **not** prove the machine has no GitHub credentials, and it is not a reason to create another PAT immediately.

If Windows Git is already authenticated through Git Credential Manager, reuse that credential context from WSL:

```powershell
powershell.exe -NoProfile -Command "Set-Location 'C:\path\to\repo'; git push origin main"
```

This was verified while publishing the McDonald's recipe: WSL Git had no usable GitHub HTTPS credential, while the same checkout pushed successfully through Windows Git. Treat the two Git environments as separate credential contexts before rotating or minting secrets.

---

## Things that change under you

Re-verify these at implementation time rather than trusting any document, including this one:

- ChatGPT's UI path for adding a custom connector, and what the feature is currently called
- Which plans can add custom MCP servers
- ChatGPT's OAuth redirect URIs
- The practical tool-count ceiling
- MCP authorization spec details

The core requirements — public HTTPS, Streamable HTTP, and OAuth 2.1 — have been stable. The exposure layer may be a tunnel, Funnel, or pure edge Worker depending on where the upstream actually runs. The product surface on top of it has not.

---

## Network environment

### cloudflared fails DNS resolution with `lookup argotunnel.com: no such host`

A local DNS interceptor (xray TUN mode, Clash TUN mode, or similar) hijacks system DNS, but `cloudflared` is a Go binary. Go's DNS resolver **does not read the Windows hosts file** and does not use the system resolver for SRV queries. Result: `argotunnel.com` is unresolvable, and the tunnel precheck fails entirely.

**Diagnosis**: `cloudflared tunnel run` starts, precheck shows all FAIL, logs contain `lookup argotunnel.com: no such host`.

**Fixes**:
- Cleanest: **do not run TUN mode** on the machine running cloudflared. Regular proxy mode (non-TUN) does not affect this.
- Alternative: run cloudflared on a machine without TUN (e.g., a cloud server), then connect back to the local machine via SSH reverse tunnel.
- Adding edge IPs to the hosts file **only works for the system resolver**, not for Go binaries. Do not waste time on this.

### Named tunnel returns 1016/530 errors even though tunnel is healthy

The tunnel shows 4 connections, SSH is working, localhost is reachable, but requests never reach cloudflared (no request logs). This is likely an API token permission issue or Cloudflare edge routing problem.

**Fallback**: use a Quick Tunnel (`cloudflared tunnel --url http://localhost:PORT`) to get a temporary URL, then put a Cloudflare Worker in front as a reverse proxy bound to a stable domain:

```
Stable domain (mcp.example.com)
  ↓ Cloudflare Worker (reverse proxy)
Quick tunnel URL (xxx-xxx-xxx.trycloudflare.com)
  ↓
cloudflared quick tunnel
  ↓
local bridge
```

**Caveat**: the quick tunnel URL changes when cloudflared restarts. You must manually update the Worker's target URL. This is suitable for temporary setups or as an emergency fallback when named tunnels fail.

### Local machine is behind NAT and cannot run cloudflared directly

When the local machine is behind NAT and cannot accept inbound connections (DNS hijacked, no public IP, etc.), use a cloud server with a public IP as a jump host:

```bash
# Local → Cloud server: map local port 3399 to cloud server's 127.0.0.1:3399
ssh -R 3399:127.0.0.1:3399 -N -o ServerAliveInterval=60 admin@cloud-server
```

Then run cloudflared on the cloud server with `--url http://localhost:3399`. Traffic path:

```
ChatGPT → CF edge → cloudflared (cloud server) → SSH tunnel → local bridge
```

**Key points**:
- Use `-N` (no remote command) and `-o ServerAliveInterval=60` (keepalive).
- Cloud server sshd should have `GatewayPorts no` (default), ensuring port 3399 binds only to 127.0.0.1.
- For auto-reconnect on disconnect, use `autossh` or a systemd service.

### stdio-only MCP server needs a minimal HTTP bridge

Many MCP servers only ship with stdio transport. ChatGPT requires Streamable HTTP. You can write a minimal bridge — **no MCP SDK Server layer needed**, just pure JSON-RPC forwarding:

```
HTTP POST /mcp  →  read JSON-RPC body  →  write to child process stdin
child process stdout  →  parse JSON-RPC response  →  HTTP response
```

Key implementation points:
- **Child process management**: spawn once, keep alive. stdin/stdout use JSON lines protocol.
- **Session ID**: extract from `mcp-session-id` header, maintain session→child mapping, 30-minute TTL cleanup.
- **Start child on initialize**, kill on session expiry.
- **stdout parsing**: MCP's stdio transport uses Content-Length header framing (like LSP), not pure JSON lines.
- **OAuth and MCP endpoint in the same Express service** reduces deployment complexity.

Alternatively, use `mcp-proxy` (mentioned earlier) for a ready-made solution.

---

## ChatGPT-specific OAuth details

### CIMD (Custom Identity / Managed Discovery) pitfalls

ChatGPT's OAuth flow has several easy-to-miss requirements:

- **redirect_uri must match exactly**: The `redirect_uri` registered in OAuth DCR must match character-for-character what ChatGPT actually uses. Otherwise the authorization endpoint rejects it immediately.
- **OAuth metadata endpoints must return `no-store`**: Responses from `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server` must include `Cache-Control: no-store`. Otherwise ChatGPT caches stale metadata.
- **PUBLIC_URL must be the public address**: The OAuth metadata returned by your bridge must contain publicly accessible URLs (e.g., `https://mcp.example.com`), not `localhost:3399`.
- **WWW-Authenticate header format**: 401 responses must return `WWW-Authenticate: Bearer realm="mcp"`. ChatGPT uses this header to trigger the OAuth flow. Without it, ChatGPT will not proceed to authorization.
- **302 redirects are unreliable**: Do not return 302 from the authorization endpoint. Return an HTML page or JSON directly. ChatGPT's HTTP client handles 302 inconsistently.
