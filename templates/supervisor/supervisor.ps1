<#
    supervisor.ps1 — keep an MCP connector's processes alive.

    A connector is several processes that must all be running: the MCP server,
    optionally a stdio bridge, optionally an OAuth gateway, and the tunnel. Any
    one of them dying takes the connector down, usually silently.

    This polls every few seconds and restarts whatever is missing. It is
    deliberately small — if you want real service management, use a real service
    manager. This exists because Windows scheduled tasks cannot express
    "keep these four things running" on their own.

    Edit the $Components list, then run it from a scheduled task at logon.
    See README.md in this directory.

    SPDX-License-Identifier: MIT
#>

$ErrorActionPreference = 'Stop'

# ------------------------------------------------------------------ config ---

# Anything unique per connector. Two supervisors with the same name cannot run
# at once, which is what stops them stacking up over days of logons.
$SupervisorName = 'MyMCPConnector'

$LogDir      = Join-Path $env:USERPROFILE '.my-mcp\logs'
$PollSeconds = 5

# Each component is checked by its Port. If nothing is listening there, Command
# is started. Order matters: list dependencies before their dependents.
#
#   Name      label used in logs and log filenames
#   Port      TCP port that proves this component is up (loopback)
#   Command   executable to run
#   Arguments argument array
#   Env       hashtable of environment variables for the child process
#   Optional  when $true, skip it instead of starting it if RequiresPort is dead
#   RequiresPort  only start this component once something is listening here
$Components = @(
    @{
        Name      = 'mcp-server'
        Port      = 8770
        Command   = 'C:\path\to\.venv\Scripts\python.exe'
        Arguments = @('C:\path\to\server.py', '--transport', 'streamable-http')
        Env       = @{
            MCP_HOST          = '127.0.0.1'
            MCP_PORT          = '8770'
            PYTHONIOENCODING  = 'utf-8'
        }
    },
    @{
        Name      = 'oauth-gateway'
        Port      = 8771
        Command   = 'node'
        Arguments = @('C:\path\to\gateway.mjs')
        Env       = @{}
    },
    @{
        Name      = 'cloudflared'
        Port      = $null   # no listening port; matched by command line instead
        Command   = 'C:\Program Files (x86)\cloudflared\cloudflared.exe'
        Arguments = @('tunnel', 'run', '--token-file', "$env:USERPROFILE\.cloudflared\my-mcp.token")
        Env       = @{}
        MatchCommandLine = 'my-mcp.token'
    }
)

# ------------------------------------------------------------------- setup ---

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Write-Log {
    param([string]$Message)
    $line = "{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    Write-Output $line
    Add-Content -Path (Join-Path $LogDir 'supervisor.log') -Value $line
}

# Only one supervisor per connector. A second one exits here rather than
# starting a duplicate set of children.
$mutex = New-Object System.Threading.Mutex($false, "Global\$SupervisorName`Supervisor")
if (-not $mutex.WaitOne(0)) {
    Write-Log "another supervisor for $SupervisorName is already running; exiting"
    exit 0
}

# ------------------------------------------------------------------ probes ---

function Test-Port {
    param([int]$Port)
    try {
        $null = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

function Test-CommandLine {
    param([string]$Fragment)
    $escaped = $Fragment -replace "'", "''"
    $found = Get-CimInstance Win32_Process -Filter "Name LIKE '%'" -ErrorAction SilentlyContinue |
             Where-Object { $_.CommandLine -and $_.CommandLine -like "*$escaped*" }
    return [bool]$found
}

function Test-ComponentAlive {
    param($Component)
    if ($Component.MatchCommandLine) { return Test-CommandLine -Fragment $Component.MatchCommandLine }
    if ($null -ne $Component.Port)   { return Test-Port -Port $Component.Port }
    return $false
}

function Start-Component {
    param($Component)

    $name = $Component.Name
    Write-Log "starting $name"

    foreach ($key in $Component.Env.Keys) {
        Set-Item -Path "env:$key" -Value $Component.Env[$key]
    }

    $stdout = Join-Path $LogDir "$name.log"
    $stderr = Join-Path $LogDir "$name.error.log"

    try {
        Start-Process -FilePath $Component.Command `
                      -ArgumentList $Component.Arguments `
                      -WindowStyle Hidden `
                      -RedirectStandardOutput $stdout `
                      -RedirectStandardError  $stderr | Out-Null
    } catch {
        Write-Log "failed to start ${name}: $($_.Exception.Message)"
    }
}

# -------------------------------------------------------------------- loop ---

Write-Log "supervisor $SupervisorName started, polling every ${PollSeconds}s"

try {
    while ($true) {
        foreach ($component in $Components) {

            # Components that only make sense once something else is up — e.g. a
            # stdio bridge whose target application isn't running yet.
            if ($component.RequiresPort -and -not (Test-Port -Port $component.RequiresPort)) {
                continue
            }

            if (-not (Test-ComponentAlive -Component $component)) {
                Start-Component -Component $component
                Start-Sleep -Seconds 2
            }
        }
        Start-Sleep -Seconds $PollSeconds
    }
} finally {
    $mutex.ReleaseMutex()
    $mutex.Dispose()
}
