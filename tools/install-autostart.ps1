# Registers a per-user logon Scheduled Task that starts the companion server hidden, then starts it now.
# Usage: npm run autostart:install   (or: powershell -NoProfile -ExecutionPolicy Bypass -File tools\install-autostart.ps1)
$ErrorActionPreference = 'Stop'
$TaskName = 'icue-claude-monitor'
$Root = Split-Path -Parent $PSScriptRoot
$Node = $null
$cmd = Get-Command node.exe -ErrorAction SilentlyContinue
if ($cmd) { $Node = $cmd.Source }
if (-not $Node) { $Node = Join-Path $env:ProgramFiles 'nodejs\node.exe' }
if (-not (Test-Path $Node)) { throw "node.exe not found (looked on PATH and in $env:ProgramFiles\nodejs)" }
$Vbs = Join-Path $PSScriptRoot 'start-hidden.vbs'
$Script = Join-Path $Root 'server\index.mjs'
if (-not (Test-Path $Script)) { throw "server script not found: $Script" }

$User = "$env:USERDOMAIN\$env:USERNAME"
$Action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"{0}" "{1}" "{2}"' -f $Vbs, $Node, $Script) -WorkingDirectory $Root
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $User
$Trigger.Delay = 'PT20S'
$Settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
  -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
$Principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Principal $Principal `
  -Description 'Companion feed server for the iCUE Claude Code Monitor widget (XENEON EDGE).' -Force | Out-Null

# A zero time limit does not always stick through the cmdlet; patch the registered task.
$task = Get-ScheduledTask -TaskName $TaskName
$task.Settings.ExecutionTimeLimit = 'PT0S'
Set-ScheduledTask -InputObject $task | Out-Null
Write-Host "registered scheduled task '$TaskName' (runs at logon for $User)"

Start-ScheduledTask -TaskName $TaskName
$port = 41780
try {
  $cfgPath = Join-Path $env:LOCALAPPDATA 'icue-claude-monitor\config.json'
  if (Test-Path $cfgPath) { $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json; if ($cfg.port) { $port = [int]$cfg.port } }
} catch { }
for ($i = 0; $i -lt 20; $i++) {
  try {
    $r = Invoke-RestMethod "http://127.0.0.1:$port/healthz" -TimeoutSec 2
    Write-Host "companion server is up (v$($r.version)) on http://127.0.0.1:$port"
    exit 0
  } catch { Start-Sleep -Milliseconds 500 }
}
Write-Warning "task registered but /healthz did not answer within 10 s; see $env:LOCALAPPDATA\icue-claude-monitor\server.log"
