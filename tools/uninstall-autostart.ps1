# Removes the logon Scheduled Task and stops a running companion server.
# Usage: npm run autostart:uninstall
$ErrorActionPreference = 'Continue'
$TaskName = 'icue-claude-monitor'
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "removed scheduled task '$TaskName'"
} else {
  Write-Host "scheduled task '$TaskName' not found"
}
$pidFile = Join-Path $env:LOCALAPPDATA 'icue-claude-monitor\server.pid'
if (Test-Path $pidFile) {
  $serverPid = [int](Get-Content $pidFile -ErrorAction SilentlyContinue)
  $proc = Get-Process -Id $serverPid -ErrorAction SilentlyContinue
  if ($proc -and $proc.ProcessName -match '^node') {
    Stop-Process -Id $serverPid -Force
    Write-Host "stopped companion server (pid $serverPid)"
  }
  Remove-Item $pidFile -ErrorAction SilentlyContinue
}
