---
name: chatgpt-mcp-connect
description: Connect custom MCP servers or an MCP runtime to ChatGPT. Use when the user asks whether an MCP can be used by ChatGPT, or asks to expose, deploy, authenticate, configure, aggregate, or connect MCP capabilities for ChatGPT. Covers direct leaf servers, MCPX runtime aggregation, hosted and local Streamable HTTP, stdio bridging, OAuth 2.1, Cloudflare Workers/Tunnel, Tailscale Funnel, and real verification inside ChatGPT.
---

# chatgpt-mcp-connect

Use this skill when the target client is **ChatGPT**.

## Start from here, not from first principles

ChatGPT can use custom remote MCP servers. Do not spend the task rediscovering that, and do not re-research the basic architecture. The public MCP boundary needs four things at once:

```text
public HTTPS URL  +  Streamable HTTP  +  OAuth 2.1 (DCR/compatible client registration + PKCE)  +  a tool count it accepts
```

Everything you do is to satisfy those four. Read [`docs/architecture.md`](./docs/architecture.md) in this repo for the full map.

## Decide the public boundary before you build

First ask: **is the user exposing one leaf MCP, or do they actually want one persistent connection to several Workspaces, Skills, or MCP servers?**

| Goal | Do this |
|---|---|
| One application-specific MCP | Follow the direct leaf-server decision table below |
| Several local MCPs / Skills / Workspaces behind one connector | Start from [`recipes/mcpx`](./recipes/mcpx/) and use MCPX as the runtime boundary |

Do not automatically build one public OAuth + tunnel + ChatGPT connector per stdio server when the user's real goal is aggregation. MCPX can keep stdio upstream MCPs private behind the runtime and expose them through its stable `mcp_tool` interface.

For a **direct leaf server**, answer two questions and follow the matching recipe in [`recipes/`](./recipes/):

| Speaks HTTP? | Has OAuth? | Do this |
|---|---|---|
| yes | no | Deploy [`templates/oauth-gateway`](./templates/oauth-gateway/) in front of it |
| no (stdio) | no | Add `mcp-proxy` first, then the gateway — see [`recipes/blender`](./recipes/blender/) |
| yes | yes | Expose it only — see [`recipes/devspace`](./recipes/devspace/) |

If it already speaks Streamable HTTP on a **public hosted HTTPS endpoint** but only has static Bearer/API-key auth, use the [`mcdonalds`](./recipes/mcdonalds/) pattern instead of tunneling it through a workstation: terminate ChatGPT OAuth in a Cloudflare Worker and proxy directly to the hosted upstream.

Then pick an exposure: Cloudflare Tunnel (token mode is fastest), Cloudflare Tunnel with local YAML (headless/WSL/systemd), Tailscale Funnel (no domain needed), or a pure Cloudflare Worker custom domain when the upstream is already public.

Reuse whatever the user already has — an existing Cloudflare account, domain, tunnel, identity provider, runtime, or verified deployment — before creating anything new.

## Workflow

1. **Inspect the capability boundary first.** Determine whether this should be a direct leaf connection or a runtime aggregation connection. For a leaf MCP, inspect project path, runtime device, startup command, transport, local endpoint, and existing auth. For MCPX, inspect the runtime version, registered Workspaces, built-in auth mode, and which Skills/upstream MCPs actually need to be reachable.

2. **Verify the local boundary before integration work.** Confirm `initialize`, `tools/list`, and one representative call work locally. For an aggregation runtime, also verify at least one representative extension path locally (`runtime → Skill` or `runtime → upstream MCP`). Do not start public integration work on a boundary that is already broken.

3. **Get the public boundary onto Streamable HTTP.** Use the server's own HTTP flag if it has one, binding to `127.0.0.1`. If a direct leaf server is stdio-only, put `mcp-proxy` in front:
   ```bash
   npx --yes mcp-proxy@6.7.0 --host 127.0.0.1 --port 9877 --server stream -- <stdio command>
   ```
   A tunnel does not convert stdio to HTTP. The bridge is a separate mandatory layer for the **direct** path. If the leaf server is intentionally behind MCPX, configure it as an MCPX upstream instead of creating a public bridge solely for ChatGPT.

4. **Add OAuth 2.1 at the public boundary.** Prefer, in order: the server/runtime's built-in OAuth → Cloudflare Access managed OAuth → a Cloudflare Worker → [`templates/oauth-gateway`](./templates/oauth-gateway/). For an already-hosted public MCP with static upstream auth, prefer the Worker pattern because it removes the tunnel and workstation from the request path. For MCPX, use MCPX's built-in OAuth; do not put the local gateway template in front of it just because other recipes use one.

5. **Verify OAuth discovery.** The public resource must advertise protected-resource metadata, an authorization server, dynamic client registration or the current supported client-metadata mechanism, and PKCE S256. The MCP endpoint must reject unauthenticated access rather than silently allowing it. Route the whole origin when the built-in auth server needs `/.well-known/...` and authorization/token paths in addition to `/mcp`.

6. **Expose it** on a stable HTTPS hostname. For a local MCP/runtime, keep the origin on `http://127.0.0.1:<port>` and expose only through the chosen ingress. For an already-hosted MCP behind a Worker facade, proxy directly to the public upstream instead.

7. **Check every public-path layer before touching ChatGPT:**
   ```bash
   # direct local gateway path
   node scripts/doctor.mjs --url https://<host> --upstream 127.0.0.1:<mcp> --gateway 127.0.0.1:<gw>

   # built-in OAuth path such as MCPX
   node scripts/doctor.mjs --url https://<host> --upstream 127.0.0.1:9090
   ```
   Fix the first failing layer before looking at anything below it.

8. **Connect it in ChatGPT** and complete the OAuth flow. The UI path and plan availability change often — check current OpenAI documentation rather than remembered menu names.

9. **Verify the real capability, not just the connector.** For a direct leaf MCP, run one read-only and one representative real tool call inside ChatGPT. For MCPX or another runtime, also run one representative call through the runtime into the Workspace / Skill / upstream MCP the user actually cares about. `ChatGPT → runtime` being green does not prove `runtime → extension` is green.

10. **Make every runtime dependency durable.** For local MCPs, a connector that dies at logout isn't done: see [`templates/supervisor`](./templates/supervisor/). WSL/systemd deployments also need the distro itself to remain alive. A pure hosted-MCP + Worker path has no workstation process to supervise.

## Acceptance

Not done until, inside ChatGPT:

```text
tools are discovered
OAuth completes
one read-only tool call succeeds
one representative real tool call succeeds and returns correct data
failures return explicit, diagnosable errors
```

For an aggregation runtime, add:

```text
one representative Workspace / Skill / upstream MCP call succeeds through the runtime
extension failures can be distinguished from public connector failures
```

A green tunnel, healthy OAuth metadata, or a successful `tools/list` from curl is not acceptance. Report honestly if the last step was not reached.

## When something breaks

[`docs/troubleshooting.md`](./docs/troubleshooting.md) has the real failures. The two worth knowing before you start, because they waste the most time:

- **Auth failures return 500 instead of 401.** Two unrelated causes in the local gateway path, identical symptom: two copies of `@modelcontextprotocol/sdk` loaded (CJS + ESM, so `instanceof` never matches), or `trust proxy` set to `true` instead of `'loopback'`. Check both.
- **Too many tools.** Large top-level tool sets get rejected or truncated. Expose fewer, use compound tools, or — when aggregation is genuinely the goal — use a runtime such as MCPX that discovers leaf capabilities behind a stable tool surface.

For runtime aggregation, debug two independent edges:

```text
ChatGPT → runtime
runtime → specific extension
```

Do not rebuild the public connector when only one upstream MCP is failing.

## Security

Read [`docs/security.md`](./docs/security.md) before exposing anything. Several of these servers give an authenticated caller arbitrary code execution. Turn off tools the user doesn't need, scope filesystem roots / Workspaces to actual project directories, bind local ports to loopback, and tell the user plainly what the blast radius is.

For MCPX, the effective blast radius is the union of the runtime's Workspace/command policy plus every enabled Skill and upstream MCP. A stable public tool count does not mean the capability surface is stable.

## Handoff record

```yaml
name:
public_boundary: leaf | runtime
runtime_device:
local_mcp: { transport:, endpoint:, command: }
runtime:   { name:, version:, workspace:, extensions: }
bridge:    { needed:, tool:, port: }
public_mcp_url:
exposure:  { type:, hostname: }
auth:      { pattern:, scope: }
supervision:
chatgpt:   { tools_discovered:, read_test:, representative_test: }
extension_test: { target:, result: }
result:
not_verified:
```

## Freshness

Verify from current official sources at implementation time: ChatGPT's UI path and current product naming, plan availability, ChatGPT's OAuth redirect/client metadata behavior, the practical tool-count ceiling, current MCP authorization details, and the exact upstream version/config fields you are deploying. The architecture above has been stable; the product surfaces and fast-moving MCP runtimes on top of it have not.
