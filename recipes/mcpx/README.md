# MCPX → ChatGPT

> Put one persistent MCP runtime between ChatGPT and your local development environment, then attach Workspaces, Skills, and upstream MCP servers behind it instead of creating a separate ChatGPT connector for every tool.

| | |
|---|---|
| **Upstream** | [opentokenz/mcpx](https://github.com/opentokenz/mcpx) · Apache-2.0 · tested at `v0.9.7` / `0d2904c` |
| **Transport** | Native Streamable HTTP on `127.0.0.1:9090/mcp` — no bridge needed |
| **Auth** | Built-in OAuth 2.1 for remote clients; Bearer is also available for local clients |
| **Exposure** | Cloudflare Tunnel to the MCPX origin; tested deployment managed the tunnel with systemd in WSL2 |
| **Status** | Verified 2026-08-21 on Windows 11 + WSL2 Ubuntu 24.04: MCPX running on `:9090`, built-in OAuth exposed through Cloudflare Tunnel, ChatGPT connector completed. This recipe records that deployment; credentials and private hostnames are intentionally omitted. |

## What this is

MCPX is different from the other recipes in this repo. Most recipes expose **one leaf MCP server** to ChatGPT. MCPX is an **MCP runtime / aggregation layer**:

```text
ChatGPT
   │
   │ OAuth 2.1 + Streamable HTTP
   ▼
MCPX Runtime
   ├── Workspace / files / edits / terminal / tasks
   ├── local Skills
   └── upstream MCP servers
          ├── AMap
          ├── GitHub
          └── anything else MCPX can discover
```

That changes the integration question. If you have several local MCP servers or Skills, you do not necessarily need one public hostname, OAuth deployment, and ChatGPT connector per server. You can expose MCPX once, then let MCPX discover and call the extensions behind it through its stable public tool surface.

At the tested `v0.9.7`, MCPX exposed 19 public tools, including `skill_tool` and `mcp_tool`. The upstream tool schemas are discovered on demand rather than flattened into ChatGPT's top-level `tools/list`. That is useful when the leaf servers collectively have more tools than a single client wants to ingest.

MCPX also separates the temporary MCP transport session from its own persistent `remote_session_id`, so a Workspace session can survive reconnects and client handoffs.

## Tested environment

The deployment this recipe was derived from used:

- Windows 11
- WSL2 Ubuntu 24.04 with systemd
- MCPX `v0.9.7`, commit [`0d2904c`](https://github.com/opentokenz/mcpx/commit/0d2904c0578f1786e185f2078b16c3de9846f5f0)
- binary installed at `~/.local/bin/mcpx`
- MCPX listening on `127.0.0.1:9090`
- an existing named Cloudflare Tunnel, kept alive by a systemd unit
- ChatGPT connected through MCPX's built-in OAuth flow

The exact hostname, tunnel UUID, OAuth password, and client credentials are private deployment state and are not copied into this repository.

## 1. Install MCPX and register a Workspace

Use the upstream release or build from source. Check the upstream README for the current installation requirements because MCPX moves quickly.

Verify the binary:

```bash
mcpx -version
```

Register at least one Workspace:

```bash
mcpx workspace register /path/to/your/project
```

Start the runtime:

```bash
mcpx
```

The default endpoint is:

```text
http://127.0.0.1:9090/mcp
```

Use an MCP `initialize` request rather than a bare `GET /mcp` as the local protocol probe:

```bash
curl -sS -m 5 \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl","version":"0.1"}}}' \
  http://127.0.0.1:9090/mcp
```

A response identifying the server as MCPX means the transport layer is alive.

## 2. Enable MCPX's built-in OAuth

For a browser-based remote MCP client, keep MCPX bound to loopback and configure OAuth in `~/.mcpx/config.yaml`:

```yaml
server:
  host: 127.0.0.1
  port: 9090
  disable_localhost_protection: true
  trust_proxy_headers: true

auth:
  mode: oauth
  oauth:
    password: "replace-with-a-strong-random-secret"
    server_url: "https://mcpx.example.com"
    token_ttl: 86400

security:
  commands:
    default: confirm
```

`server_url` is the public **origin**, without `/mcp`.

For public deployment, do not leave `auth.mode: open`. MCPX also supports `bearer` and `dual`, but ChatGPT's Remote MCP flow is the reason to use `oauth` here.

MCPX publishes the OAuth discovery and authorization endpoints itself. There is no separate `templates/oauth-gateway` process in this topology.

## 3. Expose the whole MCPX origin through Cloudflare Tunnel

The tested deployment reused an existing named Cloudflare Tunnel and ran cloudflared under systemd. The portable local-config shape is:

```yaml
# /etc/cloudflared/config.yml

tunnel: <your-tunnel-id>
credentials-file: /home/<you>/.cloudflared/<your-tunnel-id>.json

ingress:
  - hostname: mcpx.example.com
    service: http://127.0.0.1:9090
  - service: http_status:404
```

Route the hostname and run cloudflared as a service using the same pattern as the [WebCodex recipe](../webcodex/).

Proxy the **whole hostname**, not only `/mcp`. MCPX's OAuth flow also needs its `/.well-known/...` metadata and `/mcp/oauth/...` endpoints to reach the runtime.

Verify the public metadata:

```bash
curl -i https://mcpx.example.com/.well-known/oauth-protected-resource/mcp
curl -i https://mcpx.example.com/.well-known/oauth-authorization-server
```

Then run this repo's layered doctor. MCPX itself is both the MCP server and OAuth server, so there is intentionally no `--gateway` argument:

```bash
node scripts/doctor.mjs \
  --url https://mcpx.example.com \
  --upstream 127.0.0.1:9090
```

## 4. Add MCPX in ChatGPT

Add this endpoint as the custom MCP URL:

```text
https://mcpx.example.com/mcp
```

ChatGPT should discover MCPX's OAuth metadata and complete the authorization flow against MCPX itself.

After authorization, verify the runtime rather than stopping at tool discovery:

1. list registered Workspaces;
2. open a Remote Session for one Workspace;
3. perform a read-only operation such as reading a known file or project state;
4. make one representative stateful call appropriate to the Workspace;
5. reconnect and confirm the returned `remote_session_id` can be resumed when that is part of your workflow.

Do not confuse the transport `Mcp-Session-Id` with MCPX's persistent `remote_session_id`.

## 5. Put upstream MCP servers behind MCPX

This is the reason MCPX belongs in this repo as its own architectural path.

MCPX reads global upstream configuration from:

```text
~/.mcpx/.mcp.json
```

It can also merge Workspace-level MCP configs. A simple stdio upstream looks like this:

```json
{
  "mcpServers": {
    "example": {
      "type": "stdio",
      "command": "your-command",
      "args": ["your-args"],
      "env": {
        "YOUR_API_KEY": "${YOUR_API_KEY}"
      }
    }
  }
}
```

The model reaches these servers through MCPX's `mcp_tool` list / describe / call lifecycle instead of receiving every upstream tool as a new top-level ChatGPT tool.

### Example: AMap as an upstream MCP

[sugarforever/amap-mcp-server](https://github.com/sugarforever/amap-mcp-server) supports stdio directly, so it is a good example of a server that does **not** need its own public tunnel or OAuth endpoint when it sits behind MCPX:

```json
{
  "mcpServers": {
    "amap": {
      "type": "stdio",
      "command": "uvx",
      "args": ["amap-mcp-server"],
      "env": {
        "AMAP_MAPS_API_KEY": "${AMAP_MAPS_API_KEY}"
      }
    }
  }
}
```

Keep the real API key outside Git. After restarting or refreshing MCPX discovery, use `mcp_tool` to list the server, describe the route-planning tool you need, then call it.

AMap is an **example inside the MCPX recipe**, not a separate ChatGPT connection recipe: by itself its Streamable HTTP mode already matches the ordinary HTTP + OAuth-fronting shape covered elsewhere in this repository.

## 6. Skills use the same aggregation idea

MCPX can discover local Skills and expose them through the stable `skill_tool` interface. The important design point is the same as upstream MCP aggregation: ChatGPT talks to one runtime surface, while the runtime handles extension discovery and revision consistency behind it.

Use this path when your goal is a persistent development runtime with a changing set of local capabilities, not merely one application-specific MCP server.

## Supervision and WSL

A runtime path has more state worth preserving than a disposable leaf server. Keep both MCPX and the tunnel durable.

On WSL, remember the trap documented in the [WebCodex recipe](../webcodex/): systemd units disappear when the distro itself shuts down. If the machine must remain reachable after all WSL terminals close, keep the distro alive with the existing WSL keepalive pattern.

For the tested deployment, the Cloudflare tunnel service was confirmed running under systemd. If MCPX itself is run as a foreground process instead of a service/daemon, make its lifecycle equally explicit.

## Common errors

### OAuth metadata works locally but not publicly

The tunnel is probably routing only `/mcp` or `server_url` does not match the public origin. Proxy the whole hostname and keep `server_url` equal to `https://<host>` with no path.

### ChatGPT reconnect asks for authorization again

A connector reauthorization is not the same thing as losing an MCPX Remote Session. OAuth/client state and `remote_session_id` are separate layers. Reauthorize the connector, then resume the existing Remote Session if its runtime state is still present.

### Upstream MCP exists in config but is not callable

Check MCPX's merged MCP configuration and discovery first. An upstream stdio process can fail independently even while the public MCPX connector itself is completely healthy.

That distinction is important when debugging aggregation: `ChatGPT → MCPX` can pass while `MCPX → upstream MCP` fails.

### Too many leaf tools

Do not automatically flatten every upstream server into a separate ChatGPT connector. MCPX's stable `mcp_tool` / `skill_tool` interface is precisely the alternative: discover and call leaf capabilities on demand behind one runtime.

## Security notes

MCPX is a high-blast-radius server by design. Depending on Workspace policy, an authenticated caller can read and edit project files, run commands, call Skills, and invoke upstream MCP servers.

Use the runtime's own policy controls instead of treating OAuth as the only boundary:

- keep the listener on `127.0.0.1`;
- use OAuth or another authenticated mode for public access;
- scope Workspaces to the actual project directories;
- make unknown commands `confirm` or `deny` rather than permissive by default;
- keep upstream MCP credentials out of Git;
- review what each Skill and upstream MCP adds to the effective blast radius;
- preserve MCPX's audit/state data as sensitive local state.

See [`docs/security.md`](../../docs/security.md) for the repo-wide model.

## Known limitations

- MCPX is a runtime, not a sandbox. Aggregating tools behind it makes operations easier; it does not make dangerous tools safe.
- Extension failures need to be diagnosed at two layers: the MCPX public endpoint and the MCPX → extension path.
- MCPX evolves quickly. Tool names, counts, config fields, and authorization details should be checked against the upstream version you actually deploy.
- This recipe records a real `v0.9.7` deployment from 2026-08-21. It does not claim that every later MCPX release has been re-verified against ChatGPT.

## Attribution

| Component | Source | License |
|---|---|---|
| MCPX runtime | [opentokenz/mcpx](https://github.com/opentokenz/mcpx) | Apache-2.0 |
| AMap example | [sugarforever/amap-mcp-server](https://github.com/sugarforever/amap-mcp-server) | see upstream repository |
| This recipe | This repo (`chatgpt-mcp-connect`) | MIT |

The upstream projects do not endorse or maintain this integration recipe.
