#Requires -Version 7.0
param()
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
if (!(Test-Path -LiteralPath '.env')) { Copy-Item -LiteralPath '.env.example' -Destination '.env' }
$envText = [IO.File]::ReadAllText((Join-Path $projectRoot '.env'))
$sshHost = [regex]::Match($envText, '(?m)^BC250_SSH_HOST=(.+)$').Groups[1].Value.Trim()
if ($sshHost -notmatch '^[a-zA-Z0-9_.-]+@[a-zA-Z0-9_.-]+$') { throw 'Set BC250_SSH_HOST=user@bc250-server.local in .env and configure your SSH key first.' }
$privateDir = Join-Path $projectRoot '.opendots'
New-Item -ItemType Directory -Path $privateDir -Force | Out-Null
if (!(Test-Path -LiteralPath '.opendots/lan/server.pem')) { & (Join-Path $PSScriptRoot 'setup-lan.ps1') }
function Test-LocalPort([int]$PortNumber) {
  $client = [Net.Sockets.TcpClient]::new()
  try { $pending = $client.ConnectAsync('127.0.0.1', $PortNumber); return $pending.Wait(500) -and $client.Connected } catch { return $false } finally { $client.Dispose() }
}
$tunnel = Test-LocalPort 11435
if (!$tunnel) {
  $sshProcess = Start-Process -FilePath 'ssh.exe' -ArgumentList @('-N','-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=10','-o','ExitOnForwardFailure=yes','-o','ServerAliveInterval=30','-L','127.0.0.1:11435:127.0.0.1:11434',$sshHost) -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $privateDir 'tunnel.stdout.log') -RedirectStandardError (Join-Path $privateDir 'tunnel.stderr.log')
  [IO.File]::WriteAllText((Join-Path $privateDir 'tunnel.pid'), [string]$sshProcess.Id)
  for ($attempt=0; $attempt -lt 40; $attempt++) {
    if (Test-LocalPort 11435) { break }
    Start-Sleep -Milliseconds 250
  }
  if (!(Test-LocalPort 11435)) { throw 'SSH tunnel failed. Check .opendots/tunnel.stderr.log and your SSH key.' }
} elseif (!(Test-Path -LiteralPath (Join-Path $privateDir 'tunnel.pid'))) { throw 'Port 11435 is occupied by an unknown service.' }
$envText = [IO.File]::ReadAllText((Join-Path $projectRoot '.env'))
$modelLine = 'OPENAI_BASE_URL=http://127.0.0.1:11435/v1'
if ([regex]::IsMatch($envText, '(?m)^OPENAI_BASE_URL=.*$')) { $envText = [regex]::Replace($envText, '(?m)^OPENAI_BASE_URL=.*$', $modelLine) }
else { $envText += "`n$modelLine`n" }
[IO.File]::WriteAllText((Join-Path $projectRoot '.env'), $envText)
$portMatch = [regex]::Match($envText, '(?m)^PORT=(\d+)')
$appPort = if ($portMatch.Success) { [int]$portMatch.Groups[1].Value } else { 4310 }
if (Test-LocalPort $appPort) { throw 'Application port is already in use. The existing process was left running.' }
if (!(Test-Path -LiteralPath 'dist/server/server/index.js')) { throw 'Run npm ci and npm run build before starting.' }
$appProcess = Start-Process -FilePath 'node.exe' -ArgumentList @('--env-file-if-exists=.env','dist/server/server/index.js') -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $privateDir 'server.stdout.log') -RedirectStandardError (Join-Path $privateDir 'server.stderr.log')
[IO.File]::WriteAllText((Join-Path $privateDir 'server.pid'), [string]$appProcess.Id)
for ($attempt=0; $attempt -lt 80; $attempt++) {
  if (Test-LocalPort $appPort) { break }
  $appProcess.Refresh()
  if ($appProcess.HasExited) { throw 'OpenDots exited during startup. Check .opendots/server.stderr.log.' }
  Start-Sleep -Milliseconds 250
}
if (!(Test-LocalPort $appPort)) { throw 'OpenDots did not become ready. Check .opendots/server.stderr.log.' }
Write-Output 'OpenDots started with an encrypted SSH connection to the BC-250.'
Write-Output 'LAN URL: .opendots/lan/url.txt; access token: .opendots/lan/owner-token.txt.'
