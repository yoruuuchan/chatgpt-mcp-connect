# OAuth 2.1 checklist

Use OAuth when the MCP exposes private user data, account-bound resources, or write-capable tools.

The exact MCP authorization requirements can evolve, so verify current MCP and OpenAI documentation during implementation.

## Expected flow

```text
ChatGPT
  ↓
Remote MCP
  ↓ auth challenge / metadata
Authorization Server
  ↓
user authorization
  ↓
access token
  ↓
Remote MCP validates Bearer token
```

## Implementation checklist

Verify the current required forms of:

```text
protected-resource metadata
authorization-server metadata
authorization endpoint
token endpoint
client handling required by the current MCP flow
Bearer token validation
scope / permission enforcement
expired token handling
invalid token handling
```

## Provider choice

Prefer reuse in this order:

1. the application's existing OAuth / identity provider
2. an existing managed provider already used by the project
3. a lightweight standards-compliant provider suitable for the deployment
4. custom authorization-server implementation only when the project genuinely needs it

The MCP should enforce authorization at the server boundary. A successful login screen alone is not proof that tool access is correctly protected.

## Verification

Test at least:

```text
unauthenticated request is challenged correctly
valid authorization succeeds
valid token permits expected tools
invalid token is rejected
expired token is rejected or refreshed according to the current flow
ChatGPT completes authorization and then calls a real tool
```
