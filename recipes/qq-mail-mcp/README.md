# QQ Mail MCP → ChatGPT

> Keep a personal QQ mailbox available to ChatGPT from an always-on Linux cloud host — search and read mail, inspect threads and attachments, create drafts, reply, and send through QQ's IMAP/SMTP service.

| | |
|---|---|
| **Upstream** | [honest-magic/mail-mcp](https://github.com/honest-magic/mail-mcp) · MIT · tested from `3621ef9` (`1.4.0`) with the QQ Sent-folder compatibility change in [§2](#2-install-mail-mcp-and-handle-qqs-sent-folder) |
| **Transport** | stdio → [`mcp-proxy`](https://github.com/punkpeye/mcp-proxy) `6.7.0` → Streamable HTTP on loopback |
| **Auth** | [Local OAuth gateway](../../templates/oauth-gateway/) with DCR and PKCE S256 |
| **Exposure** | Cloudflare Tunnel, token mode, running on the same cloud host |
| **Status** | Verified 2026-09-05 on an always-on Linux cloud VM in mainland China: real QQ IMAP/SMTP, public OAuth, ChatGPT connection and real tool calls passed. No mailbox address, hostname, server address, or credential is recorded here. |

## What this is

[`mail-mcp`](https://github.com/honest-magic/mail-mcp) is a stdio MCP server for standard IMAP and SMTP accounts. QQ Mail supplies those protocols, but ChatGPT cannot connect to stdio directly. This recipe adds the two missing layers — a Streamable HTTP bridge and the repo's OAuth gateway — then runs the whole chain under `systemd` on a cloud server so it remains available when the personal computer is off.

The verified deployment deliberately exposed all read tools but only three write tools: `send_email`, `reply_email`, and `create_draft`. Every write requires a two-call confirmation token.

```text
ChatGPT
  │ OAuth 2.1
  ▼
https://qq-mail-mcp.example.com/mcp
  │ Cloudflare Tunnel
  ▼
OAuth gateway 127.0.0.1:18771
  │
  ▼
mcp-proxy 127.0.0.1:18770/mcp  (Streamable HTTP)
  │ stdio
  ▼
mail-mcp
  ├── TLS → imap.qq.com:993
  └── TLS → smtp.qq.com:465
```

Everything below the Cloudflare edge runs on the cloud VM. There is no WSL keepalive, desktop session, or personal-computer process in this topology.

## Tested environment

- Linux cloud VM with `systemd` 239
- Node.js `22.22.2`
- `honest-magic/mail-mcp` source at `3621ef92e96a1387dbff797c28d630259991b5a4`, packaged locally as `1.4.0-qq.1` after the compatibility change below
- `mcp-proxy` `6.7.0`
- `@waishnav/devspace` `1.0.5` through this repo's OAuth gateway
- `cloudflared` `2026.3.0`

## Prerequisites

1. A QQ Mail account with access to its web settings and bound verification method.
2. A Linux cloud VM that can reach `imap.qq.com:993` and `smtp.qq.com:465`.
3. Node.js `>=22.19 <27`, Git, OpenSSL, and `cloudflared`.
4. A Cloudflare account with a domain and a named tunnel.
5. A copy of this repository for [`templates/oauth-gateway`](../../templates/oauth-gateway/) and [`scripts/doctor.mjs`](../../scripts/doctor.mjs).

## 1. Prepare QQ Mail

In QQ Mail's web settings, find **Third-party services / IMAP/SMTP**, enable it, and generate an authorization code. The exact navigation label has changed between QQ Mail UI versions; it is currently under **Settings → General** in the newer UI and may appear under **Settings → Account** in older instructions. Tencent's [QQ Mail connector documentation](https://cloud.tencent.com/document/product/1270/55456) shows the same service switch, authorization-code requirement, and server values.

Use these settings:

| Setting | Value |
|---|---|
| IMAP host | `imap.qq.com` |
| IMAP port | `993` |
| IMAP security | implicit TLS |
| SMTP host | `smtp.qq.com` |
| SMTP port | `465` |
| SMTP security | implicit TLS |
| Username | the complete `@qq.com` address |
| Password field | the generated QQ authorization code — **not** the QQ account password |

Treat the authorization code as a revocable app password. Do not paste it into JSON, a command argument, a committed `.env`, an issue, or this repository.

## 2. Install mail-mcp and handle QQ's Sent folder

The verified build used the current upstream source commit rather than claiming an unpublished QQ package exists:

```bash
git clone https://github.com/honest-magic/mail-mcp.git /opt/mail-mcp-src
cd /opt/mail-mcp-src
git checkout 3621ef92e96a1387dbff797c28d630259991b5a4
npm ci
```

### QQ Sent-folder compatibility

At the tested commit, upstream appends sent mail to a hard-coded `Sent` folder. The tested QQ account advertises its real folder as `Sent Messages`; SMTP delivery succeeds, but the copy-to-Sent step cannot be trusted until the folder is resolved from the server.

The verified deployment added this method to `MailService` in `src/services/mail.ts`:

```ts
private async getSentFolder(): Promise<string> {
  const folders = await this.imapClient.listFolders();
  for (const candidate of ['Sent', 'Sent Messages', '已发送']) {
    const match = folders.find(
      (folder) => folder.toLocaleLowerCase() === candidate.toLocaleLowerCase(),
    );
    if (match) return match;
  }
  return 'Sent';
}
```

In `sendEmail`, `replyEmail`, and `forwardEmail`, replace:

```ts
await this.imapClient.appendMessage('Sent', rawMessage, ['\\Seen']);
```

with:

```ts
await this.imapClient.appendMessage(await this.getSentFolder(), rawMessage, ['\\Seen']);
```

Add a regression test whose folder list contains `Sent Messages`, then build a clearly labelled local artifact:

```bash
npm pkg set version=1.4.0-qq.1
npm test
npm run build
npm pack
```

The verified build passed 495 tests before it was installed. `1.4.0-qq.1` is a local deployment label, **not** a version published by the upstream project.

Create a small runtime directory, copy in the tarball and the gateway template, and install exact runtime dependencies:

```bash
sudo install -d -m 0755 /opt/qq-mail-mcp/vendor
sudo cp honest-magic-mail-mcp-1.4.0-qq.1.tgz /opt/qq-mail-mcp/vendor/
sudo cp /path/to/chatgpt-mcp-connect/templates/oauth-gateway/gateway.mjs /opt/qq-mail-mcp/

cd /opt/qq-mail-mcp
sudo npm init -y
sudo npm install --save-exact \
  ./vendor/honest-magic-mail-mcp-1.4.0-qq.1.tgz \
  mcp-proxy@6.7.0 \
  @waishnav/devspace@1.0.5
```

Pin and retain the generated lockfile. Do not run an unpinned `npx` command in an unattended service.

## 3. Configure the account and credential store

Create the three service identities before provisioning their files. Skip a `useradd` line if that user already exists, and use the platform's `nologin` path if it differs from `/sbin/nologin`:

```bash
sudo useradd --system --home-dir /var/lib/mailmcp --create-home --shell /sbin/nologin mailmcp
sudo useradd --system --home-dir /var/lib/qqmailoauth --create-home --shell /sbin/nologin qqmailoauth
sudo useradd --system --home-dir /var/lib/qqmailtunnel --create-home --shell /sbin/nologin qqmailtunnel

sudo install -d -o mailmcp -g mailmcp -m 0700 /var/lib/mailmcp/.config/mail-mcp
sudo install -d -o mailmcp -g mailmcp -m 0700 /var/lib/mailmcp/.config/keyring
sudo install -d -o mailmcp -g mailmcp -m 0700 /var/lib/mailmcp/.local/share/keyring
sudo install -d -o qqmailoauth -g qqmailoauth -m 0700 /var/lib/qqmailoauth/gateway-state
```

Copy [`.env.example`](./.env.example) outside the checkout and fill only deployment-specific, non-secret values there:

```bash
sudo install -d -m 0755 /etc/qq-mail-mcp
sudo install -m 0600 .env.example /etc/qq-mail-mcp/runtime.env
```

`mail-mcp` reads account metadata from `~/.config/mail-mcp/accounts.json`. Materialize this JSON during provisioning; it does not expand `${VARIABLE}` placeholders itself:

```json
[
  {
    "id": "qq",
    "name": "QQ Mail",
    "host": "imap.qq.com",
    "port": 993,
    "smtpHost": "smtp.qq.com",
    "smtpPort": 465,
    "user": "YOUR_QQ_NUMBER@qq.com",
    "authType": "login",
    "useTLS": true
  }
]
```

Write the rendered file to `/var/lib/mailmcp/.config/mail-mcp/accounts.json`, replacing the placeholder from `QQ_MAIL_ADDRESS`, then lock it down:

```bash
sudo chown mailmcp:mailmcp /var/lib/mailmcp/.config/mail-mcp/accounts.json
sudo chmod 0600 /var/lib/mailmcp/.config/mail-mcp/accounts.json
```

That is the exact path, owner, and mode used on the verified headless host.

`mail-mcp` has no QQ-specific authorization-code environment variable. Do not invent one and leave the code in a long-lived service environment. Feed it once through the upstream keychain interface, then clear the shell variable:

```bash
read -rsp 'QQ authorization code: ' qq_auth_code; echo
printf '%s' "$qq_auth_code" | sudo -u mailmcp env \
  HOME=/var/lib/mailmcp \
  XDG_CONFIG_HOME=/var/lib/mailmcp/.config \
  XDG_DATA_HOME=/var/lib/mailmcp/.local/share \
  TS_KEYRING_BACKEND=file \
  /opt/qq-mail-mcp/node_modules/.bin/cross-keychain \
  set ch.honest-magic.config.mail-server qq --password-stdin
unset qq_auth_code
```

The tested file backend used AES-256-GCM through `cross-keychain`. Both its key and encrypted data files were mode `0600`, their directories and `/var/lib/mailmcp` were `0700`, and the service ran as `mailmcp`. This is still a host-level trust boundary: root can read both the key and ciphertext. Prefer a native secret service or an external secret manager where the host supports one.

Validate with the exact same identity and environment the service will use:

```bash
sudo -u mailmcp env \
  HOME=/var/lib/mailmcp \
  XDG_CONFIG_HOME=/var/lib/mailmcp/.config \
  XDG_DATA_HOME=/var/lib/mailmcp/.local/share \
  TS_KEYRING_BACKEND=file \
  /opt/qq-mail-mcp/node_modules/.bin/mail-mcp --validate-accounts
```

Expected:

```text
[PASS] qq IMAP
[PASS] qq SMTP
```

## 4. Make stdio speak Streamable HTTP

Run the bridge on loopback and allow only the three required write tools:

```bash
sudo -u mailmcp env \
  HOME=/var/lib/mailmcp \
  XDG_CONFIG_HOME=/var/lib/mailmcp/.config \
  XDG_DATA_HOME=/var/lib/mailmcp/.local/share \
  TS_KEYRING_BACKEND=file \
  /opt/qq-mail-mcp/node_modules/.bin/mcp-proxy \
    --host 127.0.0.1 \
    --port 18770 \
    --server stream \
    --eventStoreMaxEvents 100 \
    --keepAliveTimeout 300000 \
    --requestTimeout 300000 \
    -- \
    /opt/qq-mail-mcp/node_modules/.bin/mail-mcp \
      --allow-tools send_email,create_draft,reply_email \
      --confirm \
      --redact
```

`--allow-tools` restricts write tools; read tools remain available. `--confirm` makes each write a two-step operation: the first call returns `confirmationRequired` plus a single-use `confirmationId`, and the second call repeats the action with that ID. Do not combine `--allow-tools` with `--read-only`; upstream treats them as mutually exclusive.

Verify the bridge:

```bash
curl -fsS http://127.0.0.1:18770/ping
# pong
```

## 5. Put OAuth in front and expose it

Use [`templates/oauth-gateway`](../../templates/oauth-gateway/) without removing either of its two auth fixes. The relevant environment is already represented in [`.env.example`](./.env.example):

```dotenv
PUBLIC_BASE_URL=https://qq-mail-mcp.example.com
OWNER_TOKEN_FILE=/etc/qq-mail-mcp/owner-token.txt
UPSTREAM_HOST=127.0.0.1
UPSTREAM_PORT=18770
UPSTREAM_PATH=/mcp
GATEWAY_HOST=127.0.0.1
GATEWAY_PORT=18771
MCP_PATH=/mcp
SCOPE=qq-mail
RESOURCE_NAME="QQ Mail MCP"
STATE_DIR=/var/lib/qqmailoauth/gateway-state
```

Generate an owner token independently of the QQ authorization code:

```bash
sudo sh -c 'umask 0077; openssl rand -hex 32 > /etc/qq-mail-mcp/owner-token.txt'
```

The **owner token** is what the human enters on the OAuth consent page. It is not the QQ password and not the QQ authorization code.

Start the gateway through the `systemd` unit below, then verify both layers:

```bash
curl -fsS http://127.0.0.1:18771/healthz
# {"ok":true,"gateway":true,"upstream":true}
```

In Cloudflare Zero Trust, create a named tunnel in token mode and route `qq-mail-mcp.example.com` to `http://127.0.0.1:18771`. Save the tunnel token in a root-owned file outside Git and run:

```bash
cloudflared tunnel --no-autoupdate run \
  --token-file /etc/qq-mail-mcp/cloudflared.token
```

### Keep all three processes alive

Create separate `systemd` units for the bridge, gateway, and tunnel. The verified dependency order was:

```text
network-online.target
  → qq-mail-mcp-bridge.service
    → qq-mail-mcp-oauth.service
      → cloudflared-qq-mail-mcp.service
```

Set the two service-readable secret files to the narrow groups that need them:

```bash
sudo chown root:qqmailoauth /etc/qq-mail-mcp/owner-token.txt
sudo chmod 0640 /etc/qq-mail-mcp/owner-token.txt
sudo chown root:qqmailtunnel /etc/qq-mail-mcp/cloudflared.token
sudo chmod 0640 /etc/qq-mail-mcp/cloudflared.token
```

Use this bridge unit as `/etc/systemd/system/qq-mail-mcp-bridge.service`:

```ini
[Unit]
Description=QQ Mail MCP stdio to Streamable HTTP bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=mailmcp
Group=mailmcp
Environment=HOME=/var/lib/mailmcp
Environment=XDG_CONFIG_HOME=/var/lib/mailmcp/.config
Environment=XDG_DATA_HOME=/var/lib/mailmcp/.local/share
Environment=TS_KEYRING_BACKEND=file
WorkingDirectory=/opt/qq-mail-mcp
ExecStart=/opt/qq-mail-mcp/node_modules/.bin/mcp-proxy \
  --host 127.0.0.1 --port 18770 --server stream \
  --eventStoreMaxEvents 100 --keepAliveTimeout 300000 --requestTimeout 300000 \
  -- /opt/qq-mail-mcp/node_modules/.bin/mail-mcp \
  --allow-tools send_email,create_draft,reply_email --confirm --redact
Restart=always
RestartSec=3
TimeoutStopSec=15
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/mailmcp

[Install]
WantedBy=multi-user.target
```

Use this gateway unit as `/etc/systemd/system/qq-mail-mcp-oauth.service`:

```ini
[Unit]
Description=QQ Mail MCP OAuth 2.1 gateway
After=network-online.target qq-mail-mcp-bridge.service
Wants=network-online.target
Requires=qq-mail-mcp-bridge.service

[Service]
Type=simple
User=qqmailoauth
Group=qqmailoauth
EnvironmentFile=/etc/qq-mail-mcp/runtime.env
WorkingDirectory=/opt/qq-mail-mcp
ExecStart=/usr/bin/node /opt/qq-mail-mcp/gateway.mjs
Restart=always
RestartSec=3
TimeoutStopSec=15
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadOnlyPaths=/etc/qq-mail-mcp/owner-token.txt
ReadWritePaths=/var/lib/qqmailoauth

[Install]
WantedBy=multi-user.target
```

Use this tunnel unit as `/etc/systemd/system/cloudflared-qq-mail-mcp.service`:

```ini
[Unit]
Description=Cloudflare Tunnel for QQ Mail MCP
After=network-online.target qq-mail-mcp-oauth.service
Wants=network-online.target
Requires=qq-mail-mcp-oauth.service

[Service]
Type=simple
User=qqmailtunnel
Group=qqmailtunnel
ExecStart=/usr/local/bin/cloudflared tunnel --no-autoupdate run --token-file /etc/qq-mail-mcp/cloudflared.token
Restart=always
RestartSec=5
TimeoutStopSec=15
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadOnlyPaths=/etc/qq-mail-mcp/cloudflared.token

[Install]
WantedBy=multi-user.target
```

These units use dedicated unprivileged users, `Restart=always`, `UMask=0077`, `NoNewPrivileges=true`, `ProtectSystem=strict`, and only the minimum `ReadWritePaths`. The bridge and gateway listen on `127.0.0.1`; Cloudflare Tunnel is the sole public ingress. Enable all three at boot:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now \
  qq-mail-mcp-bridge.service \
  qq-mail-mcp-oauth.service \
  cloudflared-qq-mail-mcp.service
```

Then check both lifecycle properties, not merely the current processes:

```bash
systemctl is-enabled qq-mail-mcp-bridge qq-mail-mcp-oauth cloudflared-qq-mail-mcp
systemctl is-active  qq-mail-mcp-bridge qq-mail-mcp-oauth cloudflared-qq-mail-mcp
```

All six results were `enabled` / `active` on the verified deployment. The VM was not deliberately rebooted while writing this recipe, so that configuration check is not presented as a literal reboot test.

## 6. Add it in ChatGPT

1. Go to [ChatGPT settings](https://chatgpt.com/settings) and enable developer mode for custom MCP connections. The label and location can change; check the current ChatGPT UI rather than copying an old screenshot.
2. Add a custom MCP connection with `https://qq-mail-mcp.example.com/mcp`.
3. Complete OAuth. When the gateway asks for **Owner password**, enter the gateway owner token from `OWNER_TOKEN_FILE` — never the QQ authorization code.
4. Review the discovered tools before enabling the connection in a chat.
5. Start with `list_folders` or another read-only call.

The tested ChatGPT connection completed OAuth, discovered the scoped tool set, and made real QQ Mail calls through the full public chain.

## Verified capability matrix

| Capability | Tool / path | Result on 2026-09-05 |
|---|---|---|
| OAuth, ChatGPT tool discovery, real call | public `/mcp` | ✅ pass |
| List folders | `list_folders` | ✅ pass |
| List and search mail | `list_emails`, `search_emails` | ✅ pass |
| Read full message | `read_email` | ✅ pass |
| Read Sent | `list_emails` + `read_email` on `Sent Messages` | ✅ pass after the compatibility change in §2 |
| Conversation thread | `get_thread` | ✅ pass |
| Mailbox counts | `mailbox_stats` | ✅ pass |
| Download attachments | `get_attachment` | ✅ pass |
| Extract attachment text | `extract_attachment_text` | ✅ PDF and plain text |
| Send mail | `send_email` via SMTP | ✅ controlled self-addressed test |
| Reply in thread | `reply_email` | ✅ pass |
| Create draft | `create_draft` | ✅ pass |
| Write confirmation | `--confirm` / `confirmationId` | ✅ two-step, single-use token |

The scoped deployment exposed 17 tools in total. QQ does not provide ManageSieve, so the upstream Sieve tools are not part of this verification even if a future upstream tool list advertises them.

## Short verification sequence

Work outward and stop at the first failed layer:

```bash
# 1. Real QQ credentials
sudo -u mailmcp env HOME=/var/lib/mailmcp \
  XDG_CONFIG_HOME=/var/lib/mailmcp/.config \
  XDG_DATA_HOME=/var/lib/mailmcp/.local/share \
  TS_KEYRING_BACKEND=file \
  /opt/qq-mail-mcp/node_modules/.bin/mail-mcp --validate-accounts

# 2. Bridge and gateway
curl -fsS http://127.0.0.1:18770/ping
curl -fsS http://127.0.0.1:18771/healthz

# 3. Public HTTPS, OAuth metadata, DCR, PKCE and unauthenticated 401
node /path/to/chatgpt-mcp-connect/scripts/doctor.mjs \
  --url https://qq-mail-mcp.example.com --path /mcp
```

Then verify from ChatGPT itself:

1. List folders and identify Inbox, Drafts, and `Sent Messages` / `已发送`.
2. Search Inbox for a known subject and read the returned UID.
3. Download a known attachment and, where applicable, extract PDF or plain-text content.
4. Send a harmless message to the same mailbox. Inspect the first confirmation response, approve with its `confirmationId`, then find and read the copy in Sent.
5. Create a disposable draft or reply in a controlled thread, again reviewing the confirmation before the second call.

A healthy tunnel and a passing doctor are not ChatGPT acceptance. The last five calls are what proved the integration here.

## Common errors

### `Credentials not found for account: qq`

The validation command is probably running as a different user or with different `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, or `TS_KEYRING_BACKEND` values than the service. Run it with the exact service identity and environment shown above. A successful bridge call proves the credential exists for the bridge process; a differently-scoped shell command does not contradict that.

### SMTP sends, but Sent is missing or reports an append error

The upstream build is still hard-coding `Sent`. Apply the folder-resolution change in §2 and verify the folder name returned by `list_folders`. The tested QQ mailbox used `Sent Messages`.

### Search in Sent returns zero even though the message is visible

On the tested QQ account, server-side subject/body search in `Sent Messages` was unreliable for appended SMTP messages. Search was verified in `INBOX`; Sent was verified separately with `list_emails` followed by `read_email`. Do not convert one provider-specific IMAP search quirk into a false SMTP failure.

### Public `/mcp` returns 401

That is correct before OAuth. It proves the gateway is rejecting an unauthenticated caller. A public 200 without a bearer token would be the failure.

### OAuth works, but tools return 502 or `/healthz` says `upstream:false`

The gateway is alive but `mcp-proxy` or its stdio child is down. Check the bridge unit and its journal before changing Cloudflare or OAuth.

### A write returns `confirmationRequired` instead of sending

That is `--confirm` working. Review the described action, then repeat the same call with the returned `confirmationId`. Tokens are short-lived and single-use; obtain a new one after an expiry or mismatch.

## Security notes

- **Email is untrusted input.** A message or attachment can contain prompt-injection instructions that try to make the model call `send_email` or `reply_email`. Keep write confirmation enabled and review recipients, subject, and body before the second call.
- Allow-list only the write tools you need. The verified deployment did not expose delete, move, label, star, forward, batch, filter, or OAuth-registration writes.
- Store the QQ authorization code only through the credential backend. Keep `accounts.json`, key material, ciphertext, owner token, tunnel token, and OAuth state outside Git with restrictive ownership and modes.
- Keep the QQ authorization code, OAuth owner token, and Cloudflare Tunnel token separate. They protect different boundaries and should never be reused.
- Bind the bridge and gateway to `127.0.0.1`. `mail-mcp` has no bearer-protected HTTP origin of its own in this topology; loopback plus the OAuth gateway is the boundary.
- `--redact` masks several common secret patterns in returned message text, but it is not a data-loss-prevention system and can have false negatives.
- `--audit-log` was intentionally not enabled in the verified deployment because mail tool arguments can include recipients, subjects, and bodies. If you enable it, treat the log as mailbox data.
- Downloaded attachments remain untrusted files. Extracting text is not permission to execute macros, scripts, or binaries.
- Read the repo-wide [security model](../../docs/security.md), especially the confused-deputy section.

## Known limitations

- The QQ `Sent Messages` compatibility change is local until upstream provides equivalent folder discovery. Keep it small, tested, and easy to drop after an upstream release fixes the behavior.
- QQ's server-side search behavior differs by folder; the tested Sent search limitation is documented above.
- A file-backed keyring is encrypted but weaker than a native OS secret service because the same host holds both key and ciphertext. Root remains the final trust boundary.
- `systemd` autostart and `Restart=always` were verified as configured and active; a deliberate whole-VM reboot was not part of this recipe's acceptance run.

## Attribution

| Component | Source | License |
|---|---|---|
| Mail MCP server | [honest-magic/mail-mcp](https://github.com/honest-magic/mail-mcp) | MIT |
| stdio → Streamable HTTP bridge | [punkpeye/mcp-proxy](https://github.com/punkpeye/mcp-proxy) | MIT |
| OAuth provider used by the gateway | [Waishnav/devspace](https://github.com/Waishnav/devspace) | MIT |
| MCP OAuth router and bearer validation | [modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk) | Apache-2.0 / MIT / CC-BY-4.0 |
| OAuth gateway template and this recipe | This repo (`chatgpt-mcp-connect`) | MIT |

The upstream projects do not endorse or maintain this integration recipe.
