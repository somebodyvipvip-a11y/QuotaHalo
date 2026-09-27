#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    collections::HashSet,
    env,
    ffi::OsString,
    fmt, fs,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, State, WebviewWindow, WindowEvent,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::Mutex,
    time::{sleep, timeout},
};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const REFRESH_TIMEOUT: Duration = Duration::from_secs(50);
const MAX_SESSION_ATTEMPTS: u8 = 3;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct QuotaWindow {
    #[serde(rename(deserialize = "usedPercent", serialize = "used_percent"))]
    used_percent: f64,
    #[serde(rename(deserialize = "windowDurationMins", serialize = "window_duration_mins"))]
    window_duration_mins: u64,
    #[serde(rename(deserialize = "resetsAt", serialize = "resets_at"))]
    resets_at: i64,
}

#[derive(Debug, Serialize)]
struct QuotaSnapshot {
    status: String,
    message: Option<String>,
    primary: Option<QuotaWindow>,
    weekly: Option<QuotaWindow>,
    updated_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct RpcEnvelope {
    id: Option<Value>,
    result: Option<Value>,
    error: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct RateLimitItem {
    primary: Option<QuotaWindow>,
    secondary: Option<QuotaWindow>,
}

#[derive(Debug, Deserialize)]
struct RateLimitsRead {
    #[serde(rename = "rateLimits")]
    rate_limits: Option<RateLimitItem>,
    #[serde(rename = "rateLimitsByLimitId")]
    rate_limits_by_limit_id: Option<std::collections::HashMap<String, RateLimitItem>>,
}

#[derive(Debug)]
enum AppServerError {
    Transport(String),
    Rpc { method: String, code: i64 },
    Unavailable(String),
}

impl fmt::Display for AppServerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Transport(message) | Self::Unavailable(message) => formatter.write_str(message),
            Self::Rpc { method, code } => {
                write!(
                    formatter,
                    "本地 Codex 服务拒绝了 {method} 请求（错误代码 {code}）。"
                )
            }
        }
    }
}

struct AppServerSession {
    _child: Child,
    stdin: ChildStdin,
    lines: tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
    next_id: u64,
}

#[derive(Default)]
struct AppServerClient {
    session: Mutex<Option<AppServerSession>>,
}

impl QuotaSnapshot {
    fn unavailable(message: impl Into<String>) -> Self {
        Self {
            status: "unavailable".into(),
            message: Some(message.into()),
            primary: None,
            weekly: None,
            updated_at: None,
        }
    }
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or_default()
}

fn installed_codex_from(local_app_data: &Path) -> Option<PathBuf> {
    let bin_root = local_app_data.join("OpenAI").join("Codex").join("bin");
    let mut candidates = fs::read_dir(bin_root)
        .ok()?
        .flatten()
        .map(|entry| entry.path().join("codex.exe"))
        .filter(|candidate| candidate.is_file())
        .collect::<Vec<_>>();
    candidates.sort();
    candidates.pop()
}

fn codex_command() -> OsString {
    env::var_os("LOCALAPPDATA")
        .and_then(|root| installed_codex_from(Path::new(&root)))
        .map(PathBuf::into_os_string)
        .unwrap_or_else(|| OsString::from("codex"))
}

async fn write_request(
    stdin: &mut ChildStdin,
    id: u64,
    method: &str,
    params: Value,
) -> Result<(), AppServerError> {
    let request = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
    let line = format!("{}\n", request);
    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|_| AppServerError::Transport("无法向本地 Codex 服务发送请求。".into()))?;
    stdin
        .flush()
        .await
        .map_err(|_| AppServerError::Transport("无法向本地 Codex 服务发送请求。".into()))
}

async fn write_notification(
    stdin: &mut ChildStdin,
    method: &str,
    params: Value,
) -> Result<(), AppServerError> {
    let notification = json!({"jsonrpc": "2.0", "method": method, "params": params});
    let line = format!("{notification}\n");
    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|_| AppServerError::Transport("无法向本地 Codex 服务发送请求。".into()))?;
    stdin
        .flush()
        .await
        .map_err(|_| AppServerError::Transport("无法向本地 Codex 服务发送请求。".into()))
}

async fn read_response(
    lines: &mut tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
    expected_id: u64,
    method: &str,
) -> Result<Value, AppServerError> {
    while let Some(line) = lines
        .next_line()
        .await
        .map_err(|_| AppServerError::Transport("无法读取本地 Codex 服务响应。".into()))?
    {
        let Ok(envelope) = serde_json::from_str::<RpcEnvelope>(&line) else {
            continue;
        };
        if !rpc_response_matches_id(&envelope.id, expected_id) {
            continue;
        }
        if let Some(error) = envelope.error {
            let code = error
                .get("code")
                .and_then(Value::as_i64)
                .unwrap_or_default();
            return Err(AppServerError::Rpc {
                method: method.to_string(),
                code,
            });
        }
        return envelope
            .result
            .ok_or_else(|| AppServerError::Transport("本地 Codex 服务没有返回额度数据。".into()));
    }
    Err(AppServerError::Transport(
        "本地 Codex 服务提前结束，未返回额度数据。".into(),
    ))
}

fn should_restart_session(error: &AppServerError, attempt: u8) -> bool {
    attempt + 1 < MAX_SESSION_ATTEMPTS
        && matches!(
            error,
            AppServerError::Transport(_) | AppServerError::Rpc { code: -32603, .. }
        )
}

fn rpc_response_matches_id(id: &Option<Value>, expected_id: u64) -> bool {
    id.as_ref().and_then(Value::as_u64) == Some(expected_id)
}

fn collect_windows(limits: RateLimitsRead) -> Vec<QuotaWindow> {
    let item = limits
        .rate_limits_by_limit_id
        .and_then(|by_id| {
            by_id
                .into_iter()
                .find(|(id, _)| id == "codex")
                .map(|(_, item)| item)
        })
        .or(limits.rate_limits);

    let mut seen = HashSet::new();
    item.into_iter()
        .flat_map(|item| [item.primary, item.secondary])
        .flatten()
        .filter(|window| {
            seen.insert((
                window.window_duration_mins,
                window.used_percent.to_bits(),
                window.resets_at,
            ))
        })
        .collect()
}

fn build_snapshot(limits: RateLimitsRead) -> QuotaSnapshot {
    let windows = collect_windows(limits);
    let primary = windows
        .iter()
        .find(|window| window.window_duration_mins == 300)
        .cloned();
    let weekly = windows
        .iter()
        .find(|window| window.window_duration_mins == 10_080)
        .cloned();
    let status = if primary.is_some() || weekly.is_some() {
        "ready"
    } else {
        "unavailable"
    };
    let message = if status == "unavailable" {
        Some("服务未返回 5 小时或每周额度窗口。".into())
    } else {
        None
    };
    QuotaSnapshot {
        status: status.into(),
        message,
        primary,
        weekly,
        updated_at: Some(now_unix()),
    }
}

impl AppServerSession {
    async fn launch() -> Result<Self, AppServerError> {
        let mut command = Command::new(codex_command());
        command
            .arg("app-server")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        #[cfg(target_os = "windows")]
        {
            command.creation_flags(0x08000000); // CREATE_NO_WINDOW
            if let Some(profile) = env::var_os("USERPROFILE") {
                if env::var_os("HOME").is_none() {
                    command.env("HOME", &profile);
                }
                if env::var_os("CODEX_HOME").is_none() {
                    command.env("CODEX_HOME", Path::new(&profile).join(".codex"));
                }
            }
        }

        let mut child = command
            .spawn()
            .map_err(|_| AppServerError::Unavailable("未找到或无法启动本机 Codex 服务。".into()))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| AppServerError::Transport("无法连接本地 Codex 服务。".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AppServerError::Transport("无法连接本地 Codex 服务。".into()))?;
        let mut session = Self {
            _child: child,
            stdin,
            lines: BufReader::new(stdout).lines(),
            next_id: 0,
        };
        let initialize_params = json!({
            "clientInfo": {"name": "quota-halo", "version": env!("CARGO_PKG_VERSION")},
            "capabilities": {}
        });
        session.request("initialize", initialize_params).await?;
        write_notification(&mut session.stdin, "initialized", json!({})).await?;
        Ok(session)
    }

    async fn request(&mut self, method: &str, params: Value) -> Result<Value, AppServerError> {
        let id = self.next_id;
        self.next_id += 1;
        timeout(REQUEST_TIMEOUT, async {
            write_request(&mut self.stdin, id, method, params).await?;
            read_response(&mut self.lines, id, method).await
        })
        .await
        .map_err(|_| {
            AppServerError::Transport(format!("本地 Codex 服务响应 {method} 超时（15 秒）。"))
        })?
    }

    async fn fetch_quota(&mut self) -> Result<QuotaSnapshot, AppServerError> {
        // The App Server exposes rate limits as a standalone authenticated endpoint.
        // Avoid `account/read` here: on some desktop sessions its account-details lookup can
        // block even though the rate-limits endpoint is healthy and can return real quota data.
        let raw_limits = self.request("account/rateLimits/read", json!({})).await?;
        let limits = serde_json::from_value::<RateLimitsRead>(raw_limits).map_err(|_| {
            AppServerError::Unavailable("本地 Codex 服务返回了无法识别的额度数据。".into())
        })?;
        Ok(build_snapshot(limits))
    }
}

impl AppServerClient {
    async fn fetch_quota(&self) -> Result<QuotaSnapshot, AppServerError> {
        let mut session_slot = self.session.lock().await;
        for attempt in 0..MAX_SESSION_ATTEMPTS {
            if session_slot.is_none() {
                match AppServerSession::launch().await {
                    Ok(session) => *session_slot = Some(session),
                    Err(error) if should_restart_session(&error, attempt) => {
                        sleep(Duration::from_millis(350 * u64::from(attempt + 1))).await;
                        continue;
                    }
                    Err(error) => return Err(error),
                }
            }

            let result = session_slot
                .as_mut()
                .expect("session was launched")
                .fetch_quota()
                .await;
            match result {
                Err(error) if should_restart_session(&error, attempt) => {
                    // A stalled transport or -32603 response can poison this stdio context.
                    // Dropping the process before retrying gives the logged-in Codex service a
                    // fresh RPC session, instead of repeating the request on the stuck pipe.
                    *session_slot = None;
                    sleep(Duration::from_millis(350 * u64::from(attempt + 1))).await;
                }
                Err(error) => {
                    *session_slot = None;
                    return Err(error);
                }
                Ok(snapshot) => return Ok(snapshot),
            }
        }
        unreachable!("the final refresh attempt returns its result")
    }

    async fn reset(&self) {
        *self.session.lock().await = None;
    }

    async fn refresh(&self) -> QuotaSnapshot {
        match timeout(REFRESH_TIMEOUT, self.fetch_quota()).await {
            Ok(Ok(snapshot)) => snapshot,
            Ok(Err(error)) => QuotaSnapshot::unavailable(error.to_string()),
            Err(_) => {
                self.reset().await;
                QuotaSnapshot::unavailable("读取本地 Codex 服务超时（50 秒），请稍后重试。")
            }
        }
    }
}

#[tauri::command]
async fn refresh_quota(client: State<'_, AppServerClient>) -> Result<QuotaSnapshot, String> {
    Ok(client.refresh().await)
}

fn position_panel(window: &WebviewWindow) {
    let Ok(Some(monitor)) = window.primary_monitor() else {
        return;
    };
    let Ok(size) = window.outer_size() else {
        return;
    };
    let area = monitor.work_area();
    const MARGIN: u32 = 14;
    let x = area.position.x
        + area
            .size
            .width
            .saturating_sub(size.width.saturating_add(MARGIN)) as i32;
    let y = area.position.y
        + area
            .size
            .height
            .saturating_sub(size.height.saturating_add(MARGIN)) as i32;
    let _ = window.set_position(PhysicalPosition::new(x, y));
}

fn show_panel(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        position_panel(&window);
        let _ = window.show();
        let _ = window.set_focus();
        let _ = app.emit("quota-refresh-request", ());
    }
}

fn toggle_panel(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            show_panel(app);
        }
    }
}

#[tauri::command]
fn hide_panel(window: WebviewWindow) {
    let _ = window.hide();
}

#[tauri::command]
fn open_usage_page() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::iter::once;
        use windows_sys::Win32::{
            Foundation::HWND,
            UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL},
        };

        let operation = "open".encode_utf16().chain(once(0)).collect::<Vec<_>>();
        let url = "https://chatgpt.com/#settings/Account"
            .encode_utf16()
            .chain(once(0))
            .collect::<Vec<_>>();
        let result = unsafe {
            ShellExecuteW(
                std::ptr::null_mut::<std::ffi::c_void>() as HWND,
                operation.as_ptr(),
                url.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            )
        };
        if (result as isize) <= 32 {
            return Err("无法打开 ChatGPT 用量页面。".into());
        }
    }
    #[cfg(not(target_os = "windows"))]
    return Err("此入口仅支持 Windows。".into());
    #[cfg(target_os = "windows")]
    Ok(())
}

#[cfg(target_os = "windows")]
fn apply_rounded_region(
    hwnd: windows_sys::Win32::Foundation::HWND,
    width: u32,
    height: u32,
    scale_factor: f64,
) {
    use windows_sys::Win32::Graphics::Gdi::{CreateRoundRectRgn, DeleteObject, SetWindowRgn};

    let diameter = ((22.0 * scale_factor).round() as i32 * 2).max(2);
    let region =
        unsafe { CreateRoundRectRgn(0, 0, width as i32, height as i32, diameter, diameter) };
    if region.is_null() {
        return;
    }
    let result = unsafe { SetWindowRgn(hwnd, region, 1) };
    if result == 0 {
        unsafe { DeleteObject(region) };
    }
}

#[cfg(target_os = "windows")]
fn apply_rounded_window_region(window: &WebviewWindow) {
    let (Ok(hwnd), Ok(size), Ok(scale_factor)) =
        (window.hwnd(), window.outer_size(), window.scale_factor())
    else {
        return;
    };
    apply_rounded_region(hwnd.0, size.width, size.height, scale_factor);
}

fn main() {
    tauri::Builder::default()
        .manage(AppServerClient::default())
        .setup(|app| {
            let refresh = MenuItem::with_id(app, "refresh", "刷新额度", true, None::<&str>)?;
            let usage =
                MenuItem::with_id(app, "usage", "打开 ChatGPT 用量页面", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&refresh, &usage, &quit])?;
            let tray_icon = app
                .default_window_icon()
                .cloned()
                .ok_or("未找到 QuotaHalo 图标资源。")?;
            TrayIconBuilder::with_id("quota-clock")
                .icon(tray_icon)
                .tooltip("QuotaHalo · 额度光环")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "refresh" => {
                        let _ = app.emit("quota-refresh-request", ());
                    }
                    "usage" => {
                        let _ = open_usage_page();
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        ..
                    } = event
                    {
                        toggle_panel(tray.app_handle());
                    }
                })
                .build(app)?;
            #[cfg(target_os = "windows")]
            if let Some(window) = app.get_webview_window("main") {
                position_panel(&window);
                apply_rounded_window_region(&window);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            #[cfg(target_os = "windows")]
            if matches!(event, WindowEvent::Resized(_)) {
                if let (Ok(hwnd), Ok(size), Ok(scale_factor)) =
                    (window.hwnd(), window.outer_size(), window.scale_factor())
                {
                    apply_rounded_region(hwnd.0, size.width, size.height, scale_factor);
                }
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            refresh_quota,
            hide_panel,
            open_usage_page
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Codex quota clock");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn quota(minutes: u64) -> QuotaWindow {
        QuotaWindow {
            used_percent: 25.0,
            window_duration_mins: minutes,
            resets_at: 1_800_000_000,
        }
    }

    #[test]
    fn exact_windows_are_selected_without_guessing() {
        let snapshot = build_snapshot(RateLimitsRead {
            rate_limits: Some(RateLimitItem {
                primary: Some(quota(300)),
                secondary: Some(quota(10_080)),
            }),
            rate_limits_by_limit_id: None,
        });
        assert_eq!(snapshot.primary.unwrap().window_duration_mins, 300);
        assert_eq!(snapshot.weekly.unwrap().window_duration_mins, 10_080);
    }

    #[test]
    fn near_windows_are_not_misclassified() {
        let snapshot = build_snapshot(RateLimitsRead {
            rate_limits: Some(RateLimitItem {
                primary: Some(quota(299)),
                secondary: Some(quota(10_000)),
            }),
            rate_limits_by_limit_id: None,
        });
        assert_eq!(snapshot.status, "unavailable");
        assert!(snapshot.primary.is_none());
        assert!(snapshot.weekly.is_none());
    }

    #[test]
    fn finds_the_desktop_codex_installation_layout() {
        let root =
            std::env::temp_dir().join(format!("quota-halo-codex-layout-{}", std::process::id()));
        let version_dir = root
            .join("OpenAI")
            .join("Codex")
            .join("bin")
            .join("test-version");
        std::fs::create_dir_all(&version_dir).unwrap();
        let executable = version_dir.join("codex.exe");
        std::fs::write(&executable, []).unwrap();

        assert_eq!(installed_codex_from(&root), Some(executable));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn parses_official_camel_case_rate_limits() {
        let response = json!({
            "rateLimits": null,
            "rateLimitsByLimitId": {
                "codex": {
                    "primary": {"usedPercent": 64, "windowDurationMins": 300, "resetsAt": 1_790_510_298},
                    "secondary": {"usedPercent": 10, "windowDurationMins": 10_080, "resetsAt": 1_791_097_098}
                },
                "codex_other": {
                    "primary": {"usedPercent": 99, "windowDurationMins": 300, "resetsAt": 1_790_510_298}
                }
            }
        });
        let parsed: RateLimitsRead = serde_json::from_value(response).unwrap();
        let snapshot = build_snapshot(parsed);
        assert_eq!(snapshot.status, "ready");
        assert_eq!(snapshot.primary.as_ref().unwrap().used_percent, 64.0);
        assert_eq!(snapshot.weekly.as_ref().unwrap().used_percent, 10.0);
        let front_end = serde_json::to_value(snapshot).unwrap();
        assert_eq!(front_end["primary"]["used_percent"], 64.0);
        assert_eq!(front_end["weekly"]["resets_at"], 1_791_097_098_i64);
    }

    #[test]
    fn internal_rpc_errors_restart_the_app_server_once() {
        let internal = AppServerError::Rpc {
            method: "account/rateLimits/read".into(),
            code: -32603,
        };
        let rejected = AppServerError::Rpc {
            method: "account/rateLimits/read".into(),
            code: -32000,
        };
        assert!(should_restart_session(&internal, 0));
        assert!(should_restart_session(&internal, 1));
        assert!(!should_restart_session(&internal, 2));
        assert!(!should_restart_session(&rejected, 0));
        assert!(should_restart_session(
            &AppServerError::Transport("closed".into()),
            0
        ));
    }

    #[test]
    fn rpc_responses_are_correlated_by_unique_id() {
        assert!(rpc_response_matches_id(&Some(json!(42)), 42));
        assert!(!rpc_response_matches_id(&Some(json!(41)), 42));
        assert!(!rpc_response_matches_id(&Some(json!("42")), 42));
        assert!(!rpc_response_matches_id(&None, 42));
    }

    #[test]
    fn refresh_timeout_allows_the_initialize_and_rate_limit_calls() {
        assert_eq!(REQUEST_TIMEOUT, Duration::from_secs(15));
        assert_eq!(REFRESH_TIMEOUT, Duration::from_secs(50));
        assert_eq!(MAX_SESSION_ATTEMPTS, 3);
    }

    #[test]
    #[ignore = "requires a signed-in local Codex CLI and network access"]
    fn live_logged_in_codex_returns_quota_windows_over_a_reused_session() {
        let client = AppServerClient::default();
        tauri::async_runtime::block_on(async {
            for _ in 0..2 {
                let snapshot = client.refresh().await;
                assert_eq!(snapshot.status, "ready", "{:?}", snapshot.message);
                let primary = snapshot.primary.expect("5-hour window missing");
                let weekly = snapshot.weekly.expect("weekly window missing");
                assert!((0.0..=100.0).contains(&primary.used_percent));
                assert!((0.0..=100.0).contains(&weekly.used_percent));
                assert!(primary.resets_at > now_unix());
                assert!(weekly.resets_at > now_unix());
            }
        });
    }
}
