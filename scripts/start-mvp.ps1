#Requires -Version 7
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
if (!(Test-Path -LiteralPath '.env')) { throw 'Configure .env using deployment/mvp-client.env.example first.' }
if (!(Test-Path -LiteralPath 'dist/server/server/index.js')) { throw 'Run npm ci and npm run build first.' }
$text = [IO.File]::ReadAllText((Join-Path $projectRoot '.env'))
if ($text -notmatch '(?m)^BC250_URL=https://') { throw 'MVP requires BC250_URL=https://...; this launcher never starts SSH.' }
New-Item -ItemType Directory -Force -Path '.opendots' | Out-Null
$portMatch = [regex]::Match($text, '(?m)^PORT=(\d+)')
$port = if ($portMatch.Success) { [int]$portMatch.Groups[1].Value } else { 44310 }
$probe = [Net.Sockets.TcpClient]::new()
try { $probe.Connect('127.0.0.1', $port); throw 'Application port is already in use. Existing service was left running.' }
catch [Net.Sockets.SocketException] { }
finally { $probe.Dispose() }
$app = Start-Process -FilePath 'node.exe' -ArgumentList @('--env-file-if-exists=.env','dist/server/server/index.js') -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput '.opendots/mvp.stdout.log' -RedirectStandardError '.opendots/mvp.stderr.log'
[IO.File]::WriteAllText((Join-Path $projectRoot '.opendots/mvp.pid'), [string]$app.Id)
for ($attempt=0; $attempt -lt 80; $attempt++) {
  $app.Refresh()
  if ($app.HasExited) { throw 'OpenDots failed to start. Check .opendots/mvp.stderr.log.' }
  $probe = [Net.Sockets.TcpClient]::new()
  try { $probe.Connect('127.0.0.1', $port); Write-Output 'OpenDots MVP started with authenticated HTTPS to BC-250; no SSH tunnel.'; exit 0 }
  catch [Net.Sockets.SocketException] { }
  finally { $probe.Dispose() }
  Start-Sleep -Milliseconds 250
}
throw 'OpenDots has not become ready. Check .opendots/mvp.stderr.log.'
