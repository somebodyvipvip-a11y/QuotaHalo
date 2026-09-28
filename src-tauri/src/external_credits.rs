use std::time::Duration;

use reqwest::{
    header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE},
    Client, StatusCode,
};
use serde_json::{json, Value};
use tokio::time::sleep;

use crate::{
    now_unix,
    services::{number, CreditSnapshot},
};

const QODER_URL: &str = "https://openapi.qoder.com.cn/sash/api/v2/me/usage";
const QODER_EXCHANGE_URL: &str = "https://openapi.qoder.com.cn/api/v1/jobToken/exchange";
const TRAE_URL: &str = "https://api.trae.com.cn/trae/api/v2/pay/user_current_entitlement_list";
const TRAE_RENEW_URL: &str = "https://api.trae.cn/cloudide/api/v3/common/GetUserToken";

fn qoder_pool(value: Option<&Value>) -> Result<Option<(f64, f64)>, &'static str> {
    let Some(pool) = value.filter(|value| !value.is_null()) else {
        return Ok(None);
    };
    let total = pool
        .get("total")
        .and_then(number)
        .ok_or("Qoder 积分数据缺失")?;
    let used = pool
        .get("used")
        .and_then(number)
        .ok_or("Qoder 积分数据缺失")?;
    if total < 0.0 || used < 0.0 {
        return Err("Qoder 积分数据无效");
    }
    Ok(Some(((total - used).max(0.0), total)))
}

fn parse_qoder(value: &Value) -> Result<CreditSnapshot, &'static str> {
    match value
        .get("displayMode")
        .or_else(|| value.get("display_mode"))
        .and_then(Value::as_str)
    {
        Some("enterprise") => return Err("Qoder 企业额度请在官网查看"),
        Some("qoder") => {}
        _ => return Err("Qoder 未返回可识别的额度"),
    }
    let usage = value
        .get("qoderUsage")
        .or_else(|| value.get("qoder_usage"))
        .ok_or("Qoder 未返回积分")?;
    let personal = qoder_pool(usage.get("userQuota").or_else(|| usage.get("user_quota")))?;
    let addon = qoder_pool(
        usage
            .get("addOnQuota")
            .or_else(|| usage.get("add_on_quota")),
    )?;
    let pools = [personal, addon];
    if pools.iter().all(Option::is_none) {
        return Err("Qoder 未返回积分池");
    }
    let remaining = pools.iter().flatten().map(|pool| pool.0).sum();
    let total = pools.iter().flatten().map(|pool| pool.1).sum();
    Ok(CreditSnapshot::ready(remaining, Some(total), now_unix()))
}

fn value_at<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut node = value;
    for key in path {
        node = node.get(*key)?;
    }
    Some(node).filter(|value| !value.is_null())
}

fn first_number<'a>(value: &'a Value, paths: &[&[&str]]) -> Option<f64> {
    paths
        .iter()
        .find_map(|path| value_at(value, path))
        .and_then(number)
}

const LIMIT_PATHS: &[&[&str]] = &[
    &["entitlement_base_info", "quota", "credits_limit"],
    &["quota", "credits_limit"],
    &["credits_limit"],
];
const USAGE_PATHS: &[&[&str]] = &[
    &["usage", "credits_amount"],
    &["entitlement_base_info", "usage", "credits_amount"],
];

fn parse_trae(value: &Value) -> Result<CreditSnapshot, &'static str> {
    let packs = value
        .get("user_entitlement_pack_list")
        .or_else(|| value.get("data").and_then(|data| data.get("user_entitlement_pack_list")))
        .and_then(Value::as_array)
        .filter(|packs| !packs.is_empty())
        .ok_or("TRAE 未返回积分数据")?;
    let mut remaining = 0.0;
    let mut total = 0.0;
    let mut credit_packs = 0;
    for pack in packs {
        // 订阅权限包（Solo 并行数等）没有 credits_limit，只发积分的包才计入。
        let Some(limit) = first_number(pack, LIMIT_PATHS) else {
            continue;
        };
        if limit == -1.0 {
            return Ok(CreditSnapshot::unlimited(now_unix()));
        }
        if limit < 0.0 {
            return Err("TRAE 积分上限无效");
        }
        // 未使用过的积分包不返回 usage，按已用 0 计。
        let used = first_number(pack, USAGE_PATHS).unwrap_or(0.0);
        if used < 0.0 {
            return Err("TRAE 积分用量无效");
        }
        remaining += (limit - used).max(0.0);
        total += limit;
        credit_packs += 1;
    }
    if credit_packs == 0 {
        return Err("TRAE 未返回积分数据");
    }
    Ok(CreditSnapshot::ready(
        (remaining * 100.0).round() / 100.0,
        Some((total * 100.0).round() / 100.0),
        now_unix(),
    ))
}

fn client() -> Result<Client, &'static str> {
    Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) QuotaHalo/0.1")
        .build()
        .map_err(|_| "网络初始化失败")
}

fn credential_value<'a>(raw: &'a str, prefix: &str) -> &'a str {
    let raw = raw.trim();
    if raw
        .get(..prefix.len())
        .is_some_and(|start| start.eq_ignore_ascii_case(prefix))
    {
        raw[prefix.len()..].trim()
    } else {
        raw
    }
}

fn retryable(status: StatusCode) -> bool {
    status == StatusCode::REQUEST_TIMEOUT
        || status == StatusCode::TOO_MANY_REQUESTS
        || status.is_server_error()
}

pub async fn fetch_qoder(token: &str) -> CreditSnapshot {
    let token = credential_value(credential_value(token, "Authorization:"), "Bearer ");
    if token.is_empty() {
        return CreditSnapshot::missing("请配置 Qoder 登录凭证");
    }
    let Ok(client) = client() else {
        return CreditSnapshot::missing("Qoder 网络初始化失败");
    };
    for attempt in 0..2 {
        let result = client
            .get(QODER_URL)
            .header(ACCEPT, "application/json")
            .header(AUTHORIZATION, format!("Bearer {token}"))
            .send()
            .await;
        match result {
            Ok(response)
                if matches!(
                    response.status(),
                    StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
                ) =>
            {
                return CreditSnapshot::missing("Qoder 登录凭证已过期")
            }
            Ok(response) if response.status().is_success() => {
                return match response.json::<Value>().await {
                    Ok(value) => parse_qoder(&value).unwrap_or_else(CreditSnapshot::missing),
                    Err(_) => CreditSnapshot::missing("Qoder 响应无法解析"),
                };
            }
            Ok(response) if !retryable(response.status()) => {
                return CreditSnapshot::missing("Qoder 额度请求失败")
            }
            _ => {}
        }
        if attempt == 0 {
            sleep(Duration::from_secs(2)).await;
        }
    }
    CreditSnapshot::missing("Qoder 暂时无法读取积分")
}

pub async fn exchange_qoder_pat(pat: &str) -> Result<String, &'static str> {
    if !pat.starts_with("pt-") {
        return Err("请填写 Qoder PAT（pt- 开头）");
    }
    let client = client()?;
    let response = client
        .post(QODER_EXCHANGE_URL)
        .header(ACCEPT, "application/json")
        .json(&json!({"personal_token": pat}))
        .send()
        .await
        .map_err(|_| "Qoder 登录服务暂时不可用")?;
    if !response.status().is_success() {
        return Err("Qoder PAT 无效或已过期");
    }
    let value = response
        .json::<Value>()
        .await
        .map_err(|_| "Qoder 登录响应无法解析")?;
    value
        .get("token")
        .or_else(|| value.get("accessToken"))
        .and_then(Value::as_str)
        .filter(|token| token.starts_with("jt-"))
        .map(str::to_owned)
        .ok_or("Qoder 未返回有效的登录令牌")
}

pub async fn renew_trae_token(session: &str) -> Result<String, &'static str> {
    if session.trim().is_empty() {
        return Err("TRAE 登录会话缺失");
    }
    let client = client()?;
    let response = client
        .post(TRAE_RENEW_URL)
        .header("Cookie", format!("X-Cloudide-Session={session}"))
        .header("Origin", "https://www.trae.cn")
        .header("Referer", "https://www.trae.cn/")
        .send()
        .await
        .map_err(|_| "TRAE 登录服务暂时不可用")?;
    if !response.status().is_success() {
        return Err("TRAE 登录已过期，请重新登录");
    }
    let value = response
        .json::<Value>()
        .await
        .map_err(|_| "TRAE 登录响应无法解析")?;
    value
        .get("Result")
        .and_then(|result| result.get("Token"))
        .and_then(Value::as_str)
        .filter(|token| !token.is_empty())
        .map(str::to_owned)
        .ok_or("TRAE 登录已过期，请重新登录")
}

pub async fn fetch_trae(secret: &str, auth_mode: &str, session: Option<&str>) -> CreditSnapshot {
    let secret = match auth_mode {
        "bearer" => credential_value(credential_value(secret, "Authorization:"), "Bearer "),
        "cloudide" => credential_value(secret, "X-Cloudide-Token:"),
        "jwt" => credential_value(secret, "Cloud-IDE-JWT "),
        "cookie" => credential_value(secret, "Cookie:"),
        _ => secret.trim(),
    };
    if secret.is_empty() {
        return CreditSnapshot::missing("请配置 TRAE 登录凭证");
    }
    if !matches!(auth_mode, "bearer" | "cloudide" | "cookie" | "jwt") {
        return CreditSnapshot::missing("TRAE 凭证类型无效");
    }
    let Ok(client) = client() else {
        return CreditSnapshot::missing("TRAE 网络初始化失败");
    };
    for attempt in 0..2 {
        let mut request = client
            .post(TRAE_URL)
            .header(ACCEPT, "application/json")
            .header(CONTENT_TYPE, "application/json")
            .header("X-User-Region", "cn")
            .json(&json!({"require_usage":true,"full_data":true,"Request":{}}));
        request = match auth_mode {
            "bearer" => request.header(AUTHORIZATION, format!("Bearer {secret}")),
            "cloudide" => request.header("X-Cloudide-Token", secret),
            "jwt" => request
                .header(AUTHORIZATION, format!("Cloud-IDE-JWT {secret}"))
                .header("Origin", "https://www.trae.cn")
                .header("Referer", "https://www.trae.cn/"),
            _ => request.header("Cookie", secret),
        };
        if auth_mode == "jwt" {
            if let Some(session) = session {
                request = request.header("Cookie", format!("X-Cloudide-Session={session}"));
            }
        }
        match request.send().await {
            Ok(response)
                if matches!(
                    response.status(),
                    StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
                ) =>
            {
                return CreditSnapshot::missing("TRAE 登录凭证已过期")
            }
            Ok(response) if response.status().is_success() => {
                return match response.json::<Value>().await {
                    Ok(value) => parse_trae(&value).unwrap_or_else(CreditSnapshot::missing),
                    Err(_) => CreditSnapshot::missing("TRAE 响应无法解析"),
                };
            }
            Ok(response) if !retryable(response.status()) => {
                return CreditSnapshot::missing("TRAE 额度请求失败")
            }
            _ => {}
        }
        if attempt == 0 {
            sleep(Duration::from_secs(2)).await;
        }
    }
    CreditSnapshot::missing("TRAE 暂时无法读取积分")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn qoder_adds_personal_and_addon_but_rejects_invalid_pool() {
        let value = json!({"displayMode":"qoder","qoderUsage":{"userQuota":{"total":1000,"used":250},"addOnQuota":{"total":200,"used":50},"orgResourcePackage":null}});
        assert_eq!(parse_qoder(&value).unwrap().remaining, Some(900.0));
        assert!(parse_qoder(
            &json!({"displayMode":"qoder","qoderUsage":{"userQuota":{"total":-1,"used":0}}})
        )
        .is_err());
        assert!(parse_qoder(&json!({"displayMode":"enterprise","enterpriseUsage":{}})).is_err());
    }

    fn trae_pack(credits: Option<f64>, used: Option<f64>) -> Value {
        let mut quota = serde_json::Map::new();
        if let Some(credits) = credits {
            quota.insert("credits_limit".into(), json!(credits));
        }
        quota.insert("enable_solo_agent".into(), json!(2));
        let mut base = serde_json::Map::new();
        base.insert("quota".into(), Value::Object(quota.clone()));
        // 同一份上限会在 product_extra 里镜像出现，不能被重复累加。
        base.insert(
            "product_extra".into(),
            json!({"package_extra": {"quota": quota}}),
        );
        let mut pack = serde_json::Map::new();
        pack.insert("entitlement_base_info".into(), Value::Object(base));
        if let Some(used) = used {
            pack.insert("usage".into(), json!({"credits_amount": used}));
        }
        Value::Object(pack)
    }

    #[test]
    fn trae_sums_only_credit_packs_and_counts_missing_usage_as_zero() {
        let value = json!({"user_entitlement_pack_list": [
            trae_pack(None, None),                       // 订阅权限包，无积分
            trae_pack(Some(500.0), Some(500.0)),         // 已用满
            trae_pack(Some(150.0), Some(19.1204)),       // 部分使用
            trae_pack(Some(150.0), None),                // 未使用，接口不返回 usage
            {"entitlement_base_info":{"quota":{"credits_limit":"1200"}},"usage":{"credits_amount":"300.5"}}
        ]});
        let snapshot = parse_trae(&value).unwrap();
        assert_eq!(snapshot.remaining, Some(1_180.38));
        assert_eq!(snapshot.total, Some(2_000.0));
    }

    #[test]
    fn trae_preserves_unlimited_and_rejects_pack_lists_without_credits() {
        let unlimited = json!({"user_entitlement_pack_list": [trae_pack(Some(-1.0), None)]});
        assert!(parse_trae(&unlimited).unwrap().unlimited);
        let subscription_only = json!({"user_entitlement_pack_list": [trae_pack(None, None)]});
        assert!(parse_trae(&subscription_only).is_err());
        assert!(parse_trae(&json!({"user_entitlement_pack_list": []})).is_err());
        assert!(parse_trae(&json!({"user_entitlement_pack_list": [{"status": 1}]})).is_err());
    }

    #[test]
    fn copied_header_values_are_normalized() {
        assert_eq!(
            credential_value(
                credential_value("Authorization: Bearer abc", "Authorization:"),
                "Bearer "
            ),
            "abc"
        );
        assert_eq!(
            credential_value("Cookie: session=abc", "Cookie:"),
            "session=abc"
        );
    }
}
