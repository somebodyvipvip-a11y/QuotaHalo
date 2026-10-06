use std::{
    env, fs,
    path::{Path, PathBuf},
    time::Duration,
};

use reqwest::{
    header::{ACCEPT, ACCEPT_LANGUAGE, AUTHORIZATION, CONTENT_TYPE, USER_AGENT},
    Client, StatusCode,
};
use serde_json::{json, Value};
use tokio::time::sleep;

const SESSION_HELPER: &str = include_str!("workbuddy_session.cjs");

use crate::{
    now_unix,
    services::{number, CreditSnapshot},
};

const PERSONAL_URL: &str = "https://copilot.tencent.com/billing/meter/get-user-resource-summary";
const ENTERPRISE_URL: &str =
    "https://copilot.tencent.com/v2/billing/meter/get-enterprise-user-usage";

struct Session {
    token: String,
    uid: String,
    enterprise_id: Option<String>,
}

fn session_path() -> Option<PathBuf> {
    env::var_os("LOCALAPPDATA").map(|root| {
        Path::new(&root).join("CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info")
    })
}

fn read_session(path: &Path) -> Result<Session, &'static str> {
    // WorkBuddy writes a marker when it logs out. A stale session must not be reused.
    if path.with_extension("info.logged-out").exists() {
        return Err("请登录 WorkBuddy");
    }
    let raw = fs::read_to_string(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            "请登录 WorkBuddy"
        } else {
            "WorkBuddy 登录文件无法读取"
        }
    })?;
    let value: Value = serde_json::from_str(&raw).map_err(|_| "WorkBuddy 登录信息无效")?;
    let token = match value.pointer("/auth/accessToken") {
        Some(Value::String(token)) if !token.is_empty() => token,
        Some(Value::String(_)) | Some(Value::Null) | None => return Err("请登录 WorkBuddy"),
        Some(token) if token.get("$wbEncrypted").and_then(Value::as_u64) == Some(1) => {
            return Err("WorkBuddy 登录信息已加密");
        }
        Some(_) => return Err("WorkBuddy 登录信息无效"),
    };
    let uid = value
        .pointer("/account/uid")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or("WorkBuddy 账号信息缺失")?;
    Ok(Session {
        token: token.to_owned(),
        uid: uid.to_owned(),
        enterprise_id: value
            .pointer("/account/enterpriseId")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_owned),
    })
}

fn count(value: Option<&Value>) -> f64 {
    value
        .and_then(number)
        .filter(|number| *number > 0.0)
        .unwrap_or(0.0)
}

fn parse_personal(value: &Value) -> Result<CreditSnapshot, &'static str> {
    if value.get("code").and_then(Value::as_i64) != Some(0) {
        return Err("WorkBuddy 额度请求失败");
    }
    let packages = value
        .pointer("/data/Packages")
        .and_then(Value::as_array)
        .ok_or("WorkBuddy 未返回积分池")?;
    let remaining = packages
        .iter()
        .map(|item| count(item.get("CycleRemainCapacity")))
        .sum();
    let total = packages
        .iter()
        .map(|item| count(item.get("CycleTotalCapacity")))
        .sum();
    Ok(CreditSnapshot::ready(remaining, Some(total), now_unix()))
}

fn parse_enterprise(value: &Value) -> Result<CreditSnapshot, &'static str> {
    if value
        .get("code")
        .is_some_and(|code| code.as_i64() != Some(0))
    {
        return Err("WorkBuddy 企业额度请求失败");
    }
    let data = value
        .pointer("/data/data")
        .or_else(|| value.get("data"))
        .unwrap_or(value);
    let limit = data
        .get("limitNum")
        .and_then(number)
        .ok_or("WorkBuddy 未返回企业额度")?;
    if limit == -1.0 {
        return Ok(CreditSnapshot::unlimited(now_unix()));
    }
    let used = data
        .get("credit")
        .and_then(number)
        .ok_or("WorkBuddy 未返回企业用量")?;
    if limit < 0.0 || used < 0.0 {
        return Err("WorkBuddy 企业额度无效");
    }
    Ok(CreditSnapshot::ready(
        (limit - used).max(0.0),
        Some(limit),
        now_unix(),
    ))
}

pub async fn fetch() -> CreditSnapshot {
    let Some(path) = session_path() else {
        return CreditSnapshot::missing("请登录 WorkBuddy");
    };
    let session = match read_session(&path) {
        Ok(session) => session,
        Err("WorkBuddy 登录信息已加密") => match read_encrypted_session().await {
            Ok(session) => session,
            Err(message) => return CreditSnapshot::missing(message),
        },
        Err(message) => return CreditSnapshot::missing(message),
    };
    let client = match Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
    {
        Ok(client) => client,
        Err(_) => return CreditSnapshot::missing("WorkBuddy 网络初始化失败"),
    };
    let enterprise = session.enterprise_id.is_some();
    let url = if enterprise {
        ENTERPRISE_URL
    } else {
        PERSONAL_URL
    };
    for attempt in 0..3 {
        let mut request = client
            .post(url)
            .header(ACCEPT, "application/json")
            .header(CONTENT_TYPE, "application/json")
            .header(ACCEPT_LANGUAGE, "zh")
            .header(
                USER_AGENT,
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) QuotaHalo/0.1",
            )
            .header(AUTHORIZATION, format!("Bearer {}", session.token))
            .header("X-User-Id", &session.uid)
            .json(&json!({}));
        if let Some(id) = &session.enterprise_id {
            request = request
                .header("X-Enterprise-Id", id)
                .header("X-Tenant-Id", id);
        }
        match request.send().await {
            Ok(response)
                if response.status() == StatusCode::UNAUTHORIZED
                    || response.status() == StatusCode::FORBIDDEN =>
            {
                return CreditSnapshot::missing("WorkBuddy 登录已过期")
            }
            Ok(response) if response.status().is_success() => {
                if let Ok(value) = response.json::<Value>().await {
                    let parsed = if enterprise {
                        parse_enterprise(&value)
                    } else {
                        parse_personal(&value)
                    };
                    if let Ok(snapshot) = parsed {
                        return snapshot;
                    }
                }
            }
            Ok(response) if !retryable_status(response.status()) => {
                return CreditSnapshot::missing("WorkBuddy 额度请求失败")
            }
            _ => {}
        }
        if attempt < 2 {
            sleep(Duration::from_secs(1 << attempt)).await;
        }
    }
    CreditSnapshot::missing("WorkBuddy 暂时无法读取积分")
}

async fn read_encrypted_session() -> Result<Session, &'static str> {
    use tokio::process::Command;
    let operation = async {
        let mut discover = Command::new("powershell.exe");
        discover.args(["-NoProfile", "-NonInteractive", "-Command", "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); Get-Process WorkBuddy -ErrorAction SilentlyContinue | Where-Object Path | Select-Object -First 1 -ExpandProperty Path"]);
        #[cfg(windows)]
        discover.creation_flags(0x08000000);
        discover.kill_on_drop(true);
        let location = discover
            .output()
            .await
            .map_err(|_| "无法定位 WorkBuddy 程序")?;
        let executable =
            String::from_utf8(location.stdout).map_err(|_| "无法定位 WorkBuddy 程序")?;
        let executable = executable.trim();
        if executable.is_empty() || !Path::new(executable).is_file() {
            return Err("请先启动 WorkBuddy 后刷新");
        }
        let mut helper = Command::new(executable);
        helper
            .env("ELECTRON_RUN_AS_NODE", "1")
            .args(["-e", SESSION_HELPER]);
        #[cfg(windows)]
        helper.creation_flags(0x08000000);
        helper.kill_on_drop(true);
        let output = helper
            .output()
            .await
            .map_err(|_| "WorkBuddy 登录信息读取失败")?;
        if !output.status.success() {
            return Err("WorkBuddy 登录信息读取失败");
        }
        let value: Value =
            serde_json::from_slice(&output.stdout).map_err(|_| "WorkBuddy 登录信息读取失败")?;
        let token = value
            .get("token")
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
            .ok_or("WorkBuddy 登录信息读取失败")?;
        let uid = value
            .get("uid")
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
            .ok_or("WorkBuddy 账号信息缺失")?;
        Ok(Session {
            token: token.to_owned(),
            uid: uid.to_owned(),
            enterprise_id: value
                .get("enterprise_id")
                .and_then(Value::as_str)
                .filter(|v| !v.is_empty())
                .map(str::to_owned),
        })
    };
    tokio::time::timeout(Duration::from_secs(10), operation)
        .await
        .map_err(|_| "WorkBuddy 登录信息读取超时")?
}

fn retryable_status(status: StatusCode) -> bool {
    status == StatusCode::REQUEST_TIMEOUT
        || status == StatusCode::TOO_MANY_REQUESTS
        || status.is_server_error()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypted_session_is_not_reported_as_logged_out() {
        let dir = env::temp_dir().join(format!("quotahalo-workbuddy-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("workbuddy-desktop.info");
        for token in [
            json!({"$wbEncrypted":1,"envelope":"fixture"}),
            json!({"$wbEncrypted":1,"scheme":"asym-v1","envelope":"fixture"}),
        ] {
            fs::write(
                &path,
                json!({"auth":{"accessToken":token},"account":{"uid":"fixture"}}).to_string(),
            )
            .unwrap();
            assert_eq!(read_session(&path).err(), Some("WorkBuddy 登录信息已加密"));
        }
        fs::write(
            &path,
            r#"{"auth":{"accessToken":"fixture"},"account":{"uid":"fixture"}}"#,
        )
        .unwrap();
        assert!(read_session(&path).is_ok());
        fs::write(path.with_extension("info.logged-out"), "fixture").unwrap();
        assert_eq!(read_session(&path).err(), Some("请登录 WorkBuddy"));
        fs::remove_file(path.with_extension("info.logged-out")).unwrap();
        fs::write(&path, "invalid json").unwrap();
        assert_eq!(read_session(&path).err(), Some("WorkBuddy 登录信息无效"));
        fs::write(
            &path,
            r#"{"auth":{"accessToken":{}},"account":{"uid":"fixture"}}"#,
        )
        .unwrap();
        assert_eq!(read_session(&path).err(), Some("WorkBuddy 登录信息无效"));
        fs::remove_file(&path).unwrap();
        assert_eq!(read_session(&path).err(), Some("请登录 WorkBuddy"));
        fs::remove_dir(&dir).unwrap();
    }

    #[test]
    fn personal_packages_sum_without_double_filtering() {
        let value = json!({"code":0,"data":{"Packages":[{"CycleRemainCapacity":120.5,"CycleTotalCapacity":200},{"CycleRemainCapacity":30,"CycleTotalCapacity":100}]}});
        let parsed = parse_personal(&value).unwrap();
        assert_eq!(parsed.remaining, Some(150.5));
        assert_eq!(parsed.total, Some(300.0));
    }

    #[test]
    fn enterprise_unlimited_is_not_a_negative_balance() {
        assert!(
            parse_enterprise(&json!({"data":{"limitNum":-1,"credit":32}}))
                .unwrap()
                .unlimited
        );
        assert_eq!(
            parse_enterprise(&json!({"data":{"limitNum":500,"credit":125}}))
                .unwrap()
                .remaining,
            Some(375.0)
        );
    }

    #[test]
    #[ignore = "requires a logged-in WorkBuddy account and network access"]
    fn live_workbuddy_returns_a_balance() {
        let snapshot = tauri::async_runtime::block_on(fetch());
        assert_eq!(snapshot.status, "ready", "{:?}", snapshot.message);
        assert!(snapshot.unlimited || snapshot.remaining.is_some_and(|value| value >= 0.0));
    }
}
