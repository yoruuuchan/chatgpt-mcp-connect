# chatgpt-mcp-connect

**Reproducible recipes for connecting local and remote MCP servers to ChatGPT.**

Your MCP server already works in Claude Code or Cursor. ChatGPT can't see it. This repo is the last mile — nine paths that were actually built, run, and verified end to end, written down so you don't spend an afternoon rediscovering them.

[中文说明](./README.zh-CN.md) · [Architecture](./docs/architecture.md) · [Security](./docs/security.md) · [Troubleshooting](./docs/troubleshooting.md)

---

## Why this exists

ChatGPT will not talk to your MCP server unless **all four** of these are true at once:

| It needs | Most MCP servers ship with |
|---|---|
| A public HTTPS URL | `127.0.0.1` |
| Streamable HTTP transport | stdio |
| OAuth 2.1 with dynamic client registration and PKCE | no auth, or a static API key |
| A tool count it will accept | however many tools the author wrote |

Nothing in the MCP ecosystem hands you those four. Every guide stops at "your server works locally", and the gap between that and a working ChatGPT connector is where the afternoon goes. The protocol is documented; the assembly is not.

So this is the assembly: which piece goes where, what breaks, and how to tell which layer broke.

## Start here

```bash
git clone https://github.com/yoruuuchan/chatgpt-mcp-connect.git
cd chatgpt-mcp-connect
```

**1. Find your row.** Answer two questions about the MCP server you want to connect:

| Does it speak HTTP? | Does it have OAuth? | Go to |
|---|---|---|
| yes | no | [`templates/oauth-gateway`](./templates/oauth-gateway/) — put OAuth in front of it |
| no (stdio only) | no | [`recipes/blender`](./recipes/blender/) — add a bridge first, then the gateway |
| yes | yes | [`recipes/devspace`](./recipes/devspace/) — you only need to expose it |
| I don't know | | [`docs/architecture.md`](./docs/architecture.md) |

If the upstream is **already hosted on public HTTPS** but only gives you a static Bearer/API token, do not tunnel it back through your workstation. Use [`recipes/mcdonalds`](./recipes/mcdonalds/) as the reference shape: a Cloudflare Worker provides ChatGPT-compatible OAuth at the edge and swaps the OAuth bearer for the upstream token.

**2. Follow the closest recipe.** Even if your MCP server isn't one of the nine, one of them has your shape.

**3. Check your work before touching ChatGPT.**

```bash
node scripts/doctor.mjs --url https://mcp.example.com --upstream 127.0.0.1:8770 --gateway 127.0.0.1:8771
```

It probes each hop in order and names the first one that's broken, instead of leaving you to guess from a blank ChatGPT error.

```
[  ok  ] 1. MCP server            127.0.0.1:8770 accepting connections
[ FAIL ] 2. OAuth gateway         gateway is up and reports upstream unreachable (HTTP 503)
         The gateway itself is fine — what sits behind it is down.
```

## Recipes

Each was built and verified on real hardware. Each records what was tested, what wasn't, and when.

| Recipe | What it connects | Transport | Auth pattern | Exposure |
|---|---|---|---|---|
| [davinci-resolve](./recipes/davinci-resolve/) | DaVinci Resolve Studio — timelines, media, colour, render | HTTP native | local gateway | Cloudflare Tunnel |
| [windows-desktop](./recipes/windows-desktop/) | Windows GUI automation, with the dangerous tools switched off | HTTP native | local gateway | Cloudflare Tunnel |
| [blender](./recipes/blender/) | Blender scene graph and Python | stdio → bridge → addon socket | local gateway | Cloudflare Tunnel |
| [comfyui](./recipes/comfyui/) | ComfyUI workflows and generation | HTTP native | **Cloudflare Worker** | Worker + Tunnel |
| [mcdonalds](./recipes/mcdonalds/) | McDonald's China official hosted MCP — account, coupons, menu, orders | hosted Streamable HTTP | **Cloudflare Worker OAuth facade** | **Worker custom domain, no Tunnel** |
| [kimi-computer-use](./recipes/kimi-computer-use/) | Desktop computer-use agent | stdio → bridge | **Cloudflare Access, zero code** | Cloudflare Tunnel |
| [devspace](./recipes/devspace/) | Local coding workspace — files, search, shell | HTTP native | built in | **Tailscale Funnel** |
| [webcodex](./recipes/webcodex/) | Project tools + console, in Docker on WSL | HTTP native | built in | Tunnel, local YAML |
| [unreal-engine](./recipes/unreal-engine/) | Unreal Editor — actors, Blueprints, materials, Niagara, Sequencer | HTTP native, **Epic's own in-editor server** | local gateway | Cloudflare Tunnel |

The variety is the point. Between them they cover **four ways to do OAuth** — from writing nothing at all to running your own gateway — and **four public-exposure shapes**, including a pure edge Worker in front of an already-hosted MCP, with the tradeoffs written down. Read [`docs/architecture.md`](./docs/architecture.md) to pick, or [`recipes/`](./recipes/) for the full comparison.

## What's in here

```
recipes/     nine verified end-to-end paths
templates/   oauth-gateway/  — OAuth 2.1 in front of any HTTP MCP server
             supervisor/     — keep the processes alive across reboots
scripts/     doctor.mjs      — layered connectivity check, no dependencies
docs/        architecture · security · troubleshooting
SKILL.md     agent skill: point Claude Code or Codex at this repo
```

The two pieces people are usually missing are [`templates/oauth-gateway`](./templates/oauth-gateway/) — about 230 lines of Node that turns a plain HTTP MCP server into one ChatGPT can authenticate against — and [`docs/troubleshooting.md`](./docs/troubleshooting.md), which is the list of real failures rather than a list of things that might go wrong. The one that cost the most to find: **every auth failure returning HTTP 500 instead of 401**, from two unrelated causes that produce an identical symptom.

## Use it as an agent skill

The repo doubles as a skill for coding agents, so a fresh session starts from the architecture instead of re-researching whether ChatGPT supports MCP at all.

```bash
git clone https://github.com/yoruuuchan/chatgpt-mcp-connect.git ~/.claude/skills/chatgpt-mcp-connect   # Claude Code
git clone https://github.com/yoruuuchan/chatgpt-mcp-connect.git ~/.agents/skills/chatgpt-mcp-connect   # Codex
```

Then add one line to your global `CLAUDE.md` or `AGENTS.md`:

> When a task involves connecting a custom MCP to ChatGPT, read and follow the `chatgpt-mcp-connect` skill first.

## Scope

**This gives you** a working, authenticated, public MCP endpoint that survives a reboot, and a way to tell which layer is broken when it isn't working.

**This is not** an MCP framework, a proxy to install, a hosted service, or a sandbox. It doesn't fork or wrap any upstream MCP server — every recipe points at the real project and tells you how to configure it. And it does not constrain what an authenticated caller can do; read [`docs/security.md`](./docs/security.md) before you expose anything, especially the part about turning off the tools you don't need.

**Verified 2026-08-18**, the Unreal recipe on **2026-08-19**, and the hosted McDonald's edge-OAuth recipe on **2026-08-21**, on Windows 11 + WSL2 and Cloudflare/Tailscale infrastructure where applicable. Each recipe states what was live-checked on that date and what wasn't — where an application wasn't running at verification time, the recipe says so rather than implying more coverage than it has.

## Attribution

Every MCP server here belongs to someone else. This repo links to them; it copies nothing and forks nothing.

| Project | License | Used for |
|---|---|---|
| [samuelgursky/davinci-resolve-mcp](https://github.com/samuelgursky/davinci-resolve-mcp) | MIT | DaVinci Resolve |
| [CursorTouch/Windows-MCP](https://github.com/CursorTouch/Windows-MCP) | MIT | Windows desktop |
| [ahujasid/blender-mcp](https://github.com/ahujasid/blender-mcp) | MIT | Blender |
| [artokun/comfyui-mcp](https://github.com/artokun/comfyui-mcp) | MIT | ComfyUI |
| [Waishnav/devspace](https://github.com/Waishnav/devspace) | MIT | DevSpace, and `SingleUserOAuthProvider` used by the gateway template |
| [yyjeqhc/webcodex](https://github.com/yyjeqhc/webcodex) | Apache-2.0 | WebCodex |
| [punkpeye/mcp-proxy](https://github.com/punkpeye/mcp-proxy) | MIT | stdio → Streamable HTTP bridge |
| [modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk) | Apache-2.0 / MIT / CC-BY-4.0 | OAuth router and bearer validation |
| [cloudflare/workers-oauth-provider](https://github.com/cloudflare/workers-oauth-provider) | MIT | edge OAuth in the ComfyUI and McDonald's recipes |
| [McDonald's China MCP](https://open.mcd.cn/mcp/doc) | proprietary hosted service | official hosted MCP used by the McDonald's recipe |
| [EpicGames/unreal-engine-skills-for-claude-code-plugin](https://github.com/EpicGames/unreal-engine-skills-for-claude-code-plugin) | MIT | Unreal Engine agent skills |
| Unreal MCP (`ModelContextProtocol`) | ships with Unreal Engine 5.8, UE EULA | Unreal Engine |
| Moonshot Kimi CU | proprietary, no public terms found | computer-use recipe — link only, nothing redistributed |

None of these projects endorse or maintain these recipes. Bugs in a recipe are this repo's problem; take upstream bugs upstream.

## Contributing

A new recipe is welcome if you actually ran it. Follow the structure of an existing one, state your tested environment and date, and mark anything you couldn't verify as unverified rather than filling it in. Corrections to a recipe that has drifted are just as useful — these depend on upstream projects that move fast.

## License

MIT — see [LICENSE](./LICENSE). Upstream projects keep their own licenses.
