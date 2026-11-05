$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$envFile = Join-Path $root '.arena-gui\.env'
if (-not (Test-Path -LiteralPath $envFile)) { throw 'Bridge configuration is missing.' }
foreach ($line in [IO.File]::ReadAllLines($envFile)) {
    if ($line -match '^([A-Z][A-Z0-9_]*)=(.*)$') {
        [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process')
    }
}
$env:ARENA_NODE_PATH = 'C:\Program Files\nodejs\node.exe'
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path -LiteralPath $electron)) { throw 'Desktop runtime is missing. Run npm install first.' }
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Start-Process -FilePath $electron -ArgumentList ('"' + (Join-Path $root 'desktop') + '"') -WorkingDirectory $root -WindowStyle Normal
