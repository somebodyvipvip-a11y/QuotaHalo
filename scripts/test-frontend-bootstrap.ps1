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

if ($main -notmatch 'listen\("tray-mode-request"' -or $main -notmatch 'snap_edge_peek_nearest') {
    throw 'The frontend does not handle tray display-mode requests.'
}

$rust = Get-Content -Raw (Join-Path $root 'src-tauri\src\main.rs')
if ($rust -notmatch '\.show_menu_on_left_click\(false\)') {
    throw 'Left-click tray menu display is still enabled.'
}

foreach ($modeId in 'mode-full', 'mode-compact', 'mode-edge') {
    if ($rust -notmatch [regex]::Escape($modeId)) {
        throw "Tray mode menu item is missing: $modeId"
    }
}

Write-Output 'Frontend bootstrap contract passed.'
