# MDR Windows source uninstaller v1
$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$OriginalEncoding = [Console]::OutputEncoding
$Stage = $null
$Result = 1
try {
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$Node = (Get-Command node.exe -ErrorAction Stop).Source
$Prepared = & $Node (Join-Path $Root 'scripts\windows\uninstall.mjs') --prepare --source $Root @args
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$Stage = $Prepared | ConvertFrom-Json
    & $Stage.node $Stage.script --plan $Stage.plan
    $Result = $LASTEXITCODE
} finally {
    if ($null -ne $Stage) { Remove-Item -LiteralPath $Stage.directory -Recurse -Force }
    [Console]::OutputEncoding = $OriginalEncoding
}
exit $Result
