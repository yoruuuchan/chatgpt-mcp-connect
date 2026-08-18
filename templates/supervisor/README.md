# Supervisor template

Keeps an MCP connector's processes alive across crashes and reboots, on Windows.

A connector is not one process. It is typically three or four — the MCP server, sometimes a stdio bridge, sometimes an OAuth gateway, and the tunnel — and all of them have to be running for ChatGPT to work. A scheduled task can start one process; it cannot express "keep these four alive". That gap is what this fills.

## Files

| File | Purpose |
|---|---|
| `supervisor.ps1` | Poll loop. Edit the `$Components` list at the top; that's the whole configuration. |
| `run-hidden.vbs` | Launches PowerShell with no console window flash. |

## Setup

1. Copy both files somewhere outside this repo — they hold machine-specific paths.

2. Edit `$SupervisorName`, `$LogDir` and `$Components` in `supervisor.ps1`.

   Each component is checked by a TCP port. If nothing is listening, it gets restarted. `cloudflared` has no listening port, so it's matched by a fragment of its command line instead:

   ```powershell
   @{
       Name             = 'cloudflared'
       Port             = $null
       Command          = 'C:\Program Files (x86)\cloudflared\cloudflared.exe'
       Arguments        = @('tunnel', 'run', '--token-file', "$env:USERPROFILE\.cloudflared\my-mcp.token")
       MatchCommandLine = 'my-mcp.token'
   }
   ```

   Use `RequiresPort` for a component that should only start once something else is up — a stdio bridge whose target application isn't running yet, for example:

   ```powershell
   @{
       Name         = 'stdio-bridge'
       Port         = 9877
       RequiresPort = 9876     # don't start until the application's socket exists
       Command      = 'npx'
       Arguments    = @('--yes', 'mcp-proxy@6.7.0', '--host', '127.0.0.1', '--port', '9877', '--server', 'stream', '--', 'your-stdio-server')
   }
   ```

3. Test it in the foreground first, so you can see the log:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\supervisor.ps1
   ```

4. Register the scheduled task:

   ```powershell
   $action = New-ScheduledTaskAction `
       -Execute 'C:\Windows\System32\wscript.exe' `
       -Argument '//B //NoLogo "C:\path\to\run-hidden.vbs" "C:\path\to\supervisor.ps1"'

   $trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
   $settings = New-ScheduledTaskSettingsSet `
       -MultipleInstances IgnoreNew `
       -ExecutionTimeLimit ([TimeSpan]::Zero) `
       -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

   Register-ScheduledTask -TaskName 'My MCP Connector' `
       -Action $action -Trigger $trigger -Settings $settings
   ```

## Two settings that matter more than they look

**Trigger at logon, in the user's session.** Not "run whether user is logged on or not". That option gives you a session with no interactive desktop, and every GUI-dependent MCP server — screen capture, UI automation, Blender, DaVinci Resolve — fails there in ways that are hard to read. If your MCP server touches the GUI, it needs the desktop.

**`-ExecutionTimeLimit ([TimeSpan]::Zero)`.** The default kills the task after three days. Your connector then stops working on day four, for no visible reason.

## Verifying

```powershell
Get-ScheduledTask -TaskName 'My MCP Connector' | Select-Object TaskName, State
Get-Content "$env:USERPROFILE\.my-mcp\logs\supervisor.log" -Tail 20
```

`State` is `Running` while the supervisor is alive — that works because `run-hidden.vbs` waits for the process rather than returning immediately.

To confirm the restart behaviour actually works, kill one component and watch it come back:

```powershell
Stop-Process -Id (Get-NetTCPConnection -State Listen -LocalPort 8771).OwningProcess
Start-Sleep 10
Get-NetTCPConnection -State Listen -LocalPort 8771
```

## Limits

Deliberately small. No backoff — a component that crashes on startup will be restarted every few seconds forever, which is loud in the logs and is the intended behaviour, since the alternative is a connector that quietly gives up. No dependency graph beyond `RequiresPort`. No health checking past "is the port open"; use the gateway's `/healthz` and [`scripts/doctor.mjs`](../../scripts/doctor.mjs) for that.

On Linux, don't use this — write a systemd unit with `Restart=always`.
