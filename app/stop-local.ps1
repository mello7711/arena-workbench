$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$node = 'C:\Program Files\nodejs\node.exe'
& $node (Join-Path $root 'desktop\stop.cjs')
if ($LASTEXITCODE -eq 0) {
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        if (-not (Get-NetTCPConnection -LocalPort 20140 -State Listen -ErrorAction SilentlyContinue)) { break }
        Start-Sleep -Milliseconds 250
    }
    return
}
$launcher = Join-Path $root 'dist\ArenaLocalBridge.exe'
$process = Start-Process -FilePath $launcher -ArgumentList @('--root', ('"' + $root + '"'), '--stop', '--console-errors') -WorkingDirectory $root -WindowStyle Hidden -PassThru -Wait
if ($process.ExitCode -ne 0) { throw 'Bridge could not stop. See .arena-gui/bridge.log.' }
