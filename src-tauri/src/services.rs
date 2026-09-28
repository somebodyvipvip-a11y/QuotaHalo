use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct CreditSnapshot {
    pub status: &'static str,
    pub remaining: Option<f64>,
    pub total: Option<f64>,
    pub unlimited: bool,
    pub message: Option<&'static str>,
    pub updated_at: Option<i64>,
}

impl CreditSnapshot {
    pub fn ready(remaining: f64, total: Option<f64>, updated_at: i64) -> Self {
        Self {
            status: "ready",
            remaining: Some(remaining),
            total,
            unlimited: false,
            message: None,
            updated_at: Some(updated_at),
        }
    }

    pub fn unlimited(updated_at: i64) -> Self {
        Self {
            status: "ready",
            remaining: None,
            total: None,
            unlimited: true,
            message: None,
            updated_at: Some(updated_at),
        }
    }

    pub fn missing(message: &'static str) -> Self {
        Self {
            status: "unavailable",
            remaining: None,
            total: None,
            unlimited: false,
            message: Some(message),
            updated_at: None,
        }
    }
}

pub fn number(value: &serde_json::Value) -> Option<f64> {
    let parsed = value
        .as_f64()
        .or_else(|| value.as_str().and_then(|raw| raw.parse().ok()))?;
    parsed.is_finite().then_some(parsed)
}
