<#
.SYNOPSIS
  One-command Windows installer for agy-dart (Antigravity all-in-one latency & context guard plugin).
.EXAMPLE
  .\install.ps1
  .\install.ps1 -InstallRg
  .\install.ps1 -WithDevtools
  .\install.ps1 -Mode host-45k
  .\install.ps1 -Mode balanced-16k
  .\install.ps1 -Command doctor
#>
param(
  [ValidateSet("install", "doctor", "uninstall", "mode")]
  [string]$Command = "install",
  [ValidateSet("host-45k", "balanced-16k", "fast-32k", "strict-8k", "no-read-hook")]
  [string]$Mode = "host-45k",
  [switch]$InstallRg,
  [switch]$WithDevtools,
  [string]$Project = ""
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Installer = Join-Path $ScriptDir "scripts\install.mjs"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "Node.js >= 22 is required. Install Node.js first: https://nodejs.org/"
  exit 1
}

$nodeArgs = @($Installer, $Command)
if ($Command -eq "install") {
  if ($PSBoundParameters.ContainsKey("Mode")) {
    $nodeArgs += @("--mode", $Mode)
  }
  if ($InstallRg) { $nodeArgs += "--install-rg" }
  if ($WithDevtools) { $nodeArgs += "--with-devtools" }
} elseif ($Command -eq "mode") {
  $nodeArgs += $Mode
}
if ($Project) {
  $nodeArgs += @("--project", $Project)
}

& node @nodeArgs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
