#Requires -Version 7.0
#Requires -RunAsAdministrator
param([int]$Port = 44310)
$ErrorActionPreference = 'Stop'
if ($Port -lt 1024 -or $Port -gt 65535) { throw 'Invalid local application port.' }
$ruleName = "OpenDotsLocalPrivate-$Port"
if (Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue) {
  Write-Output 'The named rule already exists; review it in Windows Firewall before changing it.'
  return
}
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
New-NetFirewallRule -Name $ruleName -DisplayName "OpenDots local HTTPS ($Port)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -RemoteAddress LocalSubnet -Profile Private -Program $nodePath | Out-Null
Write-Output 'Allowed only this Node application port, from LocalSubnet, on the Private network profile.'
