# Architecture

Every recipe in this repo is the same four decisions, answered differently.

## What ChatGPT actually requires

ChatGPT will not talk to your MCP server unless all of this is true at once:

| Requirement | Consequence |
|---|---|
| A public HTTPS URL | localhost is not reachable from OpenAI's servers. Something must terminate TLS on a public hostname. |
| Streamable HTTP transport | A stdio MCP server cannot be connected directly, no matter what you put in front of it. |
| OAuth 2.1 with dynamic client registration and PKCE | ChatGPT registers itself as a client at connect time. There is no field to paste an API key into. |
| A tool count it will accept | Large tool sets get rejected or silently truncated. |

Everything below exists to satisfy those four lines.

## The four decisions

```
                  ┌─ 1. Does it already speak Streamable HTTP? ─┐
                  │                                              │
                 yes                                            no
                  │                                              │
                  │                                    put mcp-proxy in front
                  │                                              │
                  └──────────────────┬───────────────────────────┘
                                     ▼
                  ┌─ 2. Where does OAuth happen? ─────────────────┐
                  │                                               │
        already built in          local gateway          at the edge
        (DevSpace, WebCodex)   (templates/oauth-gateway)  (CF Worker / CF Access)
                  │                                               │
                  └──────────────────┬────────────────────────────┘
                                     ▼
                  ┌─ 3. How does it get a public hostname? ───────┐
                  │                                               │
        Cloudflare Tunnel        Cloudflare Tunnel       Tailscale Funnel
          (token mode)            (local YAML)
                  │                                               │
                  └──────────────────┬────────────────────────────┘
                                     ▼
                     4. What keeps all of it running?
```

### 1. Transport: does it speak Streamable HTTP?

A Cloudflare Tunnel forwards network traffic. It does **not** turn a stdio process into an HTTP server. This is the single most common misunderstanding, and it costs people an afternoon.

- **Already HTTP** — many servers take a `--transport streamable-http` flag or equivalent. Use it. Bind to `127.0.0.1`, never `0.0.0.0`.
- **stdio only** — put [`mcp-proxy`](https://github.com/punkpeye/mcp-proxy) in front of it. It spawns your stdio server as a child process and speaks Streamable HTTP on a port:

  ```bash
  npx --yes mcp-proxy@6.7.0 --host 127.0.0.1 --port 9877 --server stream -- <your stdio command>
  ```

  `--server stream` selects Streamable HTTP rather than SSE. Raise `--connectionTimeout` and `--requestTimeout` if your tools are slow; the defaults will cut off long-running calls.

Recipes using a bridge: [blender](../recipes/blender/), [kimi-computer-use](../recipes/kimi-computer-use/).

### 2. Auth: where does OAuth happen?

Four patterns, in rough order of how much code you end up owning.

| Pattern | You write | State lives in | Choose it when |
|---|---|---|---|
| **Built-in** | nothing | the server's own store | The MCP server already ships OAuth ([devspace](../recipes/devspace/), [webcodex](../recipes/webcodex/)) |
| **Cloudflare Access managed OAuth** | nothing | Cloudflare | You're already on Cloudflare Zero Trust and don't need custom consent ([kimi-computer-use](../recipes/kimi-computer-use/)) |
| **Cloudflare Worker** | a small Worker | Workers KV | You want auth to stay up when the workstation sleeps, or the upstream is already hosted publicly ([comfyui](../recipes/comfyui/), [mcdonalds](../recipes/mcdonalds/)) |
| **Local gateway** | config only, using [`templates/oauth-gateway`](../templates/oauth-gateway/) | local SQLite | Everything else ([davinci-resolve](../recipes/davinci-resolve/), [windows-desktop](../recipes/windows-desktop/), [blender](../recipes/blender/)) |

The local gateway is the default recommendation because it works anywhere, has no cloud dependency beyond the tunnel, and is one process you can read end to end. It does not implement an authorization server — it reuses `SingleUserOAuthProvider` from [DevSpace](https://github.com/Waishnav/devspace) and the auth router from the MCP TypeScript SDK, and adds the reverse proxy and health check.

There is one important exception to that default: if the upstream MCP is **already hosted on public HTTPS** and only lacks ChatGPT-compatible OAuth, do not route it through a workstation just to add auth. Put the OAuth facade at the edge and proxy directly to the hosted upstream. The [McDonald's recipe](../recipes/mcdonalds/) is the verified example: ChatGPT OAuth terminates on a Cloudflare Worker, which swaps the caller's OAuth bearer for the upstream's static Bearer token.

Whichever pattern you pick, it must end up serving:

```
GET  /.well-known/oauth-protected-resource/<mcp-path>   →  points at the authorization server
GET  /.well-known/oauth-authorization-server            →  endpoints, DCR, PKCE S256
POST /register                                          →  dynamic client registration
GET  /authorize    POST /authorize                      →  consent
POST /token                                             →  token + refresh
ALL  /mcp                                               →  401 without a valid token
```

Note the path-suffixed metadata URL. For a resource at `https://host/mcp`, RFC 9728 puts its metadata at `/.well-known/oauth-protected-resource/mcp`, not at the bare path. Serving only the bare path is a common cause of a connector that fails with no readable error.

### 3. Exposure: how does it get a public hostname?

| Pattern | Setup cost | Ingress config | Notes |
|---|---|---|---|
| **Cloudflare Tunnel, token mode** | own a domain on Cloudflare | dashboard | `cloudflared tunnel run --token-file <file>`. No local YAML. Easiest to start. |
| **Cloudflare Tunnel, local YAML** | same | `/etc/cloudflared/config.yml` | Version-controllable, works headless, no dashboard access needed. Used from WSL/Linux with systemd. |
| **Tailscale Funnel** | none | none | `tailscale funnel <port>` gives public HTTPS on a `ts.net` hostname. No domain, no DNS. You don't control the hostname shape. |
| **Cloudflare Worker custom domain** | own a domain on Cloudflare | Worker route/custom domain | No tunnel or local origin at all. Best when the upstream MCP is already hosted publicly and the Worker only needs to provide OAuth/proxying. |

For tunnel/Funnel patterns the origin is `http://127.0.0.1:<port>` — the local port stays bound to loopback and is never exposed directly. A pure Worker facade is different: its upstream is an existing public HTTPS MCP endpoint, so there is no local origin or always-on workstation process.

### 4. Supervision: what keeps it running?

For local integrations, a connector that works until the next reboot is not finished. Those recipes have several processes that must stay alive: the MCP server, sometimes a bridge, sometimes a gateway, and the tunnel.

The local pattern used throughout this repo is a single supervisor script started by a scheduled task at logon, which polls every few seconds and restarts whatever died, guarded by a named mutex so duplicate supervisors can't stack. See [`templates/supervisor`](../templates/supervisor/). A pure hosted-MCP + Worker path is the exception: Cloudflare and the upstream provider own runtime availability, so there is no workstation process to supervise.

Two environment-specific traps:

- **Windows** — GUI-dependent MCP servers (screen capture, UI automation, DaVinci Resolve, Blender) need an interactive desktop session. "Run whether user is logged on or not" gives you a session with no desktop, and these servers fail in confusing ways. Run at logon, in the user's session.
- **WSL** — WSL shuts the whole distro down when no foreground process is attached, taking your background services with it. Anchor it with a hidden `sleep infinity` process. See the [webcodex recipe](../recipes/webcodex/).

## Putting it together

The most common shape, end to end:

```
ChatGPT
  │  OAuth 2.1 (DCR + PKCE S256)
  ▼
https://mcp.example.com/mcp
  │  Cloudflare Tunnel
  ▼
127.0.0.1:8771   OAuth gateway  ── validates bearer, swaps in the upstream secret
  │
  ▼
127.0.0.1:8770   MCP server (Streamable HTTP)
  │
  ▼
the application
```

For an already-hosted MCP with static upstream auth, the shorter shape is:

```
ChatGPT
  │  OAuth 2.1
  ▼
Cloudflare Worker OAuth facade
  │  swaps OAuth bearer → upstream Bearer/API token
  ▼
public hosted MCP server
```

With a stdio server, one more hop appears between the gateway and the application:

```
127.0.0.1:8771   OAuth gateway
  ▼
127.0.0.1:9877   mcp-proxy      ── Streamable HTTP ⇄ stdio
  ▼
                 your stdio MCP server (child process)
```

## Verifying, rather than assuming

Each layer has a distinct failure signature, which is what [`scripts/doctor.mjs`](../scripts/doctor.mjs) checks:

| Symptom at the public URL | Failing layer |
|---|---|
| DNS does not resolve | tunnel never created the hostname |
| connection refused / timeout | tunnel down, or ingress maps the hostname elsewhere |
| 404 at `/mcp` | wrong path, or wrong ingress rule |
| 500 with no token | auth layer bug — see [troubleshooting](./troubleshooting.md) |
| 502 / 503 | auth passed, nothing behind it: MCP server or bridge is down |
| 200 with no token | **no authentication at all** |
| 401 with no token | correct |

`401` is the pass condition. It reads like a failure the first time and it isn't.

A green tunnel, a healthy `/healthz`, and a successful `tools/list` from curl are all necessary and none of them are sufficient. The only completion criterion this repo accepts is a real tool call executed from inside ChatGPT.
