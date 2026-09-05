# Security

Read this before you expose anything.

## What you are actually doing

You are putting a hostname on the public internet that, once someone gets past OAuth, lets them operate software on your machine. Not "access an API" — operate your machine. The recipes in this repo cover MCP servers that can drive your GUI, run Python, execute workflows, read and write your files, and in the MCPX case aggregate several of those capability classes behind one runtime.

Two things follow from that.

**Obscurity is not a control.** The hostname will be found. Cloudflare and Tailscale hostnames appear in certificate transparency logs within minutes of issuance; they are enumerable and people do enumerate them. Assume every endpoint you publish is being probed within the hour. The only thing between a stranger and your desktop is the auth layer, so the auth layer has to actually be correct — which is why every recipe ends with an unauthenticated MCP check as a hard requirement rather than a suggestion.

**The OAuth approval secret / owner token is a root credential for that public boundary.** In the single-user patterns, one secret can authorize every capability the server or runtime exposes. It is not a "read-only key" or an "app password" unless the implementation explicitly scopes it that way. Generate strong random secrets, keep them out of Git, and treat losing them the way you'd treat losing your login password.

## Blast radius by recipe

Be honest with yourself about which row you're in before you publish it.

| Recipe | What a caller who completes OAuth can do | Arbitrary code execution? |
|---|---|---|
| [blender](../recipes/blender/) | `execute_blender_code` runs arbitrary Python in Blender's interpreter — file I/O, network, subprocesses, as your user | **Yes, directly** |
| [comfyui](../recipes/comfyui/) | Run any workflow graph; install custom nodes, which execute arbitrary Python inside ComfyUI | **Yes, via node install** |
| [devspace](../recipes/devspace/) | Read/write files and run shell commands inside the configured roots | **Yes, within roots** |
| [webcodex](../recipes/webcodex/) | Project tools and a console over the configured project roots | **Yes, within roots** |
| [mcpx](../recipes/mcpx/) | Workspace file/edit/terminal capabilities plus whatever local Skills and upstream MCPs are enabled behind the runtime | **Potentially yes; effective blast radius is the union of runtime policy + extensions** |
| [kimi-computer-use](../recipes/kimi-computer-use/) | See the screen, click anywhere, type anything, launch any app | Effectively yes — "launch app + type" reaches a shell |
| [windows-desktop](../recipes/windows-desktop/) | Same GUI control, but shell / filesystem / registry / process tools are **excluded by config** | Not in one call; still reachable by driving a GUI |
| [davinci-resolve](../recipes/davinci-resolve/) | Full Resolve Scripting API — read and modify projects, timelines, media, render | No, bounded by Resolve's API |
| [qq-mail-mcp](../recipes/qq-mail-mcp/) | Read mailbox content and attachments; create drafts, reply, and send to recipients after confirmation | No code execution, but direct data disclosure and outbound-message risk |

MCPX deserves special attention because aggregation changes the unit of risk. Adding an upstream MCP or a Skill does not create a new public hostname, but it **does** expand what the already-authenticated runtime can reach. Treat every extension as a security-surface change even when the public connector itself is unchanged.

## Reduce the surface before you expose it

In rough order of how much risk they remove per unit of effort:

1. **Turn off the tools and extensions you don't need.** The [windows-desktop recipe](../recipes/windows-desktop/) excludes PowerShell, FileSystem, Process and Registry from its HTTP endpoint. That single config change removes the "one tool call equals arbitrary code execution" path. Do the equivalent for whatever you're exposing. For MCPX, review both the runtime's own Workspace/command policy and the Skills/upstream MCPs it discovers; a stable top-level tool count does not mean a stable blast radius.

2. **Scope filesystem roots / Workspaces to the project, not the drive.** Server config that accepts a list of allowed roots will happily accept `C:\`. Don't give it that. This repo's own DevSpace deployment had whole drive letters configured, which is more permissive than it needed to be — a real mistake, documented so you don't copy it. MCPX Workspaces should likewise point at the projects you actually intend the runtime to operate on.

3. **Bind local ports to `127.0.0.1`.** Every port in every recipe is loopback-only. The tunnel is the only path in. Binding `0.0.0.0` puts your MCP server on the LAN with no guarantee that the public auth layer is in front of it, which is worse than the internet exposure you were being careful about.

4. **Use the server's own policy controls in addition to OAuth.** OAuth answers "who may enter"; it does not answer "what may they do once inside". Where the MCP server/runtime supports command allow/confirm/deny rules, filesystem policies, per-session ACLs, semantic confirmation, or extension controls, configure them. MCPX specifically has runtime policy and audit/state machinery; use it rather than treating the tunnel and OAuth password as the whole security model.

5. **Keep auth on the origin too.** Where the MCP server supports its own bearer token, set one even if another edge layer already authenticates. Then a mistake in the edge config — or someone reaching the origin through an unintended path — fails closed. The [comfyui recipe](../recipes/comfyui/) does this deliberately: OAuth at the Worker, shared secret at the origin. For built-in OAuth runtimes such as MCPX, the runtime itself is already the auth origin; do not bypass it with an alternate unauthenticated listener.

6. **Add a network-layer gate for anything you don't need to be public.** Cloudflare Access can require your identity provider before a request ever reaches your tunnel. That's a second, independent lock.

7. **Shorten token lifetimes where the implementation permits it.** The default in `templates/oauth-gateway` is a 1-hour access token and a 30-day refresh token. Built-in servers have their own TTL settings; high-blast-radius deployments should not keep credentials valid longer than operationally useful.

## Where the secrets live

Know your own inventory. For a typical local-gateway deployment:

| Secret | Typical location | If leaked |
|---|---|---|
| Owner token | a file read by the gateway | Full access to everything the MCP server can do |
| Upstream bearer token | a file read by the gateway | Direct access to the MCP server, bypassing OAuth, if the port is reachable |
| Cloudflare Tunnel token / credentials JSON | `~/.cloudflared/` | Someone can run your tunnel and take over your hostname's routing |
| Gateway state DB | `gateway-state/*.sqlite` | Live access and refresh tokens |
| Worker secrets | Cloudflare, via `wrangler secret put` | Origin access |
| Logs | `logs/` | Frequently contain paths, usernames, and prompt content |

For MCPX, add its own runtime state to that inventory: `~/.mcpx/config.yaml`, OAuth credentials, `.mcp.json` extension configuration, `state/mcpx.db`, task/artifact logs, and any upstream environment secrets. The runtime is designed to preserve recoverable sessions and audit/state; that makes the state useful and therefore sensitive.

None of these belong in git. Every template here ships a `.gitignore` that excludes `.env`, `secrets/`, `gateway-state/` and logs; keep it that way. For upstream MCP configs, prefer environment-variable expansion over literal API keys.

### Keep approval credentials separate from upstream credentials

A browser-facing OAuth approval form should never ask you to paste the upstream API/Bearer token itself. For a single-user Worker facade, one practical pattern is to derive a separate approval passphrase from a **high-entropy** upstream token with a domain-separated one-way hash, while keeping the raw upstream token only in the Worker secret store. The [McDonald's recipe](../recipes/mcdonalds/) uses this pattern.

The derived passphrase is still an authorization secret — leaking it can let someone approve a new OAuth client — but it does not reveal the upstream token. If the upstream credential is human-chosen or otherwise low entropy, do **not** derive from it; generate and store an independent approval secret instead.

For runtimes such as MCPX, keep the same separation of concerns: the browser-facing OAuth password belongs to the runtime auth layer; third-party API tokens belong to the extension/upstream environment and should not be reused as the approval secret.

To rotate a local-gateway owner token, replace the owner token file and restart the gateway. Existing ChatGPT sessions keep working until their refresh tokens expire — delete the state database as well if you need them cut off immediately. Built-in OAuth servers have their own client/token stores and rotation procedures; follow the version you actually run rather than deleting state blindly.

## Before you publish a repo of your own

The mistake is rarely a hardcoded API key. It's the accumulation of small identifying details: a real hostname, an absolute path with your username in it, a tunnel UUID, a machine name, the email in your commit metadata.

- Run a real scanner over the **working tree and the full history**, not just the current files: [gitleaks](https://github.com/gitleaks/gitleaks) (`gitleaks git . --log-opts="--all"`) or [detect-secrets](https://github.com/Yelp/detect-secrets). Deleting a file does not remove the blob from history.
- Grep for your own identifiers separately — scanners look for credential shapes, not for your username or your domain.
- Check `git log --format='%ae'`. Commit author email is public and is easy to forget. Use a `users.noreply.github.com` address if you don't want your real one indexed.
- Publish example configs, not real ones. `.env.example` with placeholders keeps the repo reproducible; a sanitized real config keeps the habit of editing the file you also run.

If a secret did reach history, rewriting with [git-filter-repo](https://github.com/newren/git-filter-repo) and force-pushing removes it from the default view — but treat the secret as compromised and rotate it anyway. Forks, clones, and caches may still hold it.

## What this repo does not give you

There is no sandbox here. The gateway templates authenticate callers; they do not constrain what an authenticated caller may ask the MCP server to do. Direct leaf MCPs vary in how much policy, rate limiting, or audit they provide. Runtime products such as MCPX may add policy and audit/state inside their own boundary, but that is an upstream capability, not something this repository adds for you.

And treat the model on the other end as an untrusted caller in the [confused deputy](https://en.wikipedia.org/wiki/Confused_deputy_problem) sense. If ChatGPT reads a web page, an email, or a file that contains instructions, those instructions can influence which of your tools it calls. Exposing a tool to ChatGPT exposes it to everything ChatGPT reads — and exposing an aggregation runtime means that statement applies to the union of the capabilities reachable behind it.
