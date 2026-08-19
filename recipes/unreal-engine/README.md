# Unreal Engine MCP → ChatGPT

> Drive a running Unreal Editor from ChatGPT — actors, Blueprints, materials, Niagara, Sequencer, automation tests — through Epic's own in-engine MCP server, behind a public HTTPS endpoint with OAuth 2.1.

| | |
|---|---|
| **Upstream** | Epic's `ModelContextProtocol` plugin, shipped in Unreal Engine 5.8 — no third-party server involved |
| **Transport** | Native Streamable HTTP (HTTP + SSE) on `127.0.0.1:8000/mcp` |
| **Auth** | [Local OAuth gateway](../../templates/oauth-gateway/) — the plugin has none of its own |
| **Exposure** | Cloudflare Tunnel, token mode |
| **Status** | Verified end to end against a live editor — see [What was actually verified](#what-was-actually-verified) |

## What this is

Unreal Engine 5.8 is the first release where Epic ships an MCP server inside the editor itself. The plugin is called **Unreal MCP** in the Plugin Browser and `ModelContextProtocol` everywhere else — in source, in `.uplugin` files, in C++ symbols, and in the console commands. It runs in-process inside `UnrealEditor.exe`, binds to loopback, and exposes the editor's `ToolsetRegistry` over Streamable HTTP.

This recipe puts the repo's OAuth gateway in front of it and a Cloudflare Tunnel in front of that, so ChatGPT's Remote MCP connector can reach it.

**What is upstream vs. ours:**

- **Upstream** — the MCP server (ships with UE 5.8; nothing to install separately) and the [Epic agent skills](https://github.com/EpicGames/unreal-engine-skills-for-claude-code-plugin).
- **This recipe** — what to enable, in what order, and the two integration details that are specific to Unreal.
- **Our components** — the OAuth gateway and supervisor from this repo, plus a one-line `Origin` patch described below.

## Two things that are different from every other recipe here

**1. The upstream is an application, not a daemon.** There is no MCP process to supervise. The server lives and dies with the editor, so the supervisor deliberately never starts it — it probes the port and logs up/down transitions instead. "Editor is closed" has to stay distinguishable from "gateway is broken", and launching the editor behind the user's back to paper over that difference would destroy the distinction.

**2. Unreal validates the `Origin` header.** `ValidateOriginHeader` in `ModelContextProtocolServer.cpp` allows a request with no `Origin` at all, or one whose host is exactly `localhost`, `127.0.0.1` or `[::1]`. Everything else gets **403**. Measured, not inferred:

```console
$ curl -o /dev/null -w "%{http_code}\n" ... -H "origin: https://chatgpt.com" ...
403
```

That is a real security control and it should not be turned off. But the repo's gateway forwards request headers verbatim, so ChatGPT's own `Origin` would reach Unreal and every tool call would fail — after OAuth has succeeded, after the tunnel is green, after `tools/list` looked fine. The gateway copy for this recipe rewrites `Origin` to the upstream's own address before proxying:

```js
// in the proxy handler, after the existing header deletions
if (cfg.upstreamOrigin) {
  headers.origin = cfg.upstreamOrigin;
  delete headers.referer;
}
```

driven by one new config key:

```js
upstreamOrigin: process.env.UPSTREAM_ORIGIN,
```

and `UPSTREAM_ORIGIN=http://127.0.0.1:8000` in `.env`.

## Tool count is a non-issue here

Every other recipe in this repo has to think about ChatGPT's tool budget. This one does not. `bEnableToolSearch` defaults to `True`, so `tools/list` returns exactly three meta-tools — `list_toolsets`, `describe_toolset`, `call_tool` — and the real tools are dispatched server-side through `call_tool`. Leave it alone. Setting `bEnableToolSearch=False` registers every tool upfront and will blow the budget immediately.

With `AllToolsets` enabled, `list_toolsets` returned **52 toolsets** on this install — actors, assets, Blueprints, materials, static and skeletal meshes, textures, data tables, Niagara (five separate toolsets), PCG, physics, GAS, StateTree, behaviour trees, UMG, Sequencer (seven), Control Rig, semantic search, automation tests, and the editor's own logs and app state.

Two things about that output are easy to trip over:

- **Tool descriptions come back in the editor's UI language.** On a Chinese-language editor the toolset descriptions and every schema field description arrive in Chinese, because they come from Unreal's localised reflection metadata. The Python-defined tool descriptions stay English. Nothing breaks, but the model sees a mixed-language catalogue.
- **`serverInfo` is empty.** `initialize` returns `{"name":"","title":"","version":""}`. Do not key anything off it.

## Tested environment

- Windows 11 26H1 (build 26200)
- Unreal Engine **5.8.1-56057345**, installed build from the Epic Games Launcher, engine at `E:\UE_5.8`
- Node 24.14.0 for the OAuth gateway
- cloudflared 2026.7.3

## 1. Enable the plugins

Two plugins, both required. `ModelContextProtocol` is the server and transport; `AllToolsets` provides the tools. With only the first enabled the server starts and exposes nothing.

In the project's `.uproject`, in the `Plugins` array:

```json
{ "Name": "ModelContextProtocol", "Enabled": true },
{ "Name": "AllToolsets",          "Enabled": true }
```

`AllToolsets` is an editor-only aggregator with `EnabledByDefault` off, so it has to be enabled explicitly. To expose a narrower surface, enable individual toolset plugins instead of the aggregator — see [Security notes](#security-notes).

## 2. Make the server start with the editor

Add to `<Project>/Saved/Config/WindowsEditor/EditorPerProjectUserSettings.ini`, which is per-user and not source-controlled:

```ini
[/Script/ModelContextProtocolEngine.ModelContextProtocolSettings]
bAutoStartServer=True
```

Without this the server stays stopped and you have to run `ModelContextProtocol.StartServer` in the editor console every session. `ServerPortNumber` and `ServerUrlPath` go in the same section if `8000` or `/mcp` conflict with something local.

Verify before going any further:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:8000/mcp -H "content-type: application/json" -H "accept: application/json, text/event-stream" -H "origin: http://127.0.0.1:8000" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

Note the explicit loopback `Origin`. Drop it and you get a rejection that reads like a transport bug.

Then a real call, through the meta-tool. `call_tool` nests the real tool's parameters under `arguments` — the same key name as MCP's own `params.arguments`, one level down:

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{
  "name":"call_tool",
  "arguments":{
    "toolset_name":"editor_toolset.toolsets.scene.SceneTools",
    "tool_name":"get_current_level",
    "arguments":{}
  }}}
```

`{"returnValue":"/Temp/Untitled_1"}` back means the editor answered with live state.

## 3. Put OAuth in front of it

Copy [`templates/oauth-gateway`](../../templates/oauth-gateway/), apply the `Origin` patch above, and configure:

| Variable | Value |
|---|---|
| `PUBLIC_BASE_URL` | `https://unreal-mcp.example.com` |
| `UPSTREAM_HOST` / `UPSTREAM_PORT` / `UPSTREAM_PATH` | `127.0.0.1` / `8000` / `/mcp` |
| `UPSTREAM_ORIGIN` | `http://127.0.0.1:8000` |
| `GATEWAY_PORT` | `8801` |
| `SCOPE` | `unreal` |
| `OWNER_TOKEN_FILE` | path to a 32-byte random token |

There is no `UPSTREAM_AUTHORIZATION`: the plugin has no bearer auth of its own, so the gateway strips the caller's `Authorization` header instead of swapping it.

```bash
curl -s http://127.0.0.1:8801/healthz
```

`{"ok":true,"gateway":true,"upstream":true}` is the healthy answer. `upstream:false` means the editor is closed — that is the whole point of the field.

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:8801/mcp -H "content-type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

`401` is a pass. A `500` means one of the two SDK bugs in [docs/troubleshooting.md](../../docs/troubleshooting.md).

## 4. Expose it

Cloudflare Tunnel in token mode, hostname routed at `http://127.0.0.1:8801`. Identical to [davinci-resolve](../davinci-resolve/) — nothing here is Unreal-specific.

```bash
node scripts/doctor.mjs --url https://unreal-mcp.example.com --upstream 127.0.0.1:8000 --gateway 127.0.0.1:8801
```

## 5. Add it in ChatGPT

The connector URL is the public `/mcp`. Complete OAuth with the owner token. ChatGPT should then list three tools, not three hundred — that is tool-search mode working as intended.

## Keeping it alive

Supervise **the gateway and the tunnel only**. The editor is the user's to launch. The [supervisor template](../../templates/supervisor/) covers the first two; add a probe that logs the upstream's up/down transitions so a dead connector is attributable rather than mysterious:

```powershell
$script:LastUpstreamUp = $null
function Report-UpstreamState {
    $up = [bool](Get-ListenerPid $UpstreamPort)
    if ($up -ne $script:LastUpstreamUp) {
        Write-SupervisorLog $(if ($up) { 'Unreal MCP upstream is UP.' }
                              else { 'Unreal MCP upstream is DOWN. Editor closed, or StartServer not run. Not starting it.' })
        $script:LastUpstreamUp = $up
    }
}
```

## Agent skills

Epic publishes three skills at [EpicGames/unreal-engine-skills-for-claude-code-plugin](https://github.com/EpicGames/unreal-engine-skills-for-claude-code-plugin) (MIT): `unreal-mcp` for driving the editor, `create-toolset` for adding tools, `unreal-skill` for authoring in-project Agent Skills. Despite the repository name they are plain `SKILL.md` bundles with YAML frontmatter and no Claude-Code-specific dependency other than an optional `SessionStart` hook, so they load in any harness that reads that format — Codex included.

Clone once and link the three skill directories rather than copying them, so `git pull` keeps all three current:

```powershell
git clone https://github.com/EpicGames/unreal-engine-skills-for-claude-code-plugin.git "$env:USERPROFILE\.codex\skills-upstream\unreal-engine-skills-for-claude-code-plugin"

foreach ($s in @('unreal-mcp','create-toolset','unreal-skill')) {
  New-Item -ItemType Junction -Path "$env:USERPROFILE\.codex\skills\$s" -Target "$env:USERPROFILE\.codex\skills-upstream\unreal-engine-skills-for-claude-code-plugin\skills\$s"
}
```

Keep the clone outside the skills directory, or the harness tries to load the repository root as a skill. Junctions rather than symlinks because they need no elevation on Windows.

For a local agent, point it straight at the plugin and skip the gateway entirely:

```toml
[mcp_servers.unreal-mcp]
enabled = true
url = "http://127.0.0.1:8000/mcp"
```

That is the same shape the plugin writes itself — `ModelContextProtocol.GenerateClientConfig <ClaudeCode|Cursor|VSCode|Gemini|Codex|All>` in the editor console emits exactly `[mcp_servers.unreal-mcp]` with a `url` key into `~/.codex/config.toml`. It refuses to touch an existing `config.toml` (it will not attempt a TOML merge and says so in the log), so on a configured machine, write the block by hand and match that shape.

## Common errors

### Every tool call fails after OAuth succeeded

The `Origin` header — see [above](#two-things-that-are-different-from-every-other-recipe-here). This is the failure this recipe exists to warn about, because OAuth, the tunnel, discovery and `tools/list` all pass and only the actual work fails.

### `healthz` reports `upstream:false`

The editor is closed, or the MCP server was never started. Not a gateway fault. Launch the editor, check the Output Log for MCP startup lines, and run `ModelContextProtocol.StartServer` if auto-start is off.

### Editor logs "Failed to listen on port"

Something else holds `8000`; it is a popular port. Set `ServerPortNumber` in `EditorPerProjectUserSettings.ini` or pass `-ModelContextProtocolPort=<port>` at launch, then update `UPSTREAM_PORT` **and** `UPSTREAM_ORIGIN` to match.

### "input params are required by the function input schema Json, but incoming function input params Json is empty"

The inner parameters went under the wrong key. `call_tool` takes `arguments`, not `tool_input` or `input`. This one hides: a tool that needs no parameters succeeds with any wrong key, so the first call that actually passes data is where it surfaces.

### A toolset you expect is missing

Run `ModelContextProtocol.RefreshTools`. If it is still missing, its plugin is not enabled in the `.uproject`.

### Tool calls hang

Tools run on the game thread. The editor may be compiling, loading a level, or in PIE. They also cannot be parallelised — issuing two at once deadlocks. Serialise them.

## Security notes

Read this one before exposing anything.

Epic's own documentation says the plugin "is not safe to expose beyond the local machine" and has no authentication layer. This recipe exposes it anyway, and the OAuth gateway is the only thing between the public internet and the editor. That is a deliberate trade, and the blast radius is large:

- **`ProgrammaticToolset.execute_tool_script` runs arbitrary Python inside the editor process**, with full access to every toolset API, the project on disk, the asset database, and editor-privileged functions. An authenticated caller therefore has code execution as the desktop user. It is not a plugin you can leave out on its own: it lives inside `EditorToolset`, as `editor_toolset/toolsets/programmatic.py`, alongside the actor, asset, Blueprint, material and mesh toolsets. Dropping it means dropping `EditorToolset`, which is most of what makes this integration worth having. Decide that deliberately rather than discovering it later.
- **Unreal itself warns about the data you send.** The plugin logs this the moment the server starts: data transmitted to the connected LLM is Licensed Technology under the UE EULA, and you are responsible for ensuring the provider does not use it as training input — Section 6(e). Exposing the editor to a hosted assistant is a licensing decision as well as a security one.
- MCP tools mutate live `UObject` state and can move or delete version-controlled assets in a single call. Commit or shelve before a long session.
- The owner token grants everything above. Treat it as a root password.
- Keep the plugin on loopback. The tunnel is the only ingress and the gateway binds `127.0.0.1`.
- Origin validation stays on. The gateway rewrites `Origin` for the single hop it terminates; it does not disable the check inside Unreal.

## Known limitations

- The editor must be running with its GUI in an interactive desktop session. There is no headless mode for this.
- Tool calls are serial by construction. Long compiles block everything; prefer `LiveCodingToolset.CompileLiveCoding`, which returns when the compile actually finishes.
- Editor-only tools behave differently while Play-in-Editor is active.

## What was actually verified

Being explicit, because "verified" gets used loosely.

**Verified 2026-08-19**, against Unreal Engine 5.8.1 with the editor open on a blank project.

| Checked | Result |
|---|---|
| `scripts/doctor.mjs`, all six layers | pass |
| `initialize` on `127.0.0.1:8000/mcp` | 200, `Mcp-Session-Id` issued, protocol `2025-06-18` |
| `tools/list` | exactly 3 meta-tools, as tool-search mode intends |
| `list_toolsets` | 52 toolsets |
| Read-only tool call (`SceneTools.get_current_level`) | returned live editor state |
| Non-loopback `Origin` straight to the plugin | **403** — confirms the rewrite is required, not precautionary |
| DCR → PKCE S256 → authorize → token, over the public URL | pass, `bearer`, `expires_in=3600`, `scope=unreal` |
| `initialize` + `tools/list` over HTTPS with a real access token and `Origin: https://chatgpt.com` | pass — the gateway's rewrite carried it through |
| Mutating call over the same path: create a `PointLight`, read its label and transform back, delete it | pass, all four calls |
| Test actor removed afterwards (`find_actors` → `[]`) | pass |
| Supervisor logs upstream up/down transitions and never starts the editor | pass |
| Epic agent skills linked and loadable | pass |
| **ChatGPT connector: OAuth from the UI, tool discovery, a tool call initiated from a chat** | **not run — needs a human in the ChatGPT UI** |

The last row is the honest gap. Everything ChatGPT's connector does mechanically has been exercised with a hand-driven client that follows the same OAuth flow and sends the same `Origin`, but nobody has clicked through the connector itself.

## Attribution

| Component | Source | License |
|---|---|---|
| Unreal MCP (`ModelContextProtocol` plugin) | Ships with Unreal Engine 5.8 | Unreal Engine EULA |
| Unreal Engine agent skills | [EpicGames/unreal-engine-skills-for-claude-code-plugin](https://github.com/EpicGames/unreal-engine-skills-for-claude-code-plugin) | MIT |
| MCP TypeScript SDK | [modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk) | Apache-2.0 / MIT / CC-BY-4.0 |
| SingleUserOAuthProvider | [Waishnav/devspace](https://github.com/Waishnav/devspace) | MIT |
| OAuth gateway, supervisor, this recipe | This repo | MIT |

Epic does not endorse or ship this integration.
