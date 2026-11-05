#Requires -Version 7.5
param([string]$LanAddress, [int]$Port = 44310, [switch]$RenewCertificate)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$privateDir = Join-Path $projectRoot '.opendots\lan'
New-Item -ItemType Directory -Path $privateDir -Force | Out-Null
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls $privateDir /inheritance:r /grant:r "*${currentSid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not protect the local certificate directory.' }
if (!$LanAddress) {
  $LanAddress = Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway } | ForEach-Object { $_.IPv4Address.IPAddress } | Where-Object { $_ -match '^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)' } | Select-Object -First 1
}
if (!$LanAddress) { throw 'Pass -LanAddress with the PC private IPv4 address.' }
if ($Port -lt 1024 -or $Port -gt 65535) { throw 'Port must be between 1024 and 65535.' }
$pcName = $env:COMPUTERNAME.ToLowerInvariant()
$certFile = Join-Path $privateDir 'server.pem'
$keyFile = Join-Path $privateDir 'server.key'
$caFile = Join-Path $privateDir 'opendots-local-ca.cer'
if ($RenewCertificate) {
  $backupTag = [DateTimeOffset]::UtcNow.ToString('yyyyMMddHHmmss')
  foreach ($certificatePath in @($certFile, $keyFile, $caFile)) {
    if (Test-Path -LiteralPath $certificatePath) { Move-Item -LiteralPath $certificatePath -Destination ($certificatePath + '.previous-' + $backupTag) }
  }
}
if (!(Test-Path -LiteralPath $certFile) -and !(Test-Path -LiteralPath $keyFile)) {
  $caKey = [Security.Cryptography.RSA]::Create(3072)
  $hash = [Security.Cryptography.HashAlgorithmName]::SHA256
  $padding = [Security.Cryptography.RSASignaturePadding]::Pkcs1
  $caRequest = [Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=OpenDots Local CA', $caKey, $hash, $padding)
  $caRequest.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($true, $false, 0, $true))
  $caRequest.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new([Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyCertSign, $true))
  $caRequest.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509SubjectKeyIdentifierExtension]::new($caRequest.PublicKey, $false))
  $start = [DateTimeOffset]::UtcNow.AddMinutes(-5)
  $ca = $caRequest.CreateSelfSigned($start, $start.AddYears(2))
  $serverKey = [Security.Cryptography.RSA]::Create(3072)
  $request = [Security.Cryptography.X509Certificates.CertificateRequest]::new("CN=$pcName", $serverKey, $hash, $padding)
  $san = [Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
  $san.AddDnsName($pcName); $san.AddDnsName('localhost')
  $san.AddIpAddress([Net.IPAddress]::Parse($LanAddress))
  $san.AddIpAddress([Net.IPAddress]::Parse('127.0.0.1'))
  $request.CertificateExtensions.Add($san.Build())
  $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509SubjectKeyIdentifierExtension]::new($request.PublicKey, $false))
  $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509AuthorityKeyIdentifierExtension]::CreateFromCertificate($ca, $true, $false))
  $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false, $false, 0, $true))
  $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new([Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature -bor [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyEncipherment, $true))
  $oids = [Security.Cryptography.OidCollection]::new()
  $oids.Add([Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.1')) | Out-Null
  $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($oids, $true))
  $leaf = $request.Create($ca, $start, $start.AddDays(365), [Security.Cryptography.RandomNumberGenerator]::GetBytes(16))
  [IO.File]::WriteAllText($certFile, $leaf.ExportCertificatePem())
  [IO.File]::WriteAllText($keyFile, $serverKey.ExportPkcs8PrivateKeyPem())
  [IO.File]::WriteAllBytes($caFile, $ca.Export([Security.Cryptography.X509Certificates.X509ContentType]::Cert))
  $serverKey.Dispose(); $caKey.Dispose(); $ca.Dispose(); $leaf.Dispose()
} elseif (!(Test-Path -LiteralPath $certFile) -or !(Test-Path -LiteralPath $keyFile)) {
  throw 'Incomplete certificate pair. Restore the existing certificate and key before continuing.'
}
$envPath = Join-Path $projectRoot '.env'
if (!(Test-Path -LiteralPath $envPath)) { Copy-Item -LiteralPath (Join-Path $projectRoot '.env.example') -Destination $envPath }
$envText = [IO.File]::ReadAllText($envPath)
$tokenMatch = [regex]::Match($envText, '(?m)^OWNER_TOKEN=(.+)$')
$ownerToken = $tokenMatch.Groups[1].Value.Trim()
if ($ownerToken.Length -lt 24) { $ownerToken = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant() }
$settings = @{HOST='0.0.0.0'; PORT="$Port"; OWNER_TOKEN=$ownerToken; TLS_CERT_FILE='.opendots/lan/server.pem'; TLS_KEY_FILE='.opendots/lan/server.key'; APP_ORIGIN="https://${LanAddress}:$Port,https://${pcName}:$Port,https://localhost:$Port,https://127.0.0.1:$Port"}
foreach ($entry in $settings.GetEnumerator()) {
  $pattern = '(?m)^' + [regex]::Escape($entry.Key) + '=.*$'
  if ([regex]::IsMatch($envText, $pattern)) { $envText = [regex]::Replace($envText, $pattern, [System.Text.RegularExpressions.MatchEvaluator]{ param($match) $entry.Key + '=' + $entry.Value }) }
  else { $envText = $envText.TrimEnd() + "`n" + $entry.Key + '=' + $entry.Value + "`n" }
}
[IO.File]::WriteAllText($envPath, $envText)
[IO.File]::WriteAllText((Join-Path $privateDir 'owner-token.txt'), $ownerToken)
[IO.File]::WriteAllText((Join-Path $privateDir 'url.txt'), "https://${LanAddress}:$Port")
Write-Output "LAN URL: https://${LanAddress}:$Port"
Write-Output 'Token saved in .opendots/lan/owner-token.txt (not printed).'
Write-Output 'Trust only opendots-local-ca.cer on the notebook; never copy server.key.'
Write-Output 'If Windows Firewall blocks the notebook, an administrator can allow this TCP port only on the Private profile and LocalSubnet.'
