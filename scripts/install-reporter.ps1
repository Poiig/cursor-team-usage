# Download prebuilt Reporter VSIX from a fixed URL, then install into Cursor.
# No build/npm required.
#
# Usage:
#   .\scripts\install-reporter.ps1
#   .\scripts\install-reporter.ps1 -Url https://example.com/reporter.vsix
#
# 远程一行（默认 URL）：
#   irm https://raw.githubusercontent.com/Poiig/cursor-team-usage/master/scripts/install-reporter.ps1 | iex
#
# 远程一行并传下载地址（irm|iex 本身不能带参，需包一层 scriptblock）：
#   iex "& { $(irm https://raw.githubusercontent.com/Poiig/cursor-team-usage/master/scripts/install-reporter.ps1) } -Url 'https://example.com/reporter.vsix'"
#
# 或用环境变量（仍可用 irm | iex）：
#   $env:CTU_VSIX_URL='https://example.com/reporter.vsix'; irm https://raw.githubusercontent.com/Poiig/cursor-team-usage/master/scripts/install-reporter.ps1 | iex

[CmdletBinding()]
param(
  # VSIX 下载地址；未传时读 CTU_VSIX_URL，再回退到仓库默认 Release 地址
  [string]$Url = $(
    if (-not [string]::IsNullOrWhiteSpace($env:CTU_VSIX_URL)) { $env:CTU_VSIX_URL }
    else { 'https://github.com/Poiig/cursor-team-usage/releases/download/extension-latest/cursor-team-usage-reporter.vsix' }
  )
)

$ErrorActionPreference = 'Stop'

# 只装到 Cursor，不回退到 VS Code
$cmd = Get-Command cursor -ErrorAction SilentlyContinue
if (-not $cmd) {
  throw 'cursor CLI not found. Install Cursor and ensure "cursor" is on PATH.'
}
$cli = $cmd.Source

$outFile = Join-Path $env:TEMP 'cursor-team-usage-reporter.vsix'
Write-Host "Download: $Url"
Write-Host "Save to:  $outFile"
Invoke-WebRequest -Uri $Url -OutFile $outFile -UseBasicParsing

if (-not (Test-Path -LiteralPath $outFile) -or (Get-Item -LiteralPath $outFile).Length -lt 1000) {
  throw "Download failed or file too small: $outFile"
}

Write-Host "Install with: $cli"
& $cli --install-extension $outFile
if ($LASTEXITCODE -ne 0) {
  throw "Install failed, exit code $LASTEXITCODE"
}

Write-Host 'Done. Reload window: Developer: Reload Window'
