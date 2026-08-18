# Recipes

Seven paths that were actually built and run. Pick the one whose *shape* matches yours — the specific application matters much less than whether your server speaks HTTP and where you want OAuth to happen.

## Pick by shape

| If your MCP server… | Start from |
|---|---|
| already speaks Streamable HTTP, has no auth | [davinci-resolve](./davinci-resolve/) — the canonical path |
| is stdio only | [blender](./blender/) or [kimi-computer-use](./kimi-computer-use/) — both add a bridge first |
| already has its own OAuth | [devspace](./devspace/) or [webcodex](./webcodex/) — you only need to expose it |
| should stay reachable while the workstation sleeps | [comfyui](./comfyui/) — OAuth at the edge, in a Worker |
| is on a machine with no domain and no Cloudflare account | [devspace](./devspace/) — Tailscale Funnel |
| runs in Docker inside WSL | [webcodex](./webcodex/) — tunnel as a systemd unit, plus the WSL keepalive trap |
| has dangerous tools you'd rather not expose | [windows-desktop](./windows-desktop/) — tool exclusion as a first-class step |

## Full comparison

| | Upstream | License | Transport | Bridge | Auth | Exposure |
|---|---|---|---|---|---|---|
| [davinci-resolve](./davinci-resolve/) | [samuelgursky/davinci-resolve-mcp](https://github.com/samuelgursky/davinci-resolve-mcp) | MIT | HTTP native | — | local gateway | CF Tunnel, token |
| [windows-desktop](./windows-desktop/) | [CursorTouch/Windows-MCP](https://github.com/CursorTouch/Windows-MCP) | MIT | HTTP native | — | local gateway | CF Tunnel, token |
| [blender](./blender/) | [ahujasid/blender-mcp](https://github.com/ahujasid/blender-mcp) | MIT | stdio | mcp-proxy | local gateway | CF Tunnel, token |
| [comfyui](./comfyui/) | [artokun/comfyui-mcp](https://github.com/artokun/comfyui-mcp) | MIT | HTTP native | — | CF Worker | Worker + Tunnel |
| [kimi-computer-use](./kimi-computer-use/) | Moonshot Kimi CU | proprietary | stdio | mcp-proxy | CF Access managed | CF Tunnel, token |
| [devspace](./devspace/) | [Waishnav/devspace](https://github.com/Waishnav/devspace) | MIT | HTTP native | — | built in | Tailscale Funnel |
| [webcodex](./webcodex/) | [yyjeqhc/webcodex](https://github.com/yyjeqhc/webcodex) | Apache-2.0 | HTTP native | — | built in | CF Tunnel, local YAML |

## Choosing an auth pattern

Ordered by how much code you end up maintaining.

**Built in** — nothing to do. Check for it before building anything; DevSpace and WebCodex both ship OAuth and people miss it.

**Cloudflare Access managed OAuth** — a Zero Trust application of type `mcp`. Cloudflare runs the whole flow; you write zero code and the tunnel validates the JWT. Best choice if you're already on Cloudflare and don't need a custom consent screen. Ties you to Cloudflare. See [kimi-computer-use](./kimi-computer-use/).

**Cloudflare Worker** — your own Worker with `@cloudflare/workers-oauth-provider`, state in KV. More work than Access, less than a gateway, and the auth layer stays up independently of your workstation. Costs a second hostname. See [comfyui](./comfyui/).

**Local gateway** — [`templates/oauth-gateway`](../templates/oauth-gateway/), a Node process on the same machine. Works anywhere, no cloud dependency beyond the tunnel, small enough to read end to end. This is the default recommendation, and it's what three of the seven use.

## Choosing an exposure pattern

**Cloudflare Tunnel, token mode** — `cloudflared tunnel run --token-file <file>`, ingress in the dashboard. Fastest to get working. Needs a domain on Cloudflare.

**Cloudflare Tunnel, local YAML** — `config.yml` plus a credentials file. Version-controllable, works headless, no dashboard needed to change routing. What you want on Linux or WSL with systemd. Remember the `http_status:404` catch-all at the end of the ingress list, or `cloudflared` won't start.

**Tailscale Funnel** — `tailscale funnel <port>`. No domain, no DNS, no Cloudflare account. You don't get to choose the hostname, and access control is coarser.

## Every recipe follows the same structure

So you can skim across them:

1. What this is
2. Tested environment
3. Prerequisites
4. Get the MCP server running locally
5. Make it speak Streamable HTTP *(only where a bridge is needed)*
6. Put OAuth in front of it
7. Expose it on a public HTTPS URL
8. Add it in ChatGPT
9. Verify the whole chain
10. Common errors
11. Security notes
12. Known limitations
13. Attribution

Each opens with a status line saying what was verified and when. Where an application wasn't running at verification time — ComfyUI and Blender were both stopped on 2026-08-18 — the recipe says so instead of implying end-to-end coverage it doesn't have.

## Before you start

Read [`../docs/architecture.md`](../docs/architecture.md) if you're unsure which shape you're in, and [`../docs/security.md`](../docs/security.md) before exposing anything — several of these recipes hand an authenticated caller arbitrary code execution on your machine, and the docs say plainly which ones.
