$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Root = $PSScriptRoot
$OriginalEncoding = [Console]::OutputEncoding
$ExitCode = 1
try {
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$BundledNode = Join-Path $Root 'runtime\node.exe'
if (Test-Path -LiteralPath $BundledNode) {
    & $BundledNode (Join-Path $Root 'app\scripts\windows\install.mjs') @args
} else {
    $Node = Get-Command node.exe -ErrorAction Stop
    & $Node.Source (Join-Path $Root 'scripts\windows\source.mjs') @args
}
$ExitCode = $LASTEXITCODE
} finally { [Console]::OutputEncoding = $OriginalEncoding }
exit $ExitCode
