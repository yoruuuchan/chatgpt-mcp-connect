---
name: chatgpt-mcp-connect
description: Connect a custom MCP server to ChatGPT/GPT. Use when the user asks whether an MCP can be used by ChatGPT, or asks to expose, deploy, authenticate, configure, or connect a custom MCP for ChatGPT. Covers Remote MCP, Cloudflare Tunnel, OAuth 2.1, and real ChatGPT verification.
---

# chatgpt-mcp-connect

Use this skill when the target client is **ChatGPT**.

The goal is to make an existing or new MCP server reachable, authenticated, discoverable, and actually callable from ChatGPT.

## Known starting point

ChatGPT can use custom remote MCP servers. Do not spend the task rediscovering that capability.

The usual architecture is:

```text
ChatGPT
  ↓
HTTPS Remote MCP endpoint
  ↓
OAuth 2.1
  ↓
MCP server
```

For a local or private MCP, the default practical path is:

```text
ChatGPT
  ↓
https://mcp.example.com/mcp
  ↓
OAuth 2.1
  ↓
Cloudflare Tunnel
  ↓
local Remote MCP / Streamable HTTP server
```

If the server already has a stable public HTTPS Remote MCP endpoint, use it directly and skip the tunnel.

## Workflow

### 1. Inspect the MCP

Establish the current state:

```text
project / repository
runtime device
startup command
MCP framework / SDK
transport
local endpoint
existing authentication
tools/list result
representative tools/call result
```

The MCP itself should work before ChatGPT integration begins.

### 2. Provide a Remote MCP endpoint

ChatGPT needs a network-reachable Remote MCP endpoint.

Prefer Streamable HTTP for new work.

If the existing server is stdio-only, expose the same tool implementation through a Remote MCP / Streamable HTTP entry point before placing Cloudflare Tunnel in front of it. Cloudflare Tunnel forwards network services; it does not turn stdio into HTTP by itself.

Keep the existing tool schemas and business logic unless a protocol change actually requires modification.

### 3. Expose local/private MCP with Cloudflare Tunnel

For a server such as:

```text
http://127.0.0.1:8787/mcp
```

create a stable HTTPS hostname such as:

```text
https://mcp.example.com/mcp
```

and route it through Cloudflare Tunnel to the local MCP service.

Record:

```text
tunnel name / id
public hostname
local target
MCP path
```

Reuse existing Cloudflare accounts, domains, tunnels, CLI configuration, and authentication when available.

See `examples/cloudflare-tunnel.md`.

### 4. Add OAuth 2.1

Private data and write-capable MCPs should normally use OAuth 2.1.

Implement or reuse an authorization server that provides the metadata and endpoints required by the current MCP authorization specification and by ChatGPT.

At minimum verify:

```text
protected-resource metadata
authorization-server metadata
authorization endpoint
token endpoint
Bearer token validation
invalid / expired token behavior
```

Prefer an existing identity provider or existing application auth stack over building a new identity system only for MCP.

See `examples/oauth.md`.

### 5. Connect it to ChatGPT

Use the current ChatGPT custom MCP / app / developer-mode connection flow and supply the HTTPS MCP endpoint.

If OAuth is enabled, complete the authorization flow and then rescan or reconnect as required by the current product UI.

The exact UI path changes more often than the protocol. If it is unclear, check the latest official OpenAI documentation instead of relying on remembered menu names.

### 6. Verify in the real client

Completion requires real ChatGPT verification:

```text
ChatGPT can discover the MCP tools
OAuth completes successfully
one read-only tool succeeds
one representative real tool succeeds
returned data is correct
errors are explicit and diagnosable
```

Deployment, a green tunnel, or a successful `tools/list` outside ChatGPT is not final acceptance by itself.

## Output for handoff

Leave a compact record:

```yaml
name:
project:
runtime_device:

local_mcp:
  transport:
  endpoint:
  command:

remote_mcp:
  url:

cloudflare:
  tunnel:
  hostname:

auth:
  type: oauth2.1
  provider:

chatgpt_verification:
  tools_discovered:
  read_test:
  representative_test:
  result:
```

## Freshness rule

Treat these as fast-changing and verify them from current official documentation when relevant:

- ChatGPT UI paths
- plan / workspace availability
- current developer-mode setup
- exact OpenAI product terminology
- current OAuth metadata requirements
- current MCP protocol details

Do not re-research the basic architectural fact that the task is to connect a custom Remote MCP to ChatGPT; start from the workflow above and only verify the details that can actually change.
