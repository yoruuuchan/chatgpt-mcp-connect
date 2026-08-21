---
name: chatgpt-mcp-connect
description: Connect a custom MCP server to ChatGPT. Use when the user asks whether an MCP can be used by ChatGPT, or asks to expose, deploy, authenticate, configure, or connect a custom MCP for ChatGPT. Covers hosted and local Streamable HTTP, stdio bridging, OAuth 2.1, Cloudflare Workers/Tunnel, Tailscale Funnel, and real verification inside ChatGPT.
---

# chatgpt-mcp-connect

Use this skill when the target client is **ChatGPT**.

## Start from here, not from first principles

ChatGPT can use custom remote MCP servers. Do not spend the task rediscovering that, and do not re-research the basic architecture. It requires four things at once:

```
public HTTPS URL  +  Streamable HTTP  +  OAuth 2.1 (DCR + PKCE)  +  a tool count it accepts
```

Everything you do is to satisfy those four. Read [`docs/architecture.md`](./docs/architecture.md) in this repo for the full map.

## Decide before you build

Answer two questions about the user's MCP server, then follow the matching recipe in [`recipes/`](./recipes/):

| Speaks HTTP? | Has OAuth? | Do this |
|---|---|---|
| yes | no | Deploy [`templates/oauth-gateway`](./templates/oauth-gateway/) in front of it |
| no (stdio) | no | Add `mcp-proxy` first, then the gateway — see [`recipes/blender`](./recipes/blender/) |
| yes | yes | Expose it only — see [`recipes/devspace`](./recipes/devspace/) |

If it already speaks Streamable HTTP on a **public hosted HTTPS endpoint** but only has static Bearer/API-key auth, use the [`mcdonalds`](./recipes/mcdonalds/) pattern instead of tunneling it through a workstation: terminate ChatGPT OAuth in a Cloudflare Worker and proxy directly to the hosted upstream.

Then pick an exposure: Cloudflare Tunnel (token mode is fastest), Cloudflare Tunnel with local YAML (headless/WSL/systemd), Tailscale Funnel (no domain needed), or a pure Cloudflare Worker custom domain when the upstream is already public.

Reuse whatever the user already has — an existing Cloudflare account, domain, tunnel, or identity provider — before creating anything new.

## Workflow

1. **Inspect the MCP server first.** Project path, runtime device, startup command, transport, local endpoint, existing auth. Confirm `initialize`, `tools/list`, and one representative `tools/call` work locally. Do not start integration work on a server that isn't working yet.

2. **Get it onto Streamable HTTP.** Use the server's own HTTP flag if it has one, binding to `127.0.0.1`. If it's stdio-only, put `mcp-proxy` in front:
   ```bash
   npx --yes mcp-proxy@6.7.0 --host 127.0.0.1 --port 9877 --server stream -- <stdio command>
   ```
   A tunnel does not convert stdio to HTTP. The bridge is a separate mandatory layer.

3. **Add OAuth 2.1.** Prefer, in order: the server's built-in OAuth → Cloudflare Access managed OAuth (zero code) → a Cloudflare Worker → [`templates/oauth-gateway`](./templates/oauth-gateway/). For an already-hosted public MCP with static upstream auth, prefer the Worker pattern because it removes the tunnel and workstation from the request path. Verify the server publishes protected-resource metadata at the **path-suffixed** URL (`/.well-known/oauth-protected-resource/mcp`), authorization-server metadata with `registration_endpoint` and PKCE `S256`, and returns **401** — not 500 — for an unauthenticated request.

4. **Expose it** on a stable HTTPS hostname. For a local MCP, keep the origin on `http://127.0.0.1:<port>` and expose only through the chosen ingress. For an already-hosted MCP behind a Worker facade, proxy directly to the public upstream instead.

5. **Check every layer before touching ChatGPT:**
   ```bash
   node scripts/doctor.mjs --url https://<host> --upstream 127.0.0.1:<mcp> --gateway 127.0.0.1:<gw>
   ```
   Fix the first failing layer before looking at anything below it.

6. **Connect it in ChatGPT** and complete the OAuth flow. The UI path and the plan availability change often — check current OpenAI documentation rather than remembered menu names.

7. **Make every runtime dependency durable.** For local MCPs, a connector that dies at logout isn't done: see [`templates/supervisor`](./templates/supervisor/). GUI-dependent servers need an interactive desktop session, so trigger at logon, not "whether user is logged on or not". A pure hosted-MCP + Worker path has no workstation process to supervise.

## Acceptance

Not done until, inside ChatGPT:

```
tools are discovered
OAuth completes
one read-only tool call succeeds
one representative real tool call succeeds and returns correct data
failures return explicit, diagnosable errors
```

A green tunnel, a healthy `/healthz`, or a successful `tools/list` from curl is not acceptance. Report honestly if the last step was not reached.

## When something breaks

[`docs/troubleshooting.md`](./docs/troubleshooting.md) has the real failures. The two worth knowing before you start, because they waste the most time:

- **Auth failures return 500 instead of 401.** Two unrelated causes, identical symptom: two copies of `@modelcontextprotocol/sdk` loaded (CJS + ESM, so `instanceof` never matches), or `trust proxy` set to `true` instead of `'loopback'`. Check both.
- **Too many tools.** Large tool sets get rejected or truncated. Expose fewer, or use a server with compound tools.

## Security

Read [`docs/security.md`](./docs/security.md) before exposing anything. Several of these servers give an authenticated caller arbitrary code execution. Turn off tools the user doesn't need, scope filesystem roots to actual project directories, bind local ports to loopback, and tell the user plainly what the blast radius is — do not expose a write-capable or code-executing MCP without saying so first.

## Handoff record

```yaml
name:
runtime_device:
local_mcp: { transport:, endpoint:, command: }
bridge:    { needed:, tool:, port: }
public_mcp_url:
exposure:  { type:, hostname: }
auth:      { pattern:, scope: }
supervision:
chatgpt:   { tools_discovered:, read_test:, representative_test: }
result:
not_verified:
```

## Freshness

Verify from current official sources at implementation time: ChatGPT's UI path and current product naming, plan availability, ChatGPT's OAuth redirect URIs, the practical tool-count ceiling, and current MCP authorization spec details. The architecture above has been stable; the product surface on top of it has not.
