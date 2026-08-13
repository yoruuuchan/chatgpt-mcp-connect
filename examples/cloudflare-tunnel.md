# Cloudflare Tunnel example

Use this path when the MCP runs on a local machine or private network but already exposes a Remote MCP / Streamable HTTP endpoint.

## Target shape

```text
ChatGPT
  ↓
https://mcp.example.com/mcp
  ↓
Cloudflare Tunnel
  ↓
http://127.0.0.1:8787/mcp
```

## Checklist

1. Confirm the local MCP works directly.
2. Confirm its transport is Remote MCP / Streamable HTTP.
3. Reuse an existing Cloudflare account, domain, `cloudflared` installation, and tunnel when practical.
4. Route a dedicated hostname to the local MCP origin.
5. Keep the MCP path stable, normally `/mcp`.
6. Verify the public HTTPS hostname reaches the correct MCP service.
7. Add OAuth before exposing private data or write-capable tools to ChatGPT.
8. Finish with a real ChatGPT tool call.

## Important transport detail

Cloudflare Tunnel forwards network traffic. It does **not** convert a stdio MCP server into a Remote MCP server.

For stdio-only MCPs, first add a Streamable HTTP entry point around the existing MCP implementation, then place the tunnel in front of that HTTP endpoint.

## Record

```yaml
cloudflare:
  tunnel_name:
  tunnel_id:
  hostname:
  origin: http://127.0.0.1:8787
  mcp_path: /mcp
```
