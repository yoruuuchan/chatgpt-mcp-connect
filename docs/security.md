# Security

Read this before you expose anything.

## What you are actually doing

You are putting a hostname on the public internet that, once someone gets past OAuth, lets them operate software on your machine. Not "access an API" — operate your machine. The recipes in this repo cover MCP servers that can drive your GUI, run Python, execute workflows, and read and write your files.

Two things follow from that.

**Obscurity is not a control.** The hostname will be found. Cloudflare and Tailscale hostnames appear in certificate transparency logs within minutes of issuance; they are enumerable and people do enumerate them. Assume every endpoint you publish is being probed within the hour. The only thing between a stranger and your desktop is the auth layer, so the auth layer has to actually be correct — which is why every recipe ends with "unauthenticated request must return 401" as a hard check rather than a suggestion.

**The owner token is a root password.** In the single-user OAuth pattern, one secret grants every capability the MCP server has. It is not a "read-only key" or an "app password". Generate it with `openssl rand -hex 32`, store it in a file rather than an environment variable or a script, and treat losing it the way you'd treat losing your login password.

## Blast radius by recipe

Be honest with yourself about which row you're in before you publish it.

| Recipe | What a caller who completes OAuth can do | Arbitrary code execution? |
|---|---|---|
| [blender](../recipes/blender/) | `execute_blender_code` runs arbitrary Python in Blender's interpreter — file I/O, network, subprocesses, as your user | **Yes, directly** |
| [comfyui](../recipes/comfyui/) | Run any workflow graph; install custom nodes, which execute arbitrary Python inside ComfyUI | **Yes, via node install** |
| [devspace](../recipes/devspace/) | Read/write files and run shell commands inside the configured roots | **Yes, within roots** |
| [webcodex](../recipes/webcodex/) | Project tools and a console over the configured project roots | **Yes, within roots** |
| [kimi-computer-use](../recipes/kimi-computer-use/) | See the screen, click anywhere, type anything, launch any app | Effectively yes — "launch app + type" reaches a shell |
| [windows-desktop](../recipes/windows-desktop/) | Same GUI control, but shell / filesystem / registry / process tools are **excluded by config** | Not in one call; still reachable by driving a GUI |
| [davinci-resolve](../recipes/davinci-resolve/) | Full Resolve Scripting API — read and modify projects, timelines, media, render | No, bounded by Resolve's API |

The bottom two rows are meaningfully safer than the top four, and the difference is deliberate configuration, not luck.

## Reduce the surface before you expose it

In rough order of how much risk they remove per unit of effort:

1. **Turn off the tools you don't need.** The [windows-desktop recipe](../recipes/windows-desktop/) excludes PowerShell, FileSystem, Process and Registry from its HTTP endpoint. That single config change removes the "one tool call equals arbitrary code execution" path. Do the equivalent for whatever you're exposing — most servers have some allow/deny mechanism, and if yours doesn't, that's worth knowing before you publish it rather than after.

2. **Scope filesystem roots to the project, not the drive.** Server config that accepts a list of allowed roots will happily accept `C:\`. Don't give it that. This repo's own DevSpace deployment had whole drive letters configured, which is more permissive than it needed to be — a real mistake, documented so you don't copy it.

3. **Bind local ports to `127.0.0.1`.** Every port in every recipe is loopback-only. The tunnel is the only path in. Binding `0.0.0.0` puts your MCP server on the LAN with no auth in front of it, which is worse than the internet exposure you were being careful about.

4. **Keep auth on the origin too.** Where the MCP server supports its own bearer token, set one, even though the gateway already authenticates. Then a mistake in the gateway config — or someone reaching the origin hostname directly — fails closed. The [comfyui recipe](../recipes/comfyui/) does this deliberately: OAuth at the Worker, shared secret at the origin.

5. **Add a network-layer gate for anything you don't need to be public.** Cloudflare Access can require your identity provider before a request ever reaches your tunnel. That's a second, independent lock.

6. **Shorten token lifetimes.** The default in `templates/oauth-gateway` is a 1-hour access token and a 30-day refresh token. Shorten both for high-blast-radius servers.

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

None of these belong in git. Every template here ships a `.gitignore` that excludes `.env`, `secrets/`, `gateway-state/` and logs; keep it that way.

### Keep approval credentials separate from upstream credentials

A browser-facing OAuth approval form should never ask you to paste the upstream API/Bearer token itself. For a single-user Worker facade, one practical pattern is to derive a separate approval passphrase from a **high-entropy** upstream token with a domain-separated one-way hash, while keeping the raw upstream token only in the Worker secret store. The [McDonald's recipe](../recipes/mcdonalds/) uses this pattern.

The derived passphrase is still an authorization secret — leaking it can let someone approve a new OAuth client — but it does not reveal the upstream token. If the upstream credential is human-chosen or otherwise low entropy, do **not** derive from it; generate and store an independent approval secret instead.

To rotate: replace the owner token file and restart the gateway. Existing ChatGPT sessions keep working until their refresh tokens expire — delete the state database as well if you need them cut off immediately.

## Before you publish a repo of your own

The mistake is rarely a hardcoded API key. It's the accumulation of small identifying details: a real hostname, an absolute path with your username in it, a tunnel UUID, a machine name, the email in your commit metadata.

- Run a real scanner over the **working tree and the full history**, not just the current files: [gitleaks](https://github.com/gitleaks/gitleaks) (`gitleaks git . --log-opts="--all"`) or [detect-secrets](https://github.com/Yelp/detect-secrets). Deleting a file does not remove the blob from history.
- Grep for your own identifiers separately — scanners look for credential shapes, not for your username or your domain.
- Check `git log --format='%ae'`. Commit author email is public and is easy to forget. Use a `users.noreply.github.com` address if you don't want your real one indexed.
- Publish example configs, not real ones. `.env.example` with placeholders keeps the repo reproducible; a sanitized real config keeps the habit of editing the file you also run.

If a secret did reach history, rewriting with [git-filter-repo](https://github.com/newren/git-filter-repo) and force-pushing removes it from the default view — but treat the secret as compromised and rotate it anyway. Forks, clones, and caches may still hold it.

## What this repo does not give you

There is no sandbox here. The gateway authenticates callers; it does not constrain what an authenticated caller may ask the MCP server to do. There is no rate limiting on tool calls, no audit log of who called what, and no per-tool authorization. If you need those, they belong in the MCP server or in a policy layer in front of it — not in a 200-line proxy.

And treat the model on the other end as an untrusted caller in the [confused deputy](https://en.wikipedia.org/wiki/Confused_deputy_problem) sense. If ChatGPT reads a web page, an email, or a file that contains instructions, those instructions can influence which of your tools it calls. Exposing a tool to ChatGPT exposes it to everything ChatGPT reads.
