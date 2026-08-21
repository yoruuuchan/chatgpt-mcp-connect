# McDonald's China MCP → ChatGPT

> Put ChatGPT-compatible OAuth 2.1 in front of McDonald's official hosted Streamable HTTP MCP server, without OpenAI Secure MCP Tunnel and without any always-on workstation process.

| | |
|---|---|
| **Upstream** | McDonald's China official MCP · `https://mcp.mcd.cn` |
| **Transport** | Streamable HTTP |
| **Upstream auth** | Static `Authorization: Bearer <MCP_TOKEN>` |
| **ChatGPT auth** | Cloudflare Worker + `@cloudflare/workers-oauth-provider` |
| **Exposure** | Cloudflare Worker custom domain only; no Tunnel |
| **Status** | Verified-good 2026-08-21 — real McDonald's token, ChatGPT OAuth connection, and a real read-only account tool call all succeeded |

## Architecture

```text
ChatGPT
  │ OAuth 2.1
  ▼
https://mcd-mcp.yoru-and-akari.dev/mcp
  │ Cloudflare Worker swaps OAuth bearer → McDonald's MCP bearer
  ▼
https://mcp.mcd.cn
```

This is the edge-OAuth pattern from the ComfyUI recipe with the local origin and Cloudflare Tunnel removed. McDonald's already operates the upstream as a public HTTPS Streamable HTTP MCP server, so a second tunnel would add failure modes without adding connectivity.

## Secrets

The Worker expects one Cloudflare secret:

- `MCD_MCP_TOKEN` — token issued by the McDonald's MCP console.

The OAuth approval passphrase is deterministically derived from that token with SHA-256 and a domain-separated label. The McDonald's token itself is never submitted through the approval form, and no second secret needs to be stored or rotated. The token belongs only in Cloudflare Secrets, never Git or `wrangler.jsonc`.

## Deploy

```bash
cd recipes/mcdonalds
npm install
wrangler secret put MCD_MCP_TOKEN
wrangler deploy
```

The OAuth KV namespace is bound as `OAUTH_KV`; the custom domain is `mcd-mcp.yoru-and-akari.dev`.

## Verify before ChatGPT

```bash
curl -i https://mcd-mcp.yoru-and-akari.dev/healthz
# 200 {"ok":true,"gateway":true}

curl -i -X POST https://mcd-mcp.yoru-and-akari.dev/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
# 401 is correct: the Worker must reject unauthenticated MCP requests.
```

Then add `https://mcd-mcp.yoru-and-akari.dev/mcp` as the ChatGPT MCP endpoint, complete OAuth, and verify `tools/list` plus at least one real read-only McDonald's tool call.

Verified on 2026-08-21 from ChatGPT: OAuth completed successfully and `query-my-account` returned HTTP 200 through the full ChatGPT → Worker → McDonald's MCP chain. No account identifiers or token values are recorded here.

## Upstream compatibility note

McDonald's documentation currently says its MCP server supports MCP protocol version `2025-06-18` and earlier, with a per-token rate limit of 600 requests/minute. Do not add protocol rewriting unless a real ChatGPT integration test demonstrates that it is necessary.
