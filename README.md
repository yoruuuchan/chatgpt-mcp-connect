# chatgpt-mcp-connect

**Reproducible recipes for connecting local and remote MCP servers to ChatGPT.**

Your MCP server already works in Claude Code or Cursor. ChatGPT can't see it. This repo is the last mile: thirteen paths that were actually built, run, and verified end to end, written down so you don't spend an afternoon rediscovering them.

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

Nothing in the MCP ecosystem hands you those four. Every guide stops at "your server works locally". The gap between that and a working ChatGPT connector is where the afternoon goes. The protocol is documented; the assembly is not.

So this is the assembly: which piece goes where, what breaks, and how to tell which layer broke.

## Start here

```bash
git clone https://github.com/yoruuuchan/chatgpt-mcp-connect.git
cd chatgpt-mcp-connect
```

**0. Decide whether you're exposing one MCP or a runtime.** If you want one persistent ChatGPT connector in front of multiple Workspaces, Skills, or upstream MCP servers, start with [`recipes/mcpx`](./recipes/mcpx/). MCPX is the aggregation/runtime path. The table below covers the direct paths, one leaf server at a time.

**1. Find your row.** Answer two questions about the MCP server you want to connect directly:

| Does it speak HTTP? | Does it have OAuth? | Go to |
|---|---|---|
| yes | no | [`templates/oauth-gateway`](./templates/oauth-gateway/): put OAuth in front of it |
| no (stdio only) | no | [`recipes/blender`](./recipes/blender/): add a bridge first, then the gateway |
| yes | yes | [`recipes/devspace`](./recipes/devspace/): you only need to expose it |
| I don't know | | [`docs/architecture.md`](./docs/architecture.md) |

If the upstream is already hosted on public HTTPS but only gives you a static Bearer/API token, don't tunnel it back through your workstation. Use [`recipes/mcdonalds`](./recipes/mcdonalds/) as the reference shape. A Cloudflare Worker provides ChatGPT-compatible OAuth at the edge and swaps the OAuth bearer for the upstream token.

If the data source is a mobile device that must stay reachable while roaming or sleeping away from your workstation, use [`recipes/listening-bridge`](./recipes/listening-bridge/). The device keeps one persistent outbound WebSocket to a hosted MCP service. ChatGPT reaches that hosted service through OAuth over public HTTPS.

**2. Follow the closest recipe.** Even if your MCP server isn't one of the thirteen, one of them has your shape.

**3. Check your work before touching ChatGPT.**

```bash
node scripts/doctor.mjs --url https://mcp.example.com --upstream 127.0.0.1:8770 --gateway 127.0.0.1:8771
```

It probes each hop in order and names the first one that's broken. You don't have to guess from a blank ChatGPT error.

```text
[  ok  ] 1. MCP server            127.0.0.1:8770 accepting connections
[ FAIL ] 2. OAuth gateway         gateway is up and reports upstream unreachable (HTTP 503)
         The gateway itself is fine — what sits behind it is down.
```

For a server with built-in OAuth, such as MCPX, leave out `--gateway` and point `--upstream` at the server itself.

## Recipes

Each one was built and verified on real hardware. Each one records what was tested, what wasn't, and when.

| Recipe | What it connects | Transport | Auth pattern | Exposure |
|---|---|---|---|---|
| [davinci-resolve](./recipes/davinci-resolve/) | DaVinci Resolve Studio: timelines, media, colour, render | HTTP native | local gateway | Cloudflare Tunnel |
| [windows-desktop](./recipes/windows-desktop/) | Windows GUI automation, with the dangerous tools switched off | HTTP native | local gateway | Cloudflare Tunnel |
| [blender](./recipes/blender/) | Blender scene graph and Python | stdio → bridge → addon socket | local gateway | Cloudflare Tunnel |
| [qq-mail-mcp](./recipes/qq-mail-mcp/) | QQ Mail over IMAP/SMTP: search, read, threads, attachments, draft, reply, send | stdio → bridge | local gateway | Cloudflare Tunnel on an always-on cloud host |
| [comfyui](./recipes/comfyui/) | ComfyUI workflows and generation | HTTP native | Cloudflare Worker | Worker + Tunnel |
| [mcdonalds](./recipes/mcdonalds/) | McDonald's China official hosted MCP: account, coupons, menu, orders | hosted Streamable HTTP | Cloudflare Worker OAuth facade | Worker custom domain, no Tunnel |
| [listening-bridge](./recipes/listening-bridge/) | Android media-session metadata and playback controls via an outbound phone WebSocket | hosted Streamable HTTP | local gateway on the host | Cloudflare Tunnel; separate HTTPS/WSS hostnames |
| [kimi-computer-use](./recipes/kimi-computer-use/) | Desktop computer-use agent | stdio → bridge | Cloudflare Access, zero code | Cloudflare Tunnel |
| [devspace](./recipes/devspace/) | Local coding workspace: files, search, shell | HTTP native | built in | Cloudflare Tunnel (Tailscale Funnel alternative) |
| [webcodex](./recipes/webcodex/) | Project tools + console, in Docker on WSL | HTTP native | built in | Tunnel, local YAML |
| [unreal-engine](./recipes/unreal-engine/) | Unreal Editor: actors, Blueprints, materials, Niagara, Sequencer | HTTP native, Epic's own in-editor server | local gateway | Cloudflare Tunnel |
| [mcpx](./recipes/mcpx/) | MCP runtime: Workspaces, persistent sessions, Skills, upstream MCP aggregation | HTTP native | built in | Cloudflare Tunnel |

The variety is the point. Between them they cover four ways to do OAuth, from writing nothing at all to running your own gateway. They also cover several ways to go public: Cloudflare Tunnel, Worker custom domains, and Tailscale Funnel as an alternative when you don't have a Cloudflare-managed domain. MCPX adds a second architectural choice on top: connect ChatGPT directly to a leaf MCP, or put an MCP runtime in front of a changing set of local capabilities. To pick one, read [`docs/architecture.md`](./docs/architecture.md). For the full comparison, see [`recipes/`](./recipes/).

## What's in here

```text
recipes/     thirteen verified end-to-end paths, including a runtime aggregation path
templates/   oauth-gateway/  — OAuth 2.1 in front of any HTTP MCP server
             supervisor/     — keep the processes alive across reboots
scripts/     doctor.mjs      — layered connectivity check, no dependencies
docs/        architecture · security · troubleshooting
SKILL.md     agent skill: point Claude Code or Codex at this repo
```

People are usually missing two pieces. The first is [`templates/oauth-gateway`](./templates/oauth-gateway/), about 230 lines of Node that turn a plain HTTP MCP server into one ChatGPT can authenticate against. The second is [`docs/troubleshooting.md`](./docs/troubleshooting.md). It lists real failures, not things that might go wrong. The one that cost the most to find: **every auth failure returning HTTP 500 instead of 401**. Two unrelated causes produce that identical symptom.

## Use it as an agent skill

The repo doubles as a skill for coding agents. A fresh session starts from the architecture instead of re-researching whether ChatGPT supports MCP at all.

```bash
git clone https://github.com/yoruuuchan/chatgpt-mcp-connect.git ~/.claude/skills/chatgpt-mcp-connect   # Claude Code
git clone https://github.com/yoruuuchan/chatgpt-mcp-connect.git ~/.agents/skills/chatgpt-mcp-connect   # Codex
```

Then add one line to your global `CLAUDE.md` or `AGENTS.md`:

> When a task involves connecting a custom MCP to ChatGPT, read and follow the `chatgpt-mcp-connect` skill first.

## Scope

What you get: a working, authenticated, public MCP endpoint that survives a reboot, and a way to tell which layer is broken when it isn't working. The repo also documents when a single runtime connector fits better than exposing every leaf MCP on its own.

What it isn't: an MCP framework, a proxy to install, a hosted service, or a sandbox. It doesn't fork or wrap any upstream MCP server. Every recipe points at the real project and tells you how to configure it.

It also does **not** constrain what an authenticated caller can do. Read [`docs/security.md`](./docs/security.md) before you expose anything, especially the part about turning off the tools you don't need.

When each recipe was verified:

- Original workstation recipes: 2026-08-18
- Unreal: 2026-08-19
- Hosted McDonald's edge-OAuth recipe and MCPX runtime: 2026-08-21
- QQ Mail, on an always-on Linux cloud host: 2026-09-05
- Listening Bridge's mobile outbound-WebSocket path, on a vivo phone: 2026-09-11

On 2026-09-09, DevSpace's public exposure layer moved from Tailscale Funnel to Cloudflare Tunnel. The Funnel path stays documented as a previously tested alternative.

Each recipe states what was live-checked on that date and what wasn't. If an application wasn't running at verification time, the recipe says so. It doesn't imply more coverage than it has.

## Attribution

Every MCP server here belongs to someone else. This repo links to them. It copies nothing and forks nothing.

| Project | License | Used for |
|---|---|---|
| [samuelgursky/davinci-resolve-mcp](https://github.com/samuelgursky/davinci-resolve-mcp) | MIT | DaVinci Resolve |
| [CursorTouch/Windows-MCP](https://github.com/CursorTouch/Windows-MCP) | MIT | Windows desktop |
| [ahujasid/blender-mcp](https://github.com/ahujasid/blender-mcp) | MIT | Blender |
| [honest-magic/mail-mcp](https://github.com/honest-magic/mail-mcp) | MIT | QQ Mail over IMAP/SMTP |
| [artokun/comfyui-mcp](https://github.com/artokun/comfyui-mcp) | MIT | ComfyUI |
| [Waishnav/devspace](https://github.com/Waishnav/devspace) | MIT | DevSpace, and `SingleUserOAuthProvider` used by the gateway template |
| [yyjeqhc/webcodex](https://github.com/yyjeqhc/webcodex) | Apache-2.0 | WebCodex |
| [opentokenz/mcpx](https://github.com/opentokenz/mcpx) | Apache-2.0 | MCP runtime / aggregation recipe |
| [sugarforever/amap-mcp-server](https://github.com/sugarforever/amap-mcp-server) | see upstream | upstream-MCP example inside the MCPX recipe |
| [punkpeye/mcp-proxy](https://github.com/punkpeye/mcp-proxy) | MIT | stdio → Streamable HTTP bridge |
| [modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk) | Apache-2.0 / MIT / CC-BY-4.0 | OAuth router and bearer validation |
| [cloudflare/workers-oauth-provider](https://github.com/cloudflare/workers-oauth-provider) | MIT | edge OAuth in the ComfyUI and McDonald's recipes |
| [McDonald's China MCP](https://open.mcd.cn/mcp/doc) | proprietary hosted service | official hosted MCP used by the McDonald's recipe |
| [yoruuuchan/listening-bridge](https://github.com/yoruuuchan/listening-bridge) | MIT | Android → outbound WebSocket → hosted MCP recipe |
| [EpicGames/unreal-engine-skills-for-claude-code-plugin](https://github.com/EpicGames/unreal-engine-skills-for-claude-code-plugin) | MIT | Unreal Engine agent skills |
| Unreal MCP (`ModelContextProtocol`) | ships with Unreal Engine 5.8, UE EULA | Unreal Engine |
| Moonshot Kimi CU | proprietary, no public terms found | computer-use recipe (link only, nothing redistributed) |

None of these projects endorse or maintain these recipes. Bugs in a recipe are this repo's problem; take upstream bugs upstream.

## Contributing

A new recipe is welcome if you actually ran it. Follow the structure of an existing one. State your tested environment and date. Mark anything you couldn't verify as unverified instead of filling it in. Corrections to a recipe that has drifted are just as useful, because these depend on upstream projects that move fast.

## License

MIT. See [LICENSE](./LICENSE). Upstream projects keep their own licenses.
