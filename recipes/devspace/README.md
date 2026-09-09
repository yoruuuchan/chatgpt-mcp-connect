# DevSpace → ChatGPT

> Give ChatGPT a secure connection to your local coding workspace — file operations, code search, shell execution, and Git worktree support — over a public HTTPS URL with built-in OAuth 2.1 and Cloudflare Tunnel.

| | |
|---|---|
| **Upstream** | [Waishnav/devspace](https://github.com/Waishnav/devspace) · MIT · `@waishnav/devspace` · tested at `1.0.5`, latest `1.0.7` (2026-08-11) · 3.8k stars |
| **Transport** | Native Streamable HTTP on `127.0.0.1:7676` — no bridge needed |
| **Auth** | Built-in (pattern #4 — DevSpace ships its own OAuth 2.1 authorization server) |
| **Exposure** | Cloudflare Tunnel |
| **Status** | Current deployment 2026-09-09 — migrated from Tailscale Funnel to Cloudflare Tunnel; the original Funnel path was verified 2026-08-18 |

## What this is

DevSpace is one of the simplest MCPs in this repo to expose because it already solves the authentication layer itself.

**Auth:** DevSpace ships its own `SingleUserOAuthProvider`. There is nothing to build. No local gateway, no Cloudflare Worker, and no Cloudflare Access application are required for this recipe. You run `devspace serve` and OAuth 2.1 is already there. In fact, DevSpace's `SingleUserOAuthProvider` is the same component that the [local OAuth gateway template](../../templates/oauth-gateway/) wraps for other recipes.

**Exposure:** the current deployment uses **Cloudflare Tunnel**. `cloudflared` publishes a hostname you control and forwards it to `http://127.0.0.1:7676`; DevSpace remains the OAuth authority behind that tunnel.

The original deployment used **Tailscale Funnel**. It was attractive because `tailscale funnel 7676` gives you a public HTTPS endpoint with almost no setup. On the tested Windows host, however, Funnel became noticeably slower and sometimes unreliable while a system proxy/VPN was active, so the long-running deployment was moved to Cloudflare Tunnel. Funnel is still a valid alternative when you do not have a domain or Cloudflare account.

| | Cloudflare Tunnel | Tailscale Funnel |
|---|---|---|
| Setup | Named tunnel + hostname route | `tailscale funnel 7676` |
| Domain | Your own domain | `<machine>.<tailnet>.ts.net` |
| TLS | Cloudflare edge | Tailscale-managed |
| Auth in this recipe | DevSpace built-in OAuth | DevSpace built-in OAuth |
| Operational fit here | **Current deployment** | Simpler fallback / historical deployment |

**What is ours vs. upstream:**
- **Upstream** — DevSpace itself. You install it from npm; you do not modify it.
- **This recipe** — the integration knowledge: public exposure, supervision, verification, and the security notes below.
- **Our components** — the OAuth gateway template at [`templates/oauth-gateway/`](../../templates/oauth-gateway/) reuses DevSpace's `SingleUserOAuthProvider`, but this recipe does not use the template because DevSpace ships the provider natively.

## Tested environment

- Windows 11
- Node 22+
- Cloudflare-managed domain
- `cloudflared` with a named Tunnel

The previous 2026-08-18 deployment used Tailscale Funnel. The current deployment uses Cloudflare Tunnel.

## Prerequisites

1. **Node >=22.19 <27** (DevSpace's engine requirement).
2. **cloudflared** installed and authenticated, or an existing Cloudflare Tunnel already running on the machine.
3. A hostname on a domain managed by Cloudflare.

## 1. Get the MCP server running locally

Install DevSpace globally:

```powershell
npm install -g @waishnav/devspace@1.0.7
```

Configure it. DevSpace needs a sandbox/working directory and a list of allowed filesystem roots:

```powershell
devspace config
```

Follow the prompts to set your working directory and allowed roots.

> **Scope your allowed roots tightly.** On the tested deployment, the allowed roots were entire drive letters. That is **more permissive than necessary** — it gives ChatGPT file read/write and shell execution across everything on those drives. Set roots to the specific project directories you intend to expose. Do as I say, not as I did.

Start the server:

```powershell
devspace serve
```

Verify:

```powershell
# Should return 200 with OAuth metadata
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:7676/.well-known/oauth-protected-resource/mcp
```

## 3. Put OAuth in front of it

Nothing to do. DevSpace ships its own OAuth 2.1 authorization server (`SingleUserOAuthProvider`). It supports:

- RFC 9728 protected-resource metadata
- RFC 8414 authorization server metadata
- RFC 7591 dynamic client registration
- PKCE S256
- Authorization code grant

When ChatGPT connects, it will discover the OAuth endpoints automatically, redirect you to DevSpace's built-in consent screen, and ask for the **owner token** that DevSpace generated at first run. Find it in DevSpace's config output or logs.

Cloudflare Tunnel is only the ingress layer here. Do not add another OAuth gateway in front of DevSpace. A Cloudflare Access application is also unnecessary for this recipe and can complicate MCP OAuth discovery if inserted without designing the two auth layers together.

## 4. Expose it on a public HTTPS URL

Create or reuse a named Cloudflare Tunnel and map a public hostname to:

```text
http://127.0.0.1:7676
```

For example:

```text
https://devspace.example.com  →  http://127.0.0.1:7676
```

The exact `cloudflared` launch command depends on whether you use dashboard/token mode or local YAML. Both are fine; the important invariant is that the public hostname terminates at the DevSpace listener on port `7676`.

Verify:

```powershell
# Should return 200
curl -s -o /dev/null -w "%{http_code}" https://devspace.example.com/.well-known/oauth-protected-resource/mcp

# Should return 401 (OAuth enforced — this is correct)
curl -s -o /dev/null -w "%{http_code}" https://devspace.example.com/mcp
```

### Autostart (optional)

To keep DevSpace alive across reboots, create a Windows Scheduled Task triggered at interactive logon:

- **Action:** `node` with arguments pointing to the DevSpace entry point, or `devspace serve`.
- **Run whether user is logged on or not:** No — DevSpace needs the interactive session for shell execution.

Run `cloudflared` as a service or another supervised long-running process so the tunnel comes back independently of the interactive shell.

See [`templates/supervisor/`](../../templates/supervisor/) for a supervisor pattern that uses a global mutex and restarts on crash.

## 5. Add it in ChatGPT

1. Go to **ChatGPT → Settings → Connected apps**.
2. Add a new MCP connector with URL: `https://devspace.example.com/mcp`
3. ChatGPT will discover the OAuth endpoints, redirect you to DevSpace's consent screen, and ask for the **owner token**.
4. Enter the owner token.
5. After authorization, ChatGPT should list the DevSpace tools (file operations, code search, shell, Git).

## 6. Verify the whole chain

```bash
# 1. Local — should return 200
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:7676/.well-known/oauth-protected-resource/mcp

# 2. Public metadata — should return 200
curl -s -o /dev/null -w "%{http_code}\n" https://devspace.example.com/.well-known/oauth-protected-resource/mcp

# 3. Public MCP — should return 401 (OAuth enforced; this is CORRECT)
curl -s -o /dev/null -w "%{http_code}\n" https://devspace.example.com/mcp
```

A `401` at step 3 is a **pass**, not a failure — it means OAuth is enforced.

Then in ChatGPT, try: *"List the files in the current workspace."*

## Common errors

### Public hostname returns Cloudflare 502 / origin unreachable

**Symptom:** the Cloudflare hostname resolves, but requests fail before they reach DevSpace.

**Cause:** `cloudflared` cannot reach the local origin, DevSpace is not running, or the Tunnel route points at the wrong port.

**Fix:** first verify `http://127.0.0.1:7676/.well-known/oauth-protected-resource/mcp` locally. Then verify the Tunnel hostname is routed to `http://127.0.0.1:7676`.

### Tunnel hostname is unreachable / Tunnel is down

**Symptom:** Cloudflare reports that the Tunnel is unavailable even though DevSpace itself works locally.

**Cause:** the `cloudflared` connector is stopped or the named Tunnel is not connected.

**Fix:** check the `cloudflared` process/service and the Tunnel status separately from DevSpace. Treat them as two different layers.

### OAuth discovery works locally but fails through the public hostname

**Symptom:** local metadata is healthy, but ChatGPT cannot complete OAuth through the public endpoint.

**Cause:** the hostname is routed to the wrong service, an extra access/authentication layer is intercepting discovery, or forwarded-host/proxy behavior changes the URLs DevSpace advertises.

**Fix:** fetch the public RFC 9728 / RFC 8414 metadata directly and inspect the advertised URLs. They must resolve through the same public hostname ChatGPT uses.

### Tailscale Funnel behaves badly with a system proxy/VPN

This was the reason the tested long-running deployment moved away from Funnel. The old Funnel recipe can still work, especially on a machine with simple networking, but on this Windows setup it became high-latency and intermittently unusable while a proxy/VPN was active. Prefer Cloudflare Tunnel for the current deployment.

## Security notes

- DevSpace binds to `127.0.0.1` only. Cloudflare Tunnel is the public ingress in the current deployment.
- OAuth is enforced by DevSpace on the MCP endpoint. Unauthenticated requests return 401.
- The owner token is a secret — store it like a password.
- **Blast radius depends entirely on your allowed roots.** DevSpace provides file read/write and shell execution inside the allowed filesystem roots. With whole-drive roots, that is effectively the entire user account — any file readable/writable by your user, any command your shell can run. **Scope roots to the specific project directories you want ChatGPT to access.**
- See [`docs/security.md`](../../docs/security.md) for the repo-wide security model.

## Known limitations

- DevSpace's tools are workspace-scoped — powerful, but not domain-specific like DaVinci Resolve or ComfyUI tools. ChatGPT gets generic file and shell access, not a curated API.
- The public endpoint now depends on Cloudflare Tunnel and a domain you control.
- Cloudflare Tunnel solves ingress, not DevSpace process supervision; `devspace serve` still has to be running locally.
- The previous Tailscale Funnel path remains useful as a low-setup alternative, but it is no longer the current deployment for this recipe.

## Attribution

| Component | Source | License |
|---|---|---|
| DevSpace MCP server + SingleUserOAuthProvider | [Waishnav/devspace](https://github.com/Waishnav/devspace) | MIT — Copyright (c) 2026 Waishnav |
| This recipe | This repo (`chatgpt-mcp-connect`) | MIT |

The upstream project does not endorse or ship this integration.
