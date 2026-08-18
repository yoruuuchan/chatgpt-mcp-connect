# OAuth gateway template

A ~230-line Node process that puts ChatGPT-compatible OAuth 2.1 in front of an MCP server that speaks Streamable HTTP but has no authentication of its own.

```
ChatGPT ──OAuth 2.1──▶ gateway :8771 ──static bearer──▶ your MCP server :8770
```

Used by the [davinci-resolve](../../recipes/davinci-resolve/), [windows-desktop](../../recipes/windows-desktop/) and [blender](../../recipes/blender/) recipes.

## What it is and isn't

It is **not** an authorization server. Writing one correctly is a bad use of your afternoon, so this doesn't. It composes two existing pieces and adds the parts that were missing:

| Piece | From | License |
|---|---|---|
| `SingleUserOAuthProvider` — consent, codes, tokens, SQLite storage | [Waishnav/devspace](https://github.com/Waishnav/devspace) | MIT |
| `mcpAuthRouter`, `requireBearerAuth`, resource-indicator checks | [modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk) | Apache-2.0 / MIT / CC-BY-4.0 |
| the reverse proxy, `/healthz`, config surface, and two bug workarounds | this repo | MIT |

Nothing is vendored. `npm install` pulls both upstreams from their registries.

"Single user" means one owner token authorizes every client. There are no user accounts. That fits a personal workstation connector and does not fit a multi-tenant service.

## What it serves

```
GET  /.well-known/oauth-authorization-server        endpoints, DCR, PKCE S256
GET  /.well-known/oauth-protected-resource/mcp      points at the authorization server
POST /register                                      dynamic client registration (RFC 7591)
GET  /authorize    POST /authorize                  consent form, PKCE
POST /token                                         token issue and refresh
ALL  /mcp                                           bearer-gated reverse proxy
GET  /healthz                                       liveness, unauthenticated
```

## Setup

```bash
cp .env.example .env
mkdir -p secrets
openssl rand -hex 32 > secrets/owner-token.txt
npm install
```

Edit `.env`. At minimum set `PUBLIC_BASE_URL` to the public HTTPS origin you will route to this gateway, and point `UPSTREAM_HOST` / `UPSTREAM_PORT` at your MCP server.

If your MCP server has its own bearer token — it should — put the full header value in `secrets/upstream-authorization.txt`:

```
Bearer <the token your MCP server expects>
```

Then run it:

```bash
node --env-file=.env gateway.mjs
```

Node 20.6+ reads `--env-file` natively. On older Node, export the variables yourself.

Expected output:

```
[gateway] listening on http://127.0.0.1:8771/mcp
[gateway] upstream  http://127.0.0.1:8770/mcp
[gateway] public    https://mcp.example.com/mcp
```

Now point a tunnel at `http://127.0.0.1:8771` and paste the public `/mcp` URL into ChatGPT.

## Verifying

```bash
curl -s http://127.0.0.1:8771/healthz
# {"ok":true,"gateway":true,"upstream":true}

curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8771/mcp
# 401  ← correct. An unauthenticated request must be rejected.
```

Once the tunnel is up:

```bash
node ../../scripts/doctor.mjs --url https://mcp.example.com --upstream 127.0.0.1:8770 --gateway 127.0.0.1:8771
```

A `401` on `/mcp` is the pass condition, not a failure. A `500` there means one of the two bugs below.

## The two workarounds, and why they're in the code

Both produce the same symptom — auth failures returning HTTP 500 instead of 401 — from unrelated causes, which is why they cost so much to find.

**One SDK instance.** `createRequire().resolve()` picks a package's `require` condition and lands on `dist/cjs`, while DevSpace's ESM `oauth-provider.js` pulls `dist/esm`. Two module instances means `error instanceof InvalidTokenError` compares different class objects, always returns false, and falls through to a generic `ServerError`. `importResolved()` rewrites the path onto the ESM build so both halves share one instance.

**`trust proxy` is `'loopback'`, not `true`.** `mcpAuthRouter` contains an `express-rate-limit` instance that throws `ERR_ERL_PERMISSIVE_TRUST_PROXY` under `true`, and the throw becomes a 500. The only proxy hop here is a tunnel client on localhost, so `'loopback'` is correct.

Don't "simplify" either one away. Details in [docs/troubleshooting.md](../../docs/troubleshooting.md).

## Configuration

Every option is an environment variable; see [`.env.example`](./.env.example) for the annotated list. Secrets can be given inline (`OWNER_TOKEN`) or read from a file (`OWNER_TOKEN_FILE`) — prefer the file, so the value never appears in a process listing or shell history.

The gateway refuses to start on a missing `PUBLIC_BASE_URL`, a missing owner token, an owner token shorter than 32 characters, or a malformed upstream header. Failing at startup beats failing during OAuth, where the error surfaces inside ChatGPT with no detail.

## Security

The owner token grants everything your MCP server can do. Read [docs/security.md](../../docs/security.md) before exposing anything — particularly the part about turning off tools you don't need, which does more for your risk than anything in this file.
