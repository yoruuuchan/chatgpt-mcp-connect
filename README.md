# chatgpt-mcp-connect
A small Agent Skill for one annoyingly repetitive problem: **connecting a custom MCP server to ChatGPT**.

OpenAI does support custom MCP connections in ChatGPT, but the implementation details are spread across product docs, developer-mode docs, MCP docs, and authentication docs. New Claude Code / Codex sessions often waste time rediscovering the same facts before doing any real work.

This Skill gives the agent a fixed starting point:

```text
existing MCP
  ↓
Remote MCP / Streamable HTTP
  ↓
OAuth 2.1
  ↓
Cloudflare Tunnel or an existing public HTTPS endpoint
  ↓
ChatGPT
  ↓
real tool-call verification
```

The Skill deliberately keeps fast-changing UI paths and product-plan details out of the stable workflow. When those details matter, the agent should verify the latest official OpenAI documentation at execution time.

## What it covers

- recognizing that the target client is ChatGPT
- turning a local/private MCP into a ChatGPT-reachable Remote MCP
- using Cloudflare Tunnel for local/private HTTP MCP servers
- adding OAuth 2.1 authentication
- connecting the endpoint in ChatGPT
- validating with real tool calls instead of stopping at deployment

## Install

### Codex

Place this repository at:

```text
~/.agents/skills/chatgpt-mcp-connect
```

On Windows this is typically:

```text
%USERPROFILE%\.agents\skills\chatgpt-mcp-connect
```

### Claude Code

Place this repository at:

```text
~/.claude/skills/chatgpt-mcp-connect
```

On Windows this is typically:

```text
%USERPROFILE%\.claude\skills\chatgpt-mcp-connect
```

## Make it deterministic

Skill auto-discovery is useful, but for this particular workflow a one-line global trigger is worth adding.

For Codex, add to your global `AGENTS.md`:

```md
When a task involves connecting a custom MCP server to ChatGPT/GPT, load and follow the `chatgpt-mcp-connect` skill before implementation.
```

For Claude Code, add the same rule to your global `CLAUDE.md`.

That keeps the workflow stable across fresh sessions instead of relying on the agent to rediscover the capability from scratch.

## Files

- [`SKILL.md`](./SKILL.md) — the actual Agent Skill
- [`examples/cloudflare-tunnel.md`](./examples/cloudflare-tunnel.md) — local/private MCP via Cloudflare Tunnel
- [`examples/oauth.md`](./examples/oauth.md) — OAuth 2.1 integration checklist

## Design principle

This repository is a **routing layer, not a frozen copy of OpenAI documentation**.

Stable architecture belongs in the Skill. Fast-changing product UI, plan availability, exact OAuth metadata requirements, and ChatGPT setup screens should be checked against current official documentation when the task is executed.

## License

MIT
