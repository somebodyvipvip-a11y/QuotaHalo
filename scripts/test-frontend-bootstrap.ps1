$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$main = Get-Content -Raw (Join-Path $root 'src\main.js')
$config = Get-Content -Raw (Join-Path $root 'src-tauri\tauri.conf.json') | ConvertFrom-Json

if ($main -match 'from\s+["'']@tauri-apps/api') {
    throw 'The packaged frontend still contains a bare Tauri API import.'
}

if (-not $config.app.withGlobalTauri) {
    throw 'The packaged frontend uses the Tauri global API, but it is not enabled.'
}

if ($main -notmatch 'window\.__TAURI__\.core' -or $main -notmatch 'window\.__TAURI__\.event') {
    throw 'The frontend does not use the injected Tauri invoke and event APIs.'
}

Write-Output 'Frontend bootstrap contract passed.'
