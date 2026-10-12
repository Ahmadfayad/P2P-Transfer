# Run locally. Credentials are prompted privately and sent to Wrangler over stdin.
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$wranglerPath = Join-Path $projectRoot 'node_modules/wrangler/bin/wrangler.js'
if (-not (Test-Path -LiteralPath $wranglerPath)) { throw 'Run npm ci in the project folder first.' }
Write-Host 'Use an expiring credential from an Open Relay Free account with no paid upgrade.'
Write-Host 'The username and password stay in this terminal and the Cloudflare secret. Do not paste them in chat.'
$turnUsernameSecure = Read-Host 'Temporary TURN username' -AsSecureString
$turnPasswordSecure = Read-Host 'Temporary TURN password' -AsSecureString
$pilotHoursText = Read-Host 'Credential validity remaining in hours (1-24; default 8)'
$pilotHours = if ($pilotHoursText) { [int]$pilotHoursText } else { 8 }
if ($pilotHours -lt 1 -or $pilotHours -gt 24) { throw 'Use a credential valid for 1 to 24 hours.' }
$config = @{
  expiresAt = [DateTimeOffset]::UtcNow.AddHours($pilotHours).ToString('o')
  maxBytes = 268435456
  iceServers = @(@{
    urls = 'turns:standard.relay.metered.ca:443?transport=tcp'
    username = [System.Net.NetworkCredential]::new('', $turnUsernameSecure).Password
    credential = [System.Net.NetworkCredential]::new('', $turnPasswordSecure).Password
  })
}
$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = (Get-Command node).Source
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.RedirectStandardInput = $true
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
$startInfo.WorkingDirectory = $projectRoot
$startInfo.Arguments = '"' + $wranglerPath + '" secret put TURN_PILOT_CONFIG --config "' + (Join-Path $projectRoot 'wrangler.jsonc') + '"'
$startInfo.EnvironmentVariables['XDG_CONFIG_HOME'] = Join-Path $projectRoot '.wrangler/config-home'
$startInfo.EnvironmentVariables['WRANGLER_LOG_PATH'] = Join-Path $projectRoot '.wrangler/logs/configure-turn.log'
$startInfo.EnvironmentVariables['WRANGLER_SEND_METRICS'] = 'false'
$process = [System.Diagnostics.Process]::new()
$process.StartInfo = $startInfo
try {
  $null = $process.Start()
  $outputTask = $process.StandardOutput.ReadToEndAsync()
  $errorTask = $process.StandardError.ReadToEndAsync()
  $process.StandardInput.WriteLine(($config | ConvertTo-Json -Depth 5 -Compress))
  $process.StandardInput.Close()
  $process.WaitForExit()
  $null = $outputTask.GetAwaiter().GetResult()
  $null = $errorTask.GetAwaiter().GetResult()
  if ($process.ExitCode -ne 0) { throw 'Configuration failed. Check your private Cloudflare login before retrying.' }
  Write-Host 'TURN pilot configured. Refresh both devices, approve the student and test a small file.'
} finally {
  $config = $null
  $turnUsernameSecure.Dispose()
  $turnPasswordSecure.Dispose()
  $process.Dispose()
}
