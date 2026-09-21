# MDR Windows uninstaller v1
$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$OriginalEncoding = [Console]::OutputEncoding
$Stage = $null
$Result = 1
try {
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$App = Join-Path $Root 'app'
if (Test-Path -LiteralPath (Join-Path $App 'scripts\windows\uninstall.mjs')) {
    $Node = Join-Path $Root 'runtime\node.exe'
} else {
    $Registration = Get-Content -LiteralPath (Join-Path $Root 'uninstaller.json') -Encoding UTF8 -Raw | ConvertFrom-Json
    $Current = Get-Content -LiteralPath (Join-Path $Registration.prefix 'current.json') -Encoding UTF8 -Raw | ConvertFrom-Json
    if ($Current.project -ne 'mcp-dev-runtime' -or $Current.version -notmatch '^\d+\.\d+\.\d+(-[A-Za-z0-9.-]+)?$') { throw 'Invalid installed version pointer.' }
    $VersionRoot = Join-Path $Registration.prefix $Current.version
    $Node = Join-Path $VersionRoot 'runtime\node.exe'
    $App = Join-Path $VersionRoot 'app'
}
$Prepared = & $Node (Join-Path $App 'scripts\windows\uninstall.mjs') --prepare @args
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$Stage = $Prepared | ConvertFrom-Json
    & $Stage.node $Stage.script --plan $Stage.plan
    $Result = $LASTEXITCODE
} finally {
    # This is only the uniquely generated temporary uninstaller directory.
    if ($null -ne $Stage) { Remove-Item -LiteralPath $Stage.directory -Recurse -Force }
    [Console]::OutputEncoding = $OriginalEncoding
}
exit $Result
