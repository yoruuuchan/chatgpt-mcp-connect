# DevSpace → ChatGPT

> Give ChatGPT a secure connection to your local coding workspace — file operations, code search, shell execution, and Git worktree support — over a public HTTPS URL with built-in OAuth 2.1 and Tailscale Funnel.

| | |
|---|---|
| **Upstream** | [Waishnav/devspace](https://github.com/Waishnav/devspace) · MIT · `@waishnav/devspace` · tested at `1.0.5`, latest `1.0.7` (2026-08-11) · 3.8k stars |
| **Transport** | Native Streamable HTTP on `127.0.0.1:7676` — no bridge needed |
| **Auth** | Built-in (pattern #4 — DevSpace ships its own OAuth 2.1 authorization server) |
| **Exposure** | Tailscale Funnel |
| **Status** | Verified 2026-08-18 — process running on :7676, Funnel active, `/.well-known/oauth-protected-resource/mcp` reachable |

## What this is

This recipe is the odd one out in this repo — twice over.

**Auth:** DevSpace ships its own `SingleUserOAuthProvider`. There is nothing to build. No local gateway, no Cloudflare Worker, no Cloudflare Access app. You run `devspace serve` and OAuth 2.1 is already there. In fact, DevSpace's `SingleUserOAuthProvider` is the same component that every *other* recipe in this repo reuses — the [local OAuth gateway template](../../templates/oauth-gateway/) wraps it. DevSpace is where it comes from; give credit where it is due.

**Exposure:** This recipe uses **Tailscale Funnel**, not Cloudflare. `tailscale funnel <port>` gives you a public HTTPS URL on a `<your-tailnet>.ts.net` hostname with no domain purchase, no DNS setup, and no Cloudflare account.

**Tradeoffs vs. Cloudflare Tunnel:**

| | Tailscale Funnel | Cloudflare Tunnel |
|---|---|---|
| Setup | `tailscale funnel 7676` — one command | Named tunnel + dashboard config + DNS record |
| Domain | `<machine>.<tailnet>.ts.net` — you do not control the shape | Your own domain |
| TLS | Tailscale manages it end-to-end | Cloudflare terminates at the edge |
| Access control | Funnel ACL in tailnet policy (coarser) | Cloudflare Access policies (finer) |
| Dependency | Tailscale relay infrastructure | Cloudflare edge network |

Both are legitimate choices. Funnel wins on simplicity; Cloudflare wins on control.

**What is ours vs. upstream:**
- **Upstream** — DevSpace itself. You install it from npm; you do not modify it.
- **This recipe** — the integration knowledge: Funnel setup, scheduled-task autostart, and the security notes below.
- **Our components** — the OAuth gateway template at [`templates/oauth-gateway/`](../../templates/oauth-gateway/) reuses DevSpace's `SingleUserOAuthProvider` — but this recipe does not use the template, because DevSpace ships the provider natively.

## Tested environment

- Windows 11
- Node 22+
- Tailscale installed and logged in, Funnel enabled in the tailnet ACL

## Prerequisites

1. **Node >=22.19 <27** (DevSpace's engine requirement).
2. **Tailscale** installed and logged in.
3. **Funnel enabled** in your tailnet. Funnel must be permitted by the tailnet ACL/policy — it is off by default. See [Tailscale docs on Funnel](https://tailscale.com/kb/1223/funnel).

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

## 4. Expose it on a public HTTPS URL

```powershell
tailscale funnel 7676
```

Tailscale will print the public URL — something like `https://<machine>.<tailnet>.ts.net`. That is your MCP endpoint.

Verify:

```powershell
# Should return 200
curl -s -o /dev/null -w "%{http_code}" https://<machine>.<tailnet>.ts.net/.well-known/oauth-protected-resource/mcp

# Should return 401 (OAuth enforced — this is correct)
curl -s -o /dev/null -w "%{http_code}" https://<machine>.<tailnet>.ts.net/mcp
```

### Autostart (optional)

To keep DevSpace alive across reboots, create a Windows Scheduled Task triggered at interactive logon:

- **Action:** `node` with arguments pointing to the DevSpace entry point, or `devspace serve`.
- **Run whether user is logged on or not:** No — DevSpace needs the interactive session for shell execution.

See [`templates/supervisor/`](../../templates/supervisor/) for a supervisor pattern that uses a global mutex and restarts on crash.

## 5. Add it in ChatGPT

1. Go to **ChatGPT → Settings → Connected apps**.
2. Add a new MCP connector with URL: `https://<machine>.<tailnet>.ts.net/mcp`
3. ChatGPT will discover the OAuth endpoints, redirect you to DevSpace's consent screen, and ask for the **owner token**.
4. Enter the owner token.
5. After authorization, ChatGPT should list the DevSpace tools (file operations, code search, shell, Git).

## 6. Verify the whole chain

```bash
# 1. Local — should return 200
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:7676/.well-known/oauth-protected-resource/mcp

# 2. Public — should return 200
curl -s -o /dev/null -w "%{http_code}\n" https://<machine>.<tailnet>.ts.net/.well-known/oauth-protected-resource/mcp

# 3. Public MCP — should return 401 (OAuth enforced; this is CORRECT)
curl -s -o /dev/null -w "%{http_code}\n" https://<machine>.<tailnet>.ts.net/mcp
```

A `401` at step 3 is a **pass**, not a failure — it means OAuth is enforced.

Then in ChatGPT, try: *"List the files in the current workspace."*

## Common errors

### `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` in Express logs

**Symptom:** DevSpace's Express server logs `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` from `express-rate-limit` when accessed through Tailscale Funnel. Non-fatal — requests still succeed.

**Cause:** Tailscale Funnel sets `X-Forwarded-For` but Express is not configured with a matching `trust proxy` setting, so `express-rate-limit` warns about an unexpected forwarded header.

**Fix:** This is a cosmetic warning in DevSpace's upstream code. It does not affect functionality. It is the mirror image of the `trust proxy` trap documented in [`docs/troubleshooting.md`](../../docs/troubleshooting.md) — same root cause, different proxy.

### Funnel URL returns connection refused

**Symptom:** The `ts.net` URL returns an error even though `tailscale funnel` is running.

**Cause:** DevSpace is not running, or it bound to a different port.

**Fix:** Confirm `devspace serve` is running and listening on the port you passed to `tailscale funnel`.

### Funnel not permitted

**Symptom:** `tailscale funnel` returns an error about the feature being disabled.

**Cause:** Funnel is off by default in Tailscale. It must be enabled in the tailnet ACL/policy.

**Fix:** In the Tailscale admin console, update the ACL to allow Funnel for the relevant nodes. See [Tailscale Funnel docs](https://tailscale.com/kb/1223/funnel).

## Security notes

- DevSpace binds to `127.0.0.1` only. The Tailscale Funnel is the sole public ingress.
- OAuth is enforced on the MCP endpoint. Unauthenticated requests return 401.
- The owner token is a secret — store it like a password.
- **Blast radius depends entirely on your allowed roots.** DevSpace provides file read/write and shell execution inside the allowed filesystem roots. With whole-drive roots, that is effectively the entire user account — any file readable/writable by your user, any command your shell can run. **Scope roots to the specific project directories you want ChatGPT to access.**
- See [`docs/security.md`](../../docs/security.md) for the repo-wide security model.

## Known limitations

- DevSpace's tools are workspace-scoped — powerful, but not domain-specific like DaVinci Resolve or ComfyUI tools. ChatGPT gets generic file and shell access, not a curated API.
- The `ts.net` hostname is determined by Tailscale. You cannot choose a custom domain without adding a CNAME (which partially defeats the simplicity argument).
- Tailscale Funnel routes traffic through Tailscale's relay infrastructure. Latency may be higher than a Cloudflare Tunnel in the same region.
- The `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` warning is logged on every proxied request. Harmless but noisy.

## Attribution

| Component | Source | License |
|---|---|---|
| DevSpace MCP server + SingleUserOAuthProvider | [Waishnav/devspace](https://github.com/Waishnav/devspace) | MIT — Copyright (c) 2026 Waishnav |
| This recipe | This repo (`chatgpt-mcp-connect`) | MIT |

The upstream project does not endorse or ship this integration.
