[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$cargoManifest = Join-Path $projectRoot 'src-tauri\Cargo.toml'
$tauriConfig = Join-Path $projectRoot 'src-tauri\tauri.conf.json'
$outputDirectory = Join-Path $projectRoot 'dist'

if (-not (Test-Path -LiteralPath $cargoManifest)) {
    throw "Cargo manifest not found: $cargoManifest"
}

$config = Get-Content -LiteralPath $tauriConfig -Raw | ConvertFrom-Json
$version = $config.version
if ([string]::IsNullOrWhiteSpace($version)) {
    throw "Could not read the app version from $tauriConfig."
}

Write-Host "Building QuotaHalo $version portable EXE..."
& cargo build --release --manifest-path $cargoManifest
if ($LASTEXITCODE -ne 0) {
    throw "Cargo build failed with exit code $LASTEXITCODE."
}

$builtExecutable = Join-Path $projectRoot 'src-tauri\target\release\quota-halo.exe'
if (-not (Test-Path -LiteralPath $builtExecutable)) {
    throw "Built executable not found: $builtExecutable"
}

New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$releaseExecutable = Join-Path $outputDirectory "QuotaHalo-$version.exe"
Copy-Item -LiteralPath $builtExecutable -Destination $releaseExecutable -Force

Write-Host "Done: $releaseExecutable"
