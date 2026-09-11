# Listening Bridge → ChatGPT

> Relay Android media-session state to an always-on hosted MCP through one outbound persistent WebSocket, then let ChatGPT reach the hosted MCP through OAuth 2.1 over public HTTPS.

| | |
|---|---|
| **Upstream** | [yoruuuchan/listening-bridge](https://github.com/yoruuuchan/listening-bridge) · MIT · v0.1.1 |
| **Device transport** | Android `MediaSession` metadata → outbound persistent WSS with a device bearer token |
| **MCP transport** | Hosted Streamable HTTP on loopback |
| **ChatGPT auth** | Single-user OAuth 2.1 gateway with DCR + PKCE S256 |
| **Exposure** | Cloudflare Tunnel with separate public HTTPS/WSS hostnames |
| **Status** | Verified 2026-09-11 on a vivo V2405A — phone → WebSocket → hosted server → OAuth/MCP → ChatGPT real `get_listening_context` call succeeded |

## Why this shape exists

A phone is a poor inbound server. Its IP changes, carrier NAT blocks unsolicited inbound traffic, vendor power management is aggressive, and the phone should keep working when the user's workstation is asleep.

Listening Bridge reverses that direction: the Android companion dials out to an always-on host and keeps one authenticated WebSocket open. The host keeps the current media-session snapshot, exposes MCP only on loopback, puts OAuth in front of it, and publishes the gateway through HTTPS.

```text
Android media player
  │ MediaSession metadata + explicit playback controls
  ▼
Listening Bridge companion
  │ outbound persistent WSS · device bearer token
  ▼
hosted Listening Bridge
  │ loopback Streamable HTTP MCP
  ▼
single-user OAuth gateway
  │ OAuth 2.1 · DCR · PKCE S256
  ▼
public HTTPS endpoint
  ▼
ChatGPT
```

The phone listener and ChatGPT endpoint should use separate public hostnames. The device credential and OAuth owner credential should also be independent.

## What the phone sends

The Android app reads metadata published through Android `MediaSession`: title, artist, album, duration, playback state, position, speed, and stable media identifiers when the player provides them. It does not request microphone permission or capture raw audio.

The same WebSocket can carry explicit playback actions back to the phone. The MCP surface stays intentionally small: read listening context and request supported playback controls.

## Deploy

Use the upstream repository for the concrete server, Android, gateway, and systemd files:

```bash
git clone https://github.com/yoruuuchan/listening-bridge.git
cd listening-bridge
```

The hosted deployment runs three logical layers on one always-on Linux host:

1. Listening Bridge in `phone` source mode, with MCP bound to loopback and a separate authenticated phone WebSocket listener.
2. The included OAuth gateway, also bound to loopback, proxying `/mcp` to the Python origin.
3. A Cloudflare Tunnel publishing one hostname for the OAuth/MCP gateway and another WSS hostname for the phone listener.

Follow the upstream [`deploy/systemd` guide](https://github.com/yoruuuchan/listening-bridge/tree/main/deploy/systemd) for service units, token files, and exact environment variables.

## Android side

Install the APK from the upstream Releases page, grant notification access so Android permits `MediaSessionManager.getActiveSessions`, then configure the public `wss://.../phone` endpoint and the device token.

On vendor Android builds such as vivo / OriginOS, also allow autostart and background power usage. A foreground notification and battery-optimization exemption improve persistence, but vendor policy still matters.

The companion's `online` state proves only the phone WebSocket. It does not prove OAuth, MCP discovery, or a ChatGPT tool call.

## Add it in ChatGPT

Add the public MCP endpoint from the hosted gateway, for example:

```text
https://mcp.example.com/mcp
```

Complete the OAuth flow with the owner token. ChatGPT should discover the protected-resource metadata, authorization-server metadata, dynamic client registration, PKCE flow, token/refresh endpoints, and MCP tools.

## Verify the whole chain

Treat every hop as a separate acceptance layer:

1. **Phone:** companion reports `online` and the hosted service sees a fresh phone heartbeat.
2. **Hosted origin:** local health check reports the phone/source state explicitly.
3. **OAuth:** DCR, authorization code + PKCE, token exchange, and refresh succeed.
4. **MCP:** authenticated `tools/list` succeeds.
5. **ChatGPT:** select the Listening Bridge app and execute a real `get_listening_context` call.

The 2026-09-11 verification reached step 5 from ChatGPT. With no active phone media session at that moment, the tool correctly returned an unavailable media-session state; that result still proves the connector, OAuth, MCP transport, and tool execution path were live.

## Failure signatures seen during verification

### Cloudflare 530 on an old hostname

A previously used Tunnel hostname returned Cloudflare 530 even though the current deployment was healthy. Confirm the exact active public hostname before debugging OAuth or the application server. A stale DNS/Tunnel name can mimic a dead service.

### ChatGPT says it cannot connect the account

The public OAuth endpoints can work while an existing ChatGPT app connection is stale. Reconnect the app against the current MCP hostname and complete OAuth again, then perform a real tool call before declaring success.

### Phone is online but listening context is unavailable

The WebSocket can be healthy while Android has no active `MediaSession`. Start playback in a player that publishes a media session and check notification-access permission. The server diagnostics should distinguish transport health from media-session availability.

### Background disconnects on vivo / other vendor builds

Grant notification access, foreground notification permission, battery-optimization exemption, autostart, and the vendor's background-power permission. Test after the screen has been off for a while; a foreground success alone is weak evidence for a persistent mobile bridge.

## Security notes

- Keep the Python MCP origin and OAuth gateway on loopback; publish them only through the intended tunnel/proxy.
- Use WSS for the phone listener and a random device token stored outside Git.
- Keep the phone token separate from the OAuth owner token.
- Do not commit `.env`, token files, OAuth state databases, signing keystores, APK build directories, logs, or real private endpoints copied from a production deployment.
- The Android app stores its endpoint/token in app-private preferences; a rooted or otherwise compromised phone is outside that boundary.
- Lyrics providers receive track metadata when configured; that is separate from the raw-audio privacy property.

## Known limitations

- Accuracy depends on what the Android player publishes through `MediaSession`; missing or stale player metadata cannot be reconstructed reliably.
- Android vendor background policy can still terminate long-lived networking despite standard foreground-service and battery exemptions.
- A green Tunnel, a healthy gateway, and successful `tools/list` are prerequisites. Completion still requires a real ChatGPT tool call.

## Attribution

| Component | Source | License |
|---|---|---|
| Listening Bridge server + Android companion | [yoruuuchan/listening-bridge](https://github.com/yoruuuchan/listening-bridge) | MIT |
| This recipe | This repo (`chatgpt-mcp-connect`) | MIT |
