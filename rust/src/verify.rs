use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;

use crate::response::PaymentRequirementsV2;

/// Build a shared facilitator HTTP client.
pub fn build_client() -> Client {
    Client::builder()
        .timeout(Duration::from_secs(5))
        .connect_timeout(Duration::from_secs(2))
        .pool_idle_timeout(Duration::from_secs(60))
        .pool_max_idle_per_host(10)
        .build()
        .expect("Failed to build HTTP client")
}

/// x402 v2 verify request body.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyRequestV2 {
    pub x402_version: u32,
    pub payment_payload: serde_json::Value,
    pub payment_requirements: PaymentRequirementsV2,
}

/// x402 v2 verify response body.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyResponseV2 {
    pub is_valid: bool,
    pub invalid_reason: Option<String>,
    pub payer: Option<String>,
}

/// Call facilitator /verify with v2 wire format.
/// Decodes PAYMENT-SIGNATURE from base64 into a JSON value.
/// Returns None if unreachable/timeout/parse error.
pub async fn verify_payment(
    client: &Client,
    facilitator_url: &str,
    payment_header: &str,
    requirements: &PaymentRequirementsV2,
) -> Option<VerifyResponseV2> {
    let payment_bytes = BASE64.decode(payment_header).ok()?;
    let payment_payload: serde_json::Value =
        serde_json::from_slice(&payment_bytes).ok()?;

    let body = VerifyRequestV2 {
        x402_version: 2,
        payment_payload,
        payment_requirements: requirements.clone(),
    };

    let url = format!("{}/verify", facilitator_url);
    let resp = match client.post(&url).json(&body).send().await {
        Ok(r) => r,
        Err(e) => {
            if e.is_timeout() {
                tracing::error!("Facilitator timeout after 5s");
            } else {
                tracing::error!("Facilitator error: {}", e);
            }
            return None;
        }
    };

    if !resp.status().is_success() {
        tracing::error!("Facilitator returned {}", resp.status());
        return None;
    }

    match resp.json::<VerifyResponseV2>().await {
        Ok(v) => Some(v),
        Err(e) => {
            tracing::error!("Facilitator response parse error: {}", e);
            None
        }
    }
}

/// Check facilitator health (GET /supported).
pub async fn check_health(client: &Client, facilitator_url: &str) -> bool {
    let url = format!("{}/supported", facilitator_url);
    let result = client
        .get(&url)
        .timeout(Duration::from_secs(3))
        .send()
        .await;

    matches!(result, Ok(r) if r.status().is_success())
}
