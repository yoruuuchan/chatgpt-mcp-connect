# Architecture

Every recipe in this repo is the same decisions, answered differently.

The first one is now architectural: **does ChatGPT connect to the leaf MCP directly, or to an MCP runtime that sits in front of several capabilities?** After that, the familiar transport / auth / exposure / supervision decisions still apply.

## What ChatGPT actually requires

ChatGPT will not talk to your MCP server unless all of this is true at once:

| Requirement | Consequence |
|---|---|
| A public HTTPS URL | localhost is not reachable from OpenAI's servers. Something must terminate TLS on a public hostname. |
| Streamable HTTP transport | A stdio MCP server cannot be connected directly, no matter what you put in front of it. |
| OAuth 2.1 with dynamic client registration and PKCE | ChatGPT registers itself as a client at connect time. There is no field to paste an API key into. |
| A tool count it will accept | Large tool sets get rejected or silently truncated. |

Everything below exists to satisfy those four lines — either for a leaf server, or once at the runtime boundary.

## The five decisions

```text
                  ┌─ 0. What is the public MCP boundary? ─────────┐
                  │                                               │
              leaf server                                  MCP runtime
                  │                                      (MCPX aggregation)
                  │                                               │
                  └──────────────────┬────────────────────────────┘
                                     ▼
                  ┌─ 1. Does that boundary speak Streamable HTTP? ┐
                  │                                               │
                 yes                                             no
                  │                                               │
                  │                                    put mcp-proxy in front
                  │                                               │
                  └──────────────────┬────────────────────────────┘
                                     ▼
                  ┌─ 2. Where does OAuth happen? ─────────────────┐
                  │                                               │
        already built in          local gateway          at the edge
   (DevSpace/WebCodex/MCPX)   (templates/oauth-gateway)  (CF Worker / Access)
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

### 0. Boundary: direct leaf server or MCP runtime?

Most MCP integrations have an obvious product boundary: DaVinci Resolve, Blender, Unreal Engine, a hosted API, one coding workspace. In those cases, expose that MCP directly and keep the request path short.

But if your real requirement is "give ChatGPT one stable connection to a changing set of local Workspaces, Skills, and MCP servers", a separate public connector per leaf server is usually the wrong abstraction. You repeat the same work — HTTPS, OAuth, tunnel, supervision, reconnects — and you multiply the number of public endpoints and top-level tools ChatGPT must ingest.

The verified runtime path in this repo is [MCPX](../recipes/mcpx/):

```text
ChatGPT
   │ OAuth 2.1 + Streamable HTTP
   ▼
MCPX Runtime
   ├── Workspace / files / edits / terminal / tasks
   ├── local Skills
   └── upstream MCP servers
```

At the tested MCPX `v0.9.7`, the runtime exposed a stable 19-tool public surface. Skills and upstream MCPs were reached through `skill_tool` and `mcp_tool` list / describe / call flows instead of flattening every leaf tool into ChatGPT's top-level `tools/list`.

That solves a different problem from a bridge. `mcp-proxy` converts **transport** (stdio → Streamable HTTP). MCPX changes the **public capability boundary**: multiple changing extensions sit behind one authenticated runtime.

Use a runtime when the aggregation itself is useful: persistent Workspace state, cross-client sessions, shared policy, audit/state, Skills, several upstream MCPs, or a combined tool inventory that is too large or too volatile to expose directly.

Do not insert a runtime just because you can. For one stable application-specific MCP, the direct path is simpler and has fewer failure layers.

Runtime aggregation also changes diagnostics:

```text
ChatGPT → MCPX        may be healthy
MCPX → upstream A    may be healthy
MCPX → upstream B    may be broken
```

Treat those as separate layers. A green public connector does not prove every extension behind it works.

### 1. Transport: does it speak Streamable HTTP?

A Cloudflare Tunnel forwards network traffic. It does **not** turn a stdio process into an HTTP server. This is the single most common misunderstanding, and it costs people an afternoon.

- **Already HTTP** — many servers take a `--transport streamable-http` flag or equivalent. Use it. Bind to `127.0.0.1`, never `0.0.0.0`.
- **stdio only, direct path** — put [`mcp-proxy`](https://github.com/punkpeye/mcp-proxy) in front of it. It spawns your stdio server as a child process and speaks Streamable HTTP on a port:

  ```bash
  npx --yes mcp-proxy@6.7.0 --host 127.0.0.1 --port 9877 --server stream -- <your stdio command>
  ```

  `--server stream` selects Streamable HTTP rather than SSE. Raise `--connectionTimeout` and `--requestTimeout` if your tools are slow; the defaults will cut off long-running calls.

- **stdio behind MCPX** — do not create a public HTTP bridge just for ChatGPT. MCPX can spawn supported stdio upstream MCP servers itself from `.mcp.json`, keeping the leaf process private behind the runtime boundary. See the AMap example in the [MCPX recipe](../recipes/mcpx/).

Recipes using a direct bridge: [blender](../recipes/blender/), [kimi-computer-use](../recipes/kimi-computer-use/).

### 2. Auth: where does OAuth happen?

Four patterns, in rough order of how much code you end up owning.

| Pattern | You write | State lives in | Choose it when |
|---|---|---|---|
| **Built-in** | nothing | the server/runtime's own store | The public MCP boundary already ships OAuth ([devspace](../recipes/devspace/), [webcodex](../recipes/webcodex/), [mcpx](../recipes/mcpx/)) |
| **Cloudflare Access managed OAuth** | nothing | Cloudflare | You're already on Cloudflare Zero Trust and don't need custom consent ([kimi-computer-use](../recipes/kimi-computer-use/)) |
| **Cloudflare Worker** | a small Worker | Workers KV | You want auth to stay up when the workstation sleeps, or the upstream is already hosted publicly ([comfyui](../recipes/comfyui/), [mcdonalds](../recipes/mcdonalds/)) |
| **Local gateway** | config only, using [`templates/oauth-gateway`](../templates/oauth-gateway/) | local SQLite | Everything else ([davinci-resolve](../recipes/davinci-resolve/), [windows-desktop](../recipes/windows-desktop/), [blender](../recipes/blender/)) |

The local gateway is the default recommendation for a direct local MCP that lacks OAuth because it works anywhere, has no cloud dependency beyond the tunnel, and is one process you can read end to end. It does not implement an authorization server from scratch — it reuses `SingleUserOAuthProvider` from [DevSpace](https://github.com/Waishnav/devspace) and the auth router from the MCP TypeScript SDK, and adds the reverse proxy and health check.

There are two important exceptions to that default.

**Already-hosted public MCP:** if the upstream MCP is already on public HTTPS and only lacks ChatGPT-compatible OAuth, do not route it through a workstation just to add auth. Put the OAuth facade at the edge and proxy directly to the hosted upstream. The [McDonald's recipe](../recipes/mcdonalds/) is the verified example: ChatGPT OAuth terminates on a Cloudflare Worker, which swaps the caller's OAuth bearer for the upstream's static Bearer token.

**Runtime boundary with built-in OAuth:** if you intentionally chose MCPX as the public boundary, terminate OAuth there. Do not put `templates/oauth-gateway` in front of MCPX merely because other recipes do — MCPX already publishes the OAuth metadata and authorization endpoints itself.

**Topology rule: do not hairpin a hosted MCP through your workstation.** If the upstream is already public HTTPS, every local proxy, tunnel, keepalive process, and machine dependency you insert is another failure mode without adding reachability. Keep the path as short as the auth boundary allows.

Whichever pattern you pick, it must end up serving the metadata and authorization flow ChatGPT needs. The exact endpoint paths can vary by implementation, but the public resource must advertise an authorization server, dynamic client registration / supported client metadata, PKCE S256, and reject unauthenticated MCP requests rather than silently allowing them.

For this repo's local gateway, the expected shape is:

```text
GET  /.well-known/oauth-protected-resource/<mcp-path>   →  points at the authorization server
GET  /.well-known/oauth-authorization-server            →  endpoints, DCR, PKCE S256
POST /register                                          →  dynamic client registration
GET  /authorize    POST /authorize                      →  consent
POST /token                                             →  token + refresh
ALL  /mcp                                               →  401 without a valid token
```

MCPX uses its own `/mcp/oauth/...` authorization paths; follow the implementation you actually deploy rather than assuming the gateway template's route names.

Note the path-suffixed metadata URL. For a resource at `https://host/mcp`, RFC 9728 puts its metadata at `/.well-known/oauth-protected-resource/mcp`, not only at the bare path. Serving the path shape is the safest compatibility choice.

### 3. Exposure: how does it get a public hostname?

| Pattern | Setup cost | Ingress config | Notes |
|---|---|---|---|
| **Cloudflare Tunnel, token mode** | own a domain on Cloudflare | dashboard | `cloudflared tunnel run --token-file <file>`. No local YAML. Easiest to start. |
| **Cloudflare Tunnel, local YAML** | same | `/etc/cloudflared/config.yml` | Version-controllable, works headless, no dashboard access needed. Used from WSL/Linux with systemd. |
| **Tailscale Funnel** | none | none | `tailscale funnel <port>` gives public HTTPS on a `ts.net` hostname. No domain, no DNS. You don't control the hostname shape. |
| **Cloudflare Worker custom domain** | own a domain on Cloudflare | Worker route/custom domain | No tunnel or local origin at all. Best when the upstream MCP is already hosted publicly and the Worker only needs to provide OAuth/proxying. |

For tunnel/Funnel patterns the origin is `http://127.0.0.1:<port>` — the local port stays bound to loopback and is never exposed directly. A pure Worker facade is different: its upstream is an existing public HTTPS MCP endpoint, so there is no local origin or always-on workstation process.

When the public boundary owns OAuth, proxy the **whole origin**, not only `/mcp`, unless the implementation explicitly documents otherwise. Built-in OAuth servers such as MCPX need their `/.well-known/...` and authorization/token paths to traverse the same ingress.

### 4. Supervision: what keeps it running?

For local integrations, a connector that works until the next reboot is not finished. Those recipes have several processes that must stay alive: the MCP server or runtime, sometimes a bridge, sometimes a gateway, and the tunnel.

The local pattern used throughout this repo is either a supervisor script started by a scheduled task at logon or a system service appropriate to the environment. See [`templates/supervisor`](../templates/supervisor/) and the WSL/systemd examples in [webcodex](../recipes/webcodex/) and [mcpx](../recipes/mcpx/). A pure hosted-MCP + Worker path is the exception: Cloudflare and the upstream provider own runtime availability, so there is no workstation process to supervise.

Two environment-specific traps:

- **Windows** — GUI-dependent MCP servers (screen capture, UI automation, DaVinci Resolve, Blender) need an interactive desktop session. "Run whether user is logged on or not" gives you a session with no desktop, and these servers fail in confusing ways. Run at logon, in the user's session.
- **WSL** — WSL shuts the whole distro down when no foreground process is attached, taking your background services with it. Anchor it with a hidden `sleep infinity` process when the distro must remain reachable. See the [webcodex recipe](../recipes/webcodex/).

## Putting it together

The most common direct shape, end to end:

```text
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

```text
ChatGPT
  │  OAuth 2.1
  ▼
Cloudflare Worker OAuth facade
  │  swaps OAuth bearer → upstream Bearer/API token
  ▼
public hosted MCP server
```

For a runtime aggregation path:

```text
ChatGPT
  │  OAuth 2.1
  ▼
https://mcpx.example.com/mcp
  │  Cloudflare Tunnel
  ▼
127.0.0.1:9090   MCPX Runtime
  ├── Workspace tools
  ├── Skills
  └── upstream MCP servers
          └── stdio / other private leaf processes
```

With a direct stdio server, one more hop appears between the gateway and the application:

```text
127.0.0.1:8771   OAuth gateway
  ▼
127.0.0.1:9877   mcp-proxy      ── Streamable HTTP ⇄ stdio
  ▼
                 your stdio MCP server (child process)
```

## Verifying, rather than assuming

Each public-path layer has a distinct failure signature, which is what [`scripts/doctor.mjs`](../scripts/doctor.mjs) checks:

| Symptom at the public URL | Failing layer |
|---|---|
| DNS does not resolve | tunnel never created the hostname |
| connection refused / timeout | tunnel down, or ingress maps the hostname elsewhere |
| 404 at `/mcp` | wrong path, or wrong ingress rule |
| 500 with no token | auth layer bug — see [troubleshooting](./troubleshooting.md) |
| 502 / 503 | auth passed, nothing behind it: MCP server or bridge is down |
| 200 with no token | **no authentication at all** |
| 401 with no token | correct for the gateway patterns in this repo |

For built-in OAuth servers such as MCPX, run the same doctor without `--gateway`:

```bash
node scripts/doctor.mjs --url https://mcpx.example.com --upstream 127.0.0.1:9090
```

Then continue one layer deeper. A runtime connector is not fully verified until at least one real extension path has also worked:

```text
ChatGPT → runtime → representative Workspace / Skill / upstream MCP call
```

A green tunnel, healthy OAuth metadata, and a successful `tools/list` from curl are all necessary and none of them are sufficient. The only completion criterion this repo accepts is a real tool call executed from inside ChatGPT — and for an aggregation runtime, one representative call through the runtime into the capability you actually care about.
